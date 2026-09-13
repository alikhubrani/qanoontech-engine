import type { FastifyInstance } from 'fastify'
import { REQUIRED_MODULE_IDS } from '../../catalogue/index.js'
import { readDeployment } from '../../health/deployment.js'
import { listServices, runningVersion } from '../../services.js'
import { loadState } from '../../state/store.js'
import type { ServerContext } from '../context.js'

/**
 * The page an operator leaves open.
 *
 * It leads with the assessment — one verdict computed from the disk and from
 * Docker at request time, the same one `engine status` prints — and carries
 * the notable audit entries, not the routine ones. Everything wrong should be
 * visible from here, and until 0.20.0 the four things the last three phases
 * built (offsite copies, encrypted engine state, an external database,
 * pinned sign-in) were not.
 */
export function overviewRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/overview', async (request) => {
    const state = loadState(ctx.dir)
    const listed = await listServices(ctx.dir)
    const assessment = await readDeployment(ctx.dir, listed)

    return {
      success: true,
      data: {
        engineVersion: ctx.engineVersion,
        version: state.version,
        previousVersion: state.previousVersion ?? null,
        runningVersion: runningVersion(listed.services) ?? null,
        bindAddress: state.settings.bindAddress,
        appPort: state.settings.appPort,
        timezone: state.settings.timezone,
        modulesOn: [...REQUIRED_MODULE_IDS, ...state.enabled],
        plan: assessment.plan,
        services: listed.services,
        ...(listed.dockerError ? { dockerError: listed.dockerError } : {}),
        assessment,
        operator: request.operator ?? null,
        audit: ctx.audit.recent({ limit: 8, kinds: ['security', 'change', 'failure'] }),
      },
    }
  })
}
