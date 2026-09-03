import type { FastifyInstance } from 'fastify'
import {
  fetchSet,
  listRemote,
  offsiteClient,
  readOffsite,
  uploadSet,
} from '../../backup/offsite.js'
import {
  deleteBackup,
  listBackups,
  restoreBackup,
  takeBackup,
} from '../../backup/service.js'
import { loadState } from '../../state/store.js'
import type { ServerContext } from '../context.js'
import { refuse } from '../guards.js'

/**
 * Backups over the API: list, take, restore, delete. One at a time — the
 * flag guards helper containers that would otherwise race over the same
 * database.
 */
export function backupRoutes(app: FastifyInstance, ctx: ServerContext): void {
  let busy = false

  app.get('/api/backups', async () => {
    const offsite = offsiteClient(ctx.dir)
    const settings = loadState(ctx.dir).settings
    return {
      success: true,
      data: {
        backups: listBackups(ctx.dir).map((set) => ({
          ...set,
          offsite: readOffsite(set.id, ctx.dir),
        })),
        busy,
        offsiteConfig: {
          enabled: settings.backupOffsiteEnabled,
          driveId: settings.backupOffsiteDriveId,
          ready: offsite.client !== null,
          reason: offsite.client === null && offsite.reason !== 'off' ? offsite.reason : null,
        },
      },
    }
  })

  app.get('/api/backups/offsite', async () => {
    const result = await listRemote(ctx.dir)
    return { success: true, data: result.ok ? { sets: result.sets } : { sets: [], detail: result.detail } }
  })

  app.post('/api/backups/offsite/fetch', async (request, reply) => {
    if (busy) return refuse(reply, 409, 'A backup or restore is already running.')
    const { name } = (request.body ?? {}) as { name?: string }
    if (!name) return refuse(reply, 400, 'A backup name is required.')
    busy = true
    try {
      const result = await fetchSet(name, ctx.dir)
      ctx.audit.record(result.ok ? 'offsite-fetched' : 'offsite-failed', {
        detail: result.detail,
        address: request.ip,
      })
      if (!result.ok) return refuse(reply, 502, result.detail)
      return { success: true, data: {} }
    } finally {
      busy = false
    }
  })

  app.post('/api/backups/:id/offsite', async (request, reply) => {
    if (busy) return refuse(reply, 409, 'A backup or restore is already running.')
    const { id } = request.params as { id: string }
    busy = true
    try {
      const result = await uploadSet(id, ctx.dir)
      ctx.audit.record(result.ok ? 'offsite-uploaded' : 'offsite-failed', {
        detail: result.detail,
        address: request.ip,
      })
      if (!result.ok) return refuse(reply, 502, result.detail)
      return { success: true, data: {} }
    } finally {
      busy = false
    }
  })

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
