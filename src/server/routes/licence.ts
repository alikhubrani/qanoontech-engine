import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  currentLicence,
  enforceClear,
  installLicence,
  isEnforced,
  licencePublicKey,
  readHeartbeat,
  verifyLicence,
} from '../../licence/index.js'
import type { ServerContext } from '../context.js'
import { refuse } from '../guards.js'

/**
 * The licence, as the operator sees it: what standing it is in, and a way to
 * install a new one. Installing is the remedy for everything — expiry,
 * revocation, an enforcement that already fired — so it also lifts
 * enforcement and restarts what enforcement stopped, when the new licence is
 * good.
 */
export function licenceRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/licence', async () => {
    const status = await currentLicence(ctx.dir)
    const heartbeat = readHeartbeat(ctx.dir)
    return {
      success: true,
      data: {
        standing: status.standing,
        message: status.message,
        problem: status.problem ?? null,
        graceUsedDays: status.graceUsedDays ?? null,
        graceDays: status.graceDays ?? null,
        enforced: isEnforced(ctx.dir),
        claims: status.claims
          ? {
              firmName: status.claims.firmName,
              licenceId: status.claims.licenceId,
              expiresAt: status.claims.expiresAt,
              entitlements: status.claims.entitlements,
              seats: status.claims.seats,
              override: status.claims.override,
            }
          : null,
        heartbeat: {
          lastSuccessAt: heartbeat.lastSuccessAt || null,
          lastError: heartbeat.lastError || null,
        },
      },
    }
  })

  app.put('/api/licence', async (request, reply) => {
    const body = z.object({ token: z.string().min(1) }).safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'A licence is required.')

    // Verified before it is written: an operator pasting the wrong thing gets
    // told now, not a panel that silently degrades on the next tick.
    const verified = await verifyLicence(body.data.token, licencePublicKey())
    if (!verified.ok) return refuse(reply, 422, verified.message)

    const wasEnforced = isEnforced(ctx.dir)
    installLicence(body.data.token, ctx.dir)
    ctx.audit.record('licence-installed', {
      detail: verified.claims.licenceId,
      address: request.ip,
    })

    const status = await currentLicence(ctx.dir)
    if (wasEnforced && (status.standing === 'ok' || status.standing === 'grace')) {
      const cleared = await enforceClear(ctx.dir)
      ctx.audit.record('licence-cleared', { detail: cleared.detail, address: request.ip })
    }

    return { success: true, data: { standing: status.standing, message: status.message } }
  })
}
