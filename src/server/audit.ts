import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateDir } from '../state/store.js'

/**
 * The audit log: who did what to this deployment, and when.
 *
 * Append-only JSONL on the engine's volume. A law firm gets asked "who
 * restarted the system on the 14th" by its own auditors, and the answer has to
 * come from somewhere better than memory. Every entry is also the operator's
 * own defence: a version chosen on purpose, on the record, is easier to stand
 * behind than a container that changed at 3am.
 *
 * Never logged: passwords, tokens, secrets, or anything from a request body
 * beyond what the named fields carry.
 */

const AUDIT_FILE = 'audit.jsonl'

export type AuditEvent =
  | 'setup'
  | 'login'
  | 'login-failed'
  | 'login-locked'
  | 'logout'
  | 'password-changed'
  | 'service-start'
  | 'service-stop'
  | 'service-restart'
  | 'licence-installed'
  | 'licence-enforced'
  | 'licence-cleared'
  | 'settings-changed'
  | 'registry-changed'
  | 'version-set'
  | 'module-enabled'
  | 'module-disabled'
  | 'module-configured'
  | 'module-secret-set'
  | 'deploy-started'
  | 'engine-update-started'
  | 'backup-taken'
  | 'backup-failed'
  | 'backup-deleted'
  | 'restore-started'
  | 'restore-completed'
  | 'restore-failed'
  | 'offsite-uploaded'
  | 'offsite-failed'
  | 'offsite-fetched'

export interface AuditEntry {
  readonly at: string
  readonly event: AuditEvent
  /** e.g. the service acted on. Small, structured, never free text from a request. */
  readonly detail?: string
  readonly address?: string
}

export class AuditLog {
  constructor(private readonly dir = stateDir()) {}

  record(event: AuditEvent, fields: { detail?: string; address?: string } = {}): void {
    const entry: AuditEntry = { at: new Date().toISOString(), event, ...fields }
    const path = join(this.dir, AUDIT_FILE)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 })
  }

  /** The most recent entries, newest first. */
  recent(limit = 50): AuditEntry[] {
    let text: string
    try {
      text = readFileSync(join(this.dir, AUDIT_FILE), 'utf8')
    } catch {
      return []
    }
    const lines = text.trim().split('\n')
    const entries: AuditEntry[] = []
    // Read from the end; a malformed line is skipped rather than fatal, since
    // an audit log that cannot be read is worse than one with a bad line.
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        entries.push(JSON.parse(lines[i]!) as AuditEntry)
      } catch {
        /* skip */
      }
    }
    return entries
  }
}
