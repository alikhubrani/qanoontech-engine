import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { stateDir } from '../state/store.js'
import { readJsonFile, writeJsonAtomic } from '../lib/json-files.js'

/**
 * One operator, one password, and everything durable.
 *
 * Durability is the point, not a nicety: the engine's container is recreated
 * on every update, so an in-memory failure counter is a lockout that resets
 * whenever the attacker is patient, and an in-memory session table signs the
 * operator out every time the panel updates itself.
 */

// scrypt parameters per OWASP: N=2^17, r=8, p=1.
const SCRYPT = { N: 131072, r: 8, p: 1, keyLength: 64, maxmem: 256 * 1024 * 1024 }

const credentialsSchema = z.object({
  salt: z.string().min(1),
  hash: z.string().min(1),
  updatedAt: z.string(),
})

const throttleSchema = z.object({
  failures: z.number().int().min(0).default(0),
  lockedUntil: z.number().default(0),
})

const sessionSchema = z.object({
  /** sha256 of the token. The cookie value itself is never stored. */
  tokenHash: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
})

export type Session = z.infer<typeof sessionSchema>

const CREDENTIALS_FILE = 'auth.json'
const THROTTLE_FILE = 'throttle.json'
const SESSIONS_FILE = 'sessions.json'

/** Idle and absolute session lifetimes. An administrative console, not a mail client. */
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000
export const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000

/** Failures tolerated before the lockout starts, per OWASP guidance. */
export const LOCKOUT_THRESHOLD = 5
const LOCKOUT_BASE_MS = 10 * 60 * 1000
const LOCKOUT_MAX_MS = 6 * 60 * 60 * 1000

export class AuthStore {
  constructor(private readonly dir = stateDir()) {}

  // -- credentials ----------------------------------------------------------

  isConfigured(): boolean {
    return this.credentials() !== undefined
  }

  /**
   * Set the operator password. Refuses to overwrite one that exists — changing
   * a password requires knowing the current one, and that flow proves it
   * before calling this with `force`.
   */
  setPassword(password: string, options: { force?: boolean } = {}): void {
    if (this.isConfigured() && !options.force) {
      throw new Error('A password is already set.')
    }
    const salt = randomBytes(16).toString('hex')
    const hash = this.derive(password, salt)
    writeJsonAtomic(join(this.dir, CREDENTIALS_FILE), {
      salt,
      hash,
      updatedAt: new Date().toISOString(),
    })
  }

  /**
   * Check a password, counting the attempt against the throttle.
   *
   * The failure counter belongs to the account, not the address: this is a
   * single-operator console behind NAT and a tunnel, where source addresses
   * are both trivially shared and trivially rotated.
   */
  verifyPassword(password: string): { ok: boolean; lockedForMs?: number } {
    const lockedForMs = this.lockedForMs()
    if (lockedForMs > 0) return { ok: false, lockedForMs }

    const credentials = this.credentials()
    if (!credentials) return { ok: false }

    const supplied = Buffer.from(this.derive(password, credentials.salt), 'hex')
    const stored = Buffer.from(credentials.hash, 'hex')
    const ok = supplied.length === stored.length && timingSafeEqual(supplied, stored)

    if (ok) {
      // Reset on success, per OWASP — a legitimate operator who fumbled four
      // times is not four fifths of the way to locking themselves out forever.
      this.writeThrottle({ failures: 0, lockedUntil: 0 })
      return { ok: true }
    }

    const throttle = this.throttle()
    const failures = throttle.failures + 1
    let lockedUntil = throttle.lockedUntil
    if (failures >= LOCKOUT_THRESHOLD) {
      const step = Math.min(
        LOCKOUT_BASE_MS * 2 ** (failures - LOCKOUT_THRESHOLD),
        LOCKOUT_MAX_MS,
      )
      lockedUntil = Date.now() + step
    }
    this.writeThrottle({ failures, lockedUntil })
    return { ok: false, ...(lockedUntil > Date.now() ? { lockedForMs: lockedUntil - Date.now() } : {}) }
  }

  lockedForMs(): number {
    return Math.max(0, this.throttle().lockedUntil - Date.now())
  }

  // -- sessions -------------------------------------------------------------

  /** Create a session; the returned token goes in the cookie and is never stored. */
  createSession(): string {
    const token = randomBytes(32).toString('hex')
    const now = Date.now()
    const sessions = this.liveSessions()
    sessions.push({ tokenHash: hashToken(token), createdAt: now, lastSeenAt: now })
    this.writeSessions(sessions)
    return token
  }

  /** Validate a token, sliding the idle window when it is good. */
  touchSession(token: string): boolean {
    const tokenHash = hashToken(token)
    const sessions = this.liveSessions()
    const session = sessions.find((s) => s.tokenHash === tokenHash)
    if (!session) return false
    session.lastSeenAt = Date.now()
    this.writeSessions(sessions)
    return true
  }

  destroySession(token: string): void {
    const tokenHash = hashToken(token)
    this.writeSessions(this.liveSessions().filter((s) => s.tokenHash !== tokenHash))
  }

  destroyAllSessions(): void {
    this.writeSessions([])
  }

  /** Sessions that have not idled out or exceeded their absolute lifetime. */
  private liveSessions(): Session[] {
    const now = Date.now()
    const raw = readJsonFile(join(this.dir, SESSIONS_FILE), { lenient: true })
    const parsed = z.array(sessionSchema).safeParse(raw ?? [])
    const sessions = parsed.success ? parsed.data : []
    return sessions.filter(
      (s) => now - s.lastSeenAt < SESSION_IDLE_MS && now - s.createdAt < SESSION_ABSOLUTE_MS,
    )
  }

  private writeSessions(sessions: Session[]): void {
    writeJsonAtomic(join(this.dir, SESSIONS_FILE), sessions)
  }

  // -- internals ------------------------------------------------------------

  private credentials(): z.infer<typeof credentialsSchema> | undefined {
    const raw = readJsonFile(join(this.dir, CREDENTIALS_FILE))
    if (raw === undefined) return undefined
    const parsed = credentialsSchema.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }

  private throttle(): z.infer<typeof throttleSchema> {
    const raw = readJsonFile(join(this.dir, THROTTLE_FILE), { lenient: true })
    const parsed = throttleSchema.safeParse(raw ?? {})
    return parsed.success ? parsed.data : { failures: 0, lockedUntil: 0 }
  }

  private writeThrottle(value: z.infer<typeof throttleSchema>): void {
    writeJsonAtomic(join(this.dir, THROTTLE_FILE), value)
  }

  private derive(password: string, salt: string): string {
    return scryptSync(password, Buffer.from(salt, 'hex'), SCRYPT.keyLength, SCRYPT).toString('hex')
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Exposed for the CLI's future `passwd`; not used by routes. */
export function readCredentialsFile(dir = stateDir()): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, CREDENTIALS_FILE), 'utf8'))
  } catch {
    return undefined
  }
}
