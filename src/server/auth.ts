import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { stateDir } from '../state/store.js'
import { readJsonFile, writeJsonAtomic } from '../lib/json-files.js'

/**
 * Sessions, and nothing else.
 *
 * **There is no password.** This class used to hold one — scrypt at OWASP's
 * parameters, a durable lockout, a change-password flow — and it was the
 * weakest thing in the system by some distance: a single static secret, shared
 * by whoever had been told it, with no second factor, no rotation, no
 * revocation and no way to tell two people apart, guarding a panel that can
 * deploy, restore over a live database, and read every credential the
 * deployment holds.
 *
 * Identity is Microsoft Entra's job now (`entra.ts`), which brings MFA,
 * conditional access and central revocation without any of it being built here.
 * What survives is the part Entra does not do: once somebody has been
 * identified, something has to remember it for the next request. That is all
 * this is.
 *
 * No password fallback was kept, deliberately. A fallback nobody uses is the
 * credential nobody rotates and nobody notices leaking, and keeping one would
 * have meant adding a lock beside an unlocked door rather than on it. **The way
 * in when Entra cannot be reached is the CLI**, which authenticates zero times
 * because `docker exec` on the box already means root-equivalent access. That
 * makes one rule load-bearing rather than advisory: no operation may be
 * panel-only. See `docs/operator-sign-in.md`.
 *
 * Durability is still the point: the engine's container is recreated on every
 * update, and an in-memory session table would sign the operator out every time
 * the panel updated itself.
 */

const sessionSchema = z.object({
  /** sha256 of the token. The cookie value itself is never stored. */
  tokenHash: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
})

export type Session = z.infer<typeof sessionSchema>

const SESSIONS_FILE = 'sessions.json'

/**
 * Idle and absolute session lifetimes. An administrative console, not a mail
 * client — and with no password to fall back on, a session that has expired
 * means a round trip to Microsoft, which is the intended cost.
 */
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000
export const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000

export class AuthStore {
  constructor(private readonly dir = stateDir()) {}

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

  /**
   * Sign everyone out everywhere.
   *
   * The engine's half of revocation. Entra can stop *new* sign-ins the moment
   * an account is disabled, but a session already issued here is a cookie on
   * somebody's laptop and Microsoft has no say in it — so revoking access means
   * doing both, and this is the second half.
   */
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
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
