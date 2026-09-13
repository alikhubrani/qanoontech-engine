import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { loadState, stateDir } from '../state/store.js'
import { AuditLog } from './audit.js'
import { AuthStore } from './auth.js'
import type { ServerContext } from './context.js'
import { checkHost, checkOrigin, defaultAllowedHosts, hostOfRedirect, refuse } from './guards.js'
import { startBackupLoop } from './backup-tick.js'
import { JobRunner } from './jobs.js'
import { auditRoutes } from './routes/audit.js'
import { backupRoutes } from './routes/backups.js'
import { deployRoutes } from './routes/deploy.js'
import { engineRoutes } from './routes/engine.js'
import { overviewRoutes } from './routes/overview.js'
import { SESSION_COOKIE, sessionRoutes } from './routes/session.js'
import { serviceRoutes } from './routes/services.js'
import { supportRoutes } from './routes/support.js'

/**
 * The engine's web server.
 *
 * Request order is guard → session → route: a request that fails the Host or
 * Origin check is refused before anything reads it, and only /api/health,
 * /api/setup and signing in answer without a session. The UI's static files
 * are served to anyone who can reach the port — they contain nothing; every
 * fact on every page comes from the API.
 */

export interface ServerOptions {
  readonly dir?: string
  readonly allowedHosts?: readonly string[]
  /** Directory of built UI files. Omit to serve API only. */
  readonly uiDir?: string
  readonly logger?: boolean
}

/**
 * The only routes that answer without a session.
 *
 * The two Entra paths belong here for the obvious reason and it is worth
 * stating anyway: they *are* the sign-in. Leaving them behind the session check
 * makes signing in require being signed in, which fails as a 401 on the
 * callback — after Microsoft has authenticated the person, which is the most
 * confusing place for it to fail.
 *
 * Everything here is written to give a stranger nothing: health returns an
 * empty object, setup refuses once configured, a failed sign-in does not
 * distinguish its reasons, and the callback refuses anything that did not
 * start on this box.
 */
const OPEN_ROUTES = new Set([
  '/api/health',
  '/api/session/entra/start',
  '/api/session/entra/callback',
])

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const dir = options.dir ?? stateDir()
  const state = loadState(dir)

  const ctx: ServerContext = {
    dir,
    auth: new AuthStore(dir),
    audit: new AuditLog(dir),
    guard: {
      allowedHosts:
        options.allowedHosts ??
        defaultAllowedHosts(state.settings.bindAddress, hostOfRedirect(state.settings.entraRedirectUri)),
    },
    engineVersion: engineVersion(),
  }

  const app = Fastify({ logger: options.logger ?? true })
  app.register(cookie)
  // Who is asking, once the session hook has said. Declared in context.ts.
  app.decorateRequest('operator', undefined)

  app.addHook('onRequest', async (request, reply) => {
    if (!checkHost(request, ctx.guard)) {
      // The one log a refused request gets; rebinding probes should be seen.
      request.log.warn({ host: request.headers.host }, 'refused: host not served here')
      return refuse(reply, 421, 'This engine does not serve that host name.')
    }
    if (!checkOrigin(request, ctx.guard)) {
      return refuse(reply, 403, 'Cross-origin requests are refused.')
    }

    if (!request.url.startsWith('/api/')) return // static files carry no facts
    const path = request.url.split('?')[0] ?? request.url
    if (OPEN_ROUTES.has(path)) return
    // Signing out with a dead cookie should succeed, not 401.
    if (path === '/api/session' && request.method === 'DELETE') return

    const token = request.cookies[SESSION_COOKIE]
    const session = token ? ctx.auth.touchSession(token) : undefined
    if (!session) {
      return refuse(reply, 401, 'Sign in first.')
    }
    request.operator = session.subject
  })

  app.get('/api/health', async () => ({ success: true, data: {} }))

  sessionRoutes(app, ctx)
  overviewRoutes(app, ctx)
  auditRoutes(app, ctx)
  serviceRoutes(app, ctx)
  deployRoutes(app, ctx, new JobRunner(dir))
  backupRoutes(app, ctx)
  engineRoutes(app, ctx)
  supportRoutes(app, ctx)

  /*
   * The schedule. Started unconditionally, and never again behind a flag.
   *
   * This call used to sit inside `if (options.licenceLoop ?? true) { ... }`
   * alongside the licence loop, sharing a switch with something it has nothing
   * to do with. Removing licensing removed the block and took this with it, and
   * a firm's box ran for two hours with no schedule at all while reporting
   * itself healthy.
   *
   * It reported healthy because `backup-stale` — the check written *because*
   * backups once stopped for three days unnoticed — is recorded by the tick. A
   * detector inside the thing it watches cannot report that thing being dead.
   * `backupLoopStartedAt` exists so that fact is observable from outside.
   */
  startBackupLoop(app, ctx)

  const uiDir = options.uiDir ?? defaultUiDir()
  if (uiDir && existsSync(join(uiDir, 'index.html'))) {
    app.register(fastifyStatic, { root: uiDir })
    // The UI is a single page; any non-API path is a client-side route.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return refuse(reply, 404, 'No such route.')
      }
      return reply.sendFile('index.html')
    })
  }

  return app
}

export async function startServer(port = 8080, host = '0.0.0.0'): Promise<void> {
  // 0.0.0.0 *inside the container* is correct and unrelated to the renderer's
  // wildcard refusal: publishing decides reachability, and the compose file
  // publishes this port on the box's chosen address only.
  const app = buildServer()
  await app.listen({ port, host })
}

function engineVersion(): string {
  // The image bakes the release tag in; package.json is the fallback for a
  // checkout run by hand and is the number that once lagged behind the tag.
  const baked = process.env.ENGINE_VERSION?.trim()
  if (baked && baked !== 'dev') return baked
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const relative of ['../../package.json', '../../../package.json']) {
      const path = join(here, relative)
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: string }
        if (parsed.version) return parsed.version
      }
    }
  } catch {
    /* fall through */
  }
  return 'dev'
}

function defaultUiDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const relative of ['../../ui/dist', '../../../ui/dist']) {
    const path = join(here, relative)
    if (existsSync(path)) return path
  }
  return undefined
}
