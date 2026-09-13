import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** What the uploads volume "contains" for a given test. */
let volume: { path: string; size: number }[] = []
/** Paths the staging helper was asked to copy out. */
let staged: string[] = []
/** Paths written back onto the volume by a restore. */
let unstaged = 0

vi.mock('../docker/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../docker/index.js')>()
  return {
    ...original,
    appOwner: vi.fn(async () => '1001:65533'),
    listUploads: vi.fn(async () => ({
      code: 0,
      stdout: volume.map((f) => `${f.size} ${f.path}`).join('\n') + '\n',
      stderr: '',
    })),
    stageUploads: vi.fn(async (listPath: string, stageDir: string) => {
      const dir = process.env['TEST_DIR']!
      const host = (p: string) => join(dir, p.replace('/state/', ''))
      const wanted = readFileSync(host(listPath), 'utf8').split('\n').filter(Boolean)
      staged = wanted
      for (const path of wanted) {
        const at = join(host(stageDir), path)
        mkdirSync(join(at, '..'), { recursive: true })
        writeFileSync(at, 'x'.repeat(volume.find((f) => f.path === path)?.size ?? 1))
      }
      return { code: 0, stdout: '', stderr: '' }
    }),
    unstageUploads: vi.fn(async () => {
      unstaged += 1
      return { code: 0, stdout: '', stderr: '' }
    }),
  }
})

import {
  DOCUMENTS_PREFIX,
  listDocuments,
  readDocumentIndex,
  restoreDocuments,
  syncDocuments,
  writeDocumentIndex,
} from './documents.js'
import type { OffsiteObject, OffsiteStore } from './store.js'

/** A store that remembers what it was given, and how often it was asked. */
function fakeStore(seed: Record<string, number> = {}) {
  const objects = new Map<string, number>(Object.entries(seed))
  const calls = { list: 0, put: 0, get: 0 }
  const store: OffsiteStore = {
    label: 'Test Store',
    async put(key, filePath) {
      calls.put += 1
      objects.set(key, readFileSync(filePath).length)
    },
    async stat(key) {
      const size = objects.get(key)
      return size === undefined ? undefined : { key, size }
    },
    async list(prefix) {
      calls.list += 1
      const found: OffsiteObject[] = []
      for (const [key, size] of objects) if (key.startsWith(prefix)) found.push({ key, size })
      return found
    },
    async get(key, toPath) {
      calls.get += 1
      const size = objects.get(key)
      if (size === undefined) throw new Error(`${key} is not there`)
      mkdirSync(join(toPath, '..'), { recursive: true })
      writeFileSync(toPath, 'x'.repeat(size))
    },
    async remove(key) {
      objects.delete(key)
    },
  }
  return { store, objects, calls }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'documents-test-'))
  process.env['TEST_DIR'] = dir
  volume = []
  staged = []
  unstaged = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('reading the uploads volume', () => {
  it('parses size and path, and keeps the path intact', async () => {
    volume = [{ path: 'generated/2026/9/abc-تقرير_جلسة.pdf', size: 707371 }]
    expect(await listDocuments()).toEqual([{ path: 'generated/2026/9/abc-تقرير_جلسة.pdf', size: 707371 }])
  })

  it('ignores blank and malformed lines rather than inventing files', async () => {
    const { listUploads } = await import('../docker/index.js')
    vi.mocked(listUploads).mockResolvedValueOnce({
      code: 0,
      stdout: '\n12 a/b.pdf\nnonsense\n  \n34 c/d.docx\n',
      stderr: '',
    })
    expect(await listDocuments()).toEqual([
      { path: 'a/b.pdf', size: 12 },
      { path: 'c/d.docx', size: 34 },
    ])
  })
})

describe('sending documents offsite', () => {
  it('sends what is missing and nothing else', async () => {
    volume = [
      { path: 'a.pdf', size: 10 },
      { path: 'b.pdf', size: 20 },
    ]
    const { store, objects, calls } = fakeStore({ [`${DOCUMENTS_PREFIX}a.pdf`]: 10 })
    const result = await syncDocuments(dir, store)
    expect(result.sent).toBe(1)
    expect(staged).toEqual(['b.pdf'])
    expect(objects.has(`${DOCUMENTS_PREFIX}b.pdf`)).toBe(true)
    // One list for the whole volume, not one question per file.
    expect(calls.list).toBe(1)
  })

  it('does nothing at all on a second run', async () => {
    volume = [{ path: 'a.pdf', size: 10 }]
    const { store, calls } = fakeStore()
    await syncDocuments(dir, store)
    const again = await syncDocuments(dir, store)
    expect(again.sent).toBe(0)
    expect(calls.put).toBe(1)
    expect(again.detail).toContain('All 1 document(s) are offsite')
  })

  /*
   * Nothing rewrites a stored path -- every name carries a fresh uuid -- so a
   * size that disagrees is a partial upload, not a changed file, and must be
   * sent again rather than trusted.
   */
  it('sends again when the size in the bucket disagrees', async () => {
    volume = [{ path: 'a.pdf', size: 10 }]
    const { store, objects } = fakeStore({ [`${DOCUMENTS_PREFIX}a.pdf`]: 3 })
    expect((await syncDocuments(dir, store)).sent).toBe(1)
    expect(objects.get(`${DOCUMENTS_PREFIX}a.pdf`)).toBe(10)
  })

  it('carries a large backlog across ticks rather than staging all of it', async () => {
    volume = Array.from({ length: 250 }, (_, i) => ({ path: `f${i}.pdf`, size: 1 }))
    const { store } = fakeStore()
    const first = await syncDocuments(dir, store)
    expect(first.sent).toBe(200)
    expect(first.remaining).toBe(50)
    const second = await syncDocuments(dir, store)
    expect(second.sent).toBe(50)
    expect(second.remaining).toBe(0)
  })

  it('says so plainly when offsite is not configured', async () => {
    volume = [{ path: 'a.pdf', size: 10 }]
    // No store passed and none configured in this scratch state directory.
    expect((await syncDocuments(dir)).ok).toBe(false)
  })
})

describe('the index a set carries', () => {
  it('round-trips the paths that existed when it was taken', () => {
    const setDir = join(dir, 'set')
    mkdirSync(setDir, { recursive: true })
    const files = [{ path: 'a.pdf', size: 10 }]
    writeDocumentIndex(setDir, files)
    expect(readDocumentIndex(setDir)).toEqual(files)
  })

  it('reads a missing or damaged index as empty rather than throwing', () => {
    expect(readDocumentIndex(join(dir, 'nowhere'))).toEqual([])
  })
})

describe('putting documents back', () => {
  it('fetches what the index names, and only that', async () => {
    const setDir = join(dir, 'set')
    mkdirSync(setDir, { recursive: true })
    writeDocumentIndex(setDir, [{ path: 'a.pdf', size: 10 }])
    // The bucket holds a later file too; restoring Tuesday must not bring it.
    const { store, calls } = fakeStore({
      [`${DOCUMENTS_PREFIX}a.pdf`]: 10,
      [`${DOCUMENTS_PREFIX}written-later.pdf`]: 99,
    })
    volume = []
    const result = await restoreDocuments(setDir, dir, store)
    expect(result.fetched).toBe(1)
    expect(calls.get).toBe(1)
    expect(unstaged).toBe(1)
  })

  it('leaves files already in place alone, so a half-done restore resumes', async () => {
    const setDir = join(dir, 'set')
    mkdirSync(setDir, { recursive: true })
    writeDocumentIndex(setDir, [
      { path: 'a.pdf', size: 10 },
      { path: 'b.pdf', size: 20 },
    ])
    volume = [{ path: 'a.pdf', size: 10 }]
    const { store, calls } = fakeStore({
      [`${DOCUMENTS_PREFIX}a.pdf`]: 10,
      [`${DOCUMENTS_PREFIX}b.pdf`]: 20,
    })
    const result = await restoreDocuments(setDir, dir, store)
    expect(result.fetched).toBe(1)
    expect(result.alreadyThere).toBe(1)
    expect(calls.get).toBe(1)
  })

  it('refuses clearly when a set names documents and there is nowhere to fetch them from', async () => {
    const setDir = join(dir, 'set')
    mkdirSync(setDir, { recursive: true })
    writeDocumentIndex(setDir, [{ path: 'a.pdf', size: 10 }])
    const result = await restoreDocuments(setDir, dir)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('offsite is not configured')
  })

  it('is content with a set that carries no index', async () => {
    const setDir = join(dir, 'set')
    mkdirSync(setDir, { recursive: true })
    const result = await restoreDocuments(setDir, dir)
    expect(result.ok).toBe(true)
    expect(result.fetched).toBe(0)
  })
})
