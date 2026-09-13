import { createHash, createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * S3, signed by hand, for Cloudflare R2.
 *
 * Dependency-free deliberately: the AWS SDK is several
 * megabytes and a tree of transitive packages to make four HTTP calls, and this
 * container is the thing that has to still work when everything else does not.
 * Signature Version 4 is a documented recipe over `node:crypto` — four HMACs
 * and a canonical string — and it is written out below rather than abbreviated,
 * because a signature that is wrong by one byte fails with `SignatureDoesNotMatch`
 * and no clue which byte.
 *
 * R2 specifics, which are the whole reason to name it here:
 *  - the endpoint is `https://<account id>.r2.cloudflarestorage.com`;
 *  - the region is the literal string `auto` — R2 has no regions, but SigV4
 *    requires one in the credential scope, and `auto` is what Cloudflare
 *    expects to see there;
 *  - path-style addressing (`/<bucket>/<key>`) is used rather than
 *    virtual-host style, because it needs no per-bucket DNS and R2 accepts it.
 *
 * Everything is signed with a real payload hash rather than `UNSIGNED-PAYLOAD`.
 * The files are a few hundred kilobytes to a few megabytes, hashing one costs
 * milliseconds, and an unsigned payload is a request whose body nobody checked.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'

export interface S3Config {
  readonly endpoint: string
  readonly bucket: string
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

export interface S3Object {
  readonly key: string
  readonly size: number
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest()

/**
 * RFC 3986, which is not what `encodeURIComponent` does.
 *
 * It leaves `!'()*` alone and S3 does not, so a key containing one signs
 * differently from the way it is sent. Our ids are timestamps and filenames, so
 * this is belt and braces — but a canonical request is exact or it is nothing.
 */
function uriEncode(value: string, encodeSlash = true): string {
  let out = ''
  for (const char of value) {
    if (/[A-Za-z0-9\-._~]/.test(char)) {
      out += char
    } else if (char === '/') {
      out += encodeSlash ? '%2F' : '/'
    } else {
      for (const byte of Buffer.from(char, 'utf8')) {
        out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
      }
    }
  }
  return out
}

/** `20260911T230456Z` and `20260911`, which SigV4 wants in both forms. */
function stamps(at: Date): { amzDate: string; dateStamp: string } {
  const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

export interface SignedRequest {
  readonly url: string
  readonly headers: Record<string, string>
}

/**
 * The signature, step by step and in the order the specification gives them.
 *
 * Exported so it can be tested without a network: a canonical request is a
 * string, and getting it wrong is the only interesting failure here.
 */
export function signRequest(input: {
  readonly config: S3Config
  readonly method: string
  /** Path after the host, starting with `/`, not yet encoded. */
  readonly path: string
  readonly query?: Record<string, string>
  readonly payloadHash: string
  readonly extraHeaders?: Record<string, string>
  readonly at?: Date
}): SignedRequest {
  const { config, method, path, query = {}, payloadHash, extraHeaders = {}, at = new Date() } = input
  const { amzDate, dateStamp } = stamps(at)
  const host = new URL(config.endpoint).host

  const canonicalUri = path
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/')

  // Sorted by key, each name and value encoded. Empty query is an empty string.
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(query[key] ?? '')}`)
    .join('&')

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  }
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim()}\n`).join('')
  const signedHeaders = names.join(';')

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`
  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n')

  // kSecret -> kDate -> kRegion -> kService -> kSigning.
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), SERVICE),
    'aws4_request',
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')

  return {
    url: `${config.endpoint.replace(/\/$/, '')}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
    headers: {
      ...headers,
      Authorization: `${ALGORITHM} Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  }
}

/**
 * How long one request may take before it is treated as stalled: a minute,
 * plus four milliseconds per kilobyte of body. A link slower than 250 KB/s is
 * a stall, not a slow link, and a 500 MB document still gets over half an hour.
 *
 * Without a budget a socket that stops answering holds the tick open for as
 * long as the kernel is patient, which is hours, and every backup behind it.
 */
export function requestBudgetMs(bodyBytes: number): number {
  return 60_000 + Math.ceil(bodyBytes / 1024) * 4
}

/**
 * The pause before the one retry. Long enough to outlast a resolver blink or
 * a connection reset while an image is pulling next door; short enough that
 * a tick with a retry in it still finishes well inside the next one.
 */
export const RETRY_AFTER_MS = 20_000

export interface S3ClientOptions {
  /** Replaces the wait before the retry; tests pass one that records and returns. */
  readonly pause?: (ms: number) => Promise<void>
  /** Replaces the per-request budget; tests pass a tiny one. */
  readonly budgetMs?: (bodyBytes: number) => number
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })

/** 429 and the 5xx family pass; everything else a store says, it means. */
const passes = (status: number): boolean => status === 429 || status >= 500

/**
 * Why a request never got an answer, in the words the audit will show.
 *
 * `fetch` reports every network failure as `TypeError: fetch failed` and puts
 * the reason -- `ENOTFOUND`, `ECONNRESET`, a connect timeout -- on `cause`,
 * which the trail dropped. Eight rows on a firm's box read "fetch failed" and
 * nothing else, and whether the resolver blinked or the line was saturated
 * by an image pull was not recoverable afterwards. The code and the host
 * travel now.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'no answer within the time allowed'
  const cause = (error as Error & { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const c = cause as { code?: string; name?: string; message?: string; hostname?: string }
    const code = c.code ?? c.name ?? 'unknown'
    const where = c.hostname ? ` ${c.hostname}` : ''
    const message = c.message && c.message !== code ? `: ${c.message}` : ''
    return `${error.message} (${code}${where}${message})`
  }
  return error.message
}

/** The smallest client that serves the offsite copy: put, head, list, get. */
export class S3Client {
  private readonly pause: (ms: number) => Promise<void>
  private readonly budgetMs: (bodyBytes: number) => number

  constructor(
    private readonly config: S3Config,
    private readonly fetcher: typeof fetch = fetch,
    options: S3ClientOptions = {},
  ) {
    this.pause = options.pause ?? sleep
    this.budgetMs = options.budgetMs ?? requestBudgetMs
  }

  static from(config: S3Config, fetcher: typeof fetch = fetch, options: S3ClientOptions = {}): S3Client {
    for (const [name, value] of Object.entries(config)) {
      if (!value) throw new Error(`S3 is not configured: ${name} is empty.`)
    }
    return new S3Client(config, fetcher, options)
  }

  private path(key: string): string {
    return `/${this.config.bucket}/${key}`
  }

  /**
   * One request, and one more twenty seconds later when the failure is the
   * kind that passes: no answer at all, a 429, a 5xx. A 403 is not retried --
   * a wrong signature is wrong twice -- and neither is a 404, which is an
   * answer.
   *
   * One retry, not a schedule. The tick is the schedule: it comes back in five
   * minutes whatever happened here, and the retry exists only so that a blip
   * shorter than the pause costs nothing at all.
   */
  private async request(
    method: string,
    signed: SignedRequest,
    body?: Buffer,
    accept: (status: number) => boolean = () => false,
  ): Promise<Response> {
    const attempt = (): Promise<Response> =>
      this.fetcher(signed.url, {
        method,
        headers: signed.headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
        signal: AbortSignal.timeout(this.budgetMs(body?.length ?? 0)),
      })
    const where = `${method} ${new URL(signed.url).pathname}`
    const unanswered = (error: unknown) => new Error(`${describeFailure(error)} on ${where}`)

    let response: Response
    try {
      response = await attempt()
    } catch {
      await this.pause(RETRY_AFTER_MS)
      try {
        response = await attempt()
      } catch (again) {
        throw unanswered(again)
      }
    }
    if (!response.ok && !accept(response.status) && passes(response.status)) {
      await this.pause(RETRY_AFTER_MS)
      try {
        response = await attempt()
      } catch (again) {
        throw unanswered(again)
      }
    }
    if (!response.ok && !accept(response.status)) {
      const text = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`${method} ${signed.url} → ${response.status}. ${text}`)
    }
    return response
  }

  async putFile(key: string, filePath: string, contentType: string): Promise<void> {
    // Read rather than stream: SigV4 over a stream means chunked signing, and
    // these files are megabytes at most.
    const body = readFileSync(filePath)
    const signed = signRequest({
      config: this.config,
      method: 'PUT',
      path: this.path(key),
      payloadHash: sha256(body),
      extraHeaders: { 'content-type': contentType, 'content-length': String(body.length) },
    })
    await this.request('PUT', signed, body)
  }

  /**
   * Size of an object, or undefined when it is not there.
   *
   * **Listed, not HEADed**, and that is not a style choice. Cloudflare
   * compresses some responses on the way out, and when it does the HEAD comes
   * back `content-encoding: gzip` with **no `content-length` at all** — so the
   * obvious `Number(headers.get('content-length') ?? 0)` reads as zero. It is
   * intermittent: measured against R2 on 2026-09-12, one key answered 46 and
   * another answered nothing, minutes apart, same code.
   *
   * That is worse than a cosmetic bug. This answer decides whether a file is
   * re-uploaded, so a zero means every set is sent again on every tick — a
   * quiet, permanent doubling of a firm's egress that looks like it is working.
   *
   * `ListObjectsV2` returns `<Size>` in the body, which no transfer encoding
   * can alter. One request, same cost, an answer that is actually the object's.
   */
  async head(key: string): Promise<S3Object | undefined> {
    const listed = await this.list(key)
    return listed.find((object) => object.key === key)
  }

  /**
   * Every object under a prefix, following continuation tokens.
   *
   * The response is XML and this reads it with a regular expression rather than
   * adding a parser. That is a deliberate, bounded decision: the shape is fixed
   * by the S3 API, the two fields wanted are `<Key>` and `<Size>`, and both are
   * plain text in a response we asked for. It would be the wrong call for
   * arbitrary XML.
   */
  async list(prefix: string): Promise<S3Object[]> {
    const objects: S3Object[] = []
    let token: string | undefined

    do {
      const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' }
      if (token) query['continuation-token'] = token
      const signed = signRequest({
        config: this.config,
        method: 'GET',
        path: `/${this.config.bucket}`,
        query,
        payloadHash: sha256(''),
      })
      const xml = await (await this.request('GET', signed)).text()

      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const block = match[1] ?? ''
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1]
        const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1]
        if (key) objects.push({ key: decodeXml(key), size: Number(size ?? 0) })
      }

      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      token = truncated
        ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]
        : undefined
    } while (token)

    return objects
  }

  async getFile(key: string, toPath: string): Promise<void> {
    const signed = signRequest({
      config: this.config,
      method: 'GET',
      path: this.path(key),
      payloadHash: sha256(''),
    })
    const response = await this.request('GET', signed)
    mkdirSync(dirname(toPath), { recursive: true })
    writeFileSync(toPath, Buffer.from(await response.arrayBuffer()))
  }

  async deleteObject(key: string): Promise<void> {
    const signed = signRequest({
      config: this.config,
      method: 'DELETE',
      path: this.path(key),
      payloadHash: sha256(''),
    })
    // 204 on success, 404 when it was already gone; neither is a problem.
    await this.request('DELETE', signed, undefined, (status) => status === 404)
  }

  /** One cheap call that proves the credentials and the bucket, for the panel. */
  async check(): Promise<void> {
    await this.list('__engine_connectivity_check__/')
  }
}

/** The five entities S3 escapes in keys. */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export { sha256 as hashForS3 }
