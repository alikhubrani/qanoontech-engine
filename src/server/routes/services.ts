import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CATALOGUE, findModule } from '../../catalogue/index.js'
import * as docker from '../../docker/index.js'
import type { ServerContext } from '../context.js'
import { refuse } from '../guards.js'

/**
 * The services the deployment defines: what state they are in, their recent
 * output, and start/stop/restart. Nothing here accepts a name the catalogue
 * does not define, and the check happens in the route as well as in the
 * docker layer — the second is the boundary, the first is the good error.
 */

/** One line of `docker compose ps --format json` — the fields we read. */
const psLine = z.object({
  Service: z.string(),
  State: z.string(),
  Health: z.string().optional().default(''),
  Status: z.string().optional().default(''),
  Image: z.string().optional().default(''),
})

export interface ServiceView {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly required: boolean
  /** 'running' | 'exited' | ... from docker, or 'absent' when no container exists. */
  readonly state: string
  /** 'healthy' | 'unhealthy' | 'starting' | '' */
  readonly health: string
  readonly status: string
  readonly image: string
}

export async function listServices(): Promise<{ services: ServiceView[]; dockerError?: string }> {
  const result = await docker.ps()
  const running = new Map<string, z.infer<typeof psLine>>()
  let dockerError: string | undefined

  if (result.code === 0) {
    // compose emits one JSON object per line; some versions emit an array.
    const text = result.stdout.trim()
    const rows: unknown[] = []
    if (text.startsWith('[')) {
      try {
        rows.push(...(JSON.parse(text) as unknown[]))
      } catch {
        /* fall through with nothing parsed */
      }
    } else if (text !== '') {
      for (const line of text.split('\n')) {
        try {
          rows.push(JSON.parse(line))
        } catch {
          /* a non-JSON line; skip it */
        }
      }
    }
    for (const row of rows) {
      const parsed = psLine.safeParse(row)
      if (parsed.success) running.set(parsed.data.Service, parsed.data)
    }
  } else {
    dockerError = (result.stderr || result.stdout).trim() || 'Docker did not answer.'
  }

  const services = CATALOGUE.map((module): ServiceView => {
    const row = running.get(module.id)
    return {
      id: module.id,
      title: module.title,
      summary: module.summary,
      required: module.required,
      state: row?.State ?? 'absent',
      health: row?.Health ?? '',
      status: row?.Status ?? '',
      image: row?.Image ?? '',
    }
  })

  return dockerError === undefined ? { services } : { services, dockerError }
}

export function serviceRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/services', async () => {
    const { services, dockerError } = await listServices()
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

      ctx.audit.record(`service-${action}`, { detail: id, address: request.ip })
      const result = await docker[action]([id])
      if (result.code !== 0) {
        return refuse(reply, 502, (result.stderr || `Could not ${action} ${id}.`).trim())
      }
      return { success: true, data: {} }
    })
  }
}
