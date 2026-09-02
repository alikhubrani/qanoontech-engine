import { CATALOGUE } from '../catalogue/index.js'

/**
 * Entitlements — what this deployment's licence permits.
 *
 * PHASE 1 STUB. There is no licence yet, so this grants everything in the
 * catalogue. Phase 3 replaces the body with verification of an Ed25519-signed
 * licence and the heartbeat that can revoke it; the signature of this function
 * is the shape that stays.
 *
 * It exists now rather than later so that resolution runs the real code path
 * from the first commit. A gate wired up on the day it starts refusing things
 * is a gate nobody has watched succeed.
 */
export function currentEntitlements(): readonly string[] {
  return CATALOGUE.map((m) => m.entitlement).filter((e): e is string => e !== undefined)
}
