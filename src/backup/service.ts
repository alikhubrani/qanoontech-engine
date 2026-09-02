import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
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
 * firm recovering from Drive must not rename.
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

export function listBackups(dir = stateDir()): BackupSet[] {
  let names: string[]
  try {
    names = readdirSync(backupsRoot(dir))
  } catch {
    return []
  }
  const sets: BackupSet[] = []
  for (const id of names.filter((name) => ID_PATTERN.test(name)).sort().reverse()) {
    const manifest = readJsonFile(join(backupsRoot(dir), id, 'manifest.json'), { lenient: true })
    if (manifest && typeof manifest === 'object') {
      sets.push({ id, ...(manifest as BackupManifest) })
    }
  }
  return sets
}

export function newestBackupAt(dir = stateDir()): number | undefined {
  const [newest] = listBackups(dir)
  return newest ? Date.parse(newest.takenAt) : undefined
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
  if (state.settings.backupIncludeUploads) {
    const archive = await docker.archiveUploads(containerPath(id, 'uploads.tar.gz'))
    if (archive.code !== 0) {
      rmSync(setDir, { recursive: true, force: true })
      return { ok: false, detail: `Documents archive failed: ${(archive.stderr || 'unknown').trim()}` }
    }
    uploadsBytes = sizeOf(join(setDir, 'uploads.tar.gz'))
  }

  const manifest: BackupManifest = {
    takenAt: new Date().toISOString(),
    trigger,
    appVersion: state.version,
    includesUploads: state.settings.backupIncludeUploads,
    databaseBytes: sizeOf(join(setDir, 'database.sql.gz')),
    uploadsBytes,
  }
  writeJsonAtomic(join(setDir, 'manifest.json'), manifest)

  pruneBackups(dir)
  return { ok: true, id, detail: `Backup ${id} taken and verified.` }
}

/**
 * Retention: sets older than the configured days go, except that the newest
 * three stay whatever their age — a box that was off for two months should
 * not wake up, prune everything, and then fail its next dump with no set
 * left at all. Unfinished sets (no manifest) are swept here too.
 */
export function pruneBackups(dir = stateDir()): string[] {
  const state = loadState(dir)
  const cutoff = Date.now() - state.settings.backupRetentionDays * 24 * 60 * 60 * 1000
  const removed: string[] = []

  const sets = listBackups(dir)
  for (const set of sets.slice(3)) {
    if (Date.parse(set.takenAt) < cutoff) {
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

  if (set.includesUploads) {
    const extract = await docker.restoreUploads(containerPath(id, 'uploads.tar.gz'))
    steps.push({ step: 'restore-documents', ok: extract.code === 0 })
    if (extract.code !== 0) return { ok: false, steps }
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
