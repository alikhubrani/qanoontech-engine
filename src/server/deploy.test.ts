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
    plannedImages: vi.fn(async () => ({
      code: 0,
      stdout: 'ghcr.io/alikhubrani/qanoontech:1.0.2\nghcr.io/alikhubrani/qanoontech-nginx:1.0.2\npostgres:15-alpine\n',
      stderr: '',
    })),
    pull: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    apply: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    login: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    ps: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    selfUpdate: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  }
})

vi.mock('../docker/pull.js', () => ({
  pullImages: vi.fn(async (images: string[]) => ({
    ok: true,
    images: images.map((image) => ({ image, state: 'done', downloaded: 1, total: 1, percent: 100, attempt: 1, detail: '' })),
  })),
}))

import * as docker from '../docker/index.js'
import { pullImages } from '../docker/pull.js'
import { orderVersions } from '../registry.js'
import {
  ensureGeneratedSecrets,
  loadSecrets,
  loadState,
  saveState,
  saveSecrets,
} from '../state/store.js'
import { AuthStore } from './auth.js'
import { buildServer } from './index.js'
import { SESSION_COOKIE } from './routes/session.js'
import { JobRunner, rollbackVersion, setVersion } from './jobs.js'

const DAY = 24 * 60 * 60 * 1000
const { privateKey, publicKey } = generateKeyPairSync('ed25519')

let dir: string
let app: FastifyInstance

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-deploy-'))
  app = buildServer({ dir, logger: false })
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

/**
 * A signed-in session, without going through Entra.
 *
 * These tests are about what the panel does *once* somebody is in; who gets in
 * is `entra.test.ts`. There is no password to post any more, so the session is
 * minted the way the callback mints it — which also keeps the two concerns from
 * leaking into each other, so a change to sign-in cannot quietly break every
 * deploy test.
 */
async function signIn(): Promise<string> {
  return `${SESSION_COOKIE}=${new AuthStore(dir).createSession()}`
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

  /**
   * The setting deciding whether a box keeps any diagnostic record at all was
   * missing from the patch schema, so it was written once at install and could
   * not be changed afterwards from anywhere -- not this endpoint, not the CLI.
   * An operator has to be able to turn the logs up when something is wrong.
   */
  it('lets an operator change the log level', async () => {
    const cookie = await signIn()
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { logLevel: 'debug' },
    })
    expect(put.statusCode).toBe(200)
    expect(loadState(dir).settings.logLevel).toBe('debug')
  })

  it('refuses a log level that is not one of the four', async () => {
    const cookie = await signIn()
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { logLevel: 'chatty' },
    })
    expect(put.statusCode).toBe(400)
  })

  it('defaults a new deployment to info, not warn', () => {
    // At warn a box kept 731 warnings, 26 errors and zero info lines over nine
    // days -- no record of who read what, and no successful sign-ins.
    expect(loadState(dir).settings.logLevel).toBe('info')
  })

  it('accepts a wildcard bind address — deployments are LAN-open by design', async () => {
    const cookie = await signIn()
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { bindAddress: '0.0.0.0' },
    })
    expect(put.statusCode).toBe(200)
    expect(loadState(dir).settings.bindAddress).toBe('0.0.0.0')
  })
})

/**
 * The optional modules these tests drive the module API with. `email` has
 * required configuration and only optional secrets; `tunnel` has the one
 * required secret left in the catalogue. Both roles used to be the Drive
 * mirror's, retired with Google Drive.
 */
const VALID_EMAIL = { smtpHost: 'smtp.example.com', fromAddress: 'firm@example.com' }
const TUNNEL_TOKEN = 'eyJhIjoidHVubmVsLXRva2VuIn0'

describe('modules over the API', () => {
  it('enables, disables, and refuses the required', async () => {
    const cookie = await signIn()
    expect(
      (await app.inject({ method: 'POST', url: '/api/modules/email/enable', headers: { cookie } }))
        .statusCode,
    ).toBe(200)
    expect(loadState(dir).enabled).toContain('email')

    expect(
      (await app.inject({ method: 'POST', url: '/api/modules/postgres/disable', headers: { cookie } }))
        .statusCode,
    ).toBe(409)

    expect(
      (await app.inject({ method: 'POST', url: '/api/modules/email/disable', headers: { cookie } }))
        .statusCode,
    ).toBe(200)
    expect(loadState(dir).enabled).not.toContain('email')
  })

  it('validates module config against its schema', async () => {
    const cookie = await signIn()
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/modules/email/config',
      headers: { cookie },
      payload: { config: { ...VALID_EMAIL, smtpHost: '' } },
    })
    expect(bad.statusCode).toBe(422)

    const good = await app.inject({
      method: 'PUT',
      url: '/api/modules/email/config',
      headers: { cookie },
      payload: { config: VALID_EMAIL },
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
    setVersion('1.0.2', dir)
    const jobs = new JobRunner(dir)
    expect(jobs.startDeploy()).toBe(true)
    await vi.waitFor(() => expect(jobs.isRunning()).toBe(false))

    const job = jobs.current()!
    expect(job.ok).toBe(true)
    expect(vi.mocked(pullImages)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(docker.apply)).toHaveBeenCalledTimes(1)
    expect(job.log).toContain('4 services')
  })

  it('refuses a second deploy while one runs', async () => {
    setVersion('1.0.2', dir)
    let release!: () => void
    vi.mocked(pullImages).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, images: [] })
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
    setVersion('1.0.2', dir)
    vi.mocked(pullImages).mockResolvedValueOnce({
      ok: false,
      images: [{ image: 'x', state: 'failed', downloaded: 0, total: 0, percent: -1, attempt: 6, detail: 'stalled' }],
    })
    const jobs = new JobRunner(dir)
    jobs.startDeploy()
    await vi.waitFor(() => expect(jobs.isRunning()).toBe(false))
    expect(jobs.current()!.ok).toBe(false)
    expect(jobs.current()!.log).toContain('Nothing running has been touched')
    expect(vi.mocked(docker.apply)).not.toHaveBeenCalled()
  })

  it('a deploy that cannot be planned fails before docker is involved', async () => {
    /*
     * A module turned on and never configured, so resolution refuses.
     *
     * This used to be an unlicensed deploy, and removing licensing showed the
     * test had been resting on it: with no licence gate a bare deployment
     * deploys, because `JobRunner` generates its own secrets before planning.
     * That is right — an engine that cannot install itself without a licence
     * server was the thing being removed.
     *
     * What the test is for survives the change: whatever stops a deploy being
     * *planned* must stop it before anything is pulled or recreated. A deploy
     * that gets as far as touching containers and then fails is the one that
     * leaves a firm with neither the old version nor the new.
     */
    const state = loadState(dir)
    saveState({ ...state, enabled: ['email'], config: {} }, dir)

    const jobs = new JobRunner(dir)
    jobs.startDeploy()
    await vi.waitFor(() => expect(jobs.isRunning()).toBe(false))
    expect(jobs.current()!.ok).toBe(false)
    expect(vi.mocked(docker.pull)).not.toHaveBeenCalled()
    expect(vi.mocked(docker.apply)).not.toHaveBeenCalled()
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
    expect(script).toContain("|| docker image inspect 'ghcr.io/x/engine:1.2.3'")
    expect(script).toContain("docker rm -f 'qanoontech-engine'")
    expect(script).toContain("docker run -d --name 'qanoontech-engine'")
  })
})

describe('the support bundle', () => {
  it('is valid JSON after redaction, with no stored secret value inside', async () => {
    // The first redactor broke the JSON it was redacting — found on the
    // staging box, on the first real download. This is that download.
    const cookie = await signIn()
    const { gunzipSync } = await import('node:zlib')
    const response = await app.inject({ method: 'GET', url: '/api/support-bundle', headers: { cookie } })
    expect(response.statusCode).toBe(200)

    const text = gunzipSync(response.rawPayload).toString()
    const bundle = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(bundle)).toContain('preflight')
    expect(Object.keys(bundle)).toContain('audit')

    const { loadSecrets } = await import('../state/store.js')
    for (const value of Object.values(loadSecrets(dir))) {
      expect(text).not.toContain(value)
    }
  })
})

describe('modules describe themselves to the panel', () => {
  it('exposes the form schema derived from the validation schema', async () => {
    const cookie = await signIn()
    const response = await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie } })
    const modules = response.json().data.modules as {
      id: string
      configSchema: { properties?: Record<string, { title?: string }> } | null
      secrets: { name: string; set: boolean }[]
    }[]

    const mailer = modules.find((m) => m.id === 'email')!
    expect(mailer.configSchema?.properties?.['smtpHost']?.title).toBe('SMTP host')
    expect(mailer.secrets.map((s) => s.name)).toEqual(['DATABASE_URL', 'SMTP_PASSWORD', 'SMTP_OAUTH_SECRET'])
    expect(mailer.secrets[0]!.set).toBe(false)

    // A module with no config renders no form — null, not an empty object.
    expect(modules.find((m) => m.id === 'postgres')!.configSchema).toBeNull()
  })

  it('accepts a declared secret, reports it as set, and never echoes it', async () => {
    const cookie = await signIn()
    const put = await app.inject({
      method: 'PUT',
      url: '/api/modules/tunnel/secrets',
      headers: { cookie },
      payload: { values: { CLOUDFLARE_TUNNEL_TOKEN: TUNNEL_TOKEN } },
    })
    expect(put.statusCode).toBe(200)
    expect(JSON.stringify(put.json())).not.toContain(TUNNEL_TOKEN)

    const listing = await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie } })
    const tunnelled = listing
      .json()
      .data.modules.find((m: { id: string }) => m.id === 'tunnel')
    expect(tunnelled.secrets[0].set).toBe(true)
    expect(JSON.stringify(listing.json())).not.toContain(TUNNEL_TOKEN)

    const { loadSecrets } = await import('../state/store.js')
    expect(loadSecrets(dir)['CLOUDFLARE_TUNNEL_TOKEN']).toBe(TUNNEL_TOKEN)
  })

  it('reports which secrets are optional, and lets only those be cleared', async () => {
    const cookie = await signIn()
    const listing = await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie } })
    const modules = listing.json().data.modules as {
      id: string
      secrets: { name: string; optional: boolean; set: boolean }[]
    }[]
    const smtp = modules.find((m) => m.id === 'email')!.secrets.find((s) => s.name === 'SMTP_PASSWORD')!
    expect(smtp.optional).toBe(true)
    expect(modules.find((m) => m.id === 'tunnel')!.secrets[0]!.optional).toBe(false)

    const { loadSecrets } = await import('../state/store.js')

    const set = await app.inject({
      method: 'PUT',
      url: '/api/modules/email/secrets',
      headers: { cookie },
      payload: { values: { SMTP_PASSWORD: 'relay-password' } },
    })
    expect(set.statusCode).toBe(200)
    expect(loadSecrets(dir)['SMTP_PASSWORD']).toBe('relay-password')

    // Empty clears an optional secret — it is gone, not stored as ''.
    const clear = await app.inject({
      method: 'PUT',
      url: '/api/modules/email/secrets',
      headers: { cookie },
      payload: { values: { SMTP_PASSWORD: '' } },
    })
    expect(clear.statusCode).toBe(200)
    expect('SMTP_PASSWORD' in loadSecrets(dir)).toBe(false)

    // A required secret can be replaced but never cleared.
    await app.inject({
      method: 'PUT',
      url: '/api/modules/tunnel/secrets',
      headers: { cookie },
      payload: { values: { CLOUDFLARE_TUNNEL_TOKEN: TUNNEL_TOKEN } },
    })
    const refused = await app.inject({
      method: 'PUT',
      url: '/api/modules/tunnel/secrets',
      headers: { cookie },
      payload: { values: { CLOUDFLARE_TUNNEL_TOKEN: '' } },
    })
    expect(refused.statusCode).toBe(422)
    expect(loadSecrets(dir)['CLOUDFLARE_TUNNEL_TOKEN']).toBe(TUNNEL_TOKEN)
  })

  it('refuses a secret the module does not declare — this is not a general write path', async () => {
    const cookie = await signIn()
    for (const [module, name] of [
      ['tunnel', 'DB_PASSWORD'],
      ['tunnel', 'JWT_SECRET'],
      ['email', 'CLOUDFLARE_TUNNEL_TOKEN'],
    ] as const) {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/modules/${module}/secrets`,
        headers: { cookie },
        payload: { values: { [name]: 'overwrite-attempt' } },
      })
      expect(put.statusCode, `${module}/${name}`).toBe(422)
    }
    const { loadSecrets } = await import('../state/store.js')
    expect(loadSecrets(dir)['DB_PASSWORD']).not.toBe('overwrite-attempt')
  })
})

describe('the engine updating itself', () => {
  it('starts the helper with the standard run configuration', async () => {
    const cookie = await signIn()
    const response = await app.inject({
      method: 'POST',
      url: '/api/engine/update',
      headers: { cookie },
      payload: { version: '0.2.0' },
    })
    expect(response.statusCode).toBe(200)
    const [image, name, args] = vi.mocked(docker.selfUpdate).mock.calls[0]!
    expect(image).toBe('ghcr.io/alikhubrani/qanoontech-engine:0.2.0')
    expect(name).toBe('qanoontech-engine')
    expect(args).toContain('--restart')
  })

  it('refuses a version that is not a tag shape', async () => {
    const cookie = await signIn()
    const response = await app.inject({
      method: 'POST',
      url: '/api/engine/update',
      headers: { cookie },
      payload: { version: 'v1; rm -rf /' },
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('per-module resource overrides', () => {
  it('reports the default and accepts an override that renders as the limit', async () => {
    const cookie = await signIn()

    const before = await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie } })
    const mailer = before.json().data.modules.find((m: { id: string }) => m.id === 'email')
    expect(mailer.resources.defaultMemory).toBe('256M')
    expect(mailer.resources.memory).toBe('256M')

    const put = await app.inject({
      method: 'PUT',
      url: '/api/modules/email/resources',
      headers: { cookie },
      payload: { memory: '10G', cpus: '4' },
    })
    expect(put.statusCode).toBe(200)

    const after = await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie } })
    const mailer2 = after.json().data.modules.find((m: { id: string }) => m.id === 'email')
    expect(mailer2.resources.memory).toBe('10G')
    expect(mailer2.resources.defaultMemory).toBe('256M')
    expect(loadState(dir).resources['email']).toEqual({ memory: '10G', cpus: '4' })
  })

  it('refuses a nonsense memory string', async () => {
    const cookie = await signIn()
    const put = await app.inject({
      method: 'PUT',
      url: '/api/modules/email/resources',
      headers: { cookie },
      payload: { memory: 'lots' },
    })
    expect(put.statusCode).toBe(400)
  })
})
