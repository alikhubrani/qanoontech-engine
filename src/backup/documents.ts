import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as docker from '../docker/index.js'
import { stateDir } from '../state/store.js'
import { offsiteStore, type OffsiteStore } from './store.js'

/**
 * Documents go offsite once each, and never again.
 *
 * They used to ride the daily backup set as a tar of the whole uploads volume.
 * That is 11.9 MB on the firm's box and fine; at ten gigabytes it is ten
 * gigabytes *per set*, and with ninety sets retained it is the same unchanged
 * PDF stored ninety times. It fails by becoming slow and expensive, which is
 * the worst way for a backup to fail.
 *
 * Sending each file once works because the store is append-only, and that was
 * established by reading the application rather than assuming it (2026-09-12):
 *
 *  - every stored name is `${randomUUID()}-${basename}`, so a path is unique by
 *    construction and a file is never overwritten in place — a new version is a
 *    new file;
 *  - nothing deletes stored bytes. `permanentlyDeleteFile` exists and has no
 *    callers; `purgeDocument` deletes database rows only; the one live caller of
 *    `storage.delete()` is the cleanup path when generating a document fails.
 *
 * So "have I already sent this path" is a question whose answer cannot go
 * stale. If either of those facts changes, this design has to change with it.
 */

/** Keys live under this prefix, beside `backups/` rather than mixed into it. */
export const DOCUMENTS_PREFIX = 'documents/'

/*
 * How much to move in one tick.
 *
 * A first run on an established box has everything to send, and a tick that
 * tries to stage ten gigabytes onto the engine's own volume would fill it. The
 * batch bounds both the disk used and the time held, and progress carries
 * across ticks: whatever is not sent this time is first in line next time.
 */
const MAX_FILES_PER_TICK = 200
const MAX_BYTES_PER_TICK = 256 * 1024 * 1024

export interface DocumentFile {
  readonly path: string
  readonly size: number
}

/** What is on the uploads volume right now. */
export async function listDocuments(): Promise<DocumentFile[]> {
  const result = await docker.listUploads()
  if (result.code !== 0) {
    throw new Error(`Could not read the uploads volume: ${(result.stderr || '').trim().slice(0, 200)}`)
  }
  const files: DocumentFile[] = []
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const space = trimmed.indexOf(' ')
    if (space <= 0) continue
    const size = Number(trimmed.slice(0, space))
    const path = trimmed.slice(space + 1)
    if (!Number.isFinite(size) || !path) continue
    files.push({ path, size })
  }
  return files
}

export interface SyncOutcome {
  readonly ok: boolean
  /** Files sent this tick. */
  readonly sent: number
  /** Files still to send after this tick. */
  readonly remaining: number
  readonly bytes: number
  readonly detail: string
}

/**
 * Send whatever is not there yet.
 *
 * One `list` of the prefix rather than a `stat` per file: at a thousand objects
 * per request that is one call today and ten at ten thousand files, where
 * per-file checks would be one call *per file per tick* — impossible at any
 * real size. A local ledger would make it zero calls and introduce a file that
 * can disagree with the bucket, which is the wrong trade for something whose
 * whole job is to be believed.
 */
export async function syncDocuments(
  dir = stateDir(),
  store?: OffsiteStore,
): Promise<SyncOutcome> {
  const target = store ?? offsiteStore(dir).store
  if (!target) return { ok: false, sent: 0, remaining: 0, bytes: 0, detail: 'Offsite is not configured.' }

  let local: DocumentFile[]
  try {
    local = await listDocuments()
  } catch (error) {
    return { ok: false, sent: 0, remaining: 0, bytes: 0, detail: (error as Error).message }
  }

  const remote = new Map<string, number>()
  try {
    for (const object of await target.list(DOCUMENTS_PREFIX)) {
      remote.set(object.key.slice(DOCUMENTS_PREFIX.length), object.size)
    }
  } catch (error) {
    return { ok: false, sent: 0, remaining: 0, bytes: 0, detail: (error as Error).message.slice(0, 200) }
  }

  /*
   * A size that disagrees means a partial upload, not a changed file — nothing
   * rewrites a stored path — so it is sent again rather than trusted.
   */
  const missing = local.filter((file) => remote.get(file.path) !== file.size)
  if (missing.length === 0) {
    return { ok: true, sent: 0, remaining: 0, bytes: 0, detail: `All ${local.length} document(s) are offsite.` }
  }

  const batch: DocumentFile[] = []
  let bytes = 0
  for (const file of missing) {
    if (batch.length >= MAX_FILES_PER_TICK || bytes + file.size > MAX_BYTES_PER_TICK) break
    batch.push(file)
    bytes += file.size
  }
  // Never stall: one file larger than the budget still goes, alone.
  if (batch.length === 0 && missing[0]) {
    batch.push(missing[0])
    bytes = missing[0].size
  }

  const stageName = `documents.staging`
  const stageDir = join(dir, stageName)
  const listName = `documents.staging.list`
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  writeFileSync(join(dir, listName), batch.map((file) => file.path).join('\n') + '\n')

  try {
    const staged = await docker.stageUploads(`/state/${listName}`, `/state/${stageName}`)
    if (staged.code !== 0) {
      return {
        ok: false, sent: 0, remaining: missing.length, bytes: 0,
        detail: `Could not stage documents: ${(staged.stderr || '').trim().slice(0, 200)}`,
      }
    }

    let sent = 0
    for (const file of batch) {
      await target.put(`${DOCUMENTS_PREFIX}${file.path}`, join(stageDir, file.path), contentTypeFor(file.path))
      sent += 1
    }

    const remaining = missing.length - sent
    return {
      ok: true,
      sent,
      remaining,
      bytes,
      detail:
        remaining > 0
          ? `${sent} document(s) copied to ${target.label}; ${remaining} still to go.`
          : `${sent} document(s) copied to ${target.label}; all ${local.length} are offsite.`,
    }
  } catch (error) {
    return {
      ok: false, sent: 0, remaining: missing.length, bytes: 0,
      detail: (error as Error).message.slice(0, 200),
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true })
    rmSync(join(dir, listName), { force: true })
  }
}

/**
 * The paths a backup set was taken beside.
 *
 * Written into the set so a restore is faithful to a moment: this database,
 * these documents. Without it, restoring Tuesday's database gets today's
 * documents — files no restored row references — which is a different system
 * from the one being recovered.
 */
export function writeDocumentIndex(setDir: string, files: readonly DocumentFile[]): void {
  writeFileSync(
    join(setDir, 'documents.index.json'),
    JSON.stringify({ takenAt: new Date().toISOString(), count: files.length, files }, null, 0) + '\n',
  )
}

export function readDocumentIndex(setDir: string): DocumentFile[] {
  try {
    const raw = JSON.parse(readFileSync(join(setDir, 'documents.index.json'), 'utf8')) as {
      files?: DocumentFile[]
    }
    return Array.isArray(raw.files) ? raw.files : []
  } catch {
    return []
  }
}

/** Enough to be useful in a bucket browser; never trusted for anything. */
function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const known: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return known[extension] ?? 'application/octet-stream'
}
