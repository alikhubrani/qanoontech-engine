import type { KeyObject } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { readJsonFile, writeJsonAtomic } from '../lib/json-files.js'
import { stateDir } from '../state/store.js'
import { observedNow } from './clock.js'
import { verifyLicence, type LicenceClaims } from './format.js'

/**
 * What the engine knows about its licence, and what that means right now.
 *
 * Two files: the licence token as it was handed to us, and the heartbeat
 * record. Everything else — days of grace used, which warning tier, whether
 * to enforce — is computed from those plus the monotonic clock, never stored.
 * Stored conclusions are conclusions that can disagree with their inputs.
 */

const LICENCE_FILE = 'licence.paseto'
const HEARTBEAT_FILE = 'heartbeat.json'

const heartbeatRecordSchema = z.object({
  /** Last time the licence service confirmed this licence, observed time. */
  lastSuccessAt: z.number().default(0),
  lastAttemptAt: z.number().default(0),
  lastError: z.string().default(''),
  /** Set when the service answers "revoked"; cleared by a new licence. */
  revokedAt: z.number().default(0),
})

export type HeartbeatRecord = z.infer<typeof heartbeatRecordSchema>

export function readLicenceToken(dir = stateDir()): string | undefined {
  try {
    return readFileSync(join(dir, LICENCE_FILE), 'utf8').trim()
  } catch {
    return undefined
  }
}

export function writeLicenceToken(token: string, dir = stateDir()): void {
  const path = join(dir, LICENCE_FILE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, token.trim() + '\n', { mode: 0o600 })
}

export function readHeartbeat(dir = stateDir()): HeartbeatRecord {
  const raw = readJsonFile(join(dir, HEARTBEAT_FILE), { lenient: true })
  const parsed = heartbeatRecordSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : heartbeatRecordSchema.parse({})
}

export function writeHeartbeat(record: HeartbeatRecord, dir = stateDir()): void {
  writeJsonAtomic(join(dir, HEARTBEAT_FILE), record)
}

/** Installing a new licence forgives a revocation: reissuing is the remedy. */
export function installLicence(token: string, dir = stateDir()): void {
  writeLicenceToken(token, dir)
  const heartbeat = readHeartbeat(dir)
  writeHeartbeat({ ...heartbeat, revokedAt: 0, lastError: '' }, dir)
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type LicenceStanding =
  /** Signed, in date, heartbeat fresh (or an override). All is well. */
  | 'ok'
  /** Valid but decaying: expired, revoked, or heartbeats missed. Grace is running. */
  | 'grace'
  /** Grace exhausted. The deployment is to be stopped. */
  | 'enforce'
  /** No licence installed. */
  | 'missing'
  /** A token is installed but does not verify. */
  | 'invalid'

export interface LicenceStatus {
  readonly standing: LicenceStanding
  readonly claims?: LicenceClaims
  /** Why grace is running, when it is. */
  readonly problem?: 'expired' | 'revoked' | 'heartbeat'
  /** Days of grace used and available, when grace is running. */
  readonly graceUsedDays?: number
  readonly graceDays?: number
  readonly message: string
}

/**
 * The state machine, as one pure-ish function of (files, clock).
 *
 * Grace starts at the earliest moment anything went wrong — expiry, the
 * revocation, or the last confirmed heartbeat plus the allowed interval —
 * and enforcement begins when that moment is more than `graceDays` ago. The
 * clock is the monotonic one; see clock.ts for what that defeats.
 */
export async function licenceStatus(
  publicKey: KeyObject,
  dir = stateDir(),
): Promise<LicenceStatus> {
  const token = readLicenceToken(dir)
  if (token === undefined) {
    return { standing: 'missing', message: 'No licence is installed.' }
  }

  const verified = await verifyLicence(token, publicKey)
  if (!verified.ok) {
    return { standing: 'invalid', message: verified.message }
  }

  const claims = verified.claims
  const now = observedNow(dir)
  const graceMs = claims.heartbeat.graceDays * DAY_MS

  // An override licence answers to nothing but its own expiry — that is its
  // job — and when it expires there is no grace to run: it *was* the grace.
  if (claims.override) {
    if (now > Date.parse(claims.expiresAt)) {
      return {
        standing: 'enforce',
        claims,
        problem: 'expired',
        message: 'The override licence has expired.',
      }
    }
    return { standing: 'ok', claims, message: 'Running on an override licence.' }
  }

  const heartbeat = readHeartbeat(dir)
  const problems: { problem: 'expired' | 'revoked' | 'heartbeat'; since: number }[] = []

  if (now > Date.parse(claims.expiresAt)) {
    problems.push({ problem: 'expired', since: Date.parse(claims.expiresAt) })
  }
  if (heartbeat.revokedAt > 0) {
    problems.push({ problem: 'revoked', since: heartbeat.revokedAt })
  }

  // The heartbeat clock starts at the licence's issue when none has ever
  // succeeded — a box that never once reached the service is not a box with
  // an unrevokable licence.
  const heartbeatBasis = Math.max(heartbeat.lastSuccessAt, Date.parse(claims.issuedAt))
  const heartbeatDue = heartbeatBasis + claims.heartbeat.intervalHours * HOUR_MS
  if (now > heartbeatDue) {
    problems.push({ problem: 'heartbeat', since: heartbeatDue })
  }

  if (problems.length === 0) {
    return { standing: 'ok', claims, message: 'Licensed.' }
  }

  const earliest = problems.reduce((a, b) => (a.since <= b.since ? a : b))
  const graceUsedDays = Math.floor((now - earliest.since) / DAY_MS)

  if (now - earliest.since > graceMs) {
    return {
      standing: 'enforce',
      claims,
      problem: earliest.problem,
      graceUsedDays,
      graceDays: claims.heartbeat.graceDays,
      message: describeProblem(earliest.problem, claims.heartbeat.graceDays, graceUsedDays, true),
    }
  }

  return {
    standing: 'grace',
    claims,
    problem: earliest.problem,
    graceUsedDays,
    graceDays: claims.heartbeat.graceDays,
    message: describeProblem(earliest.problem, claims.heartbeat.graceDays, graceUsedDays, false),
  }
}

function describeProblem(
  problem: 'expired' | 'revoked' | 'heartbeat',
  graceDays: number,
  usedDays: number,
  exhausted: boolean,
): string {
  const cause = {
    expired: 'The licence has expired.',
    revoked: 'The licence has been revoked.',
    heartbeat: 'The licence service has not been reachable.',
  }[problem]
  if (exhausted) {
    return `${cause} The ${graceDays}-day grace period has been used. The system will be stopped.`
  }
  const left = Math.max(0, graceDays - usedDays)
  return `${cause} ${left} day${left === 1 ? '' : 's'} of grace remain${left === 1 ? 's' : ''}.`
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
