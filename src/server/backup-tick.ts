import type { FastifyInstance } from 'fastify'
import { pendingOffsite, uploadSet } from '../backup/offsite.js'
import { newestBackupAt, newestFullBackupAt, takeBackup } from '../backup/service.js'
import { backupDue } from '../backup/schedule.js'
import { backupHealth } from '../backup/health.js'
import { alertIfNeeded } from '../backup/alert.js'
import { loadState } from '../state/store.js'
import type { ServerContext } from './context.js'

/**
 * The backup loop. Same shape as the licence loop, same reasoning: the inputs
 * are on disk and the decision is a pure function, so a container recreated
 * on every update loses nothing. A busy flag keeps the tick from stacking a
 * second dump behind a slow one; it is in memory because the thing it guards
 * — a running helper container — dies with the process anyway.
 */

/*
 * Five minutes, because the interval it serves can be five minutes. A tick
 * coarser than the schedule turns "hourly" into "hourly, give or take a
 * quarter of an hour", and the point of the interval is that the number means
 * something. A tick that finds nothing due costs two `readdir`s.
 */
const TICK_MS = 5 * 60 * 1000

let running = false

export async function backupTick(ctx: ServerContext): Promise<void> {
  if (running) return
  const state = loadState(ctx.dir)
  const due = backupDue({
    newestAt: newestBackupAt(ctx.dir),
    newestFullAt: newestFullBackupAt(ctx.dir),
    now: Date.now(),
    backupHour: state.settings.backupHour,
    intervalMinutes: state.settings.backupIntervalMinutes,
    timezone: state.settings.timezone,
  })

  running = true
  try {
    if (due !== 'none') {
      const outcome = await takeBackup('scheduled', ctx.dir, due)
      ctx.audit.record(outcome.ok ? 'backup-taken' : 'backup-failed', { detail: outcome.detail })
    }

    // The offsite copy of the newest set, until it lands. Retried here rather
    // than fired-and-forgotten at take time, so an outage during the night is
    // healed by the next tick rather than by the next backup.
    const pending = pendingOffsite(ctx.dir)
    if (pending) {
      const sent = await uploadSet(pending, ctx.dir)
      ctx.audit.record(sent.ok ? 'offsite-uploaded' : 'offsite-failed', { detail: sent.detail })
    }

    /*
     * And say so when it has stopped.
     *
     * Last, and after the attempt above, so the state reported is the state
     * this tick leaves behind rather than the one it found. A firm's backups
     * stopped for three days with nothing failing anywhere -- the schedule had
     * simply stopped being asked -- so the check is on the *outcome*, not on
     * whether anything threw.
     */
    const health = backupHealth(ctx.dir)
    if (health.level === 'stale' || health.level === 'none') {
      ctx.audit.record('backup-stale', { detail: health.detail })
    }
    const alert = await alertIfNeeded(health, ctx.dir)
    if (alert.sent) ctx.audit.record('alert-sent', { detail: alert.detail })
  } finally {
    running = false
  }
}

export function startBackupLoop(app: FastifyInstance, ctx: ServerContext): void {
  const run = () => backupTick(ctx).catch((error) => app.log.error(error, 'backup tick failed'))
  void run()
  const timer = setInterval(run, TICK_MS)
  timer.unref()
  app.addHook('onClose', async () => clearInterval(timer))
}
