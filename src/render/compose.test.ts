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
    expect(Object.keys(doc.services)).toEqual(['postgres', 'app', 'nginx'])
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
    const doc = document(['ocr'])
    expect(Object.keys(doc.volumes).sort()).toEqual(['logs_data', 'postgres_data', 'uploads_data'])
  })

  it('mounts the documents volume read-only wherever it is not the application', () => {
    // A mirror copies out and a recogniser reads a page. Neither has any
    // business writing to the volume holding the firm's documents.
    const doc = document(['ocr', 'drive-mirror'], {
      'drive-mirror': { sharedDriveId: '0ABCdef' },
    })
    expect(doc.services.nginx.volumes).toContain('uploads_data:/app/uploads:ro')
    expect(doc.services.ocr.volumes).toContain('uploads_data:/app/uploads:ro')
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
    const doc = document(['ocr'])
    expect(doc.services.ocr.deploy.resources.limits).toEqual({ cpus: '2', memory: '2G' })
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

  it('gives the drive mirror the application database and never a write mount', () => {
    const doc = document(['drive-mirror'], { 'drive-mirror': { sharedDriveId: '0ABCdef' } })
    const mirror = doc.services['drive-mirror']
    expect(mirror.environment.DATABASE_URL).toContain('@postgres:5432/')
    expect(mirror.environment.DATABASE_URL).toContain('db-secret')
    expect(mirror.volumes).toEqual(['uploads_data:/app/uploads:ro'])
    expect(mirror.depends_on.postgres).toEqual({ condition: 'service_healthy' })
  })
})
