import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from './index.js'
import { SESSION_COOKIE } from './routes/session.js'
import { AuthStore } from './auth.js'
import { loadSecrets, loadState, saveSecrets } from '../state/store.js'

let dir: string
let app: FastifyInstance
const ME = '59e5362f-28b1-4b04-b6aa-b125fcb3c5ea'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-settings-'))
  app = buildServer({ dir, logger: false })
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

const withSubject = () => ({
  cookie: `${SESSION_COOKIE}=${new AuthStore(dir).createSession({ oid: ME, upn: 'a@example.com', name: 'A' })}`,
  origin: 'http://127.0.0.1:8081',
})
const withoutSubject = () => ({ cookie: `${SESSION_COOKIE}=${new AuthStore(dir).createSession()}`, origin: 'http://127.0.0.1:8081' })

describe('PUT /api/auth — the allow-list', () => {
  it('refuses to remove the signed-in account', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/auth',
      headers: withSubject(),
      payload: { allowedObjectIds: ['someone-else'] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('must stay on the list')
    expect(loadState(dir).settings.entraAllowedObjectIds).toEqual([ME])
  })

  it('refuses an empty list', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/auth', headers: withSubject(), payload: { allowedObjectIds: [] } })
    expect(response.statusCode).toBe(400)
  })

  it('refuses a session that cannot prove who it is', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/auth',
      headers: withoutSubject(),
      payload: { allowedObjectIds: [ME, 'someone-else'] },
    })
    expect(response.statusCode).toBe(409)
  })

  it('adds an account when the caller stays on the list, and records who did it', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/auth',
      headers: withSubject(),
      payload: { allowedObjectIds: [ME, 'someone-else'] },
    })
    expect(response.statusCode).toBe(200)
    expect(loadState(dir).settings.entraAllowedObjectIds).toEqual([ME, 'someone-else'])
    const overview = await app.inject({ method: 'GET', url: '/api/overview', headers: withSubject() })
    const entry = overview.json().data.audit.find((e: { event: string }) => e.event === 'auth-changed')
    expect(entry.subject).toBe('a@example.com')
    expect(entry.kind).toBe('security')
  })

  it('refuses a redirect URI Entra would refuse, and says a restart is needed for one it accepts', async () => {
    const http = await app.inject({ method: 'PUT', url: '/api/auth', headers: withSubject(), payload: { redirectUri: 'http://portal.example.com/cb' } })
    expect(http.statusCode).toBe(400)
    const https = await app.inject({ method: 'PUT', url: '/api/auth', headers: withSubject(), payload: { redirectUri: 'https://portal.example.com/api/session/entra/callback' } })
    expect(https.statusCode).toBe(200)
    expect(https.json().data.restartNeeded).toBe(true)
  })

  it('stores the client secret and never reads it back', async () => {
    await app.inject({ method: 'PUT', url: '/api/auth', headers: withSubject(), payload: { clientSecret: 'very-secret' } })
    expect(loadSecrets(dir)['ENTRA_CLIENT_SECRET']).toBe('very-secret')
    const get = await app.inject({ method: 'GET', url: '/api/auth', headers: withSubject() })
    expect(get.json().data.clientSecretSet).toBe(true)
    expect(JSON.stringify(get.json())).not.toContain('very-secret')
  })
})

describe('POST /api/auth/sign-out-everyone', () => {
  it('destroys every session, the caller included', async () => {
    const headers = withSubject()
    const other = withSubject()
    const response = await app.inject({ method: 'POST', url: '/api/auth/sign-out-everyone', headers })
    expect(response.statusCode).toBe(200)
    for (const h of [headers, other]) {
      const after = await app.inject({ method: 'GET', url: '/api/overview', headers: h })
      expect(after.statusCode).toBe(401)
    }
  })
})

describe('credentials', () => {
  it('lists names with set flags and never values', async () => {
    saveSecrets({ DB_PASSWORD: 'p', S3_ACCESS_KEY_ID: 'k' }, dir)
    const response = await app.inject({ method: 'GET', url: '/api/secrets', headers: withSubject() })
    const list = response.json().data.secrets as { name: string; set: boolean; generated: boolean; usedBy: string[] }[]
    expect(list.find((s) => s.name === 'DB_PASSWORD')).toMatchObject({ set: true, generated: true })
    expect(list.find((s) => s.name === 'S3_ACCESS_KEY_ID')).toMatchObject({ set: true, usedBy: ['Offsite storage'] })
    expect(list.find((s) => s.name === 'S3_SECRET_ACCESS_KEY')).toMatchObject({ set: false })
    expect(JSON.stringify(response.json())).not.toContain('"p"')
  })

  it('refuses to remove a generated or in-use secret without force, and removes with it', async () => {
    saveSecrets({ DB_PASSWORD: 'p', SOMETHING_OLD: 'x' }, dir)
    const generated = await app.inject({ method: 'DELETE', url: '/api/secrets/DB_PASSWORD', headers: withSubject() })
    expect(generated.statusCode).toBe(409)
    const stale = await app.inject({ method: 'DELETE', url: '/api/secrets/SOMETHING_OLD', headers: withSubject() })
    expect(stale.statusCode).toBe(200)
    const forced = await app.inject({ method: 'DELETE', url: '/api/secrets/DB_PASSWORD?force=1', headers: withSubject() })
    expect(forced.statusCode).toBe(200)
    expect(loadSecrets(dir)).toEqual({})
  })

  it('refuses a name that is not a secret name', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/secrets/not-a-name', headers: withSubject(), payload: { value: 'v' } })
    expect(response.statusCode).toBe(400)
  })
})

describe('database', () => {
  it('reports local when no URL is stored, and refuses use-local twice', async () => {
    const off = await app.inject({ method: 'DELETE', url: '/api/database', headers: withSubject() })
    expect(off.statusCode).toBe(409)
  })

  it('refuses a URL that is not a postgres URL before any probe', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/database', headers: withSubject(), payload: { url: 'mysql://x' } })
    expect(response.statusCode).toBe(400)
    expect(loadSecrets(dir)['DATABASE_URL']).toBeUndefined()
  })
})
