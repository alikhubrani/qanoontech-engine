import type { FastifyInstance } from 'fastify'
import { pendingOffsite, uploadSet } from '../backup/offsite.js'
import { newestBackupAt, takeBackup } from '../backup/service.js'
import { backupDue } from '../backup/schedule.js'
import { loadState } from '../state/store.js'
import type { ServerContext } from './context.js'

/**
 * The backup loop. Same shape as the licence loop, same reasoning: the inputs
 * are on disk and the decision is a pure function, so a container recreated
 * on every update loses nothing. A busy flag keeps the tick from stacking a
 * second dump behind a slow one; it is in memory because the thing it guards
 * — a running helper container — dies with the process anyway.
 */

const TICK_MS = 15 * 60 * 1000

let running = false

export async function backupTick(ctx: ServerContext): Promise<void> {
  if (running) return
  const state = loadState(ctx.dir)
  const due = backupDue({
    newestAt: newestBackupAt(ctx.dir),
    now: Date.now(),
    backupHour: state.settings.backupHour,
    timezone: state.settings.timezone,
  })

  running = true
  try {
    if (due) {
      const outcome = await takeBackup('scheduled', ctx.dir)
      ctx.audit.record(outcome.ok ? 'backup-taken' : 'backup-failed', { detail: outcome.detail })
    }

    // The offsite copy of the newest set, until it lands. Retried here rather
    // than fired-and-forgotten at take time, so a Drive outage during the
    // night is healed by the next quarter-hour rather than the next backup.
    const pending = pendingOffsite(ctx.dir)
    if (pending) {
      const sent = await uploadSet(pending, ctx.dir)
      ctx.audit.record(sent.ok ? 'offsite-uploaded' : 'offsite-failed', { detail: sent.detail })
    }
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
