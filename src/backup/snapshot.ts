import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile, writeJsonAtomic } from '../lib/json-files.js'
import { loadSecrets, loadState, saveSecrets, saveState, stateDir } from '../state/store.js'
import type { OffsiteStore } from './store.js'

/**
 * The engine's own state, encrypted, so a dead box is recoverable from a bucket.
 *
 * Everything else the engine copies offsite — backup sets, documents — is
 * useless without this. A restored database with no `DATABASE_URL`, no JWT
 * secret and no record of which version or which modules a firm ran is a pile
 * of rows, not a deployment. This is the small file that turns one into the
 * other.
 *
 * **It is encrypted because it is the one copy that leaves the box**, and it
 * holds every credential the deployment has: the database password, the JWT
 * pair, the registry token, the SMTP secret, the R2 keys and the Entra client
 * secret. The local copy is deliberately left as it is — anyone who can read
 * the state volume already holds the Docker socket the engine mounts, so
 * encrypting there defends a boundary that is already crossed. A bucket is a
 * different boundary: a third party, a key that can be leaked, a share that can
 * be misconfigured.
 *
 * ## The scheme
 *
 * scrypt to turn a passphrase into a key, AES-256-GCM to encrypt with it.
 *
 * GCM and not CBC because this has to be **authenticated**. A snapshot is the
 * thing a firm restores from on the worst day they have had, and silently
 * decrypting tampered or corrupted bytes into a plausible-looking state file is
 * the failure that would not be noticed until it had been acted on. GCM's tag
 * makes a wrong passphrase, a truncated object and a modified one all fail the
 * same way: loudly, before anything is returned.
 *
 * The derived key is **cached in memory** after the first use. scrypt at these
 * parameters costs about 128 MB and the better part of a second by design —
 * that is the point of it against an offline attacker — and paying it on every
 * tick would be a self-inflicted denial of service on a small box.
 *
 * The salt is stored beside the passphrase rather than derived from anything,
 * and travels in the envelope, so a future change of parameters can be read
 * back by a version that predates it.
 */

/** OWASP's scrypt parameters, as the operator password used before it was removed. */
const SCRYPT = { N: 131072, r: 8, p: 1, keyLength: 32, maxmem: 256 * 1024 * 1024 }

/** Where the snapshot lives. Its own prefix: it is not a backup set and must not be pruned like one. */
export const SNAPSHOT_KEY = 'engine/state.enc'

export interface SnapshotEnvelope {
  /** Bumped only for a change that an older engine could not read. */
  readonly v: 1
  readonly kdf: 'scrypt'
  readonly N: number
  readonly r: number
  readonly p: number
  readonly salt: string
  readonly iv: string
  readonly tag: string
  readonly ciphertext: string
}

/**
 * Derived keys, by passphrase and salt.
 *
 * Module scope, so it dies with the container — which is the right lifetime for
 * something that is only an optimisation and is reconstructible from the
 * secret store.
 */
const keyCache = new Map<string, Buffer>()

function deriveKey(passphrase: string, salt: Buffer, params = SCRYPT): Buffer {
  const cacheKey = `${passphrase}:${salt.toString('base64')}:${params.N}:${params.r}:${params.p}`
  const cached = keyCache.get(cacheKey)
  if (cached) return cached
  const key = scryptSync(passphrase, salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  })
  keyCache.set(cacheKey, key)
  return key
}

/** Test seam, and the way to make a changed passphrase take effect at once. */
export function clearKeyCache(): void {
  keyCache.clear()
}

export function encryptSnapshot(plaintext: string, passphrase: string, salt: Buffer): SnapshotEnvelope {
  if (!passphrase) throw new Error('No recovery passphrase.')
  const key = deriveKey(passphrase, salt)
  // 96 bits, which is GCM's own recommendation: longer is hashed down and
  // shorter narrows the space a nonce must never repeat in.
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    v: 1,
    kdf: 'scrypt',
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

/**
 * Read one back, or say why not.
 *
 * Never throws for a wrong passphrase: recovery is driven by a person typing
 * something from memory at a bad moment, and "that is not the passphrase" is an
 * answer, not a crash. It throws for nothing at all — every failure is a
 * result.
 */
export function decryptSnapshot(
  envelope: unknown,
  passphrase: string,
): { ok: true; plaintext: string } | { ok: false; detail: string } {
  const e = envelope as Partial<SnapshotEnvelope>
  if (!e || typeof e !== 'object') return { ok: false, detail: 'That is not a snapshot.' }
  if (e.v !== 1) return { ok: false, detail: `Snapshot version ${String(e.v)} is not one this engine can read.` }
  if (e.kdf !== 'scrypt') return { ok: false, detail: `Unknown key derivation '${String(e.kdf)}'.` }
  for (const field of ['salt', 'iv', 'tag', 'ciphertext'] as const) {
    if (typeof e[field] !== 'string') return { ok: false, detail: `The snapshot has no ${field}.` }
  }

  try {
    /*
     * The envelope's own parameters, not this build's constants. A snapshot
     * written by an engine with different settings has to stay readable, or the
     * upgrade that changes them is the upgrade that loses a firm's recovery.
     */
    const key = deriveKey(passphrase, Buffer.from(e.salt!, 'base64'), {
      N: typeof e.N === 'number' ? e.N : SCRYPT.N,
      r: typeof e.r === 'number' ? e.r : SCRYPT.r,
      p: typeof e.p === 'number' ? e.p : SCRYPT.p,
      keyLength: SCRYPT.keyLength,
      maxmem: SCRYPT.maxmem,
    })
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv!, 'base64'))
    decipher.setAuthTag(Buffer.from(e.tag!, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(e.ciphertext!, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    return { ok: true, plaintext }
  } catch {
    /*
     * One message for every failure, on purpose. A wrong passphrase and a
     * tampered object are the same answer to whoever is holding the terminal,
     * and distinguishing them tells an attacker which of the two they achieved.
     */
    return { ok: false, detail: 'The snapshot did not decrypt. Wrong passphrase, or the object has been altered.' }
  }
}

/** A new random salt, for a deployment that has never had one. */
export function newSalt(): Buffer {
  return randomBytes(16)
}

/** Constant-time, because a passphrase check should not be a timing oracle. */
export function samePassphrase(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

// ---------------------------------------------------------------------------
// What a snapshot contains, and how it gets to the bucket
// ---------------------------------------------------------------------------

/**
 * The four things a bare machine needs to become this deployment again.
 *
 * Chosen by asking what cannot be re-derived, not by copying the state
 * directory — a glob would have carried `auth.json.bak-20260907` off `.106`,
 * a superseded credential no code writes.
 *
 *  - **`state`** — settings, enabled modules, their config, the version. The
 *    deployment's identity.
 *  - **`secrets`** — the credentials. Without them a restored database is rows
 *    nobody can connect to.
 *  - **`audit`** — a tail, so a recovered box can say what the last deploy was
 *    rather than starting with amnesia about its own history.
 *  - **`engineVersion`** — which engine wrote this, so a mismatch is visible.
 *
 * Deliberately absent: `sessions.json` (live logins must not survive onto a
 * different machine), `alerts.json` and `heartbeat.json` (stored conclusions,
 * re-derived on the first tick), `clock.json` (tamper detection about *that*
 * box's clock), and `docker-compose.generated.yml` — which is an **output**.
 * Restoring it would pin a stale render against a newer engine; outputs are
 * re-derived, never restored.
 */
export interface SnapshotBody {
  readonly takenAt: string
  readonly engineVersion: string
  readonly state: unknown
  readonly secrets: Record<string, string>
  readonly audit: readonly unknown[]
}

/** How much history rides along. Enough to explain the last deploy, not an archive. */
const AUDIT_TAIL = 200

/** The local note of what was last sent, so an unchanged snapshot is not re-sent. */
const MARKER_FILE = 'snapshot.json'

export const RECOVERY_PASSPHRASE = 'RECOVERY_PASSPHRASE'
export const RECOVERY_SALT = 'RECOVERY_SALT'

/**
 * Assemble the snapshot from what is on disk right now.
 *
 * The audit tail is read from the file rather than through `AuditLog`, so this
 * module depends on the state directory and not on the server.
 */
export function buildSnapshotBody(dir = stateDir(), engineVersion = 'unknown'): SnapshotBody {
  let audit: unknown[] = []
  try {
    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n')
    for (const line of lines.slice(-AUDIT_TAIL)) {
      if (!line.trim()) continue
      try {
        audit.push(JSON.parse(line))
      } catch {
        /* One malformed line must not cost the whole snapshot. */
      }
    }
  } catch {
    audit = []
  }

  return {
    takenAt: new Date().toISOString(),
    engineVersion,
    state: readJsonFile(join(dir, 'state.json'), { lenient: true }) ?? loadState(dir),
    secrets: loadSecrets(dir),
    audit,
  }
}

/**
 * What identifies a snapshot as unchanged.
 *
 * `takenAt` is excluded on purpose: it moves every time, and hashing it would
 * make every tick look like a change and re-upload 4 KB forever. The audit tail
 * *is* included, because a new audit line is a real change worth carrying.
 */
function bodyHash(body: SnapshotBody): string {
  const { takenAt: _ignored, ...rest } = body
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

export interface SnapshotOutcome {
  readonly ok: boolean
  readonly sent: boolean
  readonly detail: string
}

/**
 * Put the current state in the bucket, if it has changed.
 *
 * Never throws: the caller is the tick, and a snapshot failing must not stop a
 * backup being taken. It returns a result instead, and the tick records it.
 */
export async function pushSnapshot(
  dir = stateDir(),
  store?: OffsiteStore | null,
  engineVersion = 'unknown',
): Promise<SnapshotOutcome> {
  const secrets = loadSecrets(dir)
  const passphrase = secrets[RECOVERY_PASSPHRASE]
  if (!passphrase) return { ok: true, sent: false, detail: 'No recovery passphrase is set; nothing to send.' }
  if (!store) return { ok: true, sent: false, detail: 'Offsite is not configured.' }

  /*
   * The salt is settled *before* the body is built, and the order is the whole
   * point. Generating it afterwards meant the first push hashed a secret set
   * that did not yet contain the salt, then wrote it — so the next tick saw a
   * different hash and sent an identical snapshot again. Harmless, and exactly
   * the kind of "why does this upload twice" nobody would have chased.
   *
   * The salt is not itself secret; it travels in the envelope. It is kept
   * because it must be *stable*, or every write re-derives the key at 128 MB
   * and a second of CPU.
   */
  let salt: Buffer
  const stored = secrets[RECOVERY_SALT]
  if (stored) {
    salt = Buffer.from(stored, 'base64')
  } else {
    salt = newSalt()
    saveSecrets({ ...secrets, [RECOVERY_SALT]: salt.toString('base64') }, dir)
  }

  const body = buildSnapshotBody(dir, engineVersion)
  const hash = bodyHash(body)
  const marker = readJsonFile(join(dir, MARKER_FILE), { lenient: true }) as { hash?: string } | undefined
  if (marker?.hash === hash) return { ok: true, sent: false, detail: 'Unchanged.' }

  try {
    const envelope = encryptSnapshot(JSON.stringify(body), passphrase, salt)
    const temporary = join(dir, `${MARKER_FILE}.upload`)
    writeJsonAtomic(temporary, envelope)
    await store.put(SNAPSHOT_KEY, temporary, 'application/json')
    writeJsonAtomic(join(dir, MARKER_FILE), { hash, uploadedAt: new Date().toISOString() })
    return { ok: true, sent: true, detail: `Engine state copied to ${store.label}.` }
  } catch (error) {
    return { ok: false, sent: false, detail: (error as Error).message.slice(0, 200) }
  }
}

/**
 * Fetch and open the snapshot. The first half of recovery.
 */
export async function fetchSnapshot(
  store: OffsiteStore,
  passphrase: string,
  scratchPath: string,
): Promise<{ ok: true; body: SnapshotBody } | { ok: false; detail: string }> {
  try {
    await store.get(SNAPSHOT_KEY, scratchPath)
  } catch (error) {
    return { ok: false, detail: `No engine snapshot in the store: ${(error as Error).message.slice(0, 160)}` }
  }

  let envelope: unknown
  try {
    envelope = JSON.parse(readFileSync(scratchPath, 'utf8'))
  } catch {
    return { ok: false, detail: 'The snapshot object is not readable JSON.' }
  }

  const opened = decryptSnapshot(envelope, passphrase)
  if (!opened.ok) return opened

  try {
    const body = JSON.parse(opened.plaintext) as SnapshotBody
    if (!body || typeof body !== 'object' || !body.secrets || !body.state) {
      return { ok: false, detail: 'The snapshot decrypted but is not shaped like one.' }
    }
    return { ok: true, body }
  } catch {
    return { ok: false, detail: 'The snapshot decrypted into something that is not JSON.' }
  }
}

/**
 * Write a fetched snapshot onto this box.
 *
 * Refuses to overwrite a deployment that already has one. Recovery is for a
 * bare machine, and running it against a live box would replace a working
 * deployment's credentials with an older set — which is not a recovery, it is
 * an outage with extra steps. `force` exists for the deliberate case.
 */
export function applySnapshot(
  body: SnapshotBody,
  dir = stateDir(),
  options: { force?: boolean } = {},
): { ok: boolean; detail: string } {
  const existing = readJsonFile(join(dir, 'state.json'), { lenient: true })
  if (existing && !options.force) {
    return { ok: false, detail: 'This box already has engine state. Recovery is for a machine that has none.' }
  }

  saveState(loadState(dir), dir) // ensure the directory exists and is shaped
  writeJsonAtomic(join(dir, 'state.json'), body.state)
  saveSecrets(body.secrets, dir)
  return {
    ok: true,
    detail: `Engine state restored from a snapshot taken ${body.takenAt} by engine ${body.engineVersion}.`,
  }
}
