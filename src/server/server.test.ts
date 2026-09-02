import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from './index.js'
import { AuthStore, LOCKOUT_THRESHOLD } from './auth.js'

const PASSWORD = 'a-long-operator-password'

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

async function setUp(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { password: PASSWORD },
  })
  expect(response.statusCode).toBe(200)
  return sessionCookie(response.headers['set-cookie'])
}

function sessionCookie(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header
  const value = raw?.split(';')[0]
  if (!value) throw new Error('no session cookie in response')
  return value
}

describe('setup', () => {
  it('is needed once and never again', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/setup' })
    expect(before.json().data.needed).toBe(true)

    await setUp()

    const after = await app.inject({ method: 'GET', url: '/api/setup' })
    expect(after.json().data.needed).toBe(false)

    const again = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { password: 'another-password-entirely' },
    })
    expect(again.statusCode).toBe(409)
  })

  it('refuses a short password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { password: 'short' },
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('sessions', () => {
  it('refuses everything but the open routes without one', async () => {
    await setUp()
    for (const url of ['/api/overview', '/api/services', '/api/services/app/logs']) {
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode, url).toBe(401)
    }
    const action = await app.inject({ method: 'POST', url: '/api/services/app/restart' })
    expect(action.statusCode).toBe(401)
  })

  it('signs in with the password and out again', async () => {
    await setUp()
    const login = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { password: PASSWORD },
    })
    expect(login.statusCode).toBe(200)
    const cookie = sessionCookie(login.headers['set-cookie'])

    const overview = await app.inject({
      method: 'GET',
      url: '/api/overview',
      headers: { cookie },
    })
    expect(overview.statusCode).toBe(200)
    expect(overview.json().data.version).toBeDefined()

    const logout = await app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie } })
    expect(logout.statusCode).toBe(200)

    const after = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })
    expect(after.statusCode).toBe(401)
  })

  it('sets the cookie HttpOnly and SameSite=Strict', async () => {
    const cookie = await setUp()
    void cookie
    const login = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { password: PASSWORD },
    })
    const raw = String(login.headers['set-cookie'])
    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('SameSite=Strict')
  })

  it('survives the server being rebuilt, as an update restarts it', async () => {
    const cookie = await setUp()
    await app.close()
    app = buildServer({ dir, logger: false })
    const response = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })
    expect(response.statusCode).toBe(200)
  })
})

describe('lockout', () => {
  it('locks after repeated failures and stays locked across a restart', async () => {
    await setUp()

    let last = 0
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/session',
        payload: { password: 'wrong-every-time' },
      })
      last = response.statusCode
    }
    expect(last).toBe(429)

    // The right password is refused while locked — that is what a lockout is.
    const evenRight = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { password: PASSWORD },
    })
    expect(evenRight.statusCode).toBe(429)

    // Durable: recreating the container does not reset the counter.
    await app.close()
    app = buildServer({ dir, logger: false })
    const afterRestart = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { password: PASSWORD },
    })
    expect(afterRestart.statusCode).toBe(429)
  })

  it('resets the counter on success', async () => {
    await setUp()
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
      await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'wrong' } })
    }
    const good = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { password: PASSWORD },
    })
    expect(good.statusCode).toBe(200)

    const store = new AuthStore(dir)
    expect(store.lockedForMs()).toBe(0)
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
    const cross = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { password: PASSWORD },
      headers: { origin: 'https://attacker.example' },
    })
    expect(cross.statusCode).toBe(403)

    const same = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { password: PASSWORD },
      headers: { origin: 'http://127.0.0.1:8081' },
    })
    expect(same.statusCode).toBe(200)
  })

  it('lets a browserless client through the origin check to authentication', async () => {
    // curl sends no Origin. It is not a CSRF vector; it is a client, and it
    // still has to sign in.
    await setUp()
    const response = await app.inject({ method: 'POST', url: '/api/services/app/restart' })
    expect(response.statusCode).toBe(401)
  })
})

describe('service actions', () => {
  it('refuses a name the catalogue does not define, before docker is involved', async () => {
    const cookie = await setUp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/services/portainer/restart',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(404)
  })

  it('records actions in the audit log, and the overview shows them', async () => {
    const cookie = await setUp()
    await app.inject({ method: 'POST', url: '/api/services/app/restart', headers: { cookie } })

    const overview = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })
    const events = overview.json().data.audit.map((entry: { event: string }) => entry.event)
    expect(events).toContain('service-restart')
    expect(events).toContain('setup')
  })
})
