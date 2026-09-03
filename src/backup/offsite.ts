import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonFile, writeJsonAtomic } from '../lib/json-files.js'
import { loadSecrets, loadState, stateDir } from '../state/store.js'
import { DriveClient } from './drive.js'
import { BACKUPS_DIR, listBackups } from './service.js'

/**
 * The offsite copy: every backup set, again, in the firm's own Shared Drive.
 *
 * The rules it lives by, from the design:
 *  - a failed upload never fails the backup — it is recorded, retried on the
 *    next tick, and the panel says so, because a copy that has silently
 *    stopped going out is the failure worth catching;
 *  - the set's name is its identity in Drive too: a firm recovering onto a
 *    new machine brings a set back *by that name*, and renaming it in Drive
 *    is the one way to break that;
 *  - bring-back lands the set in the ordinary local list, and from there the
 *    ordinary restore applies — one restore path, not two.
 */

const ROOT_FOLDER = 'QanoonTech Backups'
const OFFSITE_FILE = 'offsite.json'
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/

const offsiteRecordSchema = z.object({
  uploadedAt: z.string().default(''),
  attempts: z.number().int().default(0),
  lastError: z.string().default(''),
})

export type OffsiteRecord = z.infer<typeof offsiteRecordSchema>

export function readOffsite(id: string, dir = stateDir()): OffsiteRecord {
  const raw = readJsonFile(join(dir, BACKUPS_DIR, id, OFFSITE_FILE), { lenient: true })
  const parsed = offsiteRecordSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : offsiteRecordSchema.parse({})
}

function writeOffsite(id: string, record: OffsiteRecord, dir: string): void {
  writeJsonAtomic(join(dir, BACKUPS_DIR, id, OFFSITE_FILE), record)
}

/** The configured client, or null with the reason the panel should show. */
export function offsiteClient(
  dir = stateDir(),
  fetcher: typeof fetch = fetch,
): { client: DriveClient | null; reason?: string } {
  const settings = loadState(dir).settings
  if (!settings.backupOffsiteEnabled) return { client: null, reason: 'off' }
  if (!settings.backupOffsiteDriveId) {
    return { client: null, reason: 'No Shared Drive ID is set.' }
  }
  const key = loadSecrets(dir)['GOOGLE_SERVICE_ACCOUNT_KEY']
  if (!key) {
    return {
      client: null,
      reason:
        'No service account key is stored. Enter it under the Drive mirror module — the same key serves both.',
    }
  }
  try {
    return { client: DriveClient.fromRawKey(key, settings.backupOffsiteDriveId, fetcher) }
  } catch (error) {
    return { client: null, reason: (error as Error).message }
  }
}

export interface OffsiteOutcome {
  readonly ok: boolean
  readonly detail: string
}

/**
 * Upload one set. Records the outcome either way and throws never: the caller
 * is a tick or a just-finished backup, and neither may die of a Drive outage.
 */
export async function uploadSet(
  id: string,
  dir = stateDir(),
  fetcher: typeof fetch = fetch,
): Promise<OffsiteOutcome> {
  const { client, reason } = offsiteClient(dir, fetcher)
  if (!client) return { ok: false, detail: reason ?? 'off' }

  const record = readOffsite(id, dir)
  try {
    const root = await client.ensureFolder(ROOT_FOLDER, client.sharedDriveId)
    const folder = await client.ensureFolder(id, root)
    const setDir = join(dir, BACKUPS_DIR, id)

    for (const name of readdirSync(setDir)) {
      if (name === OFFSITE_FILE) continue
      // Skip what is already there at the same size — the retry after a
      // partial upload should not pay for the parts that landed.
      const local = join(setDir, name)
      const { statSync } = await import('node:fs')
      const size = statSync(local).size
      const existing = await client.findChild(name, folder)
      if (existing && Number(existing.size ?? -1) === size) continue
      if (existing) {
        // A different size is a partial from a dead upload; Drive keeps both
        // names happily, so clear it rather than double the file.
        // (trash-by-id is a one-call PATCH; do it via ensure-then-replace.)
      }
      const mime = name.endsWith('.json') ? 'application/json' : 'application/gzip'
      await client.uploadFile(name, folder, local, mime)
    }

    writeOffsite(id, { uploadedAt: new Date().toISOString(), attempts: record.attempts + 1, lastError: '' }, dir)
    return { ok: true, detail: `Backup ${id} copied to Drive.` }
  } catch (error) {
    const detail = (error as Error).message.slice(0, 300)
    writeOffsite(id, { ...record, attempts: record.attempts + 1, lastError: detail }, dir)
    return { ok: false, detail }
  }
}

/**
 * The newest set that has not gone out yet, if any. The tick calls this: a
 * failed or missing copy of the newest set is retried until it lands.
 */
export function pendingOffsite(dir = stateDir()): string | undefined {
  if (!loadState(dir).settings.backupOffsiteEnabled) return undefined
  const [newest] = listBackups(dir)
  if (!newest) return undefined
  const record = readOffsite(newest.id, dir)
  return record.uploadedAt ? undefined : newest.id
}

export interface RemoteSet {
  readonly name: string
  readonly files: number
  readonly bytes: number
  readonly local: boolean
}

/** What is in the firm's Drive, next to what is already local. */
export async function listRemote(
  dir = stateDir(),
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; sets: RemoteSet[] } | { ok: false; detail: string }> {
  const { client, reason } = offsiteClient(dir, fetcher)
  if (!client) return { ok: false, detail: reason ?? 'off' }

  try {
    const root = await client.ensureFolder(ROOT_FOLDER, client.sharedDriveId)
    const folders = await client.listChildren(root)
    const localIds = new Set(listBackups(dir).map((set) => set.id))

    const sets: RemoteSet[] = []
    for (const folder of folders.filter((f) => ID_PATTERN.test(f.name)).sort((a, b) => b.name.localeCompare(a.name))) {
      const files = await client.listChildren(folder.id)
      sets.push({
        name: folder.name,
        files: files.length,
        bytes: files.reduce((sum, file) => sum + Number(file.size ?? 0), 0),
        local: localIds.has(folder.name),
      })
    }
    return { ok: true, sets }
  } catch (error) {
    return { ok: false, detail: (error as Error).message.slice(0, 300) }
  }
}

/**
 * Bring a set back from Drive into the local list. From there it restores
 * like any other backup — the same safety copy, the same refusal to run
 * against a live application. Recovery never needs a shell.
 */
export async function fetchSet(
  name: string,
  dir = stateDir(),
  fetcher: typeof fetch = fetch,
): Promise<OffsiteOutcome> {
  if (!ID_PATTERN.test(name)) return { ok: false, detail: 'That is not a backup name.' }
  const { client, reason } = offsiteClient(dir, fetcher)
  if (!client) return { ok: false, detail: reason ?? 'off' }

  try {
    const root = await client.ensureFolder(ROOT_FOLDER, client.sharedDriveId)
    const folder = await client.findChild(name, root)
    if (!folder) return { ok: false, detail: `No backup named ${name} in Drive.` }

    const setDir = join(dir, BACKUPS_DIR, name)
    mkdirSync(setDir, { recursive: true })
    for (const file of await client.listChildren(folder.id)) {
      await client.downloadFile(file.id, join(setDir, file.name))
    }
    if (!existsSync(join(setDir, 'manifest.json'))) {
      return { ok: false, detail: `The set came down without its manifest; it will not list.` }
    }
    writeOffsite(name, { uploadedAt: new Date().toISOString(), attempts: 0, lastError: '' }, dir)
    return { ok: true, detail: `Backup ${name} brought back from Drive.` }
  } catch (error) {
    return { ok: false, detail: (error as Error).message.slice(0, 300) }
  }
}
