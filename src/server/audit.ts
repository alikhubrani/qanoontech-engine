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
 * What an entry is *for*, decided once, here.
 *
 * The trail is complete and stays complete; this is how a screen decides what
 * to lead with. On the staging box 135 of 166 lines in a day were the same
 * routine copy, and the two sign-ins and the one failure among them were
 * invisible — not because they were missing but because nothing told them
 * apart. `routine` is what the schedule does when it is working; the other
 * three are what somebody did, or what went wrong, and those are what the
 * overview shows.
 */
export type AuditKind = 'security' | 'change' | 'failure' | 'routine'

/**
 * What the engine can record.
 *
 * The log is append-only history and older files on real boxes contain names no
 * longer in this union — `setup`, `password-changed` and `login-locked` were
 * emitted while the panel had an operator password, removed on 2026-09-12, and
 * `snapshot-copied` was emitted until 0.20.0 (see `LEGACY_EVENTS`). They still
 * read back fine; they simply cannot be written again. Keeping the union to
 * what can actually happen is what makes it useful as a list of what the
 * engine does — and `AUDIT_EVENTS` below is keyed by it, so an event added
 * here without a label and a kind is a type error rather than a raw slug on a
 * screen.
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
  /*
   * The engine's own state, encrypted, in the bucket — the file that turns a
   * restored database back into a deployment. Only its failure is an event.
   * `snapshot-copied` used to be one too, and that closed a loop: the snapshot
   * carries the audit tail and is re-sent when the tail changes, so recording
   * the copy changed the tail, which sent the copy, twelve times an hour, for
   * a day, on every box. The marker file records when it was last copied;
   * `recovery status` and the overview read that.
   */
  | 'snapshot-failed'
  | 'recovered'
  /* 0.21: configured from the panel as well as the shell. */
  | 'offsite-changed'
  | 'recovery-passphrase-set'
  | 'backup-drilled'

interface EventDescription {
  readonly label: string
  readonly kind: AuditKind
}

/** Every event the engine writes: what to call it, and what it is for. */
export const AUDIT_EVENTS: Readonly<Record<AuditEvent, EventDescription>> = {
  login: { label: 'Signed in', kind: 'security' },
  'login-failed': { label: 'Sign-in refused', kind: 'security' },
  logout: { label: 'Signed out', kind: 'security' },
  'service-start': { label: 'Service started', kind: 'change' },
  'service-stop': { label: 'Service stopped', kind: 'change' },
  'service-restart': { label: 'Service restarted', kind: 'change' },
  'settings-changed': { label: 'Settings changed', kind: 'change' },
  'registry-changed': { label: 'Registry credential changed', kind: 'change' },
  'version-set': { label: 'Version chosen', kind: 'change' },
  'module-enabled': { label: 'Module enabled', kind: 'change' },
  'module-disabled': { label: 'Module disabled', kind: 'change' },
  'module-configured': { label: 'Module configured', kind: 'change' },
  'module-secret-set': { label: 'Credential stored', kind: 'change' },
  'deploy-started': { label: 'Deploy started', kind: 'change' },
  'engine-update-started': { label: 'Engine update started', kind: 'change' },
  'offsite-drift': { label: 'Offsite copies found missing', kind: 'failure' },
  'documents-synced': { label: 'Documents copied offsite', kind: 'routine' },
  'documents-sync-failed': { label: 'Document copy failed', kind: 'failure' },
  'backup-stale': { label: 'Backups have stopped', kind: 'failure' },
  'alert-sent': { label: 'Alert sent', kind: 'failure' },
  'backup-taken': { label: 'Backup taken', kind: 'routine' },
  'backup-failed': { label: 'Backup failed', kind: 'failure' },
  'backup-deleted': { label: 'Backup deleted', kind: 'change' },
  'restore-started': { label: 'Restore started', kind: 'change' },
  'restore-completed': { label: 'Restore completed', kind: 'change' },
  'restore-failed': { label: 'Restore failed', kind: 'failure' },
  'offsite-uploaded': { label: 'Backup copied offsite', kind: 'routine' },
  'offsite-failed': { label: 'Offsite copy failed', kind: 'failure' },
  'offsite-fetched': { label: 'Backup brought back from offsite', kind: 'change' },
  'snapshot-failed': { label: 'Engine snapshot failed', kind: 'failure' },
  recovered: { label: 'Deployment recovered', kind: 'change' },
  'offsite-changed': { label: 'Offsite storage changed', kind: 'change' },
  'recovery-passphrase-set': { label: 'Recovery passphrase set', kind: 'security' },
  'backup-drilled': { label: 'Backup drilled', kind: 'routine' },
}

/**
 * Names that exist in trails on real boxes and can no longer be written.
 * Described so that history reads as history, not as raw slugs.
 */
const LEGACY_EVENTS: Readonly<Record<string, EventDescription>> = {
  setup: { label: 'Panel set up', kind: 'security' },
  'password-changed': { label: 'Password changed', kind: 'security' },
  'login-locked': { label: 'Sign-in locked after repeated failures', kind: 'security' },
  'snapshot-copied': { label: 'Engine state copied offsite', kind: 'routine' },
  'licence-installed': { label: 'Licence installed', kind: 'change' },
  'licence-refreshed': { label: 'Licence refreshed', kind: 'routine' },
  'licence-expired': { label: 'Licence expired', kind: 'failure' },
}

/**
 * What to call an event and where it belongs, for any name the file may hold.
 *
 * An unknown name is shown rather than hidden — `change` is the fallback, not
 * `routine` — because the one way to make a new event disappear from the
 * overview should be to classify it, not to forget to.
 */
export function describeEvent(event: string): EventDescription {
  return (
    (AUDIT_EVENTS as Readonly<Record<string, EventDescription>>)[event] ??
    LEGACY_EVENTS[event] ?? {
      label: event.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      kind: 'change',
    }
  )
}

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
   * Absent for anything the scheduler did on its own, which is honest — those
   * genuinely have no person behind them.
   */
  readonly subject?: string
}

/** An entry as a screen receives it: the file's fields plus their description. */
export interface DescribedEntry extends AuditEntry {
  readonly label: string
  readonly kind: AuditKind
}

export interface RecentOptions {
  readonly limit?: number
  /** Only entries strictly older than this ISO timestamp — the page after one. */
  readonly before?: string
  /** Only these kinds. Absent means all. */
  readonly kinds?: readonly AuditKind[]
}

export class AuditLog {
  constructor(private readonly dir = stateDir()) {}

  record(event: AuditEvent, fields: { detail?: string; address?: string; subject?: string } = {}): void {
    const entry: AuditEntry = { at: new Date().toISOString(), event, ...fields }
    const path = join(this.dir, AUDIT_FILE)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 })
  }

  /** The most recent entries, newest first, each carrying its description. */
  recent(options: RecentOptions | number = {}): DescribedEntry[] {
    const { limit = 50, before, kinds } = typeof options === 'number' ? { limit: options } : options
    let text: string
    try {
      text = readFileSync(join(this.dir, AUDIT_FILE), 'utf8')
    } catch {
      return []
    }
    const lines = text.trim().split('\n')
    const wanted = kinds ? new Set(kinds) : undefined
    const entries: DescribedEntry[] = []
    // Read from the end; a malformed line is skipped rather than fatal, since
    // an audit log that cannot be read is worse than one with a bad line.
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      let entry: AuditEntry
      try {
        entry = JSON.parse(lines[i]!) as AuditEntry
      } catch {
        continue
      }
      if (before !== undefined && !(entry.at < before)) continue
      const description = describeEvent(entry.event)
      if (wanted && !wanted.has(description.kind)) continue
      entries.push({ ...entry, ...description })
    }
    return entries
  }
}
