import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as docker from '../docker/index.js'
import { readJsonFile, writeJsonAtomic } from '../lib/json-files.js'
import { loadSecrets, loadState, stateDir } from '../state/store.js'

/**
 * Backups: a nightly set on the engine's own volume, and the way back.
 *
 * A set is a directory named by its moment — `2026-09-02T19-30-00Z` — holding
 * a verified `database.sql.gz`, optionally `uploads.tar.gz`, and a manifest.
 * The name is the identity: it sorts, it says when, and it is the one thing a
 * firm recovering from the offsite copy must not rename.
 *
 * Everything here shells out to helper containers over whole files. Nothing
 * selects rows; the engine still holds no SQL connection.
 */

export const BACKUPS_DIR = 'backups'

/** ids are timestamps and nothing else; anything else never reaches a path. */
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/

export interface BackupManifest {
  readonly takenAt: string
  readonly trigger: 'manual' | 'scheduled' | 'pre-update' | 'pre-restore'
  readonly appVersion: string
  readonly includesUploads: boolean
  readonly databaseBytes: number
  readonly uploadsBytes: number
}

export interface BackupSet extends BackupManifest {
  readonly id: string
}

export function newBackupId(at = new Date()): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-')
}

function backupsRoot(dir: string): string {
  return join(dir, BACKUPS_DIR)
}

/** The path a helper container sees; the engine volume mounts at /state there. */
function containerPath(id: string, file: string): string {
  return `/state/${BACKUPS_DIR}/${id}/${file}`
}

/**
 * A manifest is only a manifest if it says when.
 *
 * "Is this an object" used to be the whole test, and an object is what a
 * hand-written file is. On the firm's box somebody dropped a set in by hand
 * with `{"taken":"manual, after the 1.8.0 deploy","version":"1.8.0"}` beside
 * it — plausible, readable, and not this shape. `listBackups` accepted it, its
 * `takenAt` was `undefined`, `newestBackupAt` returned `Date.parse(undefined)`
 * — **NaN** — and every comparison in `backupDue` is false against NaN. The
 * scheduled backup stopped that day and would never have resumed. Three days
 * passed before anyone looked.
 *
 * So the gate is the field the schedule depends on, and nothing else about the
 * manifest is trusted to be there either.
 */
function readManifest(dir: string, id: string): BackupManifest | null {
  const raw = readJsonFile(join(backupsRoot(dir), id, 'manifest.json'), { lenient: true })
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<BackupManifest>
  if (typeof candidate.takenAt !== 'string' || !Number.isFinite(Date.parse(candidate.takenAt))) {
    return null
  }
  return {
    takenAt: candidate.takenAt,
    trigger: candidate.trigger ?? 'manual',
    appVersion: candidate.appVersion ?? 'unknown',
    includesUploads: candidate.includesUploads === true,
    databaseBytes: Number(candidate.databaseBytes) || 0,
    uploadsBytes: Number(candidate.uploadsBytes) || 0,
  }
}

export function listBackups(dir = stateDir()): BackupSet[] {
  let names: string[]
  try {
    names = readdirSync(backupsRoot(dir))
  } catch {
    return []
  }
  const sets: BackupSet[] = []
  for (const id of names.filter((name) => ID_PATTERN.test(name)).sort().reverse()) {
    const manifest = readManifest(dir, id)
    if (manifest) sets.push({ id, ...manifest })
  }
  return sets
}

/**
 * When the newest set was taken, or `undefined` — never NaN.
 *
 * `undefined` means "no backup", which every caller already handles as overdue.
 * NaN means the same thing and is handled by nobody, because it compares false
 * against everything. That difference stopped a firm's backups for three days.
 */
export function newestBackupAt(dir = stateDir()): number | undefined {
  const [newest] = listBackups(dir)
  if (!newest) return undefined
  const at = Date.parse(newest.takenAt)
  return Number.isFinite(at) ? at : undefined
}

/**
 * The newest set that also carries the documents.
 *
 * The daily set and the hourly one are both backups, so "when did we last back
 * up" is two questions now. Answering only the first would let a run of hourly
 * snapshots hold the daily one off indefinitely, and the documents would stop
 * being copied on a box that looked like it was backing up every hour.
 */
export function newestFullBackupAt(dir = stateDir()): number | undefined {
  const full = listBackups(dir).find((set) => set.includesUploads)
  if (!full) return undefined
  const at = Date.parse(full.takenAt)
  return Number.isFinite(at) ? at : undefined
}

export interface BackupOutcome {
  readonly ok: boolean
  readonly id?: string
  readonly detail: string
}

/**
 * Take a set. The manifest is written last, so a set without one is a set
 * that did not finish — the lister ignores it and the pruner sweeps it.
 */
export async function takeBackup(
  trigger: BackupManifest['trigger'],
  dir = stateDir(),
  /*
   * 'database' skips the documents tar. The hourly snapshot is the database
   * alone -- 142 KB against 11.9 MB, and the documents rarely change -- so a
   * caller that wants a cheap, frequent copy asks for one rather than paying
   * for a tar of the archive every hour.
   */
  kind: 'database' | 'full' = 'full',
): Promise<BackupOutcome> {
  const state = loadState(dir)
  const secrets = loadSecrets(dir)
  const password = secrets['DB_PASSWORD']
  if (!password) {
    return { ok: false, detail: 'No DB_PASSWORD is stored; there is no database to back up yet.' }
  }

  const id = newBackupId()
  const setDir = join(backupsRoot(dir), id)
  mkdirSync(setDir, { recursive: true })

  const target = { dbName: state.settings.dbName, dbUser: state.settings.dbUser, password }
  const dump = await docker.dumpDatabase(target, containerPath(id, 'database.sql.gz'))
  if (dump.code !== 0) {
    rmSync(setDir, { recursive: true, force: true })
    return { ok: false, detail: `Database dump failed: ${(dump.stderr || 'unknown').trim()}` }
  }

  let uploadsBytes = 0
  const includeUploads = kind === 'full' && state.settings.backupIncludeUploads
  if (includeUploads) {
    const archive = await docker.archiveUploads(containerPath(id, 'uploads.tar.gz'))
    if (archive.code !== 0) {
      rmSync(setDir, { recursive: true, force: true })
      return { ok: false, detail: `Documents archive failed: ${(archive.stderr || 'unknown').trim()}` }
    }
    uploadsBytes = sizeOf(join(setDir, 'uploads.tar.gz'))
  }

  /*
   * What documents existed when this set was taken, so a restore of it can be
   * faithful to that moment rather than pairing an old database with today's
   * files. Best effort: a set whose index could not be written is still a set,
   * and the database is the half that cannot be re-derived.
   */
  try {
    const { listDocuments, writeDocumentIndex } = await import('./documents.js')
    writeDocumentIndex(setDir, await listDocuments())
  } catch {
    /* No index. `restore` falls back to everything offsite, and says so. */
  }

  const manifest: BackupManifest = {
    takenAt: new Date().toISOString(),
    trigger,
    appVersion: state.version,
    includesUploads: includeUploads,
    databaseBytes: sizeOf(join(setDir, 'database.sql.gz')),
    uploadsBytes,
  }
  writeJsonAtomic(join(setDir, 'manifest.json'), manifest)

  pruneBackups(dir)
  return { ok: true, id, detail: `Backup ${id} taken and verified.` }
}

/** Sets are dense near today and sparse behind it. */
const DENSE_HOURS = 48
const MONTHLY_MONTHS = 12

/** `2026-09-11`, `2026-09`, in the deployment's own reckoning (UTC ids). */
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)
const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7)

/**
 * Which sets survive, and it is a shape rather than a cutoff.
 *
 * A flat "older than N days" was right when a set was taken once a night. With
 * an hourly snapshot it would hold 720 of them for a month — every one a
 * directory, and every one an upload to the firm's bucket — to answer a question
 * nobody asks about 3am six days ago.
 *
 * So: everything for two days, then one a day, then one a month. On the firm's
 * measured numbers that steadies at about ninety sets and thirteen megabytes,
 * while making "restore to an hour ago" and "what did this look like in March"
 * both true. The daily and monthly keepers are the **oldest** set in their
 * period, not the newest, because the useful copy of a day is the one taken
 * before that day's work rather than after it.
 *
 * The newest three stay whatever their age — a box that was off for two months
 * should not wake up, prune everything, and then fail its next dump with no set
 * left at all. Unfinished sets (no manifest) are swept here too.
 */
export function keptBackupIds(sets: readonly BackupSet[], now: number, retentionDays: number): Set<string> {
  const keep = new Set<string>()
  // Newest first, as `listBackups` returns them.
  for (const set of sets.slice(0, 3)) keep.add(set.id)

  const dense = now - DENSE_HOURS * 60 * 60 * 1000
  const daily = now - retentionDays * 24 * 60 * 60 * 1000
  const monthly = now - MONTHLY_MONTHS * 31 * 24 * 60 * 60 * 1000
  const dayKeeper = new Map<string, string>()
  const monthKeeper = new Map<string, string>()

  for (const set of sets) {
    const at = Date.parse(set.takenAt)
    if (!Number.isFinite(at)) continue
    if (at >= dense) {
      keep.add(set.id)
      continue
    }
    // Later entries are older, so the last one written wins — the oldest in
    // the period, which is the copy taken before that period's work.
    if (at >= daily) dayKeeper.set(dayOf(at), set.id)
    if (at >= monthly) monthKeeper.set(monthOf(at), set.id)
  }
  for (const id of dayKeeper.values()) keep.add(id)
  for (const id of monthKeeper.values()) keep.add(id)
  return keep
}

export function pruneBackups(dir = stateDir()): string[] {
  const state = loadState(dir)
  const removed: string[] = []

  const sets = listBackups(dir)
  const keep = keptBackupIds(sets, Date.now(), state.settings.backupRetentionDays)
  for (const set of sets) {
    if (!keep.has(set.id)) {
      rmSync(join(backupsRoot(dir), set.id), { recursive: true, force: true })
      removed.push(set.id)
    }
  }

  // Unfinished directories: a valid name with no manifest.
  try {
    for (const name of readdirSync(backupsRoot(dir))) {
      if (!ID_PATTERN.test(name)) continue
      if (!sets.some((set) => set.id === name)) {
        try {
          readFileSync(join(backupsRoot(dir), name, 'manifest.json'))
        } catch {
          // Only sweep once it is old enough that it cannot be one mid-take.
          const age = Date.now() - (statSync(join(backupsRoot(dir), name)).mtimeMs || 0)
          if (age > 6 * 60 * 60 * 1000) {
            rmSync(join(backupsRoot(dir), name), { recursive: true, force: true })
            removed.push(name)
          }
        }
      }
    }
  } catch {
    /* nothing to sweep */
  }
  return removed
}

export interface RestoreStep {
  readonly step: string
  readonly ok: boolean
  readonly detail?: string
}

/**
 * Restore a set, end to end, without a terminal:
 *
 *   safety backup → stop app and nginx → replay the dump → put the documents
 *   back → start app and nginx
 *
 * The safety backup is the way back from the restore itself. The application
 * is stopped because replaying a dump under a live schema is a corruption
 * with extra steps; Postgres stays up because it is the thing being written
 * to. A failure stops the sequence where it stands and reports every step —
 * the operator sees exactly how far it got.
 */
export async function restoreBackup(
  id: string,
  dir = stateDir(),
): Promise<{ ok: boolean; steps: RestoreStep[] }> {
  const steps: RestoreStep[] = []
  const fail = (step: string, detail: string) => {
    steps.push({ step, ok: false, detail })
    return { ok: false, steps }
  }

  if (!ID_PATTERN.test(id)) return fail('resolve', 'That is not a backup id.')
  const set = listBackups(dir).find((candidate) => candidate.id === id)
  if (!set) return fail('resolve', `No backup named ${id}.`)

  const state = loadState(dir)
  const secrets = loadSecrets(dir)
  const password = secrets['DB_PASSWORD']
  if (!password) return fail('resolve', 'No DB_PASSWORD is stored.')
  const target = { dbName: state.settings.dbName, dbUser: state.settings.dbUser, password }

  const safety = await takeBackup('pre-restore', dir)
  steps.push({ step: 'safety-backup', ok: safety.ok, ...(safety.ok ? { detail: safety.id! } : { detail: safety.detail }) })
  if (!safety.ok) return { ok: false, steps }

  const stopped = await docker.stop(['app', 'nginx'])
  steps.push({ step: 'stop-application', ok: stopped.code === 0 })
  if (stopped.code !== 0) return { ok: false, steps }

  const replay = await docker.restoreDatabase(target, containerPath(id, 'database.sql.gz'))
  steps.push({
    step: 'restore-database',
    ok: replay.code === 0,
    ...(replay.code === 0 ? {} : { detail: (replay.stderr || 'unknown').trim().slice(-500) }),
  })
  if (replay.code !== 0) return { ok: false, steps }

  /*
   * Documents come from the tar when this set has one, and from the bucket when
   * it does not.
   *
   * A set fetched from offsite never has a tar: it is the whole uploads volume
   * in one file, and sending it would duplicate every document already in the
   * bucket one-by-one. So a rebuilt machine restores its documents by name from
   * `documents.index.json` -- which is also what makes the restore faithful to
   * the moment rather than pairing an old database with every file written
   * since.
   *
   * The tar is preferred where it exists because it is local, needs no network,
   * and is one extraction rather than N fetches. It is also, for now, the only
   * copy on a box with no offsite configured.
   */
  const tarPath = join(backupsRoot(dir), id, 'uploads.tar.gz')
  if (set.includesUploads && existsSync(tarPath)) {
    const extract = await docker.restoreUploads(containerPath(id, 'uploads.tar.gz'))
    steps.push({ step: 'restore-documents', ok: extract.code === 0, detail: 'from this set\'s archive' })
    if (extract.code !== 0) return { ok: false, steps }
  } else {
    const { restoreDocuments } = await import('./documents.js')
    const restored = await restoreDocuments(join(backupsRoot(dir), id), dir)
    steps.push({ step: 'restore-documents', ok: restored.ok, detail: restored.detail })
    /*
     * Not fatal. The database is the half that cannot be re-derived, and it is
     * already back; stopping here would leave the application down over
     * documents that can be fetched again once the reason is fixed. The step
     * says what happened and the caller can see it failed.
     */
  }

  const started = await docker.start(['app', 'nginx'])
  steps.push({ step: 'start-application', ok: started.code === 0 })
  return { ok: started.code === 0, steps }
}

export function deleteBackup(id: string, dir = stateDir()): boolean {
  if (!ID_PATTERN.test(id)) return false
  rmSync(join(backupsRoot(dir), id), { recursive: true, force: true })
  return true
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
