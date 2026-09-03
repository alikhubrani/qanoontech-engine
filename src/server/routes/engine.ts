import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as docker from '../../docker/index.js'
import { ENGINE_REPOSITORY, listVersions, storedRegistryAuth } from '../../registry.js'
import type { ServerContext } from '../context.js'
import { refuse } from '../guards.js'

/**
 * The engine updating itself, from the panel — the last operation that still
 * needed a shell.
 *
 * POST hands the work to a detached helper container (pull, remove this
 * container, recreate from the standard run configuration) and answers
 * immediately: this process is about to be removed, and an answer that waited
 * for the swap would never arrive. The client watches GET /api/engine until
 * the version it reports changes; a pull that fails leaves the old engine
 * exactly where it was, still answering, still on the old number — which is
 * itself the failure report.
 */
export function engineRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/engine', async () => {
    const auth = storedRegistryAuth(ctx.dir)
    const available = auth ? await listVersions(auth, ENGINE_REPOSITORY) : null
    return {
      success: true,
      data: {
        version: ctx.engineVersion,
        available: available?.ok ? available.versions : [],
        detail: available && !available.ok ? available.detail : null,
      },
    }
  })

  app.post('/api/engine/update', async (request, reply) => {
    const body = z
      .object({ version: z.string().regex(/^[\w.\-]{1,64}$/) })
      .safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'A version is required.')

    ctx.audit.record('engine-update-started', {
      detail: `${ctx.engineVersion} → ${body.data.version}`,
      address: request.ip,
    })

    const image = `ghcr.io/${ENGINE_REPOSITORY}:${body.data.version}`
    const result = await docker.selfUpdate(
      image,
      docker.ENGINE_CONTAINER_NAME,
      docker.ENGINE_RUN_ARGS,
    )
    if (result.code !== 0) {
      return refuse(reply, 502, (result.stderr || 'Could not start the update helper.').trim())
    }
    return { success: true, data: { detail: 'The update helper is running; this panel will restart.' } }
  })
}
