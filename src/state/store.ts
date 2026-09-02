import { randomBytes } from 'node:crypto'
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
  bindAddress: z.string().min(1).default('127.0.0.1'),
  appPort: z.number().int().min(1).max(65535).default(8080),
  dbName: z.string().min(1).default('qanoontech'),
  dbUser: z.string().min(1).default('qanoontech'),
  timezone: z.string().min(1).default('Asia/Riyadh'),
  defaultLanguage: z.enum(['ar', 'en']).default('ar'),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('warn'),
  maxFileSizeBytes: z.number().int().positive().default(52_428_800),
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
})

export type EngineState = z.infer<typeof stateSchema>
export type { DeploymentSettings }

const STATE_FILE = 'state.json'
const SECRETS_FILE = 'secrets.json'

export function loadState(dir = stateDir()): EngineState {
  const raw = readJsonFile(join(dir, STATE_FILE))
  return stateSchema.parse(raw ?? {})
}

export function saveState(state: EngineState, dir = stateDir()): void {
  writeJsonAtomic(join(dir, STATE_FILE), stateSchema.parse(state))
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

export function saveSecrets(secrets: Record<string, string>, dir = stateDir()): void {
  writeJsonAtomic(join(dir, SECRETS_FILE), secrets)
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
  return { secrets, created }
}
