import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { CATALOGUE, resolve, type DeploymentSettings } from '../catalogue/index.js'
import { render } from './compose.js'

const ALL = CATALOGUE.map((m) => m.entitlement).filter((e): e is string => e !== undefined)

const settings: DeploymentSettings = {
  bindAddress: '10.77.42.5',
  appPort: 8080,
  dbName: 'qanoontech',
  dbUser: 'qanoontech',
  timezone: 'Asia/Riyadh',
  defaultLanguage: 'ar',
  logLevel: 'warn',
  maxFileSizeBytes: 52_428_800,
}

const secrets = {
  DB_PASSWORD: 'db-secret',
  JWT_SECRET: 'jwt-secret',
  JWT_REFRESH_SECRET: 'jwt-refresh-secret',
  SETTINGS_ENCRYPTION_KEY: 'c2V0dGluZ3Mta2V5LXRoaXJ0eS10d28tYnl0ZXMh',
  GOOGLE_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}',
  CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token',
}

function renderWith(
  enabled: string[] = [],
  config: Record<string, unknown> = {},
  overrides: Partial<{ settings: DeploymentSettings; secrets: Record<string, string> }> = {},
) {
  const resolution = resolve({ enabled, config, entitlements: ALL })
  if (!resolution.ok) throw new Error(resolution.problems.map((p) => p.message).join('; '))
  return render({
    modules: resolution.modules,
    version: '1.0.2',
    settings: overrides.settings ?? settings,
    secrets: overrides.secrets ?? secrets,
  })
}

function document(enabled: string[] = [], config: Record<string, unknown> = {}) {
  const result = renderWith(enabled, config)
  if (!result.ok) throw new Error(result.problems.map((p) => p.message).join('; '))
  return parse(result.yaml)
}

describe('render', () => {
  it('produces a compose file docker can parse', () => {
    const doc = document()
    expect(doc.name).toBe('qanoontech')
    expect(Object.keys(doc.services)).toEqual(['postgres', 'app', 'nginx', 'gotenberg'])
  })

  it('deploys gotenberg as a required service with no published port', () => {
    const doc = document()
    const g = doc.services.gotenberg
    expect(g.image).toBe('gotenberg/gotenberg:8')
    // Internal only — the app reaches it by name; nothing is exposed.
    expect(g.ports).toBeUndefined()
    expect(g.networks).toEqual(['internal'])
    expect(g.healthcheck.test).toContain('http://localhost:3000/health')
  })

  it('tells the application where to render PDFs', () => {
    const doc = document()
    expect(doc.services.app.environment.GOTENBERG_URL).toBe('http://gotenberg:3000')
  })

  /*
   * The name has to match the service the email module renders, and the two
   * were set in different repositories and did not. Named here so a rename on
   * either side fails a test rather than silently switching email off.
   */
  it('tells the application where to queue email, by the name the module has', () => {
    const doc = document()
    expect(doc.services.app.environment.MAILER_URL).toBe('http://email:3004')
    // No smtpUser, so no SMTP_PASSWORD secret is demanded: a relay that trusts
    // the network is a real configuration, and this test is about the hostname.
    const withEmail = document(['email'], {
      email: { smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecure: false, fromAddress: 'noreply@example.com' },
    })
    expect(Object.keys(withEmail.services)).toContain('email')
    expect(withEmail.services.app.environment.MAILER_URL).toBe('http://email:3004')
  })


  it('tags our images with the deployment version and leaves pinned ones alone', () => {
    const doc = document(['tunnel'], { tunnel: { privateRange: '10.77.42.0/24' } })
    expect(doc.services.app.image).toBe('ghcr.io/alikhubrani/qanoontech:1.0.2')
    expect(doc.services.nginx.image).toBe('ghcr.io/alikhubrani/qanoontech-nginx:1.0.2')
    // Postgres does not move with our releases. A major-version jump leaves a
    // data directory the new binary refuses to open.
    expect(doc.services.postgres.image).toBe('postgres:15-alpine')
    expect(doc.services.tunnel.image).toBe('cloudflare/cloudflared:latest')
  })

  it('waits for health rather than merely for start', () => {
    const doc = document()
    expect(doc.services.app.depends_on).toEqual({ postgres: { condition: 'service_healthy' } })
    expect(doc.services.nginx.depends_on).toEqual({ app: { condition: 'service_healthy' } })
  })

  it('binds the proxy to the given address, never to every interface', () => {
    const doc = document()
    expect(doc.services.nginx.ports).toEqual(['10.77.42.5:8080:80'])
  })

  it('renders a wildcard bind address — deployments are LAN-open by design', () => {
    // Decided 2026-09-02: reachability is a configuration, not a refusal. A
    // firm fronting the system with the tunnel narrows the address then.
    const result = renderWith([], {}, { settings: { ...settings, bindAddress: '0.0.0.0' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const doc = parse(result.yaml)
    expect(doc.services.nginx.ports).toEqual(['0.0.0.0:8080:80'])
  })

  it('reports a missing secret instead of throwing', () => {
    const result = renderWith([], {}, { secrets: { ...secrets, JWT_SECRET: '' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]?.message).toContain('JWT_SECRET')
    expect(result.problems[0]?.moduleId).toBe('app')
  })

  it('declares every volume a rendered module asked for, once', () => {
    const doc = document(['drive-mirror'], { 'drive-mirror': { sharedDriveId: '0ABCdef' } })
    expect(Object.keys(doc.volumes).sort()).toEqual(['logs_data', 'postgres_data', 'uploads_data'])
  })

  it('mounts the documents volume read-only wherever it is not the application', () => {
    // A mirror copies out and nginx serves a file. Neither has any business
    // writing to the volume holding the firm's documents.
    const doc = document(['drive-mirror'], {
      'drive-mirror': { sharedDriveId: '0ABCdef' },
    })
    expect(doc.services.nginx.volumes).toContain('uploads_data:/app/uploads:ro')
    expect(doc.services['drive-mirror'].volumes).toContain('uploads_data:/app/uploads:ro')
    expect(doc.services.app.volumes).toContain('uploads_data:/app/uploads')
  })

  it('gives the tunnel host networking and no published ports', () => {
    // Advertising a private range means forwarding IP traffic to addresses on
    // the firm's LAN, which a bridge network cannot do.
    const doc = document(['tunnel'], { tunnel: { privateRange: '10.77.42.0/24' } })
    expect(doc.services.tunnel.network_mode).toBe('host')
    expect(doc.services.tunnel.networks).toBeUndefined()
    expect(doc.services.tunnel.ports).toBeUndefined()
  })

  it('puts everything else on the internal network', () => {
    const doc = document()
    expect(doc.networks.internal).toEqual({ driver: 'bridge' })
    for (const name of ['postgres', 'app', 'nginx']) {
      expect(doc.services[name].networks).toEqual(['internal'])
    }
  })

  it('carries the secrets into the services that need them', () => {
    const doc = document()
    expect(doc.services.app.environment.DATABASE_URL).toContain('db-secret')
    expect(doc.services.app.environment.JWT_SECRET).toBe('jwt-secret')
    expect(doc.services.postgres.environment.POSTGRES_PASSWORD).toBe('db-secret')
  })

  it('never sets NEXT_PUBLIC_API_URL', () => {
    // Next inlines NEXT_PUBLIC_* at build time, so a value here arrives too
    // late to take effect and only misleads whoever reads it.
    const doc = document()
    expect(doc.services.app.environment.NEXT_PUBLIC_API_URL).toBeUndefined()
  })

  it('applies the stated resource cost as a real limit', () => {
    const doc = document(['drive-mirror'], { 'drive-mirror': { sharedDriveId: '0ABCdef' } })
    expect(doc.services['drive-mirror'].deploy.resources.limits).toEqual({ cpus: '0.5', memory: '512M' })
  })

  it('lets an operator override a module’s memory and cpu limit', () => {
    // A bigger box can give a module more than the catalogue default, which is
    // sized for a small one.
    const resolution = resolve({
      enabled: ['drive-mirror'],
      config: { 'drive-mirror': { sharedDriveId: '0ABCdef' } },
      entitlements: ALL,
    })
    if (!resolution.ok) throw new Error('unreachable')
    const result = render({
      modules: resolution.modules,
      version: '1.0.2',
      settings,
      secrets,
      resources: { 'drive-mirror': { memory: '10G', cpus: '4' } },
    })
    if (!result.ok) throw new Error(result.problems.map((p) => p.message).join('; '))
    const doc = parse(result.yaml)
    expect(doc.services['drive-mirror'].deploy.resources.limits).toEqual({ cpus: '4', memory: '10G' })
    // A module without an override keeps its catalogue default.
    expect(doc.services.postgres.deploy.resources.limits.memory).toBe('2G')
  })

  it('says in the file itself that it is generated', () => {
    const result = renderWith()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.yaml.startsWith('# Generated by the QanoonTech engine. Do not edit.')).toBe(true)
  })

  it('refuses to render without a version', () => {
    const resolution = resolve({ enabled: [], config: {}, entitlements: ALL })
    if (!resolution.ok) throw new Error('unreachable')
    const result = render({ modules: resolution.modules, version: '  ', settings, secrets })
    expect(result.ok).toBe(false)
  })

  it('sends the application nothing about SMTP — email is a module, not a setting', () => {
    // The application never holds SMTP credentials; it writes outbox rows and
    // the mailer drains them. Nothing SMTP-shaped may reach the app container.
    const doc = document(['email'], { email: { smtpHost: 'smtp.example.com', fromAddress: 'noreply@example.com' } })
    expect(Object.keys(doc.services.app.environment).filter((k) => k.startsWith('SMTP_'))).toEqual([])
  })

  it('wires the mailer to the relay and to the application database', () => {
    const result = renderWith(
      ['email'],
      {
        email: {
          smtpHost: 'smtp.example.com',
          smtpPort: 465,
          smtpSecure: true,
          smtpUser: 'notify@example.com',
          fromAddress: 'noreply@example.com',
        },
      },
      { secrets: { ...secrets, SMTP_PASSWORD: 'smtp-secret' } },
    )
    if (!result.ok) throw new Error(result.problems.map((p) => p.message).join('; '))
    const mailer = parse(result.yaml).services.email
    expect(mailer.image).toBe('ghcr.io/alikhubrani/qanoontech-mailer:1.0.2')
    expect(mailer.environment.DATABASE_URL).toContain('@postgres:5432/')
    expect(mailer.environment.DATABASE_URL).toContain('db-secret')
    expect(mailer.environment.SMTP_HOST).toBe('smtp.example.com')
    expect(mailer.environment.SMTP_PORT).toBe('465')
    expect(mailer.environment.SMTP_SECURE).toBe('true')
    expect(mailer.environment.SMTP_USER).toBe('notify@example.com')
    expect(mailer.environment.SMTP_PASSWORD).toBe('smtp-secret')
    expect(mailer.environment.SMTP_FROM).toBe('noreply@example.com')
    expect(mailer.environment.PORT).toBe('3004')
    expect(mailer.volumes).toBeUndefined()
    expect(mailer.ports).toBeUndefined()
    expect(mailer.depends_on).toEqual({
      app: { condition: 'service_healthy' },
      postgres: { condition: 'service_healthy' },
    })
    expect(mailer.healthcheck.test).toContain('http://localhost:3004/health')
  })

  it('sends the mailer the Microsoft OAuth settings, and no password', () => {
    const result = renderWith(
      ['email'],
      {
        email: {
          smtpHost: 'smtp.office365.com',
          smtpPort: 587,
          smtpSecure: false,
          authMode: 'oauth-microsoft',
          smtpUser: 'notify@example.com',
          oauthTenantId: 'tenant-guid',
          oauthClientId: 'client-guid',
          fromAddress: 'notify@example.com',
        },
      },
      { secrets: { ...secrets, SMTP_PASSWORD: 'smtp-secret', SMTP_OAUTH_SECRET: 'oauth-secret' } },
    )
    if (!result.ok) throw new Error(result.problems.map((p) => p.message).join('; '))
    const env = parse(result.yaml).services.email.environment
    expect(env.SMTP_AUTH_MODE).toBe('oauth-microsoft')
    expect(env.SMTP_USER).toBe('notify@example.com')
    expect(env.SMTP_OAUTH_TENANT).toBe('tenant-guid')
    expect(env.SMTP_OAUTH_CLIENT_ID).toBe('client-guid')
    expect(env.SMTP_OAUTH_SECRET).toBe('oauth-secret')
    // The password is set and still must not travel: an unused credential in
    // a container's environment is one more thing that can leak.
    expect(env.SMTP_PASSWORD).toBeUndefined()
  })

  it('refuses Microsoft OAuth without its client secret, and says which one', () => {
    const result = renderWith(['email'], {
      email: {
        smtpHost: 'smtp.office365.com',
        authMode: 'oauth-microsoft',
        smtpUser: 'notify@example.com',
        oauthTenantId: 'tenant-guid',
        oauthClientId: 'client-guid',
        fromAddress: 'notify@example.com',
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]?.message).toContain('SMTP_OAUTH_SECRET')
  })

  it('sends the mailer neither user nor password for a relay that takes no credentials', () => {
    // An internal relay that trusts the network is a real configuration. No
    // user means no password is demanded — the secret may stay unset.
    const doc = document(['email'], { email: { smtpHost: 'smtp.example.com', fromAddress: 'noreply@example.com' } })
    const env = doc.services.email.environment
    expect(env.SMTP_HOST).toBe('smtp.example.com')
    expect(env.SMTP_USER).toBeUndefined()
    expect(env.SMTP_PASSWORD).toBeUndefined()
    expect(env.SMTP_PORT).toBe('587')
    expect(env.SMTP_SECURE).toBe('false')
  })

  it('refuses an SMTP user without the SMTP password, and says which secret', () => {
    const result = renderWith(['email'], {
      email: { smtpHost: 'smtp.example.com', smtpUser: 'notify@example.com', fromAddress: 'noreply@example.com' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]?.moduleId).toBe('email')
    expect(result.problems[0]?.message).toContain('SMTP_PASSWORD')
  })

  it('does not demand an optional secret the render never asked for', () => {
    // SMTP_PASSWORD is declared on the email module and is absent from the
    // secrets above. With no SMTP user the render never reaches for it, and
    // the declaration alone must not refuse the deployment.
    const result = renderWith(['email'], {
      email: { smtpHost: 'smtp.example.com', fromAddress: 'noreply@example.com' },
    })
    expect(result.ok).toBe(true)
  })

  it('refuses an unset required secret whether or not the render read it', () => {
    // The declaration is a contract: a module that declares a required
    // secret cannot quietly ship without it because its render forgot to ask.
    const resolution = resolve({
      enabled: ['drive-mirror'],
      config: { 'drive-mirror': { sharedDriveId: '0ABCdef' } },
      entitlements: ALL,
    })
    if (!resolution.ok) throw new Error('unreachable')
    const mirror = resolution.modules.find((m) => m.module.id === 'drive-mirror')!
    const forgetful = {
      ...mirror,
      module: { ...mirror.module, render: () => ({ image: 'x', restart: 'no' as const }) },
    }
    const result = render({
      modules: resolution.modules.map((m) => (m === mirror ? forgetful : m)),
      version: '1.0.2',
      settings,
      secrets: { ...secrets, GOOGLE_SERVICE_ACCOUNT_KEY: '' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]?.message).toContain('GOOGLE_SERVICE_ACCOUNT_KEY')
  })

  it('reports a missing secret once, however many ways it was wanted', () => {
    // Declared and asked for: one problem, not two.
    const result = renderWith(['drive-mirror'], { 'drive-mirror': { sharedDriveId: '0ABCdef' } }, {
      secrets: { ...secrets, GOOGLE_SERVICE_ACCOUNT_KEY: '' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.filter((p) => p.message.includes('GOOGLE_SERVICE_ACCOUNT_KEY'))).toHaveLength(1)
  })

  it('gives the drive mirror the application database and never a write mount', () => {
    const doc = document(['drive-mirror'], { 'drive-mirror': { sharedDriveId: '0ABCdef' } })
    const mirror = doc.services['drive-mirror']
    expect(mirror.environment.DATABASE_URL).toContain('@postgres:5432/')
    expect(mirror.environment.DATABASE_URL).toContain('db-secret')
    expect(mirror.volumes).toEqual(['uploads_data:/app/uploads:ro'])
    expect(mirror.depends_on.postgres).toEqual({ condition: 'service_healthy' })
  })
})
