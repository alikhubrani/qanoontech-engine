import type { FastifyInstance } from 'fastify'
import {
  currentLicence,
  enforceClear,
  enforceStop,
  isEnforced,
  LICENCE_ENFORCED,
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

/**
 * `enforced` is a parameter so the enforcement path stays testable while the
 * switch is off. Production never passes it: the default is the switch, and a
 * second way to turn enforcement on in a real deployment is exactly what a
 * flag like this must not have.
 */
export async function licenceTick(
  ctx: ServerContext,
  enforced: boolean = LICENCE_ENFORCED,
): Promise<void> {
  /*
   * Licensing is switched off -- see licence/switch.ts.
   *
   * Lifting an enforcement that is already in place, rather than merely
   * declining to add one: a box stopped before the switch was flipped would
   * otherwise stay stopped with nothing left that could start it.
   */
  if (!enforced) {
    if (isEnforced(ctx.dir)) {
      const started = await enforceClear(ctx.dir)
      if (started.ok) // The existing vocabulary for "enforcement lifted"; the licence routes
      // record the same event when a good licence brings a box back.
      ctx.audit.record('licence-cleared', { detail: started.detail })
    }
    return
  }

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
