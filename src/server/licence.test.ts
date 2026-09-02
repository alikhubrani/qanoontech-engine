import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.mock('../docker/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../docker/index.js')>()
  return {
    ...original,
    stop: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    start: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    ps: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  }
})

import * as docker from '../docker/index.js'
import {
  LICENCE_VERSION,
  licenceClaimsSchema,
  signLicence,
  type LicenceClaims,
} from '../licence/format.js'
import { setLicencePublicKeyForTesting } from '../licence/index.js'
import { isEnforced, readHeartbeat } from '../licence/index.js'
import { installLicence, writeHeartbeat } from '../licence/state.js'
import { AuditLog } from './audit.js'
import { AuthStore } from './auth.js'
import { buildServer } from './index.js'
import { licenceTick } from './licence-tick.js'

const DAY = 24 * 60 * 60 * 1000
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const PASSWORD = 'a-long-operator-password'

let dir: string
let app: FastifyInstance

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-lic-'))
  setLicencePublicKeyForTesting(publicKey)
  app = buildServer({ dir, logger: false, licenceLoop: false })
})

afterEach(async () => {
  setLicencePublicKeyForTesting(undefined)
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

function claims(overrides: Partial<LicenceClaims> = {}): LicenceClaims {
  return licenceClaimsSchema.parse({
    v: LICENCE_VERSION,
    licenceId: randomUUID(),
    firmId: 'firm-1',
    firmName: 'Al-Mithal Law Firm',
    issuedAt: new Date(Date.now() - DAY).toISOString(),
    expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
    entitlements: ['module.ocr'],
    seats: 0,
    heartbeat: { url: 'https://licence.example/heartbeat', intervalHours: 24, graceDays: 30 },
    override: false,
    ...overrides,
  })
}

async function signIn(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { password: PASSWORD },
  })
  const raw = response.headers['set-cookie']
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!
}

function freshHeartbeat(): void {
  writeHeartbeat(
    { ...readHeartbeat(dir), lastSuccessAt: Date.now(), lastAttemptAt: Date.now() },
    dir,
  )
}

describe('licence routes', () => {
  it('reports missing, then ok once installed', async () => {
    const cookie = await signIn()
    const before = await app.inject({ method: 'GET', url: '/api/licence', headers: { cookie } })
    expect(before.json().data.standing).toBe('missing')

    const token = await signLicence(claims(), privateKey)
    const put = await app.inject({
      method: 'PUT',
      url: '/api/licence',
      headers: { cookie },
      payload: { token },
    })
    expect(put.statusCode).toBe(200)
    freshHeartbeat()

    const after = await app.inject({ method: 'GET', url: '/api/licence', headers: { cookie } })
    expect(after.json().data.standing).toBe('ok')
    expect(after.json().data.claims.firmName).toBe('Al-Mithal Law Firm')
  })

  it('refuses to install what does not verify, and keeps what was there', async () => {
    const cookie = await signIn()
    const good = await signLicence(claims(), privateKey)
    await app.inject({ method: 'PUT', url: '/api/licence', headers: { cookie }, payload: { token: good } })
    freshHeartbeat()

    const put = await app.inject({
      method: 'PUT',
      url: '/api/licence',
      headers: { cookie },
      payload: { token: 'v4.public.not-a-licence' },
    })
    expect(put.statusCode).toBe(422)

    const still = await app.inject({ method: 'GET', url: '/api/licence', headers: { cookie } })
    expect(still.json().data.standing).toBe('ok')
  })

  it('requires a session like everything else', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/licence' })
    expect(response.statusCode).toBe(401)
  })
})

describe('the tick', () => {
  it('stops everything but the database when grace is exhausted', async () => {
    installLicence(
      await signLicence(
        claims({
          issuedAt: new Date(Date.now() - 100 * DAY).toISOString(),
          expiresAt: new Date(Date.now() - 31 * DAY).toISOString(),
        }),
        privateKey,
      ),
      dir,
    )
    freshHeartbeat()

    const audit = new AuditLog(dir)
    await licenceTick({ dir, auth: new AuthStore(dir), audit, guard: { allowedHosts: [] }, engineVersion: 'test' })

    expect(isEnforced(dir)).toBe(true)
    const stopped = vi.mocked(docker.stop).mock.calls[0]?.[0]
    expect(stopped).toContain('app')
    expect(stopped).toContain('nginx')
    expect(stopped).not.toContain('postgres')
    expect(audit.recent().map((entry) => entry.event)).toContain('licence-enforced')
  })

  it('enforces once, not on every tick', async () => {
    installLicence(
      await signLicence(
        claims({
          issuedAt: new Date(Date.now() - 100 * DAY).toISOString(),
          expiresAt: new Date(Date.now() - 31 * DAY).toISOString(),
        }),
        privateKey,
      ),
      dir,
    )
    freshHeartbeat()
    const ctx = { dir, auth: new AuthStore(dir), audit: new AuditLog(dir), guard: { allowedHosts: [] }, engineVersion: 'test' }
    await licenceTick(ctx)
    await licenceTick(ctx)
    expect(vi.mocked(docker.stop)).toHaveBeenCalledTimes(1)
  })

  it('does nothing at all without a licence', async () => {
    await licenceTick({ dir, auth: new AuthStore(dir), audit: new AuditLog(dir), guard: { allowedHosts: [] }, engineVersion: 'test' })
    expect(isEnforced(dir)).toBe(false)
    expect(vi.mocked(docker.stop)).not.toHaveBeenCalled()
  })
})

describe('recovery', () => {
  it('a new licence lifts enforcement and restarts what was stopped', async () => {
    installLicence(
      await signLicence(
        claims({
          issuedAt: new Date(Date.now() - 100 * DAY).toISOString(),
          expiresAt: new Date(Date.now() - 31 * DAY).toISOString(),
        }),
        privateKey,
      ),
      dir,
    )
    freshHeartbeat()
    const ctx = { dir, auth: new AuthStore(dir), audit: new AuditLog(dir), guard: { allowedHosts: [] }, engineVersion: 'test' }
    await licenceTick(ctx)
    expect(isEnforced(dir)).toBe(true)

    const cookie = await signIn()
    const token = await signLicence(claims(), privateKey)
    const put = await app.inject({
      method: 'PUT',
      url: '/api/licence',
      headers: { cookie },
      payload: { token },
    })
    expect(put.statusCode).toBe(200)
    expect(isEnforced(dir)).toBe(false)
    const started = vi.mocked(docker.start).mock.calls[0]?.[0]
    expect(started).toContain('app')
    expect(started).toContain('nginx')
    expect(ctx.audit.recent().map((entry) => entry.event)).toContain('licence-cleared')
  })
})
