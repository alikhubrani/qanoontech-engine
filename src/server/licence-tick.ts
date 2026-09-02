import type { FastifyInstance } from 'fastify'
import {
  currentLicence,
  enforceStop,
  isEnforced,
  licencePublicKey,
  performHeartbeat,
  readHeartbeat,
} from '../licence/index.js'
import { observedNow } from '../licence/clock.js'
import type { ServerContext } from './context.js'

/**
 * The loop that keeps the licence honest: heartbeat when due, then act on
 * what the state machine says. It runs at boot and every 15 minutes — the
 * interval does not need to be clever, because everything it reads and
 * writes is durable and the state machine is a function of the files.
 */

const TICK_MS = 15 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

export async function licenceTick(ctx: ServerContext): Promise<void> {
  let status = await currentLicence(ctx.dir)
  if (status.standing === 'missing' || status.standing === 'invalid') return

  // Heartbeat when due — at half the licence's interval, so one failed
  // attempt still leaves attempts inside the window, and never for an
  // override, whose whole point is answering to nothing.
  if (status.claims && !status.claims.override) {
    const dueEvery = (status.claims.heartbeat.intervalHours * HOUR_MS) / 2
    if (observedNow(ctx.dir) - readHeartbeat(ctx.dir).lastAttemptAt >= dueEvery) {
      await performHeartbeat(status.claims, licencePublicKey(), ctx.dir)
      status = await currentLicence(ctx.dir)
    }
  }

  if (status.standing === 'enforce' && !isEnforced(ctx.dir)) {
    const stopped = await enforceStop(ctx.dir)
    // A failed stop is not an enforcement: no marker was written, and the
    // next tick tries again. Only what actually happened is recorded.
    if (stopped.ok) ctx.audit.record('licence-enforced', { detail: stopped.detail })
  }
}

export function startLicenceLoop(app: FastifyInstance, ctx: ServerContext): void {
  const run = () =>
    licenceTick(ctx).catch((error) => app.log.error(error, 'licence tick failed'))
  void run()
  const timer = setInterval(run, TICK_MS)
  timer.unref()
  app.addHook('onClose', async () => clearInterval(timer))
}
