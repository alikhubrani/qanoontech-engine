import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonFile, writeJsonAtomic } from '../lib/json-files.js'
import type { DeploymentSettings } from '../catalogue/index.js'

/**
 * The engine's own state, on the engine's own volume.
 *
 * Deliberately not in the application's database: the engine has to be able to
 * say what a deployment is when the database is gone, which is exactly the
 * moment someone needs to know.
 */

export const DEFAULT_STATE_DIR = '/var/lib/qanoontech-engine'

export function stateDir(): string {
  return process.env['ENGINE_STATE_DIR'] ?? DEFAULT_STATE_DIR
}

const settingsSchema = z.object({
  /** 0.0.0.0 by design: a deployment serves its LAN unless the firm narrows it. */
  bindAddress: z.string().min(1).default('0.0.0.0'),
  appPort: z.number().int().min(1).max(65535).default(8080),
  dbName: z.string().min(1).default('qanoontech'),
  dbUser: z.string().min(1).default('qanoontech'),
  timezone: z.string().min(1).default('Asia/Riyadh'),
  defaultLanguage: z.enum(['ar', 'en']).default('ar'),
  /**
   * `info`, not `warn`.
   *
   * At `warn` a deployment keeps almost nothing: measured on a firm's box, 757
   * log lines over nine days -- 731 warn, 26 error, **zero info**. Everything
   * the application logs at `info` was discarded, which included the record of
   * who read what, every successful sign-in, "database connected", and the
   * entire shutdown sequence. A box nobody is watching should say what it did,
   * not only what went wrong.
   *
   * Safe to raise now that the application rotates its diagnostic logs daily and
   * keeps thirty days, rather than filling a size cap and silently discarding
   * the oldest. The *audit* trail is a separate stream with its own twelve-month
   * retention and is not governed by this setting at all -- deliberately, so
   * that turning the noise down cannot turn the record off.
   *
   * Existing deployments are unaffected: this value is written into state.json
   * at first save, so a default only reaches a new install. Changing an existing
   * one is what the settings endpoint is for.
   */
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  maxFileSizeBytes: z.number().int().positive().default(52_428_800),
  /**
   * How often the database is snapshotted, in minutes. Hourly by default.
   *
   * This used to be daily, and the exposure was worse than that sounds: the
   * schedule forced a set only once the newest was **26 hours** old, so the
   * measured worst window on a firm's box was 26.1 hours of work that a
   * restore could not get back.
   *
   * Hourly is affordable because the thing being copied is small and the
   * measurement says so, rather than because it feels safer. On the firm's box
   * the database is 13 MB, a compressed dump is **142 KB**, and taking one
   * costs **156 ms**. Twenty-four a day is 3.4 MB — less than one Postgres WAL
   * segment, which is the alternative this replaced. See
   * `docs/spec/point-in-time-recovery.md` in the application repository.
   *
   * The floor is five minutes, and it is a floor rather than a suggestion: a
   * dump holds no lock a caller notices, but a tick that has not finished
   * before the next one starts is a queue, not a schedule.
   */
  backupIntervalMinutes: z.number().int().min(5).max(1440).default(60),
  /**
   * The hour, read in `timezone`, for the one set a day that also tars every
   * document. Two in the morning Riyadh time by default.
   *
   * Documents are the slow half -- 11.9 MB against the database's 142 KB, and
   * they change rarely -- so they ride the daily set and not the hourly one.
   * An hourly snapshot is the database alone, which is what a bad migration or
   * a deleted case needs back.
   */
  backupHour: z.number().int().min(0).max(23).default(2),
  backupRetentionDays: z.number().int().min(1).max(3650).default(30),
  /** Where documents are already copied offsite, the local set can be the database alone. */
  backupIncludeUploads: z.boolean().default(true),
  /**
   * The second copy, in object storage the firm controls. Off until a firm
   * turns it on and supplies a bucket and a key pair.
   *
   * This used to offer a choice of destination -- a firm's Google Shared Drive
   * or S3-compatible object storage -- and Drive was the default. Drive is
   * retired: a bucket takes lifecycle rules and object lock, which a Shared
   * Drive cannot, and object lock is the only thing on either side that
   * defends a backup against ransomware or against this engine being
   * compromised.
   *
   * `backupOffsiteProvider` and `backupOffsiteDriveId` are gone from this
   * schema rather than deprecated in it. A state file still carrying them
   * parses without complaint, because this object is not strict and silently
   * drops what it does not name -- which is what keeps a deployment that was
   * set to Drive from failing to boot on the release that removes it.
   */
  /**
   * Who may sign in to this panel: Microsoft Entra, and nothing else.
   *
   * There is no password and no `authMode`. The operator password was a single
   * static secret with no second factor, no rotation, no revocation and no
   * attribution, guarding a panel that can deploy, restore over a live database
   * and read every credential the deployment holds. Removing it rather than
   * keeping it as a fallback is the whole point: a fallback nobody uses is the
   * credential nobody rotates and nobody notices leaking.
   *
   * The tenant, the application and the permitted account ship as defaults
   * because every deployment of this engine is operated by the same person.
   * None of the three is a secret — they identify, they do not authorise. The
   * client secret is not among them and never will be: it is held in the secret
   * store, per box, and a fresh install has no panel until one is set from a
   * shell. That is the intended bootstrap.
   *
   * They are settings and not constants so that a deployment can be pointed at
   * a different directory without a new image.
   */
  entraTenantId: z.string().default('e12d2506-d720-4ff4-9956-27df04e3dc33'),
  entraClientId: z.string().default('a4049d7b-249b-4e77-856a-65bd61eab5f3'),
  /**
   * The redirect URI registered with the application. Per deployment — the
   * panel's own address — so it has no useful default and must be set before
   * anyone can sign in.
   *
   * Stored rather than derived from the request, because deriving it from a
   * Host header lets whoever can set that header choose where the code is sent.
   */
  entraRedirectUri: z.string().default(''),
  /**
   * Object ids permitted to sign in. **Empty admits nobody**, never everybody:
   * a tenant id alone would let every account in the directory in, and an
   * unconfigured allow-list must fail closed. Object ids and not UPNs — a UPN
   * can be renamed, and renamed onto a different person.
   */
  entraAllowedObjectIds: z.array(z.string()).default(['59e5362f-28b1-4b04-b6aa-b125fcb3c5ea']),
  backupOffsiteEnabled: z.boolean().default(false),
  /**
   * For R2: `https://<account id>.r2.cloudflarestorage.com`. Any S3-compatible
   * endpoint works; nothing here is Cloudflare-specific except the advice.
   */
  backupS3Endpoint: z.string().default(''),
  backupS3Bucket: z.string().default(''),
  /**
   * `auto` for R2, which has no regions but needs one in the credential scope
   * because Signature Version 4 has nowhere to put "none".
   */
  backupS3Region: z.string().default('auto'),
  /** Optional key prefix, so one bucket can hold more than one deployment. */
  backupS3Prefix: z.string().default(''),
  /**
   * Where the engine writes when something is wrong and nobody is looking.
   *
   * Empty means nothing is sent, which is the state a firm's backups were in
   * when they stopped for three days: every screen said green because nothing
   * had failed -- the schedule had simply stopped being asked, and no screen
   * was open anyway. A panel only shouts at somebody already looking at it.
   *
   * The engine sends this itself, over the SMTP credentials it already holds
   * and already renders into the mailer. Deliberately not through the
   * application's outbox: that table is the application's, its shape is the
   * application's to change, and a warning that needs the application working
   * goes quiet at exactly the moment it is worth having.
   */
  alertEmail: z.string().default(''),
  /**
   * The address the firm reaches the application at -- `https://cases.firm.sa`
   * -- handed to the application as APP_PUBLIC_URL so the messages it sends
   * can link back to the case, the task, the hearing. Empty means unknown,
   * and the application falls back to the address each request came to.
   */
  publicUrl: z.string().default(''),
})

const stateSchema = z.object({
  /** The QanoonTech version this deployment is on. */
  version: z.string().default('latest'),
  /** What it was on before the last change, so a rollback has somewhere to go. */
  previousVersion: z.string().optional(),
  // The default is parsed rather than written out, so the field defaults above
  // stay the single place each one is stated.
  settings: settingsSchema.default(() => settingsSchema.parse({})),
  /** Optional modules the operator has turned on. Required ones are implicit. */
  enabled: z.array(z.string()).default([]),
  /** Per-module configuration, validated against each module's own schema. */
  config: z.record(z.string(), z.unknown()).default({}),
  /**
   * Per-module resource overrides, keyed by module id. The catalogue states a
   * default that fits a modest box; an operator on a larger one raises it —
   * OCR on a 16 GB box can have far more than the 4 GB a small box allows.
   * Empty means "use the catalogue default".
   */
  resources: z
    .record(z.string(), z.object({ memory: z.string().optional(), cpus: z.string().optional() }))
    .default({}),
})

export type EngineState = z.infer<typeof stateSchema>
export type { DeploymentSettings }

const STATE_FILE = 'state.json'
const SECRETS_FILE = 'secrets.json'

export function loadState(dir = stateDir()): EngineState {
  const raw = readJsonFile(join(dir, STATE_FILE))
  return stateSchema.parse(raw ?? {})
}

/** Replace the whole file. For recovery and first boot; a change goes through `updateState`. */
export function saveState(state: EngineState, dir = stateDir()): void {
  withStateLock(() => writeJsonAtomic(join(dir, STATE_FILE), stateSchema.parse(state)), dir)
}

/*
 * Every change to state.json or secrets.json is a read-modify-write, and two
 * of them at once lose one: the CLI (`docker exec`) and the server share the
 * volume, and the server itself handles a request while the tick runs. This
 * is the lock they share — a directory, because `mkdir` is atomic on every
 * filesystem Docker mounts — held for the length of one synchronous
 * read-modify-write and never across an `await`. Reentrant within a process,
 * so a transaction may call `saveState` inside it. A lock older than
 * `staleMs` belongs to a process that died holding it and is taken over.
 */
const LOCK_DIR = '.write-lock'
let heldByThisProcess = false

export function withStateLock<T>(
  fn: () => T,
  dir = stateDir(),
  options: { timeoutMs?: number; staleMs?: number } = {},
): T {
  if (heldByThisProcess) return fn()
  const { timeoutMs = 5_000, staleMs = 15_000 } = options
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, LOCK_DIR)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) {
        throw new Error('The engine state is locked by another writer that has not finished. Try again in a moment.')
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  heldByThisProcess = true
  try {
    return fn()
  } finally {
    heldByThisProcess = false
    rmSync(lock, { recursive: true, force: true })
  }
}

/** Change the state: read it fresh under the lock, apply, write. Returns what was written. */
export function updateState(fn: (state: EngineState) => EngineState, dir = stateDir()): EngineState {
  return withStateLock(() => {
    const next = stateSchema.parse(fn(loadState(dir)))
    writeJsonAtomic(join(dir, STATE_FILE), next)
    return next
  }, dir)
}

/**
 * Secrets, kept in their own file so that anything reading configuration does
 * not incidentally read credentials. Mode 0600, and never rendered into
 * anything the operator can download — see the support bundle redactors.
 */
export function loadSecrets(dir = stateDir()): Record<string, string> {
  const raw = readJsonFile(join(dir, SECRETS_FILE))
  return z.record(z.string(), z.string()).parse(raw ?? {})
}

/** Replace the whole file. For recovery; a change goes through `updateSecrets`. */
export function saveSecrets(secrets: Record<string, string>, dir = stateDir()): void {
  withStateLock(() => writeJsonAtomic(join(dir, SECRETS_FILE), secrets), dir)
}

/** Change the secrets: read them fresh under the lock, apply, write. Returns what was written. */
export function updateSecrets(
  fn: (secrets: Record<string, string>) => Record<string, string>,
  dir = stateDir(),
): Record<string, string> {
  return withStateLock(() => {
    const next = fn(loadSecrets(dir))
    writeJsonAtomic(join(dir, SECRETS_FILE), next)
    return next
  }, dir)
}

/**
 * The secrets a deployment cannot start without.
 *
 * Generated, never chosen. Nobody types these, so a chosen value would only
 * ever be weaker than 32 random bytes — and a generated one cannot be the
 * password someone also uses for their email.
 */
export const GENERATED_SECRETS: readonly { name: string; generate: () => string }[] = [
  { name: 'DB_PASSWORD', generate: () => randomBytes(24).toString('hex') },
  { name: 'JWT_SECRET', generate: () => randomBytes(32).toString('hex') },
  { name: 'JWT_REFRESH_SECRET', generate: () => randomBytes(32).toString('hex') },
  // An AES-256 key rather than a token: the application base64-decodes it and
  // checks the length, so hex of the same nominal size decodes to 16 bytes and
  // is rejected.
  { name: 'SETTINGS_ENCRYPTION_KEY', generate: () => randomBytes(32).toString('base64') },
]

/**
 * The Web Push (VAPID) key pair: an ECDSA P-256 key, encoded the way the
 * `web-push` library and the browsers expect — the public key as the 65-byte
 * uncompressed point, the private key as its 32-byte scalar, both base64url.
 *
 * Generated here rather than by the application so that the pair is in the
 * secret store and in the encrypted snapshot, like every other credential the
 * deployment cannot be rebuilt without. The application generated its own into
 * `system_settings` until 1.16; the first deploy that injects this pair
 * replaces it, which costs each subscribed phone one tap to re-enable push.
 */
export function generateVapidPair(): { publicKey: string; privateKey: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string }
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  return { publicKey: point.toString('base64url'), privateKey: jwk.d }
}

/**
 * Secrets that only make sense together. A lone half is useless, so a pair
 * with either name missing is regenerated whole.
 */
export const GENERATED_PAIRS: readonly {
  names: readonly [string, string]
  generate: () => [string, string]
}[] = [
  {
    names: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
    generate: () => {
      const pair = generateVapidPair()
      return [pair.publicKey, pair.privateKey]
    },
  },
]

/** Every name the engine generates rather than asks for. */
export const GENERATED_SECRET_NAMES: readonly string[] = [
  ...GENERATED_SECRETS.map((g) => g.name),
  ...GENERATED_PAIRS.flatMap((p) => p.names),
]

export function isGeneratedSecret(name: string): boolean {
  return GENERATED_SECRET_NAMES.includes(name)
}

/**
 * Fill in any generated secret that is missing, leaving existing ones alone.
 *
 * Re-running must be safe. Regenerating JWT_SECRET signs everyone out;
 * regenerating DB_PASSWORD leaves the application unable to reach a database
 * that still has the old one, which looks like data loss and is unrecoverable
 * without the previous value.
 */
export function ensureGeneratedSecrets(existing: Record<string, string>): {
  secrets: Record<string, string>
  created: string[]
} {
  const secrets = { ...existing }
  const created: string[] = []
  for (const { name, generate } of GENERATED_SECRETS) {
    if (!secrets[name]) {
      secrets[name] = generate()
      created.push(name)
    }
  }
  for (const { names, generate } of GENERATED_PAIRS) {
    const [first, second] = names
    if (!secrets[first] || !secrets[second]) {
      const [a, b] = generate()
      secrets[first] = a
      secrets[second] = b
      created.push(first, second)
    }
  }
  return { secrets, created }
}
