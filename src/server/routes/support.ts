import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import type { FastifyInstance } from 'fastify'
import { listBackups } from '../../backup/service.js'
import * as docker from '../../docker/index.js'
import { currentLicence } from '../../licence/index.js'
import { runPreflight } from '../../preflight/index.js'
import { loadSecrets, loadState } from '../../state/store.js'
import type { ServerContext } from '../context.js'
import { listServices } from './services.js'

/**
 * The support bundle: the only diagnostic channel for a box we cannot reach.
 * Nothing leaves the deployment unless the firm downloads this and chooses to
 * send it.
 *
 * Collected: service states, bounded logs, the generated compose file, the
 * deployment state, preflight, licence standing, backup inventory, the audit
 * log. Never collected: anything under uploads, any database row, any secret.
 *
 * One gzipped JSON document rather than a tarball, on purpose: we are the
 * only consumer, JSON is greppable, and a single writer is a single place
 * redaction can be proven — see redactSecrets, whose tests run against the
 * real secret store.
 */

const LOG_LINES_PER_SERVICE = 300

/**
 * Redaction, two layers deep. Known-sensitive keys are masked by *name*
 * wherever they appear. Then every stored secret *value* is scrubbed from the
 * whole text — so a secret that leaks somewhere unexpected (a connection
 * string, an error message, a log line) is caught by its value even though
 * nothing knew to look for it there.
 */
export function redactSecrets(text: string, secrets: Readonly<Record<string, string>>): string {
  let out = text
  for (const value of Object.values(secrets)) {
    if (value.length >= 6) out = out.split(value).join('«redacted»')
  }
  out = out.replace(
    /("?)((?:\w*(?:PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL)\w*)\1\s*[:=]\s*)("?)([^"\n,}]+)\3/gi,
    '$1$2$3«redacted»$3',
  )
  return out
}

export function supportRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/support-bundle', async (_request, reply) => {
    const dir = ctx.dir
    const secrets = loadSecrets(dir)
    const state = loadState(dir)

    const { services } = await listServices()
    const logs: Record<string, string> = {}
    for (const service of services) {
      if (service.state === 'absent') continue
      const result = await docker.logs(service.id, LOG_LINES_PER_SERVICE)
      logs[service.id] = result.stdout.slice(-100_000)
    }

    let composeFile = ''
    try {
      composeFile = readFileSync(docker.composeFilePath(dir), 'utf8')
    } catch {
      composeFile = '(no rendered compose file)'
    }

    const licence = await currentLicence(dir)

    const bundle = {
      generatedAt: new Date().toISOString(),
      engineVersion: ctx.engineVersion,
      state: {
        version: state.version,
        previousVersion: state.previousVersion ?? null,
        settings: state.settings,
        enabled: state.enabled,
        // Module config may hold identifiers but never credentials — those
        // live in the secret store. Redaction still runs over all of it.
        config: state.config,
      },
      licence: { standing: licence.standing, message: licence.message },
      services,
      logs,
      composeFile,
      preflight: await runPreflight(dir),
      backups: listBackups(dir),
      audit: ctx.audit.recent(200),
    }

    const redacted = redactSecrets(JSON.stringify(bundle, null, 2), secrets)
    const gzipped = gzipSync(Buffer.from(redacted))

    return reply
      .header('content-type', 'application/gzip')
      .header(
        'content-disposition',
        `attachment; filename="qanoontech-support-${bundle.generatedAt.slice(0, 10)}.json.gz"`,
      )
      .send(gzipped)
  })
}
