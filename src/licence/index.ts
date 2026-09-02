import type { KeyObject } from 'node:crypto'
import { stateDir } from '../state/store.js'
import { productionPublicKey } from './format.js'
import { licenceStatus, type LicenceStatus } from './state.js'

export { verifyLicence, signLicence, productionPublicKey, licenceClaimsSchema } from './format.js'
export type { LicenceClaims } from './format.js'
export { licenceStatus, installLicence, readHeartbeat, readLicenceToken } from './state.js'
export type { LicenceStanding, LicenceStatus } from './state.js'
export { performHeartbeat } from './heartbeat.js'
export { enforceStop, enforceClear, isEnforced, enforcementTargets } from './enforce.js'
export { observedNow, clockRolledBack } from './clock.js'

/**
 * The public key everything verifies against. Tests inject their own;
 * production uses the embedded one and never anything else — this indirection
 * exists for the tests, not as a configuration point, and it must never read
 * an environment variable: a trust root the environment can swap is a licence
 * check anyone who writes the compose file can disable.
 */
let activeKey: KeyObject | undefined

export function setLicencePublicKeyForTesting(key: KeyObject | undefined): void {
  activeKey = key
}

export function licencePublicKey(): KeyObject {
  return activeKey ?? productionPublicKey()
}

/**
 * What this deployment's licence entitles, and whether it may be deployed at
 * all. A deployment with no licence, a bad licence or an exhausted grace does
 * not render — the required modules carry no entitlement, so a licence in
 * grace still runs the system; what a decayed licence cannot do is deploy
 * *more*.
 */
export async function currentLicence(dir = stateDir()): Promise<LicenceStatus> {
  return licenceStatus(licencePublicKey(), dir)
}

export type EntitlementsResult =
  | { readonly ok: true; readonly entitlements: readonly string[]; readonly status: LicenceStatus }
  | { readonly ok: false; readonly problem: string; readonly status: LicenceStatus }

export async function currentEntitlements(dir = stateDir()): Promise<EntitlementsResult> {
  const status = await currentLicence(dir)
  switch (status.standing) {
    case 'ok':
    case 'grace':
      return { ok: true, entitlements: status.claims?.entitlements ?? [], status }
    case 'missing':
      return {
        ok: false,
        problem: 'No licence is installed. Install one before deploying.',
        status,
      }
    case 'invalid':
      return { ok: false, problem: status.message, status }
    case 'enforce':
      return { ok: false, problem: status.message, status }
  }
}
