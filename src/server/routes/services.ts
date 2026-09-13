import type { FastifyInstance } from 'fastify'
import { findModule } from '../../catalogue/index.js'
import * as docker from '../../docker/index.js'
import { listServices } from '../../services.js'
import type { ServerContext } from '../context.js'
import { refuse, who } from '../guards.js'

/**
 * The services over the API: what state they are in, their recent output,
 * and start/stop/restart. The rows themselves come from `src/services.ts`,
 * which the overview and `engine status` read too. Nothing here accepts a
 * name the catalogue does not define, and the check happens in the route as
 * well as in the docker layer — the second is the boundary, the first is the
 * good error.
 */
export { listServices } from '../../services.js'
export type { ServiceView } from '../../services.js'

export function serviceRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/services', async () => {
    const { services, dockerError } = await listServices(ctx.dir)
    return { success: true, data: { services, ...(dockerError ? { dockerError } : {}) } }
  })

  app.get('/api/services/:id/logs', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!findModule(id)) return refuse(reply, 404, `No service named '${id}'.`)

    const query = request.query as { lines?: string }
    const lines = Math.min(Math.max(Number(query.lines) || 200, 1), 2000)
    const result = await docker.logs(id, lines)
    if (result.code !== 0) {
      return refuse(reply, 502, (result.stderr || 'Could not read logs.').trim())
    }
    return { success: true, data: { logs: result.stdout } }
  })

  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/services/:id/${action}`, async (request, reply) => {
      const { id } = request.params as { id: string }
      const module = findModule(id)
      if (!module) return refuse(reply, 404, `No service named '${id}'.`)

      ctx.audit.record(`service-${action}`, { detail: id, address: request.ip, ...who(request) })
      const result = await docker[action]([id])
      if (result.code !== 0) {
        return refuse(reply, 502, (result.stderr || `Could not ${action} ${id}.`).trim())
      }
      return { success: true, data: {} }
    })
  }
}
