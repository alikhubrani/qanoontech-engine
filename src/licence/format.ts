import type { KeyObject } from 'node:crypto'
import { createPublicKey } from 'node:crypto'
import { V4 } from 'paseto'
import { z } from 'zod'

/**
 * The licence: what one firm is permitted, signed.
 *
 * PASETO v4.public, deliberately not JWT: both sign with Ed25519, but a JWT
 * carries a field naming its own algorithm, and that field is the source of
 * its two classic forgeries. A PASETO token cannot ask to be verified
 * differently — the version is the algorithm.
 *
 * The payload is versioned from day one, because this format is the one thing
 * that cannot be changed retroactively across boxes already deployed. A `v` we
 * do not recognise is a licence from a future engine, and the holder is told
 * to update the engine — not refused as invalid, which would read as "your
 * licence is fake" to a firm holding a real one.
 */

export const LICENCE_VERSION = 1

export const licenceClaimsSchema = z.object({
  v: z.number().int().positive(),
  licenceId: z.string().min(1),
  firmId: z.string().min(1),
  /** Shown in the panel, so a firm sees whose licence this box holds. */
  firmName: z.string().min(1),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** Entitlement keys, matching the catalogue's `entitlement` fields. */
  entitlements: z.array(z.string()),
  /** Active QanoonTech user accounts permitted. 0 means unlimited. */
  seats: z.number().int().min(0),
  heartbeat: z.object({
    url: z.url(),
    intervalHours: z.number().int().min(1).max(24 * 7),
    graceDays: z.number().int().min(1).max(365),
  }),
  /**
   * A time-boxed licence issued over the phone to clear enforcement with no
   * network call — for the day enforcement fired for a reason that turns out
   * to be ours. It skips the heartbeat requirement until it expires, and it
   * expires soon by construction: issuing one with a long life would be
   * issuing a licence that cannot be revoked.
   */
  override: z.boolean().default(false),
})

export type LicenceClaims = z.infer<typeof licenceClaimsSchema>

export type VerifyResult =
  | { readonly ok: true; readonly claims: LicenceClaims }
  | { readonly ok: false; readonly reason: 'invalid' | 'unsupported-version'; readonly message: string }

/**
 * Verify a token's signature and shape. Expiry is deliberately not checked
 * here: expiry against the monotonic clock is the state machine's job, and a
 * verifier that also judged time would be two clocks disagreeing.
 */
export async function verifyLicence(token: string, publicKey: KeyObject): Promise<VerifyResult> {
  let payload: unknown
  try {
    payload = await V4.verify(token.trim(), publicKey, { ignoreExp: true, ignoreIat: true })
  } catch {
    return {
      ok: false,
      reason: 'invalid',
      message: 'This is not a licence signed for this system.',
    }
  }

  const versioned = z.object({ v: z.number() }).safeParse(payload)
  if (versioned.success && versioned.data.v > LICENCE_VERSION) {
    return {
      ok: false,
      reason: 'unsupported-version',
      message:
        'This licence was issued for a newer engine. Update the engine, then install it again.',
    }
  }

  const claims = licenceClaimsSchema.safeParse(payload)
  if (!claims.success) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'The licence is signed but malformed. Ask for it to be reissued.',
    }
  }
  return { ok: true, claims: claims.data }
}

/**
 * Sign a licence. Lives here for the issuing tool and the tests; the engine
 * itself never holds a private key, and this repository never holds ours.
 */
export async function signLicence(claims: LicenceClaims, privateKey: KeyObject): Promise<string> {
  return V4.sign(licenceClaimsSchema.parse(claims), privateKey, { iat: false })
}

/**
 * The production public key, compiled into the image.
 *
 * DEVELOPMENT KEY — its private half exists only on the maintainer's machine,
 * for signing test licences against real boxes. It must be replaced with the
 * real issuing key, from our infrastructure, before the first licensed
 * release; the release checklist carries that step. A licence signed with the
 * real key does not verify against this build, and vice versa — which is the
 * point.
 */
const PRODUCTION_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAoUYE9cdeOPwlIx9vXldg02C9phZo+oXbu686D1aJHcA=
-----END PUBLIC KEY-----`

export function productionPublicKey(): KeyObject {
  return createPublicKey(PRODUCTION_PUBLIC_KEY_PEM)
}
