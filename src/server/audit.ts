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

/**
 * What the engine can record.
 *
 * The log is append-only history and older files on real boxes contain names no
 * longer in this union — `setup`, `password-changed` and `login-locked` were
 * emitted while the panel had an operator password, removed on 2026-09-12. They
 * still read back fine; they simply cannot be written again. Keeping the union
 * to what can actually happen is what makes it useful as a list of what the
 * engine does.
 */
export type AuditEvent =
  | 'login'
  | 'login-failed'
  | 'logout'
  | 'service-start'
  | 'service-stop'
  | 'service-restart'
  | 'settings-changed'
  | 'registry-changed'
  | 'version-set'
  | 'module-enabled'
  | 'module-disabled'
  | 'module-configured'
  | 'module-secret-set'
  | 'deploy-started'
  | 'engine-update-started'
  /*
   * The backup system saying something about itself.
   *
   * `backup-stale` exists because its absence was the bug: a firm's backups
   * stopped for three days and the trail held five `backup-taken` events and no
   * failures, because nothing failed -- the schedule stopped being asked. A
   * record of "nothing was taken and that is wrong" is the line that would have
   * shown it.
   */
  | 'offsite-drift'
  | 'documents-synced'
  | 'documents-sync-failed'
  | 'backup-stale'
  | 'alert-sent'
  | 'backup-taken'
  | 'backup-failed'
  | 'backup-deleted'
  | 'restore-started'
  | 'restore-completed'
  | 'restore-failed'
  | 'offsite-uploaded'
  | 'offsite-failed'
  | 'offsite-fetched'
  /* The engine's own state, encrypted, in the bucket — the file that turns a
   * restored database back into a deployment. */
  | 'snapshot-copied'
  | 'snapshot-failed'
  | 'recovered'

export interface AuditEntry {
  readonly at: string
  readonly event: AuditEvent
  /** e.g. the service acted on. Small, structured, never free text from a request. */
  readonly detail?: string
  readonly address?: string
  /**
   * Who did it, when the engine knows.
   *
   * Every entry used to read "the operator", because one shared password could
   * not tell anybody apart. Entra sign-in can: this carries the UPN, falling
   * back to the immutable object id. A firm asked "who restarted the system on
   * the 14th" can now be answered with a name rather than a shrug.
   *
   * Absent for a password sign-in and for anything the scheduler did on its
   * own, which is honest — those genuinely have no person behind them.
   */
  readonly subject?: string
}

export class AuditLog {
  constructor(private readonly dir = stateDir()) {}

  record(event: AuditEvent, fields: { detail?: string; address?: string; subject?: string } = {}): void {
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
