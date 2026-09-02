import type { KeyObject } from 'node:crypto'
import { V4 } from 'paseto'
import { z } from 'zod'
import { stateDir } from '../state/store.js'
import { observedNow } from './clock.js'
import type { LicenceClaims } from './format.js'
import { readHeartbeat, writeHeartbeat } from './state.js'

/**
 * The heartbeat: "is this licence still good, according to us?"
 *
 * The request carries nothing sensitive — licence and firm ids, versions —
 * and the *response* is the part that has to be trustworthy: it is a PASETO
 * signed by the same key as the licence, because an unsigned "ok" is an "ok"
 * anyone between the box and us can manufacture, and with it, revocation is
 * theatre. An unreachable service, a bad signature and a stale response all
 * fail the same way: no heartbeat, grace keeps running. Failing toward
 * enforcement is the design — the attacker's easy move (block the URL) only
 * starts a 30-day clock with escalating warnings on it.
 *
 * A verified response also carries the service's own time, which is fed to
 * the monotonic clock: every heartbeat ratchets the high-water mark with a
 * timestamp the operator cannot wind back.
 */

const responseClaimsSchema = z.object({
  v: z.number().int().positive(),
  licenceId: z.string(),
  status: z.enum(['ok', 'revoked']),
  at: z.iso.datetime(),
})

/** How stale a signed "ok" may be before it is treated as a replay. */
const RESPONSE_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000

export interface HeartbeatOutcome {
  readonly result: 'ok' | 'revoked' | 'failed'
  readonly detail?: string
}

export async function performHeartbeat(
  claims: LicenceClaims,
  publicKey: KeyObject,
  dir = stateDir(),
  fetcher: typeof fetch = fetch,
): Promise<HeartbeatOutcome> {
  const record = readHeartbeat(dir)
  const now = observedNow(dir)
  const attempt = { ...record, lastAttemptAt: now }

  let body: string
  try {
    const response = await fetcher(claims.heartbeat.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licenceId: claims.licenceId, firmId: claims.firmId }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      writeHeartbeat({ ...attempt, lastError: `The licence service answered ${response.status}.` }, dir)
      return { result: 'failed', detail: `HTTP ${response.status}` }
    }
    body = (await response.text()).trim()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    writeHeartbeat({ ...attempt, lastError: `Could not reach the licence service: ${detail}` }, dir)
    return { result: 'failed', detail }
  }

  let payload: unknown
  try {
    payload = await V4.verify(body, publicKey, { ignoreExp: true, ignoreIat: true })
  } catch {
    writeHeartbeat({ ...attempt, lastError: 'The licence service answer was not signed for this system.' }, dir)
    return { result: 'failed', detail: 'unsigned or wrongly signed response' }
  }

  const parsed = responseClaimsSchema.safeParse(payload)
  if (!parsed.success || parsed.data.licenceId !== claims.licenceId) {
    writeHeartbeat({ ...attempt, lastError: 'The licence service answer did not match this licence.' }, dir)
    return { result: 'failed', detail: 'response for a different licence' }
  }

  const serverTime = Date.parse(parsed.data.at)
  if (now - serverTime > RESPONSE_FRESHNESS_MS) {
    writeHeartbeat({ ...attempt, lastError: 'The licence service answer was stale.' }, dir)
    return { result: 'failed', detail: 'stale response (replay?)' }
  }

  // Ratchet the clock with the service's own timestamp.
  if (serverTime > now) observedNow(dir)

  if (parsed.data.status === 'revoked') {
    writeHeartbeat({ ...attempt, lastError: '', revokedAt: record.revokedAt || now }, dir)
    return { result: 'revoked' }
  }

  writeHeartbeat({ ...attempt, lastSuccessAt: now, lastError: '', revokedAt: 0 }, dir)
  return { result: 'ok' }
}
