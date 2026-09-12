import { createHash, createPublicKey, createVerify, randomBytes, timingSafeEqual, type JsonWebKey } from 'node:crypto'

/**
 * Microsoft Entra sign-in: authorization code with PKCE.
 *
 * Deliberately not the client-credentials flow the mailer uses. That one
 * authenticates *an application* with no human present; this authenticates *a
 * person*, in a browser, with a redirect. The tenant is shared and the app
 * registration looks similar, which is exactly why the difference is worth
 * stating: none of the mailer's code applies here.
 *
 * Hand-rolled against `node:crypto` for the reason `s3.ts` hand-rolls SigV4 and
 * `alert.ts` hand-rolls SMTP — this container is the one that has to work when
 * everything else does not, and a sign-in library is a supply chain attached to
 * the front door. What it has to do is small: build a URL, exchange a code, and
 * verify a signature against a published key.
 *
 * **Everything here verifies. Nothing here trusts.** An ID token that decodes
 * is not an ID token that is for this deployment, and the checks below are the
 * difference: signature against the tenant's own published key, then issuer,
 * audience, expiry, not-before, and tenant. Skipping any one of them turns
 * "signed by Microsoft" into "signed by Microsoft for somebody else".
 */

export interface EntraConfig {
  readonly tenantId: string
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  /** Object ids permitted to sign in. Empty admits nobody, never everybody. */
  readonly allowedObjectIds: readonly string[]
}

export interface EntraIdentity {
  /** Immutable object id. The allow-list is on this, never on a UPN. */
  readonly oid: string
  readonly upn: string
  readonly name: string
}

const base64url = (input: Buffer): string =>
  input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const authority = (tenantId: string): string => `https://login.microsoftonline.com/${tenantId}`

/**
 * A PKCE pair.
 *
 * The verifier never leaves this box; only its hash travels to Microsoft, so an
 * authorization code intercepted in transit cannot be redeemed without it. The
 * client secret alone is not enough, which is the whole point of adding PKCE to
 * a confidential client that already has one.
 */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Opaque value tying the callback to the request that started it. */
export function createState(): string {
  return base64url(randomBytes(24))
}

export function authorizeUrl(config: EntraConfig, state: string, challenge: string): string {
  const url = new URL(`${authority(config.tenantId)}/oauth2/v2.0/authorize`)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('response_mode', 'query')
  // `openid profile` and nothing else: the engine wants to know who this is and
  // asks Microsoft for no access to anything. A scope added here is blast
  // radius bought for nothing.
  url.searchParams.set('scope', 'openid profile')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

/** Constant-time comparison, because `state` is a secret for the length of one sign-in. */
export function sameState(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function exchangeCode(
  config: EntraConfig,
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; idToken: string } | { ok: false; detail: string }> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
    scope: 'openid profile',
  })

  let response: Response
  try {
    response = await fetcher(`${authority(config.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch (error) {
    return { ok: false, detail: `Could not reach Microsoft: ${(error as Error).message.slice(0, 200)}` }
  }

  const text = await response.text()
  if (!response.ok) {
    // Microsoft's error bodies name the misconfiguration precisely and carry no
    // secret; the token response would, so only this branch is quoted.
    return { ok: false, detail: `Microsoft refused the code (${response.status}). ${text.slice(0, 300)}` }
  }

  let parsed: { id_token?: string }
  try {
    parsed = JSON.parse(text) as { id_token?: string }
  } catch {
    return { ok: false, detail: 'Microsoft returned something that is not JSON.' }
  }
  if (!parsed.id_token) return { ok: false, detail: 'No id_token in the response.' }
  return { ok: true, idToken: parsed.id_token }
}

interface Jwk {
  kid: string
  kty: string
  n?: string
  e?: string
  use?: string
}

/**
 * The tenant's signing keys, cached.
 *
 * Microsoft rotates these, so the cache has a lifetime and a miss on an unknown
 * `kid` refetches once — a key that rotated between two sign-ins must not look
 * like a forged token. The cache is per-process and dies with the container,
 * which is the right lifetime for something that is only an optimisation.
 */
const JWKS_TTL_MS = 12 * 60 * 60 * 1000
let jwksCache: { tenantId: string; fetchedAt: number; keys: Jwk[] } | undefined

async function jwks(tenantId: string, fetcher: typeof fetch, force = false): Promise<Jwk[]> {
  const fresh =
    jwksCache && jwksCache.tenantId === tenantId && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
  if (fresh && !force) return jwksCache!.keys

  const response = await fetcher(`${authority(tenantId)}/discovery/v2.0/keys`)
  if (!response.ok) throw new Error(`Could not fetch the signing keys (${response.status}).`)
  const body = (await response.json()) as { keys?: Jwk[] }
  const keys = body.keys ?? []
  jwksCache = { tenantId, fetchedAt: Date.now(), keys }
  return keys
}

/** Test seam; also lets a failed verification start clean. */
export function clearJwksCache(): void {
  jwksCache = undefined
}

const decodeSegment = (segment: string): unknown =>
  JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))

/**
 * Verify an ID token and say who it is for, or why it is not acceptable.
 *
 * `now` is injectable so expiry and not-before can be tested without waiting.
 */
export async function verifyIdToken(
  idToken: string,
  config: EntraConfig,
  fetcher: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<{ ok: true; identity: EntraIdentity } | { ok: false; detail: string }> {
  const parts = idToken.split('.')
  if (parts.length !== 3) return { ok: false, detail: 'That is not a token.' }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  let header: { alg?: string; kid?: string }
  let claims: Record<string, unknown>
  try {
    header = decodeSegment(headerPart) as { alg?: string; kid?: string }
    claims = decodeSegment(payloadPart) as Record<string, unknown>
  } catch {
    return { ok: false, detail: 'The token could not be decoded.' }
  }

  /*
   * The algorithm is pinned, not read. A token naming its own algorithm is the
   * root of JWT's two classic forgeries — `alg: none`, and an RSA public key
   * fed to an HMAC verifier as its secret — and the defence is to decide what
   * it must be rather than ask.
   */
  if (header.alg !== 'RS256') return { ok: false, detail: `Unexpected algorithm ${header.alg}.` }
  if (!header.kid) return { ok: false, detail: 'The token names no signing key.' }

  let keys = await jwks(config.tenantId, fetcher)
  let jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) {
    // Unknown kid: Microsoft may have rotated. Refetch once before refusing.
    keys = await jwks(config.tenantId, fetcher, true)
    jwk = keys.find((k) => k.kid === header.kid)
  }
  if (!jwk) return { ok: false, detail: 'The token was signed by a key this tenant does not publish.' }

  const verified = createVerify('RSA-SHA256')
    .update(`${headerPart}.${payloadPart}`)
    .verify(
      createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' }),
      Buffer.from(signaturePart.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    )
  if (!verified) return { ok: false, detail: 'The signature does not verify.' }

  /*
   * Signed is not the same as "for us". Each of these is a real attack if
   * dropped: a token for another application (aud), from another tenant (tid,
   * iss), or one that expired an hour ago (exp) all carry a valid Microsoft
   * signature.
   */
  const expectedIssuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`
  if (claims['iss'] !== expectedIssuer) return { ok: false, detail: 'The token is from another issuer.' }
  if (claims['aud'] !== config.clientId) return { ok: false, detail: 'The token is for another application.' }
  if (claims['tid'] !== config.tenantId) return { ok: false, detail: 'The token is from another tenant.' }

  const seconds = Math.floor(now / 1000)
  const SKEW = 120
  const exp = typeof claims['exp'] === 'number' ? claims['exp'] : 0
  const nbf = typeof claims['nbf'] === 'number' ? claims['nbf'] : 0
  if (exp + SKEW < seconds) return { ok: false, detail: 'The token has expired.' }
  if (nbf - SKEW > seconds) return { ok: false, detail: 'The token is not valid yet.' }

  const oid = typeof claims['oid'] === 'string' ? claims['oid'] : ''
  if (!oid) return { ok: false, detail: 'The token carries no object id.' }

  /*
   * The allow-list is on `oid` and never on `upn` or `email`. An object id is
   * immutable for the life of the account; a UPN can be renamed, and renamed
   * *onto* a different person, which would hand this panel to whoever inherits
   * the name. Empty admits nobody — an unconfigured allow-list is not an open
   * door.
   */
  if (!config.allowedObjectIds.includes(oid)) {
    return { ok: false, detail: 'That account is not permitted to sign in to this deployment.' }
  }

  return {
    ok: true,
    identity: {
      oid,
      upn: typeof claims['preferred_username'] === 'string' ? claims['preferred_username'] : '',
      name: typeof claims['name'] === 'string' ? claims['name'] : '',
    },
  }
}
