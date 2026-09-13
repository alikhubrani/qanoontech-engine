import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from './index.js'
import { SESSION_COOKIE } from './routes/session.js'
import { AuthStore } from './auth.js'
import { loadSecrets, loadState } from '../state/store.js'

let dir: string
let app: FastifyInstance
let cookie: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-recovery-'))
  app = buildServer({ dir, logger: false })
  cookie = `${SESSION_COOKIE}=${new AuthStore(dir).createSession({ oid: 'oid-1', upn: 'a@example.com', name: 'A' })}`
})

afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

const headers = () => ({ cookie, origin: 'http://127.0.0.1:8081' })

describe('PUT /api/offsite', () => {
  it('refuses to turn offsite on without both keys, an https endpoint and a bucket', async () => {
    const noKeys = await app.inject({
      method: 'PUT',
      url: '/api/offsite',
      headers: headers(),
      payload: { enabled: true, endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'b' },
    })
    expect(noKeys.statusCode).toBe(400)
    expect(noKeys.json().error).toContain('keys')

    const badEndpoint = await app.inject({
      method: 'PUT',
      url: '/api/offsite',
      headers: headers(),
      payload: { enabled: true, endpoint: 'http://acct.example.com/path', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' },
    })
    expect(badEndpoint.statusCode).toBe(400)
    expect(badEndpoint.json().error).toContain('https')
  })

  it('stores the keys as secrets and the rest as settings, and never reads a key back', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/offsite',
      headers: headers(),
      payload: {
        enabled: true,
        endpoint: 'https://acct.r2.cloudflarestorage.com/',
        bucket: 'firm-backups',
        prefix: 'one/',
        accessKeyId: 'AKIA',
        secretAccessKey: 'shhh',
      },
    })
    expect(put.statusCode).toBe(200)
    expect(loadSecrets(dir)['S3_SECRET_ACCESS_KEY']).toBe('shhh')
    const settings = loadState(dir).settings
    expect(settings.backupOffsiteEnabled).toBe(true)
    expect(settings.backupS3Endpoint).toBe('https://acct.r2.cloudflarestorage.com')
    expect(settings.backupS3Bucket).toBe('firm-backups')

    const get = await app.inject({ method: 'GET', url: '/api/offsite', headers: { cookie } })
    const data = get.json().data
    expect(data.keys).toEqual({ accessKeyId: true, secretAccessKey: true })
    expect(JSON.stringify(data)).not.toContain('shhh')
    expect(data.ready).toBe(true)

    const overview = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })
    const events = overview.json().data.audit.map((e: { event: string; subject?: string }) => [e.event, e.subject])
    expect(events).toContainEqual(['offsite-changed', 'a@example.com'])
  })

  it('can be turned off without touching the keys', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/offsite',
      headers: headers(),
      payload: { enabled: true, endpoint: 'https://a.example.com', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' },
    })
    const off = await app.inject({ method: 'PUT', url: '/api/offsite', headers: headers(), payload: { enabled: false } })
    expect(off.statusCode).toBe(200)
    expect(loadState(dir).settings.backupOffsiteEnabled).toBe(false)
    expect(loadSecrets(dir)['S3_ACCESS_KEY_ID']).toBe('k')
  })
})

describe('PUT /api/recovery/passphrase', () => {
  it('refuses a short passphrase and records a real one as a security event', async () => {
    const short = await app.inject({ method: 'PUT', url: '/api/recovery/passphrase', headers: headers(), payload: { passphrase: 'tooshort' } })
    expect(short.statusCode).toBe(400)

    const set = await app.inject({ method: 'PUT', url: '/api/recovery/passphrase', headers: headers(), payload: { passphrase: 'a passphrase long enough' } })
    expect(set.statusCode).toBe(200)
    expect(set.json().data.replacing).toBe(false)
    expect(loadSecrets(dir)['RECOVERY_PASSPHRASE']).toBe('a passphrase long enough')

    const status = await app.inject({ method: 'GET', url: '/api/recovery', headers: { cookie } })
    expect(status.json().data.passphraseSet).toBe(true)
    expect(JSON.stringify(status.json())).not.toContain('long enough')
  })
})

describe('PUT /api/settings', () => {
  it('accepts the schedule and the upload limit', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: headers(),
      payload: { backupHour: 3, backupRetentionDays: 14, backupIncludeUploads: false, maxFileSizeBytes: 104857600 },
    })
    expect(response.statusCode).toBe(200)
    const settings = loadState(dir).settings
    expect(settings.backupHour).toBe(3)
    expect(settings.backupRetentionDays).toBe(14)
    expect(settings.backupIncludeUploads).toBe(false)
    expect(settings.maxFileSizeBytes).toBe(104857600)
  })

  it('refuses an hour that is not one', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/settings', headers: headers(), payload: { backupHour: 24 } })
    expect(response.statusCode).toBe(400)
  })
})
