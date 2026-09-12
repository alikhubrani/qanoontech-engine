import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  authorizeUrl,
  clearJwksCache,
  createPkce,
  createState,
  exchangeCode,
  sameState,
  verifyIdToken,
  type EntraConfig,
} from './entra.js'

/**
 * Signing with a real key pair, because the whole value of this module is that
 * it refuses tokens it cannot verify. A fake that skipped the signature would
 * pass an implementation that skipped it too — which is precisely the bug
 * worth catching, since a token that merely *decodes* carries whatever claims
 * its author chose.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = 'test-key-1'

const TENANT = 'e12d2506-d720-4ff4-9956-27df04e3dc33'
const CLIENT = 'a4049d7b-249b-4e77-856a-65bd61eab5f3'
const OID = '59e5362f-28b1-4b04-b6aa-b125fcb3c5ea'

const config: EntraConfig = {
  tenantId: TENANT,
  clientId: CLIENT,
  clientSecret: 'not-used-by-verification',
  redirectUri: 'https://portal.example.com/api/session/entra/callback',
  allowedObjectIds: [OID],
}

const b64 = (value: object | Buffer): string =>
  (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const NOW = Date.UTC(2026, 8, 12, 20, 0, 0)
const seconds = Math.floor(NOW / 1000)

function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const head = b64({ alg: 'RS256', kid: KID, typ: 'JWT', ...header })
  const body = b64({
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: CLIENT,
    tid: TENANT,
    oid: OID,
    preferred_username: 'a@alikhubrani.com',
    name: 'Ali',
    nbf: seconds - 60,
    exp: seconds + 3600,
    ...claims,
  })
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey)
  return `${head}.${body}.${b64(signature)}`
}

/** A JWKS endpoint holding the public half, and nothing else. */
function jwksFetcher(keys?: object[]): typeof fetch {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  return (async () =>
    new Response(JSON.stringify({ keys: keys ?? [{ ...jwk, kid: KID, use: 'sig' }] }), {
      status: 200,
    })) as unknown as typeof fetch
}

beforeEach(() => clearJwksCache())

describe('the authorize URL', () => {
  it('asks for identity and no access at all', () => {
    const url = new URL(authorizeUrl(config, 'st', 'ch'))
    // `openid profile` and nothing more. A scope here is access granted for
    // nothing: the engine reads claims and never calls Graph.
    expect(url.searchParams.get('scope')).toBe('openid profile')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_id')).toBe(CLIENT)
    expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`)
  })

  it('sends the registered redirect, never one a caller chose', () => {
    expect(new URL(authorizeUrl(config, 'st', 'ch')).searchParams.get('redirect_uri')).toBe(config.redirectUri)
  })
})

describe('PKCE', () => {
  it('sends the hash and keeps the verifier', () => {
    const { verifier, challenge } = createPkce()
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
    expect(challenge).not.toBe(verifier)
  })

  it('is different every time', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier)
    expect(createState()).not.toBe(createState())
  })
})

describe('comparing state', () => {
  it('accepts a match and refuses anything else', () => {
    expect(sameState('abc', 'abc')).toBe(true)
    expect(sameState('abc', 'abd')).toBe(false)
    // Different lengths must not throw — timingSafeEqual does, on its own.
    expect(sameState('abc', 'abcd')).toBe(false)
    expect(sameState('', '')).toBe(true)
  })
})

/**
 * Every case below is a real way in if the check is missing. A valid Microsoft
 * signature is not the question; "signed for *this* deployment" is.
 */
describe('verifying an ID token', () => {
  it('accepts a good one and says who it is', async () => {
    const result = await verifyIdToken(token(), config, jwksFetcher(), NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.oid).toBe(OID)
    expect(result.identity.upn).toBe('a@alikhubrani.com')
  })

  it('refuses a token signed by something else', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const head = b64({ alg: 'RS256', kid: KID, typ: 'JWT' })
    const body = b64({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, oid: OID, exp: seconds + 3600 })
    const forged = `${head}.${body}.${b64(createSign('RSA-SHA256').update(`${head}.${body}`).sign(other.privateKey))}`
    const result = await verifyIdToken(forged, config, jwksFetcher(), NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('signature')
  })

  it('refuses `alg: none`, and never trusts the algorithm the token names', async () => {
    const head = b64({ alg: 'none', kid: KID })
    const body = b64({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, oid: OID, exp: seconds + 3600 })
    const result = await verifyIdToken(`${head}.${body}.`, config, jwksFetcher(), NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('algorithm')
  })

  it('refuses a token for another application', async () => {
    const result = await verifyIdToken(token({ aud: randomUUID() }), config, jwksFetcher(), NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('another application')
  })

  it('refuses a token from another tenant', async () => {
    const other = randomUUID()
    const result = await verifyIdToken(
      token({ tid: other, iss: `https://login.microsoftonline.com/${other}/v2.0` }),
      config,
      jwksFetcher(),
      NOW,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toMatch(/another (tenant|issuer)/)
  })

  it('refuses an expired token', async () => {
    const result = await verifyIdToken(token({ exp: seconds - 3600 }), config, jwksFetcher(), NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('expired')
  })

  it('refuses one that is not valid yet', async () => {
    const result = await verifyIdToken(token({ nbf: seconds + 3600 }), config, jwksFetcher(), NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('not valid yet')
  })

  /*
   * The case the tenant check alone does not cover: a colleague, in the right
   * directory, with a perfectly good token. `tid` admits the whole company.
   */
  it('refuses a valid account that is not on the allow-list', async () => {
    const result = await verifyIdToken(token({ oid: randomUUID() }), config, jwksFetcher(), NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('not permitted')
  })

  it('admits nobody when the allow-list is empty', async () => {
    // Unconfigured must fail closed. An empty list is not "everybody".
    const result = await verifyIdToken(token(), { ...config, allowedObjectIds: [] }, jwksFetcher(), NOW)
    expect(result.ok).toBe(false)
  })

  it('matches on the object id and ignores a matching UPN', async () => {
    // A UPN can be renamed onto a different person; an object id cannot.
    const result = await verifyIdToken(
      token({ oid: randomUUID(), preferred_username: 'a@alikhubrani.com' }),
      config,
      jwksFetcher(),
      NOW,
    )
    expect(result.ok).toBe(false)
  })

  it('refuses a token whose signing key the tenant does not publish', async () => {
    const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = stranger.publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    const result = await verifyIdToken(token(), config, jwksFetcher([{ ...jwk, kid: 'someone-else' }]), NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('does not publish')
  })

  it('refuses something that is not a token', async () => {
    expect((await verifyIdToken('nonsense', config, jwksFetcher(), NOW)).ok).toBe(false)
    expect((await verifyIdToken('a.b.c', config, jwksFetcher(), NOW)).ok).toBe(false)
  })
})

describe('exchanging the code', () => {
  it('sends the verifier and the secret, and asks for no extra scope', async () => {
    let sent = ''
    const fetcher = (async (_url: string, init?: RequestInit) => {
      sent = String(init?.body ?? '')
      return new Response(JSON.stringify({ id_token: 'x' }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await exchangeCode(config, 'the-code', 'the-verifier', fetcher)
    expect(result.ok).toBe(true)
    const body = new URLSearchParams(sent)
    expect(body.get('code_verifier')).toBe('the-verifier')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe(config.redirectUri)
    expect(body.get('scope')).toBe('openid profile')
  })

  it('reports a refusal without pretending it worked', async () => {
    const fetcher = (async () =>
      new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch
    const result = await exchangeCode(config, 'c', 'v', fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('invalid_grant')
  })

  it('survives Microsoft being unreachable', async () => {
    const fetcher = (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    const result = await exchangeCode(config, 'c', 'v', fetcher)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('Could not reach Microsoft')
  })
})
