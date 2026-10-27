import { X509Certificate, createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadState, saveSecrets, saveState } from '../state/store.js'
import { checkCertificate, checkM365, m365Configured, m365Gate, recordM365Applied } from './check.js'

/**
 * A real key and a real certificate, made here, because what the certificate
 * check is for is catching a key that does not belong to its certificate -- a
 * fake that skipped `checkPrivateKey` would pass an implementation that
 * skipped it too. Node can sign but not issue a certificate, so the few DER
 * structures an X.509 v3 self-signed certificate needs are written out below
 * rather than shelling out to an `openssl` the test box may not have.
 */
const DAY = 24 * 60 * 60 * 1000

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const n = body.length
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]
  return Buffer.concat([Buffer.from([tag, ...length]), body])
}
const seq = (...parts: Buffer[]) => der(0x30, ...parts)
const hex = (value: string) => Buffer.from(value, 'hex')
const SHA256_WITH_RSA = seq(hex('06092a864886f70d01010b'), hex('0500'))
const commonName = (cn: string) => seq(der(0x31, seq(hex('0603550403'), der(0x0c, Buffer.from(cn)))))
// UTCTime, YYMMDDHHMMSSZ: right for any date before 2050.
const utcTime = (date: Date) => der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`))

function certificatePem(signer: KeyObject, subject: KeyObject, notAfter: Date): string {
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    SHA256_WITH_RSA,
    commonName('qanoontech-test'),
    seq(utcTime(new Date(Date.now() - DAY)), utcTime(notAfter)),
    commonName('qanoontech-test'),
    subject.export({ type: 'spki', format: 'der' }),
  )
  const certificate = seq(tbs, SHA256_WITH_RSA, der(0x03, Buffer.from([0]), sign('sha256', tbs, signer)))
  const lines = certificate.toString('base64').match(/.{1,64}/g)!.join('\n')
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`
}

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyPem = (key: KeyObject) => key.export({ type: 'pkcs8', format: 'pem' }) as string

/** Key then certificate, as `cat key.pem cert.pem` makes it. */
function bundle(options: { daysLeft?: number; key?: KeyObject } = {}): string {
  const notAfter = new Date(Date.now() + (options.daysLeft ?? 365) * DAY)
  return keyPem(options.key ?? pair.privateKey) + certificatePem(pair.privateKey, pair.publicKey, notAfter)
}

const PEM = bundle()

const TENANT = '11111111-2222-3333-4444-555555555555'
const CLIENT = '66666666-7777-8888-9999-000000000000'
const CONTAINER_TYPE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const PUBLIC_URL = 'https://app.firm.example'

function complete(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DB_PASSWORD: 'x',
    M365_TENANT_ID: TENANT,
    M365_CLIENT_ID: CLIENT,
    M365_CONTAINER_TYPE_ID: CONTAINER_TYPE,
    M365_CERT_PEM: PEM,
    ...overrides,
  }
}

type Kind = 'token' | 'containers' | 'users' | 'registration' | 'handshake'
type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Microsoft and the firm's address, answering as if everything were set up right. */
function microsoft(overrides: Partial<Record<Kind, Handler>> = {}) {
  const handlers: Record<Kind, Handler> = {
    token: () => json(200, { access_token: 'graph-token', expires_in: 3599 }),
    containers: () => json(200, { value: [] }),
    users: () => json(200, { value: [{ id: 'someone' }] }),
    registration: () => json(200, { settings: { isSharingRestricted: true, sharingCapability: 'disabled' } }),
    handshake: (url) => new Response(url.searchParams.get('validationToken'), { status: 200 }),
    ...overrides,
  }
  const calls: { kind: Kind; url: URL; init: RequestInit | undefined }[] = []
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const kind: Kind =
      url.host === 'login.microsoftonline.com'
        ? 'token'
        : url.pathname.endsWith('/storage/fileStorage/containers')
          ? 'containers'
          : url.pathname.endsWith('/v1.0/users')
            ? 'users'
            : url.pathname.includes('/storage/fileStorage/containerTypeRegistrations/')
              ? 'registration'
              : 'handshake'
    calls.push({ kind, url, init })
    return handlers[kind](url, init)
  })
  return { fetcher: fetcher as unknown as typeof fetch, calls, kinds: () => calls.map((c) => c.kind) }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-m365-'))
  const state = loadState(dir)
  saveState({ ...state, settings: { ...state.settings, publicUrl: PUBLIC_URL } }, dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const byId = <T extends { id: string }>(checks: readonly T[], id: string): T => checks.find((c) => c.id === id)!

describe('whether Microsoft 365 is configured', () => {
  it('is none, partial or complete, and whitespace is missing', () => {
    expect(m365Configured({ DB_PASSWORD: 'x' })).toBe('none')
    expect(m365Configured(complete())).toBe('complete')
    expect(m365Configured(complete({ M365_CLIENT_ID: '' }))).toBe('partial')
    expect(m365Configured(complete({ M365_CONTAINER_TYPE_ID: '   ' }))).toBe('partial')
  })
})

describe('the checks', () => {
  it('pass end to end against a tenant set up right', async () => {
    saveSecrets(complete(), dir)
    const ms = microsoft()
    const checks = await checkM365(dir, ms.fetcher)
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['m365-config', 'pass'],
      ['m365-cert', 'pass'],
      ['m365-token', 'pass'],
      ['m365-graph', 'pass'],
      ['m365-directory', 'pass'],
      ['m365-sharing', 'pass'],
      ['m365-address', 'pass'],
      ['m365-notifications', 'pass'],
    ])
    expect(ms.kinds()).toEqual(['token', 'containers', 'users', 'registration', 'handshake'])
  })

  it('a partial set fails by name, and asks Microsoft nothing it cannot answer', async () => {
    const { M365_CLIENT_ID: _client, M365_CONTAINER_TYPE_ID: _type, ...partial } = complete()
    saveSecrets(partial, dir)
    const ms = microsoft()
    const checks = await checkM365(dir, ms.fetcher)

    const config = byId(checks, 'm365-config')
    expect(config.status).toBe('fail')
    expect(config.detail).toContain('M365_CLIENT_ID, M365_CONTAINER_TYPE_ID missing')
    // The certificate is local and still worth reading.
    expect(byId(checks, 'm365-cert').status).toBe('pass')
    for (const id of ['m365-token', 'm365-graph', 'm365-directory']) {
      expect(byId(checks, id)).toMatchObject({ status: 'fail', detail: expect.stringContaining('Not checked') })
    }
    expect(ms.kinds()).not.toContain('token')
  })

  it('a key that does not belong to the certificate fails before Entra is asked', async () => {
    saveSecrets(complete({ M365_CERT_PEM: bundle({ key: other.privateKey }) }), dir)
    const ms = microsoft()
    const checks = await checkM365(dir, ms.fetcher)
    expect(byId(checks, 'm365-cert')).toMatchObject({ status: 'fail', detail: expect.stringContaining('does not belong') })
    expect(byId(checks, 'm365-token').detail).toContain('Not checked')
    expect(ms.kinds()).not.toContain('token')
  })

  it('names what is missing from the PEM', () => {
    const certOnly = certificatePem(pair.privateKey, pair.publicKey, new Date(Date.now() + 365 * DAY))
    expect(checkCertificate(certOnly).result).toMatchObject({ status: 'fail', detail: expect.stringContaining('private key') })
    expect(checkCertificate(keyPem(pair.privateKey)).result).toMatchObject({ status: 'fail', detail: expect.stringContaining('a certificate') })
  })

  it('an expired certificate fails, one about to expire warns, and the date is given', () => {
    expect(checkCertificate(bundle({ daysLeft: -2 })).result).toMatchObject({ status: 'fail', detail: expect.stringContaining('expired') })
    expect(checkCertificate(bundle({ daysLeft: 10 })).result).toMatchObject({ status: 'warn', detail: expect.stringContaining('day(s)') })
    const fine = checkCertificate(bundle({ daysLeft: 200 }))
    const expiry = new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10)
    expect(fine.result.status).toBe('pass')
    expect(fine.result.detail).toContain(expiry.slice(0, 7))
  })

  it('asks Entra the way the application does', async () => {
    saveSecrets(complete(), dir)
    const ms = microsoft()
    await checkM365(dir, ms.fetcher)

    const call = ms.calls.find((c) => c.kind === 'token')!
    expect(call.url.toString()).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`)
    const form = call.init!.body as URLSearchParams
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('client_id')).toBe(CLIENT)
    expect(form.get('scope')).toBe('https://graph.microsoft.com/.default')
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer')

    const [head, body, signature] = form.get('client_assertion')!.split('.') as [string, string, string]
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    const certificate = new X509Certificate(PEM.slice(PEM.indexOf('-----BEGIN CERTIFICATE')))
    expect(decode(head)).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      x5t: createHash('sha1').update(certificate.raw).digest('base64url'),
    })
    const claims = decode(body)
    expect(claims).toMatchObject({ aud: call.url.toString(), iss: CLIENT, sub: CLIENT })
    expect(claims.exp - claims.nbf).toBe(600)
    expect(typeof claims.jti).toBe('string')
    expect(
      verify('RSA-SHA256', Buffer.from(`${head}.${body}`), createPublicKey(pair.privateKey), Buffer.from(signature, 'base64url')),
    ).toBe(true)
  })

  it('a refused token fails with the first line of Entra’s reason and skips Graph', async () => {
    saveSecrets(complete(), dir)
    const ms = microsoft({
      token: () =>
        json(401, {
          error: 'invalid_client',
          error_description:
            "AADSTS700027: The certificate with identifier used to sign the client assertion is not registered on application.\r\nTrace ID: 0000\r\nCorrelation ID: 1111",
        }),
    })
    const checks = await checkM365(dir, ms.fetcher)
    const token = byId(checks, 'm365-token')
    expect(token.status).toBe('fail')
    expect(token.detail).toContain('AADSTS700027')
    expect(token.detail).not.toContain('Trace ID')
    expect(byId(checks, 'm365-graph').detail).toContain('Not checked')
    expect(byId(checks, 'm365-directory').detail).toContain('Not checked')
    expect(ms.kinds()).not.toContain('containers')
    expect(ms.kinds()).not.toContain('users')
    expect(ms.kinds()).not.toContain('registration')
    // The address is not Entra's business, so it is still asked.
    expect(byId(checks, 'm365-notifications').status).toBe('pass')
  })

  it('names the missing registration or consent when Graph refuses', async () => {
    saveSecrets(complete(), dir)
    const ms = microsoft({
      containers: () => json(403, { error: { code: 'accessDenied', message: 'Access denied' } }),
      users: () => json(403, { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } }),
    })
    const checks = await checkM365(dir, ms.fetcher)
    expect(byId(checks, 'm365-graph')).toMatchObject({ status: 'fail', detail: expect.stringContaining('FileStorageContainer.Selected') })
    expect(byId(checks, 'm365-directory')).toMatchObject({ status: 'fail', detail: expect.stringContaining('User.Read.All') })
    expect(ms.calls.find((c) => c.kind === 'containers')!.url.searchParams.get('$filter')).toBe(`containerTypeId eq ${CONTAINER_TYPE}`)
  })
})

describe('the way back in', () => {
  beforeEach(() => saveSecrets(complete(), dir))

  async function notifications(handshake: Handler, publicUrl = PUBLIC_URL) {
    const state = loadState(dir)
    saveState({ ...state, settings: { ...state.settings, publicUrl } }, dir)
    const ms = microsoft({ handshake })
    const checks = await checkM365(dir, ms.fetcher)
    return { checks, ms, line: byId(checks, 'm365-notifications') }
  }

  it('passes only when the token comes back, and does not follow redirects', async () => {
    const { line, ms } = await notifications((url) => new Response(url.searchParams.get('validationToken'), { status: 200 }))
    expect(line.status).toBe('pass')
    const call = ms.calls.find((c) => c.kind === 'handshake')!
    expect(call.url.origin + call.url.pathname).toBe(`${PUBLIC_URL}/api/m365/notifications`)
    expect(call.url.searchParams.get('validationToken')).toMatch(/^[0-9a-f]{32}$/)
    expect(call.init).toMatchObject({ method: 'POST', redirect: 'manual' })
  })

  it('a 200 that is not the token is not a pass', async () => {
    const { line } = await notifications(() => new Response('<html>sign in</html>', { status: 200 }))
    expect(line).toMatchObject({ status: 'fail', detail: expect.stringContaining('not with the token') })
  })

  it('Cloudflare Access in front of the path is named, with the fix', async () => {
    const { line } = await notifications(
      () => new Response(null, { status: 302, headers: { Location: 'https://firm.cloudflareaccess.com/cdn-cgi/access/login/app.firm.example' } }),
    )
    expect(line.status).toBe('fail')
    expect(line.detail).toContain('Cloudflare Access')
    expect(line.detail).toContain('scripts/cloudflare/m365-notification-bypass.mjs')
  })

  it('a 404 means the running application is too old', async () => {
    const { line } = await notifications(() => new Response('Not found', { status: 404 }))
    expect(line).toMatchObject({ status: 'fail', detail: expect.stringContaining('1.28 or later') })
  })

  it('no address, or one that is not https, fails and is not called', async () => {
    for (const publicUrl of ['', 'http://app.firm.example']) {
      const { checks, ms } = await notifications(() => new Response('', { status: 200 }), publicUrl)
      expect(byId(checks, 'm365-address').status).toBe('fail')
      expect(byId(checks, 'm365-notifications').detail).toContain('Not checked')
      expect(ms.kinds()).not.toContain('handshake')
    }
  })
})

describe('the apply gate', () => {
  it('runs the checks on a changed configuration, and not on an unchanged one', async () => {
    saveSecrets(complete(), dir)

    const first = microsoft()
    const changed = await m365Gate(dir, first.fetcher)
    expect(changed.proceed).toBe(true)
    expect(changed.checks).toHaveLength(8)
    expect(first.fetcher).toHaveBeenCalled()
    recordM365Applied(changed.fingerprint, dir)
    expect(loadState(dir).m365AppliedFingerprint).toBe(changed.fingerprint)

    // Microsoft having a bad minute does not block a routine update.
    const down = microsoft({ token: () => json(503, { error: 'temporarily_unavailable' }) })
    const unchanged = await m365Gate(dir, down.fetcher)
    expect(unchanged.proceed).toBe(true)
    expect(unchanged.checks).toBeUndefined()
    expect(down.fetcher).not.toHaveBeenCalled()

    // The address is part of the configuration: moving it is checked.
    const state = loadState(dir)
    saveState({ ...state, settings: { ...state.settings, publicUrl: 'https://cases.firm.example' } }, dir)
    const moved = microsoft()
    const again = await m365Gate(dir, moved.fetcher)
    expect(again.checks).toBeDefined()
    expect(again.fingerprint).not.toBe(changed.fingerprint)
  })

  it('refuses a changed configuration that fails, and records nothing', async () => {
    saveSecrets(complete(), dir)
    const ms = microsoft({ handshake: () => new Response('', { status: 404 }) })
    const gate = await m365Gate(dir, ms.fetcher)
    expect(gate.proceed).toBe(false)
    expect(gate.checks!.some((c) => c.status === 'fail')).toBe(true)
    expect(loadState(dir).m365AppliedFingerprint).toBeUndefined()
  })

  it('refuses a partial configuration without asking anyone', async () => {
    saveSecrets(complete({ M365_TENANT_ID: '' }), dir)
    const ms = microsoft()
    const gate = await m365Gate(dir, ms.fetcher)
    expect(gate.proceed).toBe(false)
    expect(gate.detail).toContain('M365_TENANT_ID')
    expect(ms.fetcher).not.toHaveBeenCalled()
  })

  it('with none configured, proceeds as before and clears what was recorded', async () => {
    saveSecrets(complete(), dir)
    const applied = await m365Gate(dir, microsoft().fetcher)
    recordM365Applied(applied.fingerprint, dir)

    saveSecrets({ DB_PASSWORD: 'x' }, dir)
    const ms = microsoft()
    const gate = await m365Gate(dir, ms.fetcher)
    expect(gate).toEqual({ proceed: true, detail: '', fingerprint: undefined })
    expect(ms.fetcher).not.toHaveBeenCalled()
    recordM365Applied(gate.fingerprint, dir)
    expect(loadState(dir).m365AppliedFingerprint).toBeUndefined()
  })
})

describe('sharing', () => {
  it('fails the open model, which is the default, and external sharing', async () => {
    saveSecrets(complete(), dir)
    const open = microsoft({ registration: () => json(200, { settings: { isSharingRestricted: false } }) })
    expect(byId(await checkM365(dir, open.fetcher), 'm365-sharing')).toMatchObject({ status: 'fail', detail: expect.stringContaining('open sharing model') })

    const external = microsoft({ registration: () => json(200, { settings: { isSharingRestricted: true, sharingCapability: 'externalUserSharingOnly' } }) })
    expect(byId(await checkM365(dir, external.fetcher), 'm365-sharing')).toMatchObject({ status: 'fail', detail: expect.stringContaining('External sharing') })
  })

  it('passes restrictive with sharing off, and asks the registration of this container type', async () => {
    saveSecrets(complete(), dir)
    const ms = microsoft()
    expect(byId(await checkM365(dir, ms.fetcher), 'm365-sharing').status).toBe('pass')
    const asked = ms.calls.find((c) => c.kind === 'registration')!
    expect(asked.url.pathname).toContain(`/containerTypeRegistrations/${complete().M365_CONTAINER_TYPE_ID}`)
  })
})
