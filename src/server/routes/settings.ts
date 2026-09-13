import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CATALOGUE } from '../../catalogue/index.js'
import * as docker from '../../docker/index.js'
import { readAlert } from '../../backup/alert.js'
import { proveDatabaseUrl } from '../../backup/database-switch.js'
import { RECOVERY_PASSPHRASE, RECOVERY_SALT } from '../../backup/snapshot.js'
import { DATABASE_URL, databaseTarget } from '../../backup/target.js'
import { forgetProbe } from '../../services.js'
import { GENERATED_SECRETS, loadSecrets, loadState, saveSecrets, saveState } from '../../state/store.js'
import type { ServerContext } from '../context.js'
import { refuse, who } from '../guards.js'
import { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } from './recovery.js'

export const ENTRA_CLIENT_SECRET = 'ENTRA_CLIENT_SECRET'

const authPatch = z.object({
  redirectUri: z.string().trim().max(500).optional(),
  allowedObjectIds: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  clientSecret: z.string().max(1000).optional(),
})

const urlBody = z.object({ url: z.string().min(1).max(2000) })
const secretBody = z.object({ value: z.string().min(1).max(20_000) })
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

/** Secrets the engine itself knows by name, so the credentials list can say what each is for. */
const ENGINE_SECRETS: Readonly<Record<string, string>> = {
  [S3_ACCESS_KEY_ID]: 'Offsite storage',
  [S3_SECRET_ACCESS_KEY]: 'Offsite storage',
  [RECOVERY_PASSPHRASE]: 'Engine snapshot',
  [RECOVERY_SALT]: 'Engine snapshot',
  [ENTRA_CLIENT_SECRET]: 'Sign-in',
  [DATABASE_URL]: 'Database',
  GHCR_TOKEN: 'Registry',
  GHCR_USERNAME: 'Registry',
}

/**
 * Settings over the API — the panel's side of `auth`, `database` and
 * `secrets`.
 *
 * The one guard that matters is on the allow-list: the request must come
 * from a session whose subject stays on the list being saved, so the
 * operator cannot remove themself. Configuring a lock from behind the door
 * it locks is how a deployment gets locked out of itself; the CLI remains
 * the way back in if this guard is ever wrong.
 */
export function settingsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // -- sign-in ----------------------------------------------------------------

  app.get('/api/auth', async (request) => {
    const settings = loadState(ctx.dir).settings
    return {
      success: true,
      data: {
        tenantId: settings.entraTenantId,
        clientId: settings.entraClientId,
        redirectUri: settings.entraRedirectUri,
        allowedObjectIds: settings.entraAllowedObjectIds,
        clientSecretSet: Boolean(loadSecrets(ctx.dir)[ENTRA_CLIENT_SECRET]),
        me: request.operator ?? null,
      },
    }
  })

  app.put('/api/auth', async (request, reply) => {
    const body = authPatch.safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'Those sign-in settings are not valid.')
    const patch = body.data
    const state = loadState(ctx.dir)
    let restartNeeded = false

    const settings = { ...state.settings }
    if (patch.redirectUri !== undefined) {
      const url = patch.redirectUri
      // Entra refuses plain http except on localhost, so a URI it will not
      // accept is refused here rather than at the first sign-in.
      if (!/^https:\/\//.test(url) && !/^http:\/\/localhost(:|\/)/.test(url)) {
        return refuse(reply, 400, 'The redirect URI must be https, or http://localhost. Entra refuses anything else.')
      }
      try {
        new URL(url)
      } catch {
        return refuse(reply, 400, 'The redirect URI is not a URL.')
      }
      restartNeeded = url !== settings.entraRedirectUri
      settings.entraRedirectUri = url
    }

    if (patch.allowedObjectIds !== undefined) {
      const allow = [...new Set(patch.allowedObjectIds.map((id) => id.trim()).filter(Boolean))]
      // An empty list admits nobody, which is the right failure and a miserable
      // way to learn it.
      if (allow.length === 0) return refuse(reply, 400, 'At least one object id, or nobody can sign in.')
      /*
       * You cannot remove yourself. A session minted before 0.20 carries no
       * subject and cannot prove it would survive, so it may not change the
       * list at all — sign in again first.
       */
      if (!request.operator) {
        return refuse(reply, 409, 'Sign out and in again before changing who may sign in; this session predates the check that keeps you on the list.')
      }
      if (!allow.includes(request.operator.oid)) {
        return refuse(reply, 400, `Your own account (${request.operator.upn || request.operator.oid}) must stay on the list.`)
      }
      settings.entraAllowedObjectIds = allow
    }

    if (patch.clientSecret) {
      saveSecrets({ ...loadSecrets(ctx.dir), [ENTRA_CLIENT_SECRET]: patch.clientSecret }, ctx.dir)
    }

    saveState({ ...state, settings }, ctx.dir)
    ctx.audit.record('auth-changed', {
      detail: [
        patch.redirectUri !== undefined ? 'redirect URI' : '',
        patch.allowedObjectIds !== undefined ? `${settings.entraAllowedObjectIds.length} allowed` : '',
        patch.clientSecret ? 'client secret' : '',
      ]
        .filter(Boolean)
        .join(', '),
      address: request.ip,
      ...who(request),
    })
    return { success: true, data: { restartNeeded } }
  })

  app.post('/api/auth/sign-out-everyone', async (request) => {
    ctx.audit.record('sign-out-everyone', {
      address: request.ip,
      ...who(request),
    })
    ctx.auth.destroyAllSessions()
    return { success: true, data: {} }
  })

  // -- database ---------------------------------------------------------------

  app.get('/api/database', async () => {
    const resolved = databaseTarget(ctx.dir)
    if (!resolved.ok) return { success: true, data: { ok: false, detail: resolved.detail } }
    const t = resolved.target
    const probe = await docker.psqlQuery(t, 'SELECT version()')
    const reachable = probe.code === 0
    let tables: number | null = null
    if (reachable) {
      const count = await docker.psqlQuery(t, "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
      if (count.code === 0 && Number.isFinite(Number(count.stdout.trim()))) tables = Number(count.stdout.trim())
    }
    return {
      success: true,
      data: {
        ok: true,
        external: t.external,
        host: t.host,
        port: t.port,
        dbName: t.dbName,
        dbUser: t.dbUser,
        sslmode: t.external ? t.sslmode : null,
        reachable,
        server: reachable ? probe.stdout.trim().split(' ').slice(0, 2).join(' ') : null,
        detail: reachable ? '' : (probe.stderr || probe.stdout).trim().slice(0, 300),
        tables,
      },
    }
  })

  app.post('/api/database/test', async (request, reply) => {
    const body = urlBody.safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'A database URL is required.')
    const proof = await proveDatabaseUrl(body.data.url.trim())
    return {
      success: true,
      data: {
        ok: proof.ok,
        detail: proof.detail,
        server: proof.server ?? null,
        tables: proof.tables ?? null,
        host: proof.target?.host ?? null,
        port: proof.target?.port ?? null,
        dbName: proof.target?.dbName ?? null,
      },
    }
  })

  app.put('/api/database', async (request, reply) => {
    const body = urlBody.safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'A database URL is required.')
    const url = body.data.url.trim()
    const proof = await proveDatabaseUrl(url)
    if (!proof.ok) return refuse(reply, 400, `${proof.detail} Nothing was changed.`)
    saveSecrets({ ...loadSecrets(ctx.dir), [DATABASE_URL]: url }, ctx.dir)
    forgetProbe()
    ctx.audit.record('database-changed', {
      detail: `${proof.target!.host}:${proof.target!.port}/${proof.target!.dbName}`,
      address: request.ip,
      ...who(request),
    })
    return { success: true, data: { detail: proof.detail } }
  })

  app.delete('/api/database', async (request, reply) => {
    const secrets = loadSecrets(ctx.dir)
    if (!secrets[DATABASE_URL]) return refuse(reply, 409, 'The database is already local.')
    const { [DATABASE_URL]: _gone, ...rest } = secrets
    saveSecrets(rest, ctx.dir)
    forgetProbe()
    ctx.audit.record('database-changed', {
      detail: 'local (the postgres module)',
      address: request.ip,
      ...who(request),
    })
    return { success: true, data: {} }
  })

  // -- credentials ------------------------------------------------------------

  app.get('/api/secrets', async () => {
    const secrets = loadSecrets(ctx.dir)
    const state = loadState(ctx.dir)
    const enabled = new Set(state.enabled)
    const names = new Set<string>(Object.keys(secrets))
    for (const module of CATALOGUE) for (const secret of module.secrets) names.add(secret.name)
    for (const generated of GENERATED_SECRETS) names.add(generated.name)
    for (const name of Object.keys(ENGINE_SECRETS)) names.add(name)

    const list = [...names].sort().map((name) => {
      const modules = CATALOGUE.filter((m) => m.secrets.some((s) => s.name === name))
      const usedBy = modules.map((m) => m.title)
      if (ENGINE_SECRETS[name]) usedBy.push(ENGINE_SECRETS[name]!)
      const generated = GENERATED_SECRETS.some((g) => g.name === name)
      const inUse = generated || modules.some((m) => m.required || enabled.has(m.id)) || Boolean(ENGINE_SECRETS[name])
      return {
        name,
        set: Boolean(secrets[name]),
        usedBy,
        generated,
        /** Whether removing it would take something away from the running deployment. */
        inUse,
        title: modules.find((m) => m.secrets.some((s) => s.name === name))?.secrets.find((s) => s.name === name)?.title ?? null,
      }
    })
    return { success: true, data: { secrets: list } }
  })

  app.put('/api/secrets/:name', async (request, reply) => {
    const { name } = request.params as { name: string }
    if (!SECRET_NAME.test(name)) return refuse(reply, 400, 'A secret name is upper-case letters, digits and underscores.')
    const body = secretBody.safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'A value is required.')
    saveSecrets({ ...loadSecrets(ctx.dir), [name]: body.data.value }, ctx.dir)
    if (name === DATABASE_URL) forgetProbe()
    ctx.audit.record('secret-set', {
      detail: name,
      address: request.ip,
      ...who(request),
    })
    return { success: true, data: {} }
  })

  app.delete('/api/secrets/:name', async (request, reply) => {
    const { name } = request.params as { name: string }
    const { force } = request.query as { force?: string }
    const secrets = loadSecrets(ctx.dir)
    if (!(name in secrets)) return refuse(reply, 404, `${name} is not stored.`)
    if (force !== '1') {
      if (GENERATED_SECRETS.some((g) => g.name === name)) {
        return refuse(reply, 409, `${name} is generated for this deployment and removing it would break it.`)
      }
      const enabled = new Set(loadState(ctx.dir).enabled)
      const claimedBy = CATALOGUE.filter((m) => (m.required || enabled.has(m.id)) && m.secrets.some((s) => s.name === name))
      if (claimedBy.length > 0) {
        return refuse(reply, 409, `${name} is used by ${claimedBy.map((m) => m.title).join(', ')}.`)
      }
      if (ENGINE_SECRETS[name]) {
        return refuse(reply, 409, `${name} is used by ${ENGINE_SECRETS[name]}.`)
      }
    }
    const { [name]: _removed, ...rest } = secrets
    saveSecrets(rest, ctx.dir)
    if (name === DATABASE_URL) forgetProbe()
    ctx.audit.record('secret-removed', {
      detail: name,
      address: request.ip,
      ...who(request),
    })
    return { success: true, data: { detail: 'The offsite snapshot still carries it until the next tick rewrites it.' } }
  })

  // -- alerts -----------------------------------------------------------------

  app.get('/api/alerts', async () => {
    const settings = loadState(ctx.dir).settings
    const last = readAlert(ctx.dir)
    return {
      success: true,
      data: {
        email: settings.alertEmail,
        last: last ? { level: last.level, sentAt: last.sentAt } : null,
      },
    }
  })
}
