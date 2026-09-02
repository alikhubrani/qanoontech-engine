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
import { checkHost, checkOrigin, defaultAllowedHosts, refuse } from './guards.js'
import { overviewRoutes } from './routes/overview.js'
import { SESSION_COOKIE, sessionRoutes } from './routes/session.js'
import { serviceRoutes } from './routes/services.js'

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

const OPEN_ROUTES = new Set(['/api/health', '/api/setup', '/api/session'])

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const dir = options.dir ?? stateDir()
  const state = loadState(dir)

  const ctx: ServerContext = {
    dir,
    auth: new AuthStore(dir),
    audit: new AuditLog(dir),
    guard: {
      allowedHosts: options.allowedHosts ?? defaultAllowedHosts(state.settings.bindAddress),
    },
    engineVersion: engineVersion(),
  }

  const app = Fastify({ logger: options.logger ?? true })
  app.register(cookie)

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
    if (!token || !ctx.auth.touchSession(token)) {
      return refuse(reply, 401, 'Sign in first.')
    }
  })

  app.get('/api/health', async () => ({ success: true, data: {} }))

  sessionRoutes(app, ctx)
  overviewRoutes(app, ctx)
  serviceRoutes(app, ctx)

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
