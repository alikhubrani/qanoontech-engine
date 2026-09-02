import type { FastifyInstance, FastifyReply } from 'fastify'
import '@fastify/cookie'
import { z } from 'zod'
import type { ServerContext } from '../context.js'
import { refuse } from '../guards.js'

export const SESSION_COOKIE = 'engine_session'

const passwordSchema = z.object({ password: z.string().min(1).max(1024) })
const setupSchema = z.object({ password: z.string().min(12).max(1024) })

/**
 * First-run setup and sign-in.
 *
 * These are the only routes that answer without a session, and neither says
 * anything a stranger could use: setup refuses once a password exists, and a
 * failed login does not distinguish "wrong password" from "no password yet".
 */
export function sessionRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/setup', async () => ({
    success: true,
    data: { needed: !ctx.auth.isConfigured() },
  }))

  app.post('/api/setup', async (request, reply) => {
    if (ctx.auth.isConfigured()) {
      return refuse(reply, 409, 'Already set up. Sign in instead.')
    }
    const body = setupSchema.safeParse(request.body)
    if (!body.success) {
      return refuse(reply, 400, 'The password must be at least 12 characters.')
    }
    ctx.auth.setPassword(body.data.password)
    ctx.audit.record('setup', { address: request.ip })

    const token = ctx.auth.createSession()
    setSessionCookie(reply, token)
    return { success: true, data: {} }
  })

  app.post('/api/session', async (request, reply) => {
    const body = passwordSchema.safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'A password is required.')

    const result = ctx.auth.verifyPassword(body.data.password)
    if (!result.ok) {
      if (result.lockedForMs !== undefined) {
        ctx.audit.record('login-locked', { address: request.ip })
        const minutes = Math.ceil(result.lockedForMs / 60_000)
        return refuse(
          reply,
          429,
          `Locked after repeated failures. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        )
      }
      ctx.audit.record('login-failed', { address: request.ip })
      return refuse(reply, 401, 'That is not the password.')
    }

    ctx.audit.record('login', { address: request.ip })
    const token = ctx.auth.createSession()
    setSessionCookie(reply, token)
    return { success: true, data: {} }
  })

  app.delete('/api/session', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]
    if (token) ctx.auth.destroySession(token)
    ctx.audit.record('logout', { address: request.ip })
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { success: true, data: {} }
  })
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    // No `secure`: the panel is reached over the LAN or the tunnel on plain
    // HTTP by design; the transport protections are WARP and the bind address.
  })
}
