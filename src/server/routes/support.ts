import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import type { FastifyInstance } from 'fastify'
import { listBackups } from '../../backup/service.js'
import * as docker from '../../docker/index.js'
import { runPreflight } from '../../preflight/index.js'
import { loadSecrets, loadState } from '../../state/store.js'
import type { AuditLog } from '../audit.js'
import type { ServerContext } from '../context.js'
import { listServices } from './services.js'

/**
 * The support bundle: the only diagnostic channel for a box we cannot reach.
 * Nothing leaves the deployment unless the firm downloads this and chooses to
 * send it.
 *
 * Collected: service states, bounded logs, the application's own error log
 * from its volume, the generated compose file, the deployment state,
 * preflight, backup inventory, the audit log. Never collected: anything under
 * uploads, any database row, any secret, the application's security log.
 *
 * One gzipped JSON document rather than a tarball, on purpose: we are the
 * only consumer, JSON is greppable, and a single writer is a single place
 * redaction can be proven — see redactSecrets, whose tests run against the
 * real secret store.
 */

const LOG_LINES_PER_SERVICE = 300

/**
 * Redaction, three layers, each safe for what it runs over.
 *
 * Structured data is redacted *structurally*: deepRedact walks the object and
 * masks any value under a sensitive-looking key, so the JSON stays JSON. Text
 * blobs — the compose file, log output — get a line-oriented pass, because
 * they are lines. And the final serialized document gets a value scrub:
 * every stored secret's exact value replaced wherever it appears, catching a
 * secret that leaked somewhere nothing knew to look.
 *
 * The first version ran a key regex over the serialized JSON and produced a
 * bundle that would not parse — found on the staging box, on the first real
 * download. Hence the rule each layer now follows: redact the shape you are
 * actually looking at.
 */
const SENSITIVE_KEY = /(PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL)/i

export function deepRedact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepRedact)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
        SENSITIVE_KEY.test(key) && (typeof entry === 'string' || typeof entry === 'number')
          ? [key, '«redacted»']
          : [key, deepRedact(entry)],
      ),
    )
  }
  return value
}

export function redactLines(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.replace(
        /^(\s*"?[\w-]*(?:PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL)[\w-]*"?\s*[:=]\s*).*$/i,
        '$1«redacted»',
      ),
    )
    .join('\n')
}

export function scrubValues(text: string, secrets: Readonly<Record<string, string>>): string {
  let out = text
  for (const value of Object.values(secrets)) {
    if (value.length >= 6) out = out.split(value).join('«redacted»')
  }
  return out
}

export interface SupportBundle {
  readonly filename: string
  readonly gzipped: Buffer
}

/**
 * Build the bundle. Shared by the panel route and `support-bundle` on the
 * CLI, because the CLI is what a box with no panel session -- or a test
 * script -- has, and an operation the panel can do the CLI must do too.
 */
export async function buildSupportBundle(
  dir: string,
  audit: AuditLog,
  engineVersion: string,
): Promise<SupportBundle> {
    const secrets = loadSecrets(dir)
    const state = loadState(dir)

    const { services } = await listServices()
    const logs: Record<string, string> = {}
    for (const service of services) {
      if (service.state === 'absent') continue
      const result = await docker.logs(service.id, LOG_LINES_PER_SERVICE)
      logs[service.id] = redactLines(result.stdout.slice(-100_000))
    }

    // The structured application errors, thirty days deep, from the volume
    // stdout's 300 lines cannot reach. Redacted line by line like the rest.
    let applicationErrors = ''
    try {
      const result = await docker.readApplicationErrors()
      applicationErrors = redactLines(result.stdout.slice(-2_000_000))
    } catch (error) {
      applicationErrors = `(could not read the logs volume: ${(error as Error).message})`
    }

    let composeFile = ''
    try {
      composeFile = redactLines(readFileSync(docker.composeFilePath(dir), 'utf8'))
    } catch {
      composeFile = '(no rendered compose file)'
    }

    const bundle = {
      generatedAt: new Date().toISOString(),
      engineVersion,
      state: deepRedact({
        version: state.version,
        previousVersion: state.previousVersion ?? null,
        settings: state.settings,
        enabled: state.enabled,
        // Module config may hold identifiers but never credentials — those
        // live in the secret store. Redaction still walks all of it.
        config: state.config,
      }),
      services,
      logs,
      applicationErrors,
      composeFile,
      preflight: await runPreflight(dir),
      backups: listBackups(dir),
      audit: audit.recent(200),
    }

    const redacted = scrubValues(JSON.stringify(bundle, null, 2), secrets)
    return {
      filename: `qanoontech-support-${bundle.generatedAt.slice(0, 10)}.json.gz`,
      gzipped: gzipSync(Buffer.from(redacted)),
    }
}

export function supportRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/support-bundle', async (_request, reply) => {
    const { filename, gzipped } = await buildSupportBundle(ctx.dir, ctx.audit, ctx.engineVersion)
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(gzipped)
  })
}
