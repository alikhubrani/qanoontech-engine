import { createHash, createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * S3, signed by hand, for Cloudflare R2.
 *
 * Dependency-free for the same reason `drive.ts` is: the AWS SDK is several
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

/** The smallest client that serves the offsite copy: put, head, list, get. */
export class S3Client {
  constructor(
    private readonly config: S3Config,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  static from(config: S3Config, fetcher: typeof fetch = fetch): S3Client {
    for (const [name, value] of Object.entries(config)) {
      if (!value) throw new Error(`S3 is not configured: ${name} is empty.`)
    }
    return new S3Client(config, fetcher)
  }

  private path(key: string): string {
    return `/${this.config.bucket}/${key}`
  }

  private async send(signed: SignedRequest, method: string, body?: Buffer): Promise<Response> {
    const response = await this.fetcher(signed.url, {
      method,
      headers: signed.headers,
      ...(body ? { body: new Uint8Array(body) } : {}),
    })
    if (!response.ok) {
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
    await this.send(signed, 'PUT', body)
  }

  /** Size of an object, or undefined when it is not there. */
  async head(key: string): Promise<S3Object | undefined> {
    const signed = signRequest({
      config: this.config,
      method: 'HEAD',
      path: this.path(key),
      payloadHash: sha256(''),
    })
    const response = await this.fetcher(signed.url, { method: 'HEAD', headers: signed.headers })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`HEAD ${key} → ${response.status}`)
    return { key, size: Number(response.headers.get('content-length') ?? 0) }
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
      const xml = await (await this.send(signed, 'GET')).text()

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
    const response = await this.send(signed, 'GET')
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
    const response = await this.fetcher(signed.url, { method: 'DELETE', headers: signed.headers })
    // 204 on success, 404 when it was already gone; neither is a problem.
    if (!response.ok && response.status !== 404) {
      throw new Error(`DELETE ${key} → ${response.status}`)
    }
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
