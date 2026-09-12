import type { FastifyInstance, FastifyReply } from 'fastify'
import '@fastify/cookie'
import { z } from 'zod'
import type { ServerContext } from '../context.js'
import { refuse } from '../guards.js'
import { loadSecrets, loadState } from '../../state/store.js'
import {
  authorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  sameState,
  verifyIdToken,
  type EntraConfig,
} from '../entra.js'

export const SESSION_COOKIE = 'engine_session'

/**
 * Where the PKCE verifier and the state value wait for the round trip to
 * Microsoft. Short-lived and `SameSite=Lax`, which is the whole reason they are
 * a separate cookie from the session: the session is `Strict`, and a Strict
 * cookie is **not sent on the cross-site navigation Microsoft redirects us
 * back with**. A sign-in that set both the same way would fail every time, in a
 * way that looks like a bad state value rather than a cookie policy.
 */
const FLOW_COOKIE = 'engine_entra_flow'
const FLOW_MAX_AGE_S = 10 * 60

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
  app.get('/api/setup', async () => {
    const settings = loadState(ctx.dir).settings
    return {
      success: true,
      data: {
        // With Entra there is no password to set, so setup is never "needed".
        needed: settings.authMode === 'password' && !ctx.auth.isConfigured(),
        authMode: settings.authMode,
      },
    }
  })

  app.post('/api/setup', async (request, reply) => {
    if (loadState(ctx.dir).settings.authMode === 'entra') {
      return refuse(reply, 409, 'This deployment signs in with Microsoft Entra.')
    }
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
    /*
     * With Entra selected, the password is not a second way in.
     *
     * A fallback nobody uses is a fallback nobody rotates and nobody notices
     * leaking, and leaving this open would mean Entra had added a lock beside
     * an unlocked door rather than on it. The way back is `auth use-password`
     * from the CLI, which needs a shell on the box — the same access level the
     * panel's holder effectively has anyway.
     */
    if (loadState(ctx.dir).settings.authMode === 'entra') {
      return refuse(reply, 409, 'This deployment signs in with Microsoft Entra.')
    }

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

  app.post('/api/password', async (request, reply) => {
    if (loadState(ctx.dir).settings.authMode === 'entra') {
      return refuse(reply, 409, 'This deployment signs in with Microsoft Entra; there is no password to change.')
    }
    const body = z
      .object({ current: z.string().min(1), next: z.string().min(12).max(1024) })
      .safeParse(request.body)
    if (!body.success) {
      return refuse(reply, 400, 'The new password must be at least 12 characters.')
    }

    const result = ctx.auth.changePassword(body.data.current, body.data.next)
    if (!result.ok) {
      if (result.lockedForMs !== undefined) {
        ctx.audit.record('login-locked', { address: request.ip })
        const minutes = Math.ceil(result.lockedForMs / 60_000)
        return refuse(reply, 429, `Locked after repeated failures. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`)
      }
      ctx.audit.record('login-failed', { address: request.ip })
      return refuse(reply, 401, 'That is not the current password.')
    }

    ctx.audit.record('password-changed', { address: request.ip })
    // Every session is gone, this one included; the cookie is cleared so the
    // client lands on sign-in rather than on a 401 it has to interpret.
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { success: true, data: {} }
  })

  app.delete('/api/session', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]
    if (token) ctx.auth.destroySession(token)
    ctx.audit.record('logout', { address: request.ip })
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { success: true, data: {} }
  })

  /**
   * Start a sign-in: mint PKCE and state, park them, and send the browser to
   * Microsoft.
   */
  app.get('/api/session/entra/start', async (request, reply) => {
    const config = entraConfig(ctx.dir)
    if (!config.ok) return refuse(reply, 409, config.detail)

    const { verifier, challenge } = createPkce()
    const state = createState()
    reply.setCookie(FLOW_COOKIE, JSON.stringify({ verifier, state }), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: FLOW_MAX_AGE_S,
    })
    return reply.redirect(authorizeUrl(config.config, state, challenge), 302)
  })

  /**
   * Microsoft sends the browser back here.
   *
   * Everything is checked before anything is granted, and the order matters:
   * the state cookie proves this callback belongs to a sign-in *this* box
   * started, which is what stops a code being planted by a third party; only
   * then is the code redeemed, and only then is the resulting token verified.
   */
  app.get('/api/session/entra/callback', async (request, reply) => {
    const config = entraConfig(ctx.dir)
    if (!config.ok) return refuse(reply, 409, config.detail)

    const query = request.query as Record<string, string | undefined>
    if (query['error']) {
      ctx.audit.record('login-failed', { address: request.ip, detail: `Entra: ${query['error']}` })
      return refuse(reply, 401, `Microsoft refused the sign-in: ${query['error_description'] ?? query['error']}`)
    }

    const raw = request.cookies[FLOW_COOKIE]
    reply.clearCookie(FLOW_COOKIE, { path: '/' })
    if (!raw) return refuse(reply, 400, 'That sign-in did not start here, or it took too long.')

    let flow: { verifier?: string; state?: string }
    try {
      flow = JSON.parse(raw) as { verifier?: string; state?: string }
    } catch {
      return refuse(reply, 400, 'That sign-in did not start here.')
    }

    const code = query['code']
    const state = query['state']
    if (!code || !state || !flow.state || !flow.verifier || !sameState(state, flow.state)) {
      ctx.audit.record('login-failed', { address: request.ip, detail: 'Entra: state mismatch' })
      return refuse(reply, 400, 'That sign-in did not start here.')
    }

    const exchanged = await exchangeCode(config.config, code, flow.verifier)
    if (!exchanged.ok) {
      ctx.audit.record('login-failed', { address: request.ip, detail: exchanged.detail.slice(0, 200) })
      return refuse(reply, 401, exchanged.detail)
    }

    const verified = await verifyIdToken(exchanged.idToken, config.config)
    if (!verified.ok) {
      ctx.audit.record('login-failed', { address: request.ip, detail: verified.detail })
      return refuse(reply, 403, verified.detail)
    }

    /*
     * Entra decided *who*; the session table is unchanged. Idle and absolute
     * lifetimes, the cookie, and the pre-handler that enforces it all work
     * exactly as they did for a password, which is why this route is the only
     * thing that had to be written.
     */
    ctx.audit.record('login', {
      address: request.ip,
      subject: verified.identity.upn || verified.identity.oid,
    })
    setSessionCookie(reply, ctx.auth.createSession())
    return reply.redirect('/', 302)
  })
}

/**
 * The configuration, or why a sign-in cannot start.
 *
 * Refusing here rather than redirecting to a half-built URL means the operator
 * sees "no client secret is stored" instead of a Microsoft error page naming
 * nothing they can act on.
 */
function entraConfig(dir: string): { ok: true; config: EntraConfig } | { ok: false; detail: string } {
  const settings = loadState(dir).settings
  if (settings.authMode !== 'entra') return { ok: false, detail: 'This deployment signs in with a password.' }

  const clientSecret = loadSecrets(dir)['ENTRA_CLIENT_SECRET'] ?? ''
  const missing = [
    ['a tenant id', settings.entraTenantId],
    ['a client id', settings.entraClientId],
    ['a redirect URI', settings.entraRedirectUri],
    ['a client secret', clientSecret],
  ].filter(([, value]) => !value).map(([name]) => name)
  if (missing.length > 0) {
    return { ok: false, detail: `Entra sign-in is selected but has ${missing.join(', ')} missing.` }
  }
  if (settings.entraAllowedObjectIds.length === 0) {
    return { ok: false, detail: 'Entra sign-in is selected but nobody is on the allow-list.' }
  }

  return {
    ok: true,
    config: {
      tenantId: settings.entraTenantId,
      clientId: settings.entraClientId,
      clientSecret,
      redirectUri: settings.entraRedirectUri,
      allowedObjectIds: settings.entraAllowedObjectIds,
    },
  }
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
