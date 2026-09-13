import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSnapshotMarker, reconcileSnapshot } from './snapshot.js'
import type { OffsiteObject, OffsiteStore } from './store.js'

/**
 * The loop, and the record.
 *
 * On 2026-09-13 the staging box held 135 `snapshot-copied` lines in a day:
 * the snapshot carries the audit tail, the tail changed because the copy was
 * recorded in it, so the next tick copied it again. The fix is that a copy is
 * not an audit event. What replaces the record is asking the store.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snapshot-loop-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fakeStore(has: boolean): OffsiteStore & { stats: number } {
  const store = {
    label: 'fake',
    stats: 0,
    async put() {},
    async stat(): Promise<OffsiteObject | undefined> {
      store.stats++
      return has ? { key: 'engine/state.enc', size: 28_000 } : undefined
    },
    async list() {
      return []
    },
    async get() {},
    async remove() {},
  }
  return store
}

describe('reconcileSnapshot', () => {
  const marker = (verifiedAt?: string) =>
    writeFileSync(
      join(dir, 'snapshot.json'),
      JSON.stringify({ hash: 'abc', uploadedAt: '2026-09-13T00:00:00.000Z', ...(verifiedAt ? { verifiedAt } : {}) }),
    )

  it('does nothing when there is nothing recorded as sent', async () => {
    const store = fakeStore(true)
    expect(await reconcileSnapshot(dir, store)).toEqual({ checked: false, missing: false })
    expect(store.stats).toBe(0)
  })

  it('trusts a recent verification and asks again after six hours', async () => {
    const now = Date.parse('2026-09-13T12:00:00Z')
    marker('2026-09-13T10:00:00.000Z')
    const store = fakeStore(true)
    expect(await reconcileSnapshot(dir, store, now)).toEqual({ checked: false, missing: false })
    marker('2026-09-13T05:00:00.000Z')
    expect(await reconcileSnapshot(dir, store, now)).toEqual({ checked: true, missing: false })
    expect(store.stats).toBe(1)
    expect(readSnapshotMarker(dir).verifiedAt).toBe('2026-09-13T12:00:00.000Z')
  })

  it('clears the marker when the store no longer holds the object, so it is sent again', async () => {
    marker()
    const store = fakeStore(false)
    expect(await reconcileSnapshot(dir, store)).toEqual({ checked: true, missing: true })
    expect(JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'))).toEqual({})
  })

  it('leaves the marker alone when the store cannot be asked — not knowing is not missing', async () => {
    marker()
    const store = { ...fakeStore(true), stat: async () => { throw new Error('timeout') } }
    expect(await reconcileSnapshot(dir, store)).toEqual({ checked: false, missing: false })
    expect(readSnapshotMarker(dir).hash).toBe('abc')
  })
})
