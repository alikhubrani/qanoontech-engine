import type { FastifyInstance } from 'fastify'
import { REQUIRED_MODULE_IDS } from '../../catalogue/index.js'
import { buildPlan } from '../../plan.js'
import { loadState } from '../../state/store.js'
import type { ServerContext } from '../context.js'
import { listServices } from './services.js'

/**
 * The page an operator leaves open: version, whether the deployment as
 * configured can actually be deployed, the state of every service, and the
 * latest audit entries. Everything wrong should be visible from here.
 */
export function overviewRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/overview', async () => {
    const state = loadState(ctx.dir)
    const plan = buildPlan(ctx.dir)
    const { services, dockerError } = await listServices()

    return {
      success: true,
      data: {
        engineVersion: ctx.engineVersion,
        version: state.version,
        previousVersion: state.previousVersion ?? null,
        bindAddress: state.settings.bindAddress,
        appPort: state.settings.appPort,
        modulesOn: [...REQUIRED_MODULE_IDS, ...state.enabled],
        plan: plan.ok
          ? { deployable: true, services: plan.moduleIds.length }
          : { deployable: false, problems: plan.problems },
        services,
        ...(dockerError ? { dockerError } : {}),
        audit: ctx.audit.recent(20),
      },
    }
  })
}
