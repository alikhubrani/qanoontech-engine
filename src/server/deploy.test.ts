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
    validate: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    pull: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    apply: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    login: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    ps: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  }
})

import * as docker from '../docker/index.js'
import {
  LICENCE_VERSION,
  licenceClaimsSchema,
  signLicence,
} from '../licence/format.js'
import { setLicencePublicKeyForTesting } from '../licence/index.js'
import { installLicence, readHeartbeat, writeHeartbeat } from '../licence/state.js'
import { orderVersions } from '../registry.js'
import {
  ensureGeneratedSecrets,
  loadSecrets,
  loadState,
  saveSecrets,
} from '../state/store.js'
import { buildServer } from './index.js'
import { JobRunner, rollbackVersion, setVersion } from './jobs.js'

const DAY = 24 * 60 * 60 * 1000
const { privateKey, publicKey } = generateKeyPairSync('ed25519')

let dir: string
let app: FastifyInstance

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-deploy-'))
  setLicencePublicKeyForTesting(publicKey)
  app = buildServer({ dir, logger: false, licenceLoop: false })
})

afterEach(async () => {
  setLicencePublicKeyForTesting(undefined)
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

async function signIn(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { password: 'a-long-operator-password' },
  })
  const raw = response.headers['set-cookie']
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!
}

async function licensed(): Promise<void> {
  const claims = licenceClaimsSchema.parse({
    v: LICENCE_VERSION,
    licenceId: randomUUID(),
    firmId: 'firm-1',
    firmName: 'Al-Mithal Law Firm',
    issuedAt: new Date(Date.now() - DAY).toISOString(),
    expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
    entitlements: ['module.ocr'],
    seats: 0,
    heartbeat: { url: 'https://licence.example/hb', intervalHours: 24, graceDays: 30 },
    override: false,
  })
  installLicence(await signLicence(claims, privateKey), dir)
  writeHeartbeat({ ...readHeartbeat(dir), lastSuccessAt: Date.now(), lastAttemptAt: Date.now() }, dir)
  saveSecrets(ensureGeneratedSecrets(loadSecrets(dir)).secrets, dir)
}

describe('settings', () => {
  it('patches what is sent and keeps the rest', async () => {
    const cookie = await signIn()
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { bindAddress: '10.77.42.5' },
    })
    expect(put.statusCode).toBe(200)
    const state = loadState(dir)
    expect(state.settings.bindAddress).toBe('10.77.42.5')
    expect(state.settings.appPort).toBe(8080)
  })

  it('refuses a wildcard bind address with the reason', async () => {
    const cookie = await signIn()
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { bindAddress: '0.0.0.0' },
    })
    expect(put.statusCode).toBe(400)
    expect(put.json().error).toContain('Cloudflare')
  })
})

describe('modules over the API', () => {
  it('enables, disables, and refuses the required', async () => {
    const cookie = await signIn()
    expect(
      (await app.inject({ method: 'POST', url: '/api/modules/ocr/enable', headers: { cookie } }))
        .statusCode,
    ).toBe(200)
    expect(loadState(dir).enabled).toContain('ocr')

    expect(
      (await app.inject({ method: 'POST', url: '/api/modules/postgres/disable', headers: { cookie } }))
        .statusCode,
    ).toBe(409)

    expect(
      (await app.inject({ method: 'POST', url: '/api/modules/ocr/disable', headers: { cookie } }))
        .statusCode,
    ).toBe(200)
    expect(loadState(dir).enabled).not.toContain('ocr')
  })

  it('validates module config against its schema', async () => {
    const cookie = await signIn()
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/modules/drive-mirror/config',
      headers: { cookie },
      payload: { config: { sharedDriveId: '' } },
    })
    expect(bad.statusCode).toBe(422)

    const good = await app.inject({
      method: 'PUT',
      url: '/api/modules/drive-mirror/config',
      headers: { cookie },
      payload: { config: { sharedDriveId: '0ABCdef' } },
    })
    expect(good.statusCode).toBe(200)
  })
})

describe('versions', () => {
  it('orders releases newest first, then prereleases, then moving tags', () => {
    expect(
      orderVersions(['latest', '1.0.2', 'sha-abc1234', '1.0.10', '1.5.0-rc.1', 'staging', '1.0.9', '1.0']),
    ).toEqual(['1.0.10', '1.0.9', '1.0.2', '1.5.0-rc.1', 'latest', 'staging'])
  })

  it('set and rollback swap as a pair', () => {
    setVersion('1.0.2', dir)
    setVersion('1.1.0', dir)
    expect(loadState(dir).version).toBe('1.1.0')
    expect(loadState(dir).previousVersion).toBe('1.0.2')

    const back = rollbackVersion(dir)
    expect(back.ok).toBe(true)
    expect(loadState(dir).version).toBe('1.0.2')
    expect(loadState(dir).previousVersion).toBe('1.1.0')
  })

  it('refuses a rollback with nowhere to go', () => {
    expect(rollbackVersion(dir).ok).toBe(false)
  })
})

describe('the deploy job', () => {
  it('runs render → validate → pull → apply and finishes ok', async () => {
    await licensed()
    setVersion('1.0.2', dir)
    const jobs = new JobRunner(dir)
    expect(jobs.startDeploy()).toBe(true)
    await vi.waitFor(() => expect(jobs.isRunning()).toBe(false))

    const job = jobs.current()!
    expect(job.ok).toBe(true)
    expect(vi.mocked(docker.pull)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(docker.apply)).toHaveBeenCalledTimes(1)
    expect(job.log).toContain('3 services')
  })

  it('refuses a second deploy while one runs', async () => {
    await licensed()
    setVersion('1.0.2', dir)
    let release!: () => void
    vi.mocked(docker.pull).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ code: 0, stdout: '', stderr: '' })
        }),
    )
    const jobs = new JobRunner(dir)
    expect(jobs.startDeploy()).toBe(true)
    await vi.waitFor(() => expect(jobs.current()?.step).toBe('pull'))
    expect(jobs.startDeploy()).toBe(false)
    release()
    await vi.waitFor(() => expect(jobs.isRunning()).toBe(false))
  })

  it('a failed pull touches nothing running', async () => {
    await licensed()
    setVersion('1.0.2', dir)
    vi.mocked(docker.pull).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'denied' })
    const jobs = new JobRunner(dir)
    jobs.startDeploy()
    await vi.waitFor(() => expect(jobs.isRunning()).toBe(false))
    expect(jobs.current()!.ok).toBe(false)
    expect(jobs.current()!.log).toContain('Nothing running has been touched')
    expect(vi.mocked(docker.apply)).not.toHaveBeenCalled()
  })

  it('an unlicensed deploy fails at render, before docker is involved', async () => {
    const jobs = new JobRunner(dir)
    jobs.startDeploy()
    await vi.waitFor(() => expect(jobs.isRunning()).toBe(false))
    expect(jobs.current()!.ok).toBe(false)
    expect(jobs.current()!.log).toContain('No licence')
    expect(vi.mocked(docker.pull)).not.toHaveBeenCalled()
  })
})

describe('self-update arguments', () => {
  it('constructs the helper exactly, with quoting', async () => {
    const original = await vi.importActual<typeof import('../docker/index.js')>('../docker/index.js')
    const args = original.selfUpdateArgs('ghcr.io/x/engine:1.2.3', 'qanoontech-engine', [
      '--volume',
      '/var/run/docker.sock:/var/run/docker.sock',
    ])
    expect(args[0]).toBe('run')
    expect(args).toContain('--detach')
    const script = args[args.length - 1]!
    expect(script).toContain("docker pull 'ghcr.io/x/engine:1.2.3'")
    expect(script).toContain("docker rm -f 'qanoontech-engine'")
    expect(script).toContain("docker run -d --name 'qanoontech-engine'")
  })
})
