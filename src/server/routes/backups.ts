import type { FastifyInstance } from 'fastify'
import {
  deleteBackup,
  listBackups,
  restoreBackup,
  takeBackup,
} from '../../backup/service.js'
import type { ServerContext } from '../context.js'
import { refuse } from '../guards.js'

/**
 * Backups over the API: list, take, restore, delete. One at a time — the
 * flag guards helper containers that would otherwise race over the same
 * database.
 */
export function backupRoutes(app: FastifyInstance, ctx: ServerContext): void {
  let busy = false

  app.get('/api/backups', async () => ({
    success: true,
    data: { backups: listBackups(ctx.dir), busy },
  }))

  app.post('/api/backups', async (request, reply) => {
    if (busy) return refuse(reply, 409, 'A backup or restore is already running.')
    busy = true
    try {
      const outcome = await takeBackup('manual', ctx.dir)
      ctx.audit.record(outcome.ok ? 'backup-taken' : 'backup-failed', {
        detail: outcome.detail,
        address: request.ip,
      })
      if (!outcome.ok) return refuse(reply, 502, outcome.detail)
      return { success: true, data: { id: outcome.id } }
    } finally {
      busy = false
    }
  })

  app.post('/api/backups/:id/restore', async (request, reply) => {
    if (busy) return refuse(reply, 409, 'A backup or restore is already running.')
    const { id } = request.params as { id: string }
    busy = true
    try {
      ctx.audit.record('restore-started', { detail: id, address: request.ip })
      const result = await restoreBackup(id, ctx.dir)
      ctx.audit.record(result.ok ? 'restore-completed' : 'restore-failed', {
        detail: id,
        address: request.ip,
      })
      return { success: true, data: result }
    } finally {
      busy = false
    }
  })

  app.delete('/api/backups/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!deleteBackup(id, ctx.dir)) return refuse(reply, 404, 'No such backup.')
    ctx.audit.record('backup-deleted', { detail: id, address: request.ip })
    return { success: true, data: {} }
  })
}
