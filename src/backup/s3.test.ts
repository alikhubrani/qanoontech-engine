import { describe, expect, it } from 'vitest'
import { S3Client, signRequest, type S3Config } from './s3.js'

/**
 * Signature Version 4, checked for the properties that catch a wrong one.
 *
 * There are no hard-coded expected signatures here, deliberately. A vector
 * copied from memory that happens to match a bug is worse than no test — it
 * says "correct" about the thing it was derived from. So these assert what a
 * signature must *do*: be deterministic, and change when any signed input
 * changes. A signature that ignores the payload, the region or the method is
 * exactly the bug this catches, and each of those is one line below.
 *
 * The authoritative check is a real round-trip against R2, which fails with
 * `SignatureDoesNotMatch` if any of this is wrong. That runs on a box with
 * credentials; this runs everywhere, in a millisecond.
 */

const config: S3Config = {
  endpoint: 'https://abc123.r2.cloudflarestorage.com',
  bucket: 'qanoontech-backups',
  region: 'auto',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}

const at = new Date('2026-09-11T23:04:56.000Z')
const base = {
  config,
  method: 'PUT',
  path: '/qanoontech-backups/2026-09-11T22-53-43Z/database.sql.gz',
  payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  at,
}
const signatureOf = (signed: { headers: Record<string, string> }) =>
  /Signature=([0-9a-f]+)/.exec(signed.headers['Authorization'] ?? '')?.[1]

describe('signing a request', () => {
  it('is deterministic for the same inputs', () => {
    expect(signatureOf(signRequest(base))).toBe(signatureOf(signRequest(base)))
  })

  it('carries the credential scope R2 expects', () => {
    const auth = signRequest(base).headers['Authorization'] ?? ''
    expect(auth).toContain('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260911/auto/s3/aws4_request')
    // host must be signed, or the request can be replayed against another bucket.
    expect(auth).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date')
  })

  it('signs the content headers an upload sends, so they cannot be altered in flight', () => {
    const auth = signRequest({
      ...base,
      extraHeaders: { 'content-type': 'application/gzip', 'content-length': '142576' },
    }).headers['Authorization'] ?? ''
    expect(auth).toContain('SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date')
  })

  it('stamps the date in both forms', () => {
    const headers = signRequest(base).headers
    expect(headers['x-amz-date']).toBe('20260911T230456Z')
  })

  /*
   * Each of these is a real bug someone ships: signing without the payload,
   * without the method, without the region. If any signature below matches the
   * base one, that input is not in the signature.
   */
  it.each([
    ['the payload', { payloadHash: 'f'.repeat(64) }],
    ['the method', { method: 'GET' }],
    ['the path', { path: '/qanoontech-backups/other.gz' }],
    ['the region', { config: { ...config, region: 'us-east-1' } }],
    ['the secret', { config: { ...config, secretAccessKey: 'another-secret-entirely' } }],
    ['the moment', { at: new Date('2026-09-12T00:00:00.000Z') }],
    ['a signed header', { extraHeaders: { 'content-type': 'text/plain' } }],
  ])('changes when %s changes', (_what, override) => {
    expect(signatureOf(signRequest({ ...base, ...override }))).not.toBe(signatureOf(signRequest(base)))
  })

  it('sorts and encodes the query, because the canonical form is exact', () => {
    const signed = signRequest({
      ...base,
      method: 'GET',
      path: '/qanoontech-backups',
      query: { prefix: 'sets/2026-09-11T22-53-43Z/', 'list-type': '2' },
    })
    // Sorted by name, and the slash inside a value is escaped.
    expect(signed.url).toContain('?list-type=2&prefix=sets%2F2026-09-11T22-53-43Z%2F')
  })

  /*
   * `encodeURIComponent` leaves !'()* alone and S3 does not, so a key with one
   * would sign differently from the way it is sent — a SignatureDoesNotMatch
   * with nothing in the message to say why.
   */
  it('encodes the characters encodeURIComponent leaves alone', () => {
    const signed = signRequest({ ...base, path: "/bucket/a(b)c'd!e*f.gz" })
    expect(signed.url).toContain('a%28b%29c%27d%21e%2Af.gz')
  })
})

describe('the client', () => {
  it('refuses to be built with a missing piece rather than failing at the first call', () => {
    expect(() => S3Client.from({ ...config, bucket: '' })).toThrow(/bucket is empty/)
    expect(() => S3Client.from({ ...config, secretAccessKey: '' })).toThrow(/secretAccessKey is empty/)
  })

  it('reads keys and sizes out of a list response, and follows the token', async () => {
    const pages = [
      `<ListBucketResult><IsTruncated>true</IsTruncated>
         <Contents><Key>sets/a/database.sql.gz</Key><Size>142576</Size></Contents>
         <NextContinuationToken>TOKEN2</NextContinuationToken></ListBucketResult>`,
      `<ListBucketResult><IsTruncated>false</IsTruncated>
         <Contents><Key>sets/b/manifest.json</Key><Size>204</Size></Contents></ListBucketResult>`,
    ]
    let call = 0
    const fetcher = (async (url: string) => {
      const body = pages[call++]!
      if (call === 2) expect(String(url)).toContain('continuation-token=TOKEN2')
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch

    const objects = await new S3Client(config, fetcher).list('sets/')
    expect(objects).toEqual([
      { key: 'sets/a/database.sql.gz', size: 142576 },
      { key: 'sets/b/manifest.json', size: 204 },
    ])
  })

  it('reports a missing object as absent rather than as a failure', async () => {
    const fetcher = (async () =>
      new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', {
        status: 200,
      })) as unknown as typeof fetch
    await expect(new S3Client(config, fetcher).head('sets/nope')).resolves.toBeUndefined()
  })

  /*
   * Cloudflare compresses some responses, and a gzipped HEAD carries no
   * `content-length` at all -- so reading the size from a HEAD returned zero,
   * intermittently. Since that answer decides whether a file is uploaded again,
   * a zero meant re-sending every set on every tick, quietly, forever.
   */
  it('takes a size from the list body, which no transfer encoding can alter', async () => {
    let sawHead = false
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') sawHead = true
      return new Response(
        `<ListBucketResult><IsTruncated>false</IsTruncated>
           <Contents><Key>sets/a/database.sql.gz</Key><Size>142576</Size></Contents>
         </ListBucketResult>`,
        { status: 200, headers: { 'content-encoding': 'gzip' } },
      )
    }) as unknown as typeof fetch

    const found = await new S3Client(config, fetcher).head('sets/a/database.sql.gz')
    expect(found).toEqual({ key: 'sets/a/database.sql.gz', size: 142576 })
    expect(sawHead, 'HEAD is not trusted for size through a CDN').toBe(false)
  })

  it('does not mistake a longer key that starts the same for the one asked for', async () => {
    const fetcher = (async () =>
      new Response(
        `<ListBucketResult><IsTruncated>false</IsTruncated>
           <Contents><Key>sets/a/database.sql.gz.partial</Key><Size>9</Size></Contents>
         </ListBucketResult>`,
        { status: 200 },
      )) as unknown as typeof fetch
    await expect(new S3Client(config, fetcher).head('sets/a/database.sql.gz')).resolves.toBeUndefined()
  })

  it('turns a refusal into an error that names the status', async () => {
    const fetcher = (async () =>
      new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 })) as unknown as typeof fetch
    await expect(new S3Client(config, fetcher).list('sets/')).rejects.toThrow(/403.*SignatureDoesNotMatch/s)
  })
})
