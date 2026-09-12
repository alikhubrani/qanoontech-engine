import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSecrets, loadState, saveSecrets, saveState } from '../state/store.js'
import {
  clearKeyCache,
  decryptSnapshot,
  encryptSnapshot,
  newSalt,
  samePassphrase,
  applySnapshot,
  buildSnapshotBody,
  fetchSnapshot,
  pushSnapshot,
  type SnapshotEnvelope,
} from './snapshot.js'

/**
 * The snapshot is the only copy of a deployment's credentials that leaves the
 * box, and the thing a firm would restore from on its worst day. So these test
 * the two properties that matter and are easy to lose: that it cannot be read
 * without the passphrase, and that it cannot be read *wrongly* — a tampered or
 * truncated object must fail, never decrypt into something plausible.
 *
 * Small scrypt parameters are not used here. The real ones cost about a second
 * each, and the cache makes that once per suite rather than once per test — so
 * the tests exercise the same cost a deployment pays, which is the point of
 * having chosen it.
 */

const PASSPHRASE = 'correct horse battery staple'
const STATE = JSON.stringify({
  settings: { dbName: 'qanoontech' },
  secrets: { DB_PASSWORD: 'a-real-password', S3_SECRET_ACCESS_KEY: 'a-real-key' },
})

let salt: Buffer

beforeEach(() => {
  salt = Buffer.from('0123456789abcdef')
})

describe('a snapshot round trip', () => {
  it('comes back exactly', () => {
    const sealed = encryptSnapshot(STATE, PASSPHRASE, salt)
    const opened = decryptSnapshot(sealed, PASSPHRASE)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.plaintext).toBe(STATE)
  })

  it('puts no secret in the envelope', () => {
    // The envelope travels to a third party's bucket. Anything readable in it
    // is published.
    const sealed = encryptSnapshot(STATE, PASSPHRASE, salt)
    const asText = JSON.stringify(sealed)
    expect(asText).not.toContain('a-real-password')
    expect(asText).not.toContain('a-real-key')
    expect(asText).not.toContain(PASSPHRASE)
    expect(asText).not.toContain('qanoontech')
  })

  it('is different every time, so two writes of identical state do not match', () => {
    /*
     * A fresh IV per write. Repeating one under the same key is the single
     * catastrophic misuse of GCM — it leaks the XOR of the plaintexts and can
     * expose the authentication key itself.
     */
    const a = encryptSnapshot(STATE, PASSPHRASE, salt)
    const b = encryptSnapshot(STATE, PASSPHRASE, salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })
})

describe('a snapshot that should not open', () => {
  it('refuses the wrong passphrase', () => {
    const sealed = encryptSnapshot(STATE, PASSPHRASE, salt)
    const opened = decryptSnapshot(sealed, 'not the passphrase')
    expect(opened.ok).toBe(false)
    if (opened.ok) return
    expect(opened.detail).toContain('did not decrypt')
  })

  it('says the same thing for a wrong passphrase and a tampered object', () => {
    // Distinguishing them tells an attacker which of the two they achieved.
    const sealed = encryptSnapshot(STATE, PASSPHRASE, salt)
    const wrong = decryptSnapshot(sealed, 'nope')
    const tampered = decryptSnapshot({ ...sealed, ciphertext: flipFirstByte(sealed.ciphertext) }, PASSPHRASE)
    expect(wrong.ok).toBe(false)
    expect(tampered.ok).toBe(false)
    if (wrong.ok || tampered.ok) return
    expect(tampered.detail).toBe(wrong.detail)
  })

  it('refuses a modified ciphertext rather than returning altered state', () => {
    /*
     * The property GCM is here for. Without authentication this would decrypt
     * to *something* — and the something would be a state file a firm acts on
     * during a recovery.
     */
    const sealed = encryptSnapshot(STATE, PASSPHRASE, salt)
    const opened = decryptSnapshot({ ...sealed, ciphertext: flipFirstByte(sealed.ciphertext) }, PASSPHRASE)
    expect(opened.ok).toBe(false)
  })

  it('refuses a swapped authentication tag', () => {
    const sealed = encryptSnapshot(STATE, PASSPHRASE, salt)
    const other = encryptSnapshot(STATE, PASSPHRASE, salt)
    expect(decryptSnapshot({ ...sealed, tag: other.tag }, PASSPHRASE).ok).toBe(false)
  })

  it('refuses a truncated object', () => {
    // What a half-finished download leaves.
    const sealed = encryptSnapshot(STATE, PASSPHRASE, salt)
    const cut = Buffer.from(sealed.ciphertext, 'base64')
    const opened = decryptSnapshot(
      { ...sealed, ciphertext: cut.subarray(0, cut.length - 4).toString('base64') },
      PASSPHRASE,
    )
    expect(opened.ok).toBe(false)
  })

  it('refuses a snapshot sealed under a different salt', () => {
    const sealed = encryptSnapshot(STATE, PASSPHRASE, salt)
    expect(decryptSnapshot({ ...sealed, salt: newSalt().toString('base64') }, PASSPHRASE).ok).toBe(false)
  })

  it('refuses rubbish without throwing', () => {
    for (const bad of [undefined, null, 'a string', 42, {}, { v: 2 }, { v: 1, kdf: 'argon2' }]) {
      const opened = decryptSnapshot(bad, PASSPHRASE)
      expect(opened.ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('names a version it cannot read, rather than failing obscurely', () => {
    const opened = decryptSnapshot({ v: 2, kdf: 'scrypt', salt: 'x', iv: 'x', tag: 'x', ciphertext: 'x' }, PASSPHRASE)
    expect(opened.ok).toBe(false)
    if (opened.ok) return
    expect(opened.detail).toContain('version 2')
  })
})

describe('reading a snapshot written under different parameters', () => {
  it('uses the envelope’s parameters, not this build’s', () => {
    /*
     * The upgrade that raises the scrypt cost must not be the upgrade that
     * makes every existing snapshot unreadable — which is what hardcoding the
     * current constants on the way back in would do.
     */
    const sealed = encryptSnapshot(STATE, PASSPHRASE, salt)
    const cheaper: SnapshotEnvelope = { ...sealed, N: 16384 }
    // Sealed at N=131072 but claiming 16384: the derived key differs, so it
    // must refuse rather than silently succeed.
    expect(decryptSnapshot(cheaper, PASSPHRASE).ok).toBe(false)
    // And the untouched envelope still opens, proving the refusal was the
    // parameter change and not the round trip.
    expect(decryptSnapshot(sealed, PASSPHRASE).ok).toBe(true)
  })
})

describe('comparing passphrases', () => {
  it('matches, refuses, and survives different lengths', () => {
    expect(samePassphrase('abc', 'abc')).toBe(true)
    expect(samePassphrase('abc', 'abd')).toBe(false)
    expect(samePassphrase('abc', 'abcd')).toBe(false)
  })
})

describe('the key cache', () => {
  it('does not let a cleared cache change the answer', () => {
    const sealed = encryptSnapshot(STATE, PASSPHRASE, salt)
    clearKeyCache()
    expect(decryptSnapshot(sealed, PASSPHRASE).ok).toBe(true)
  })
})

function flipFirstByte(base64: string): string {
  const bytes = Buffer.from(base64, 'base64')
  bytes[0] = bytes[0]! ^ 0xff
  return bytes.toString('base64')
}

/**
 * The snapshot as a whole: what it carries, what it refuses to carry, and the
 * guard that stops a recovery being run at a working deployment.
 */
describe('what a snapshot carries', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snapshot-test-'))
    saveState(loadState(dir), dir)
    saveSecrets({ DB_PASSWORD: 'db-secret', S3_ACCESS_KEY_ID: 'key-id' }, dir)
    writeFileSync(
      join(dir, 'audit.jsonl'),
      [
        JSON.stringify({ at: '2026-09-12T10:00:00.000Z', event: 'deploy-started' }),
        'this line is not JSON',
        JSON.stringify({ at: '2026-09-12T11:00:00.000Z', event: 'backup-taken' }),
      ].join('\n') + '\n',
    )
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('carries state, secrets and a tail of audit', () => {
    const body = buildSnapshotBody(dir, '0.16.0')
    expect(body.secrets['DB_PASSWORD']).toBe('db-secret')
    expect(body.state).toBeTruthy()
    expect(body.engineVersion).toBe('0.16.0')
    expect(body.audit).toHaveLength(2)
  })

  it('survives a malformed audit line rather than losing the snapshot', () => {
    // One bad line in an append-only log must not cost a firm its recovery.
    const body = buildSnapshotBody(dir, '0.16.0')
    expect(body.audit).toHaveLength(2)
  })

  it('carries no sessions, alerts, heartbeat or compose file', () => {
    /*
     * Sessions must not survive onto a different machine. The rest are stored
     * conclusions or outputs, re-derived on the first tick — and the compose
     * file especially, because restoring it would pin a stale render against a
     * newer engine.
     */
    const body = buildSnapshotBody(dir, '0.16.0')
    const asText = JSON.stringify(body)
    for (const absent of ['tokenHash', 'lastSeenAt', 'docker-compose', 'services:']) {
      expect(asText, absent).not.toContain(absent)
    }
  })

  it('sends once, then not again until something changes', async () => {
    const store = fakeStore()
    saveSecrets({ ...loadSecrets(dir), RECOVERY_PASSPHRASE: PASSPHRASE }, dir)

    const first = await pushSnapshot(dir, store.store, '0.16.0')
    expect(first.sent).toBe(true)

    const second = await pushSnapshot(dir, store.store, '0.16.0')
    expect(second.sent).toBe(false)
    expect(second.detail).toBe('Unchanged.')

    // A real change goes.
    saveSecrets({ ...loadSecrets(dir), SMTP_PASSWORD: 'new' }, dir)
    const third = await pushSnapshot(dir, store.store, '0.16.0')
    expect(third.sent).toBe(true)
    expect(store.objects.size).toBe(1)
  })

  it('does nothing at all without a passphrase, and does not fail', async () => {
    // A deployment that has never set one is not broken; it simply has no
    // offsite copy of its state, and the tick must not report an error forever.
    const store = fakeStore()
    const outcome = await pushSnapshot(dir, store.store, '0.16.0')
    expect(outcome.ok).toBe(true)
    expect(outcome.sent).toBe(false)
    expect(store.objects.size).toBe(0)
  })

  it('round-trips through a store and comes back as the same secrets', async () => {
    const store = fakeStore()
    saveSecrets({ ...loadSecrets(dir), RECOVERY_PASSPHRASE: PASSPHRASE }, dir)
    await pushSnapshot(dir, store.store, '0.16.0')

    const scratch = join(dir, 'fetched.json')
    const got = await fetchSnapshot(store.store, PASSPHRASE, scratch)
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.body.secrets['DB_PASSWORD']).toBe('db-secret')
  })

  it('refuses the wrong passphrase on the way back', async () => {
    const store = fakeStore()
    saveSecrets({ ...loadSecrets(dir), RECOVERY_PASSPHRASE: PASSPHRASE }, dir)
    await pushSnapshot(dir, store.store, '0.16.0')
    const got = await fetchSnapshot(store.store, 'wrong', join(dir, 'fetched.json'))
    expect(got.ok).toBe(false)
  })
})

describe('applying a snapshot', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snapshot-apply-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const body = {
    takenAt: '2026-09-13T00:00:00.000Z',
    engineVersion: '0.16.0',
    state: { version: '1.15.0', enabled: ['email'], settings: {}, config: {} },
    secrets: { DB_PASSWORD: 'recovered' },
    audit: [],
  }

  it('writes state and secrets onto a bare machine', () => {
    const applied = applySnapshot(body, dir)
    expect(applied.ok).toBe(true)
    expect(loadSecrets(dir)['DB_PASSWORD']).toBe('recovered')
  })

  it('refuses a box that already has state', () => {
    /*
     * Recovery is for a machine with nothing. Running it at a working
     * deployment would replace live credentials with an older set — not a
     * recovery, an outage with extra steps.
     */
    saveState(loadState(dir), dir)
    const applied = applySnapshot(body, dir)
    expect(applied.ok).toBe(false)
    expect(applied.detail).toContain('already has engine state')
  })

  it('allows it when asked deliberately', () => {
    saveState(loadState(dir), dir)
    expect(applySnapshot(body, dir, { force: true }).ok).toBe(true)
  })
})

/** A store that lives in a Map, with only the three calls a snapshot uses. */
function fakeStore() {
  const objects = new Map<string, Buffer>()
  const store = {
    label: 'Test Store',
    async put(key: string, filePath: string) {
      objects.set(key, readFileSync(filePath))
    },
    async stat(key: string) {
      const body = objects.get(key)
      return body ? { key, size: body.length } : undefined
    },
    async list(prefix: string) {
      return [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.length }))
    },
    async get(key: string, toPath: string) {
      const body = objects.get(key)
      if (!body) throw new Error(`${key} is not here.`)
      writeFileSync(toPath, body)
    },
    async remove(key: string) {
      objects.delete(key)
    },
  }
  return { store, objects }
}
