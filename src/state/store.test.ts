import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSecrets, loadState, updateSecrets, updateState, withStateLock } from './store.js'

/**
 * Two writers, one file.
 *
 * Every change to state.json used to be `saveState({ ...loadState(), x })`,
 * and two of those at once — the CLI in a `docker exec` and the server
 * answering a request — kept whichever wrote last. `updateState` reads under
 * the lock, so the second sees the first.
 */
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-test-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('updateState', () => {
  it('applies a change to what is on disk now, not to a stale read', () => {
    // A writer that read before another wrote — the shape of the lost update.
    const stale = loadState(dir)
    updateState((state) => ({ ...state, enabled: ['email'] }), dir)
    // The stale reader's change goes through the transaction and lands on top.
    updateState((state) => ({ ...state, version: '1.2.3' }), dir)
    const after = loadState(dir)
    expect(after.enabled).toEqual(['email'])
    expect(after.version).toBe('1.2.3')
    expect(stale.enabled).toEqual([])
  })

  it('validates what it writes, so a transaction cannot leave an unreadable file', () => {
    expect(() => updateState((state) => ({ ...state, settings: { ...state.settings, appPort: 0 } }), dir)).toThrow()
    expect(loadState(dir).settings.appPort).not.toBe(0)
  })
})

describe('updateSecrets', () => {
  it('keeps a key written by another transaction', () => {
    updateSecrets((s) => ({ ...s, A: '1' }), dir)
    updateSecrets((s) => ({ ...s, B: '2' }), dir)
    expect(loadSecrets(dir)).toEqual({ A: '1', B: '2' })
  })
})

describe('the lock', () => {
  it('is reentrant within a process, so a transaction may save inside another', () => {
    const result = withStateLock(() => withStateLock(() => 'inner', dir), dir)
    expect(result).toBe('inner')
  })

  it('waits for a live holder and gives up with a clear message', () => {
    mkdirSync(join(dir, '.write-lock'))
    expect(() => withStateLock(() => 'never', dir, { timeoutMs: 100, staleMs: 60_000 })).toThrow(/locked by another writer/)
  })

  it('takes over a lock left by a process that died', () => {
    const lock = join(dir, '.write-lock')
    mkdirSync(lock)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    expect(withStateLock(() => 'taken over', dir, { timeoutMs: 100, staleMs: 15_000 })).toBe('taken over')
  })

  it('is released after the transaction, even one that throws', () => {
    expect(() => withStateLock(() => { throw new Error('boom') }, dir)).toThrow('boom')
    expect(withStateLock(() => 'free', dir, { timeoutMs: 100 })).toBe('free')
  })
})

describe('the Web Push pair', () => {
  it('is a P-256 key in the encoding web-push and the browsers expect', async () => {
    const { generateVapidPair } = await import('./store.js')
    const pair = generateVapidPair()
    const pub = Buffer.from(pair.publicKey, 'base64url')
    const priv = Buffer.from(pair.privateKey, 'base64url')
    expect(pub.length).toBe(65)
    expect(pub[0]).toBe(4)
    expect(priv.length).toBe(32)
    expect(pair.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('is generated whole, and regenerated whole when a half is missing', async () => {
    const { ensureGeneratedSecrets } = await import('./store.js')
    const first = ensureGeneratedSecrets({})
    expect(first.created).toEqual(expect.arrayContaining(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']))
    const again = ensureGeneratedSecrets(first.secrets)
    expect(again.created).toEqual([])
    const { VAPID_PRIVATE_KEY: _dropped, ...half } = first.secrets
    const repaired = ensureGeneratedSecrets(half)
    expect(repaired.created).toEqual(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'])
    expect(repaired.secrets['VAPID_PUBLIC_KEY']).not.toBe(first.secrets['VAPID_PUBLIC_KEY'])
  })
})
