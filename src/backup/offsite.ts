import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonFile, writeJsonAtomic } from '../lib/json-files.js'
import { loadSecrets, loadState, stateDir } from '../state/store.js'
import { offsiteStore, type OffsiteStore } from './store.js'
import { BACKUPS_DIR, listBackups } from './service.js'

/**
 * The offsite copy: every backup set, again, somewhere that is not this box.
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

const OFFSITE_FILE = 'offsite.json'

/**
 * The two things the store holds, kept apart.
 *
 * A backup set is a moment; a document is a file that outlives every moment
 * that mentions it. They were both at the root, which worked only because
 * `listRemote` filtered the top level by the timestamp pattern and quietly
 * ignored anything else — a rule nobody reading the bucket could see. Two
 * prefixes say it instead, and listing a set no longer means listing every
 * document to throw them away.
 */
const SETS = 'backups/'
const DOCUMENTS = 'documents/'
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

/**
 * The configured store, or null with the reason the panel should show.
 *
 * The selection moved to `store.ts` when R2 arrived: this module used to build
 * a `DriveClient` itself and speak folders at it, which is why adding a second
 * destination meant a second copy of everything below. It now knows only that
 * something takes a key and some bytes.
 */
export function offsiteClient(
  dir = stateDir(),
  fetcher: typeof fetch = fetch,
): { client: OffsiteStore | null; reason?: string } {
  const { store, reason } = offsiteStore(dir, fetcher)
  return { client: store, ...(reason ? { reason } : {}) }
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
    const setDir = join(dir, BACKUPS_DIR, id)

    for (const name of readdirSync(setDir)) {
      if (name === OFFSITE_FILE) continue
      /*
       * The documents tar stays on the box.
       *
       * It is the whole uploads volume in one file, and sending it would put
       * 11.9 MB of documents in the bucket beside the same documents already
       * there one-by-one -- the duplication this phase exists to end, with the
       * extra insult of paying for it twice a day. Offsite gets the
       * incrementals under `documents/`; the tar is a local convenience while
       * it lasts, and `documents.index.json` is what a fetched set restores
       * from.
       */
      if (name === 'uploads.tar.gz') continue
      const local = join(setDir, name)
      const { statSync } = await import('node:fs')
      const size = statSync(local).size
      const key = `${SETS}${id}/${name}`

      /*
       * Skip what is already there at the same size. A retry after a partial
       * upload should not pay again for the parts that landed -- and on a
       * metered connection in an office, that is the difference between a
       * retry and an evening.
       */
      const existing = await client.stat(key)
      if (existing && existing.size === size) continue

      const mime = name.endsWith('.json') ? 'application/json' : 'application/gzip'
      await client.put(key, local, mime)
    }

    writeOffsite(id, { uploadedAt: new Date().toISOString(), attempts: record.attempts + 1, lastError: '' }, dir)
    return { ok: true, detail: `Backup ${id} copied to ${client.label}.` }
  } catch (error) {
    const detail = (error as Error).message.slice(0, 300)
    writeOffsite(id, { ...record, attempts: record.attempts + 1, lastError: detail }, dir)
    return { ok: false, detail }
  }
}

/**
 * Believe the bucket, not the note we wrote about it.
 *
 * `offsite.json` records that a set went out. Nothing re-checks it, so anything
 * that removes an object afterwards — a person tidying the bucket, a lifecycle
 * rule, a mistake — leaves a local file claiming a copy exists where none does,
 * and `pendingOffsite` will never offer it again. The deployment reports itself
 * safe and is not.
 *
 * That is the shape of nearly every failure this system has had: a record that
 * asserts a safety property, trusted over the thing it describes. The manifest
 * that stopped the schedule, the health check that stayed green while backups
 * were dead, a size read from a header that was not there. The answer is the
 * same each time — ask the thing itself.
 *
 * One list per call, and only ever *clears* a claim. A list that fails changes
 * nothing: if the bucket is unreachable, "I could not see it" must never be
 * recorded as "it is not there", or an outage would mark the whole archive for
 * re-upload.
 */
export async function reconcileOffsite(
  dir = stateDir(),
  fetcher: typeof fetch = fetch,
): Promise<{ checked: number; corrected: string[] }> {
  const { client } = offsiteClient(dir, fetcher)
  if (!client) return { checked: 0, corrected: [] }

  let present: Set<string>
  try {
    present = new Set(
      (await client.list(SETS))
        .map((object) => object.key.slice(SETS.length).split('/')[0] ?? '')
        .filter((id) => ID_PATTERN.test(id)),
    )
  } catch {
    return { checked: 0, corrected: [] }
  }

  const corrected: string[] = []
  const sets = listBackups(dir)
  for (const set of sets) {
    const record = readOffsite(set.id, dir)
    if (!record.uploadedAt) continue
    if (present.has(set.id)) continue
    writeOffsite(set.id, { uploadedAt: '', attempts: 0, lastError: 'Not in the store; queued again.' }, dir)
    corrected.push(set.id)
  }
  return { checked: sets.length, corrected }
}

/**
 * The next set to send: the newest if it has not gone, otherwise the oldest
 * that has not.
 *
 * The newest comes first because it is the one worth having — a copy of last
 * hour beats a copy of last Tuesday, and if only one upload succeeds before the
 * connection goes, that is the one to have spent it on.
 *
 * The backlog behind it used to be unreachable. This returned the newest or
 * nothing, so a deployment that turned offsite on, or had it fail for a
 * fortnight, uploaded only what it took from that moment and left every earlier
 * set on the box for ever. Staging had fourteen of them: Drive had been
 * refusing every upload since 2 September, and when it was pointed at R2
 * instead, thirteen of those sets were still never going to be copied anywhere.
 *
 * Oldest-first for the backlog, so it drains in the order it accumulated and a
 * set cannot be skipped past indefinitely. One per tick, which at five-minute
 * ticks clears a fortnight's backlog in an afternoon without ever competing
 * with the set that matters most.
 */
export function pendingOffsite(dir = stateDir()): string | undefined {
  if (!loadState(dir).settings.backupOffsiteEnabled) return undefined
  const sets = listBackups(dir)
  if (sets.length === 0) return undefined

  const unsent = (id: string): boolean => !readOffsite(id, dir).uploadedAt
  if (unsent(sets[0]!.id)) return sets[0]!.id

  // `listBackups` is newest-first, so the last unsent is the oldest.
  for (let index = sets.length - 1; index > 0; index -= 1) {
    if (unsent(sets[index]!.id)) return sets[index]!.id
  }
  return undefined
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
    const localIds = new Set(listBackups(dir).map((set) => set.id))
    const objects = await client.list(SETS)

    /* Keys are `backups/<set id>/<file>`, so the sets are the first segments. */
    const bySet = new Map<string, { files: number; bytes: number }>()
    for (const object of objects) {
      const id = object.key.slice(SETS.length).split('/')[0] ?? ''
      if (!ID_PATTERN.test(id)) continue
      const entry = bySet.get(id) ?? { files: 0, bytes: 0 }
      entry.files += 1
      entry.bytes += object.size
      bySet.set(id, entry)
    }

    const sets: RemoteSet[] = [...bySet.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([name, entry]) => ({ name, files: entry.files, bytes: entry.bytes, local: localIds.has(name) }))
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
    const objects = await client.list(`${SETS}${name}/`)
    if (objects.length === 0) return { ok: false, detail: `No backup named ${name} in ${client.label}.` }

    const setDir = join(dir, BACKUPS_DIR, name)
    mkdirSync(setDir, { recursive: true })
    for (const object of objects) {
      const file = object.key.slice(SETS.length + name.length + 1)
      if (!file || file.includes('/')) continue
      await client.get(object.key, join(setDir, file))
    }
    if (!existsSync(join(setDir, 'manifest.json'))) {
      return { ok: false, detail: `The set came down without its manifest; it will not list.` }
    }
    writeOffsite(name, { uploadedAt: new Date().toISOString(), attempts: 0, lastError: '' }, dir)
    return { ok: true, detail: `Backup ${name} brought back from ${client.label}.` }
  } catch (error) {
    return { ok: false, detail: (error as Error).message.slice(0, 300) }
  }
}
