import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from './index.js'
import { SESSION_COOKIE } from './routes/session.js'
import { AuthStore } from './auth.js'
import { loadState, saveState } from '../state/store.js'


let dir: string
let app: FastifyInstance

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-test-'))
  app = buildServer({ dir, logger: false })
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A signed-in session, minted the way the Entra callback mints one.
 *
 * These tests are about what the panel does once somebody is in. Who gets in is
 * `entra.test.ts`, and keeping the two apart means a change to sign-in cannot
 * quietly break every other test in this file.
 */
function signedIn(): string {
  return `${SESSION_COOKIE}=${new AuthStore(dir).createSession()}`
}

describe('sessions', () => {
  it('refuses everything but the open routes without one', async () => {
    for (const url of ['/api/overview', '/api/services', '/api/services/app/logs']) {
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode, url).toBe(401)
    }
    const action = await app.inject({ method: 'POST', url: '/api/services/app/restart' })
    expect(action.statusCode).toBe(401)
  })

  it('has no password to post and no setup to claim', async () => {
    /*
     * The routes that used to grant access without one are gone, not disabled.
     * `/api/setup` mattered most: it was the single route that handed out a
     * session to whoever reached it first, and on a box that had never been
     * configured that was a race with the internet. There is nothing to race
     * for now — the first session comes from Entra, and Entra needs a client
     * secret that only a shell can put on the box.
     */
    for (const url of ['/api/setup', '/api/password', '/api/session']) {
      const posted = await app.inject({ method: 'POST', url, payload: { password: 'anything-at-all' } })
      // 401 rather than 404: the session hook runs before routing, so these
      // refuse as "sign in first" rather than confirming they are gone. That is
      // the better answer — it tells a stranger nothing about what this box has.
      expect(posted.statusCode, url).toBe(401)
      expect(posted.headers['set-cookie'], url).toBeUndefined()
    }
  })

  it('carries a session and gives it up on request', async () => {
    const cookie = signedIn()

    const overview = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })
    expect(overview.statusCode).toBe(200)
    expect(overview.json().data.version).toBeDefined()

    const logout = await app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie } })
    expect(logout.statusCode).toBe(200)

    const after = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })
    expect(after.statusCode).toBe(401)
  })

  it('survives the server being rebuilt, as an update restarts it', async () => {
    const cookie = signedIn()
    await app.close()
    app = buildServer({ dir, logger: false })
    const response = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })
    expect(response.statusCode).toBe(200)
  })

  it('signs everyone out at once, which is the half of revocation that is ours', async () => {
    /*
     * Entra stops *new* sign-ins the moment an account is disabled. A session
     * already issued is a cookie on somebody's laptop and Microsoft has no say
     * in it, so revoking access means doing both.
     */
    const first = signedIn()
    const second = signedIn()
    new AuthStore(dir).destroyAllSessions()
    for (const cookie of [first, second]) {
      const response = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })
      expect(response.statusCode).toBe(401)
    }
  })
})

describe('rebinding and cross-origin guards', () => {
  it('refuses a Host it does not serve', async () => {
    // The rebinding attack: attacker.example resolves to 127.0.0.1, so the
    // request arrives here carrying the attacker's hostname.
    const response = await app.inject({
      method: 'GET',
      url: '/api/setup',
      headers: { host: 'attacker.example' },
    })
    expect(response.statusCode).toBe(421)
  })

  it('accepts the hosts it serves, with or without a port', async () => {
    for (const host of ['127.0.0.1:8081', 'localhost:8081', 'localhost']) {
      const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host } })
      expect(response.statusCode, host).toBe(200)
    }
  })

  it('accepts any IP-literal host — the LAN reaches a LAN-open box by IP', async () => {
    // A rebinding request cannot carry an IP literal: the attack is a domain
    // the attacker controls resolving here, and the browser puts that domain
    // in Host. Any actual IP is therefore the operator, not the attack.
    for (const host of ['192.168.1.106:8081', '10.77.42.5', '[::1]:8081']) {
      const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host } })
      expect(response.statusCode, host).toBe(200)
    }
  })

  it('still refuses a domain it was not told to serve', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'attacker.example:8081' },
    })
    expect(response.statusCode).toBe(421)
  })

  it('refuses a cross-origin write and allows a same-origin one', async () => {
    const cookie = signedIn()
    const cross = await app.inject({
      method: 'POST',
      url: '/api/services/app/restart',
      headers: { origin: 'https://attacker.example', cookie },
    })
    // Refused on the origin, not on the session — the check runs first, so a
    // stolen cookie in a foreign page still gets nowhere.
    expect(cross.statusCode).toBe(403)

    const same = await app.inject({
      method: 'POST',
      url: '/api/services/app/restart',
      headers: { origin: 'http://127.0.0.1:8081', cookie },
    })
    /*
     * Past the origin check is the whole claim. What happens next is docker's
     * business and docker is not mocked in this file — asserting 200 here would
     * be asserting that a container restarted, which is a different test and a
     * far more fragile one.
     */
    expect(same.statusCode).not.toBe(403)
  })

  it('lets a browserless client through the origin check to authentication', async () => {
    // curl sends no Origin. It is not a CSRF vector; it is a client, and it
    // still has to sign in.
    const response = await app.inject({ method: 'POST', url: '/api/services/app/restart' })
    expect(response.statusCode).toBe(401)
  })
})

describe('service actions', () => {
  it('refuses a name the catalogue does not define, before docker is involved', async () => {
    const cookie = signedIn()
    const response = await app.inject({
      method: 'POST',
      url: '/api/services/portainer/restart',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(404)
  })

  it('records actions in the audit log, and the overview shows them', async () => {
    const cookie = signedIn()
    await app.inject({ method: 'POST', url: '/api/services/app/restart', headers: { cookie } })

    const overview = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })
    const events = overview.json().data.audit.map((entry: { event: string }) => entry.event)
    expect(events).toContain('service-restart')
  })
})

/**
 * A deployment that cannot sign anybody in must say so where it can be read.
 *
 * A fresh box has no client secret, so it has no panel — that is the intended
 * bootstrap, not a fault. What matters is that it fails at the start of the
 * flow, in a message naming what is missing, rather than sending the operator
 * to Microsoft to come back with an error page about a client they cannot see.
 */
describe('a deployment that is not ready to sign in', () => {
  it('refuses to start a sign-in it cannot finish, and says what is missing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/session/entra/start' })
    expect(response.statusCode).toBe(409)
    expect(String(response.json().error)).toContain('client secret')
  })

  it('refuses a callback that did not start here', async () => {
    // No flow cookie, so there is no state to match and no verifier to redeem
    // the code with. A code arriving on its own is somebody else's code.
    const response = await app.inject({ method: 'GET', url: '/api/session/entra/callback?code=x&state=y' })
    expect([400, 409]).toContain(response.statusCode)
  })

  it('ships knowing the tenant, the application and who is allowed', async () => {
    /*
     * Every deployment is operated by the same person, so these are defaults
     * rather than setup questions. None of the three is a secret — they
     * identify, they do not authorise — and the one that does authorise, the
     * client secret, is deliberately not among them.
     */
    const settings = loadState(dir).settings
    expect(settings.entraTenantId).toBeTruthy()
    expect(settings.entraClientId).toBeTruthy()
    expect(settings.entraAllowedObjectIds.length).toBeGreaterThan(0)
    expect(settings.entraRedirectUri).toBe('')
  })
})

/**
 * The panel's own address has to be one it will answer to.
 *
 * The Host guard defends against DNS rebinding and refuses anything it was not
 * told to serve. A deployment reached through a tunnel is addressed by that
 * hostname, so the guard has to know it — and the failure if it does not is
 * uniquely misleading: Microsoft authenticates the person, redirects back, and
 * the engine answers 421 about a host name, which reads as a tunnel fault
 * rather than a setting.
 *
 * Derived from the redirect URI rather than configured beside it, because they
 * are the same fact stated once.
 */
describe('the host the panel is reached at', () => {
  const withRedirect = (url: string) => {
    const state = loadState(dir)
    saveState({ ...state, settings: { ...state.settings, entraRedirectUri: url } }, dir)
    return buildServer({ dir, logger: false })
  }

  it('answers to the host in the redirect URI', async () => {
    const server = withRedirect('https://portal.j-lawfirm.example.com/api/session/entra/callback')
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'portal.j-lawfirm.example.com' },
    })
    expect(response.statusCode).toBe(200)
    await server.close()
  })

  it('still refuses a host it was never told about', async () => {
    const server = withRedirect('https://portal.j-lawfirm.example.com/api/session/entra/callback')
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'attacker.example' },
    })
    expect(response.statusCode).toBe(421)
    await server.close()
  })

  it('is unbothered by a redirect URI that is not a URL', async () => {
    // Never throw while assembling a guard: a malformed setting must narrow
    // what is served, never stop the engine answering at all.
    const server = withRedirect('not a url')
    const response = await server.inject({ method: 'GET', url: '/api/health', headers: { host: 'localhost' } })
    expect(response.statusCode).toBe(200)
    await server.close()
  })
})
