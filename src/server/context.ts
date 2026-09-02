import type { AuditLog } from './audit.js'
import type { AuthStore } from './auth.js'
import type { GuardConfig } from './guards.js'

/** What every route gets. Constructed once in buildServer. */
export interface ServerContext {
  /** The state directory everything in this server reads and writes. */
  readonly dir: string
  readonly auth: AuthStore
  readonly audit: AuditLog
  readonly guard: GuardConfig
  /** The engine's own version, from its package. */
  readonly engineVersion: string
}
