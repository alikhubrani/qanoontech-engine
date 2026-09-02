import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeJsonAtomic } from '../lib/json-files.js'
import {
  LICENCE_VERSION,
  licenceClaimsSchema,
  signLicence,
  verifyLicence,
  type LicenceClaims,
} from './format.js'
import { performHeartbeat } from './heartbeat.js'
import { installLicence, licenceStatus, readHeartbeat, writeHeartbeat } from './state.js'
import { V4 } from 'paseto'

const DAY = 24 * 60 * 60 * 1000

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const stranger = generateKeyPairSync('ed25519')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'licence-test-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function claims(overrides: Partial<LicenceClaims> = {}): LicenceClaims {
  return licenceClaimsSchema.parse({
    v: LICENCE_VERSION,
    licenceId: randomUUID(),
    firmId: 'firm-1',
    firmName: 'Al-Mithal Law Firm',
    issuedAt: new Date(Date.now() - DAY).toISOString(),
    expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
    entitlements: ['module.ocr', 'module.drive-mirror', 'module.tunnel'],
    seats: 25,
    heartbeat: { url: 'https://licence.qanoontech.com/heartbeat', intervalHours: 24, graceDays: 30 },
    override: false,
    ...overrides,
  })
}

async function install(c: LicenceClaims, key: KeyObject = privateKey): Promise<void> {
  installLicence(await signLicence(c, key), dir)
}

/** A licence whose heartbeat has just been confirmed. */
async function installFresh(c: LicenceClaims = claims()): Promise<LicenceClaims> {
  await install(c)
  writeHeartbeat({ ...readHeartbeat(dir), lastSuccessAt: Date.now(), lastAttemptAt: Date.now() }, dir)
  return c
}

describe('the format', () => {
  it('round-trips', async () => {
    const c = claims()
    const verified = await verifyLicence(await signLicence(c, privateKey), publicKey)
    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.claims).toEqual(c)
  })

  it('refuses a token signed by anyone else', async () => {
    const token = await signLicence(claims(), stranger.privateKey)
    const verified = await verifyLicence(token, publicKey)
    expect(verified.ok).toBe(false)
  })

  it('refuses a tampered token', async () => {
    const token = await signLicence(claims(), privateKey)
    const tampered = token.slice(0, -8) + 'AAAAAAAA'
    const verified = await verifyLicence(tampered, publicKey)
    expect(verified.ok).toBe(false)
  })

  it('tells a future-version licence apart from a fake', async () => {
    const future = await V4.sign({ v: LICENCE_VERSION + 1, whatever: true }, privateKey, {
      iat: false,
    })
    const verified = await verifyLicence(future, publicKey)
    expect(verified.ok).toBe(false)
    if (!verified.ok) {
      expect(verified.reason).toBe('unsupported-version')
      expect(verified.message).toContain('Update the engine')
    }
  })
})

describe('the state machine', () => {
  it('is ok with a fresh heartbeat and time on the licence', async () => {
    await installFresh()
    const status = await licenceStatus(publicKey, dir)
    expect(status.standing).toBe('ok')
  })

  it('is missing with no licence and invalid with a stranger’s', async () => {
    expect((await licenceStatus(publicKey, dir)).standing).toBe('missing')
    await install(claims(), stranger.privateKey)
    expect((await licenceStatus(publicKey, dir)).standing).toBe('invalid')
  })

  it('enters grace on expiry, and enforce once grace is used', async () => {
    await installFresh(claims({ expiresAt: new Date(Date.now() - 5 * DAY).toISOString() }))
    const inGrace = await licenceStatus(publicKey, dir)
    expect(inGrace.standing).toBe('grace')
    expect(inGrace.problem).toBe('expired')
    expect(inGrace.graceUsedDays).toBe(5)

    await installFresh(
      claims({
        issuedAt: new Date(Date.now() - 100 * DAY).toISOString(),
        expiresAt: new Date(Date.now() - 31 * DAY).toISOString(),
      }),
    )
    const done = await licenceStatus(publicKey, dir)
    expect(done.standing).toBe('enforce')
  })

  it('enters grace when heartbeats stop arriving', async () => {
    await install(claims())
    writeHeartbeat(
      { lastSuccessAt: Date.now() - 3 * DAY, lastAttemptAt: Date.now(), lastError: '', revokedAt: 0 },
      dir,
    )
    const status = await licenceStatus(publicKey, dir)
    expect(status.standing).toBe('grace')
    expect(status.problem).toBe('heartbeat')
  })

  it('starts the heartbeat clock at issue for a box that never phoned in', async () => {
    // Otherwise a firewalled box holds an unrevokable licence.
    await install(claims({ issuedAt: new Date(Date.now() - 40 * DAY).toISOString() }))
    const status = await licenceStatus(publicKey, dir)
    expect(status.standing).toBe('enforce')
    expect(status.problem).toBe('heartbeat')
  })

  it('enters grace on revocation, dated from the revocation', async () => {
    await installFresh()
    writeHeartbeat({ ...readHeartbeat(dir), revokedAt: Date.now() - 2 * DAY }, dir)
    const status = await licenceStatus(publicKey, dir)
    expect(status.standing).toBe('grace')
    expect(status.problem).toBe('revoked')
    expect(status.graceUsedDays).toBe(2)
  })

  it('counts grace against time already seen, not the clock', async () => {
    // The operator winds the clock back to stretch grace: the high-water mark
    // was 40 days after expiry, so grace stays exhausted whatever now claims.
    await installFresh(
      claims({
        issuedAt: new Date(Date.now() - 100 * DAY).toISOString(),
        expiresAt: new Date(Date.now() - 2 * DAY).toISOString(),
      }),
    )
    writeJsonAtomic(join(dir, 'clock.json'), { highWaterMark: Date.now() + 38 * DAY })
    const status = await licenceStatus(publicKey, dir)
    expect(status.standing).toBe('enforce')
  })

  it('lets an override run without heartbeats, until it expires', async () => {
    await install(claims({ override: true, expiresAt: new Date(Date.now() + 7 * DAY).toISOString() }))
    // No heartbeat ever — an ordinary licence this old would be in grace.
    expect((await licenceStatus(publicKey, dir)).standing).toBe('ok')

    await install(claims({ override: true, expiresAt: new Date(Date.now() - 1 * DAY).toISOString() }))
    expect((await licenceStatus(publicKey, dir)).standing).toBe('enforce')
  })

  it('forgives a revocation when a new licence is installed', async () => {
    await installFresh()
    writeHeartbeat({ ...readHeartbeat(dir), revokedAt: Date.now() - DAY }, dir)
    expect((await licenceStatus(publicKey, dir)).standing).toBe('grace')
    await installFresh()
    expect((await licenceStatus(publicKey, dir)).standing).toBe('ok')
  })
})

describe('the heartbeat', () => {
  function service(
    answer: (c: LicenceClaims) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): typeof fetch {
    return (async (_url: unknown, _init: unknown) => {
      const c = current!
      const payload = await answer(c)
      const body = await V4.sign(payload, privateKey, { iat: false })
      return new Response(body, { status: 200 })
    }) as typeof fetch
  }
  let current: LicenceClaims | undefined

  it('records a confirmed heartbeat', async () => {
    current = await installFresh()
    const outcome = await performHeartbeat(
      current,
      publicKey,
      dir,
      service((c) => ({ v: 1, licenceId: c.licenceId, status: 'ok', at: new Date().toISOString() })),
    )
    expect(outcome.result).toBe('ok')
    expect(readHeartbeat(dir).lastSuccessAt).toBeGreaterThan(0)
  })

  it('records a revocation', async () => {
    current = await installFresh()
    const outcome = await performHeartbeat(
      current,
      publicKey,
      dir,
      service((c) => ({ v: 1, licenceId: c.licenceId, status: 'revoked', at: new Date().toISOString() })),
    )
    expect(outcome.result).toBe('revoked')
    expect(readHeartbeat(dir).revokedAt).toBeGreaterThan(0)
    expect((await licenceStatus(publicKey, dir)).problem).toBe('revoked')
  })

  it('treats an unsigned answer as no answer', async () => {
    current = await installFresh()
    const fake = (async () =>
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 })) as unknown as typeof fetch
    const outcome = await performHeartbeat(current, publicKey, dir, fake)
    expect(outcome.result).toBe('failed')
  })

  it('treats a replayed old answer as no answer', async () => {
    current = await installFresh()
    const outcome = await performHeartbeat(
      current,
      publicKey,
      dir,
      service((c) => ({
        v: 1,
        licenceId: c.licenceId,
        status: 'ok',
        at: new Date(Date.now() - 30 * DAY).toISOString(),
      })),
    )
    expect(outcome.result).toBe('failed')
    expect(outcome.detail).toContain('stale')
  })

  it('treats an answer about a different licence as no answer', async () => {
    current = await installFresh()
    const outcome = await performHeartbeat(
      current,
      publicKey,
      dir,
      service(() => ({ v: 1, licenceId: 'someone-else', status: 'ok', at: new Date().toISOString() })),
    )
    expect(outcome.result).toBe('failed')
  })

  it('records an unreachable service and moves on', async () => {
    current = await installFresh()
    const dead = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    const outcome = await performHeartbeat(current, publicKey, dir, dead)
    expect(outcome.result).toBe('failed')
    expect(readHeartbeat(dir).lastError).toContain('Could not reach')
  })
})
