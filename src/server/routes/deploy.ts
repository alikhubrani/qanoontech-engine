import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CATALOGUE, findModule } from '../../catalogue/index.js'
import * as docker from '../../docker/index.js'
import { runPreflight } from '../../preflight/index.js'
import { REGISTRY, listVersions, probeRegistry, storedRegistryAuth } from '../../registry.js'
import { loadSecrets, loadState, saveSecrets, saveState } from '../../state/store.js'
import type { ServerContext } from '../context.js'
import { refuse } from '../guards.js'
import { rollbackVersion, setVersion, type JobRunner } from '../jobs.js'

const settingsPatchSchema = z.object({
  bindAddress: z.string().min(1).optional(),
  appPort: z.number().int().min(1).max(65535).optional(),
  timezone: z.string().min(1).optional(),
  defaultLanguage: z.enum(['ar', 'en']).optional(),
})

/**
 * Everything the Deploy page talks to: settings, the registry credential,
 * preflight, versions, module toggles, and the deploy job itself.
 */
export function deployRoutes(app: FastifyInstance, ctx: ServerContext, jobs: JobRunner): void {
  // -- settings -------------------------------------------------------------

  app.get('/api/settings', async () => {
    const state = loadState(ctx.dir)
    return { success: true, data: { settings: state.settings, enabled: state.enabled } }
  })

  app.put('/api/settings', async (request, reply) => {
    const body = settingsPatchSchema.safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'Those settings are not valid.')

    const state = loadState(ctx.dir)
    const patch = Object.fromEntries(
      Object.entries(body.data).filter(([, value]) => value !== undefined),
    )
    saveState({ ...state, settings: { ...state.settings, ...patch } }, ctx.dir)
    ctx.audit.record('settings-changed', { address: request.ip })
    return { success: true, data: {} }
  })

  // -- registry credential --------------------------------------------------

  app.put('/api/registry', async (request, reply) => {
    const body = z
      .object({ username: z.string().min(1), token: z.string().min(1) })
      .safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'A username and token are required.')

    // Proven before it is stored, same as the licence: a bad credential is
    // named now, not four steps later as `manifest unknown`.
    const probe = await probeRegistry(body.data)
    if (!probe.ok) return refuse(reply, 422, probe.detail)

    const secrets = loadSecrets(ctx.dir)
    saveSecrets(
      { ...secrets, GHCR_USERNAME: body.data.username, GHCR_TOKEN: body.data.token },
      ctx.dir,
    )

    // Docker holds its own copy: pulls go through the daemon, not through us.
    const login = await docker.login(REGISTRY, body.data.username, body.data.token)
    ctx.audit.record('registry-changed', { address: request.ip })
    return {
      success: true,
      data: {
        dockerLogin: login.code === 0,
        detail:
          login.code === 0
            ? 'Credential verified and stored with Docker.'
            : `Credential verified, but docker login failed: ${login.stderr.trim() || 'unknown'} — pulls may not work until it succeeds.`,
      },
    }
  })

  app.get('/api/registry', async () => {
    const auth = storedRegistryAuth(ctx.dir)
    return { success: true, data: { configured: auth !== undefined, username: auth?.username ?? null } }
  })

  // -- preflight and versions -----------------------------------------------

  app.get('/api/preflight', async () => ({
    success: true,
    data: { checks: await runPreflight(ctx.dir) },
  }))

  app.get('/api/versions', async () => {
    const auth = storedRegistryAuth(ctx.dir)
    if (!auth) {
      return { success: true, data: { versions: [], detail: 'Set the registry credential first.' } }
    }
    const result = await listVersions(auth)
    return result.ok
      ? { success: true, data: { versions: result.versions } }
      : { success: true, data: { versions: [], detail: result.detail } }
  })

  app.post('/api/version', async (request, reply) => {
    const body = z.object({ version: z.string().min(1) }).safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'A version is required.')
    if (jobs.isRunning()) return refuse(reply, 409, 'A deploy is already running.')
    setVersion(body.data.version, ctx.dir)
    ctx.audit.record('version-set', { detail: body.data.version, address: request.ip })
    return { success: true, data: {} }
  })

  app.post('/api/rollback', async (request, reply) => {
    if (jobs.isRunning()) return refuse(reply, 409, 'A deploy is already running.')
    const result = rollbackVersion(ctx.dir)
    if (!result.ok) return refuse(reply, 409, result.detail)
    ctx.audit.record('version-set', { detail: `rollback to ${result.version}`, address: request.ip })
    return { success: true, data: { version: result.version, detail: result.detail } }
  })

  // -- modules --------------------------------------------------------------

  app.get('/api/modules', async () => {
    const state = loadState(ctx.dir)
    return {
      success: true,
      data: {
        modules: CATALOGUE.map((module) => ({
          id: module.id,
          title: module.title,
          summary: module.summary,
          required: module.required,
          cost: module.cost,
          entitlement: module.entitlement ?? null,
          enabled: module.required || state.enabled.includes(module.id),
          config: state.config[module.id] ?? null,
        })),
      },
    }
  })

  app.post('/api/modules/:id/enable', async (request, reply) => {
    const { id } = request.params as { id: string }
    const module = findModule(id)
    if (!module) return refuse(reply, 404, `No module named '${id}'.`)
    if (module.required) return refuse(reply, 409, `'${module.title}' is part of the system and is always on.`)

    const state = loadState(ctx.dir)
    if (!state.enabled.includes(id)) {
      saveState({ ...state, enabled: [...state.enabled, id] }, ctx.dir)
    }
    ctx.audit.record('module-enabled', { detail: id, address: request.ip })
    return { success: true, data: {} }
  })

  app.post('/api/modules/:id/disable', async (request, reply) => {
    const { id } = request.params as { id: string }
    const module = findModule(id)
    if (!module) return refuse(reply, 404, `No module named '${id}'.`)
    if (module.required) return refuse(reply, 409, `'${module.title}' cannot be turned off.`)

    const state = loadState(ctx.dir)
    saveState({ ...state, enabled: state.enabled.filter((m) => m !== id) }, ctx.dir)
    ctx.audit.record('module-disabled', { detail: id, address: request.ip })
    return { success: true, data: {} }
  })

  app.put('/api/modules/:id/config', async (request, reply) => {
    const { id } = request.params as { id: string }
    const module = findModule(id)
    if (!module) return refuse(reply, 404, `No module named '${id}'.`)

    const body = z.object({ config: z.unknown() }).safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'A config object is required.')

    const parsed = module.config.safeParse(body.data.config)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
        .join('; ')
      return refuse(reply, 422, `Not valid for '${module.title}': ${issues}`)
    }

    const state = loadState(ctx.dir)
    saveState({ ...state, config: { ...state.config, [id]: body.data.config } }, ctx.dir)
    ctx.audit.record('module-configured', { detail: id, address: request.ip })
    return { success: true, data: {} }
  })

  // -- the deploy job -------------------------------------------------------

  app.post('/api/deploy', async (request, reply) => {
    if (!jobs.startDeploy()) return refuse(reply, 409, 'A deploy is already running.')
    ctx.audit.record('deploy-started', { address: request.ip })
    return { success: true, data: {} }
  })

  app.get('/api/deploy', async () => {
    const job = jobs.current()
    return {
      success: true,
      data: job
        ? {
            running: job.finishedAt === undefined,
            step: job.step,
            ok: job.ok ?? null,
            log: job.log,
            startedAt: job.startedAt,
          }
        : null,
    }
  })
}
