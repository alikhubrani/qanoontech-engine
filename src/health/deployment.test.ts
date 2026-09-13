import { describe, expect, it } from 'vitest'
import { assessDeployment, type DeploymentInput } from './deployment.js'
import type { ServiceView } from '../services.js'

const running = (id: string, required = true): ServiceView => ({
  id,
  title: id,
  summary: '',
  required,
  state: 'running',
  health: 'healthy',
  status: 'Up 3 days (healthy)',
  image: `ghcr.io/alikhubrani/qanoontech:1.16.3`,
})

/** A deployment with nothing wrong, to take one thing away from at a time. */
function protectedInput(): DeploymentInput {
  return {
    now: Date.parse('2026-09-13T12:00:00Z'),
    configuredVersion: '1.16.3',
    runningVersion: '1.16.3',
    services: [running('postgres'), running('app'), running('nginx'), running('gotenberg')],
    dockerError: undefined,
    plan: { deployable: true, services: 4 },
    backups: { level: 'ok', sets: 30, detail: 'Newest backup 12 minutes old; 30 set(s) kept.', offsitePending: 0 },
    intervalMinutes: 60,
    newestBackupAt: Date.parse('2026-09-13T11:48:00Z'),
    offsite: { enabled: true, ready: true, reason: undefined, label: 'Cloudflare R2' },
    recovery: { passphraseSet: true, lastCopiedAt: '2026-09-13T11:48:05Z', verifiedAt: '2026-09-13T11:48:05Z' },
    signIn: { redirectUri: 'https://portal.example.com/api/session/entra/callback', clientSecretSet: true, allowed: 1 },
    registryConfigured: true,
    database: { external: false, host: 'postgres', port: 5432, reachable: undefined, server: undefined },
  }
}

describe('assessDeployment', () => {
  it('is protected only when every responsibility is met', () => {
    const result = assessDeployment(protectedInput())
    expect(result.verdict).toBe('protected')
    expect(result.findings).toEqual([])
    expect(result.backups.nextDueAt).toBe('2026-09-13T12:48:00.000Z')
  })

  it('is at risk when backups have stopped, whatever the containers say', () => {
    // The three-day silence: every container healthy, no backup for days.
    const result = assessDeployment({
      ...protectedInput(),
      backups: { level: 'stale', sets: 30, detail: 'The newest backup is 3 days old. Backups have stopped.' },
    })
    expect(result.verdict).toBe('risk')
    expect(result.findings.map((f) => f.area)).toEqual(['backups'])
  })

  it('is at risk with no offsite copy, because one copy is not a backup', () => {
    const result = assessDeployment({
      ...protectedInput(),
      offsite: { enabled: false, ready: false, reason: undefined, label: undefined },
    })
    expect(result.verdict).toBe('risk')
    expect(result.findings[0]?.area).toBe('offsite')
  })

  it('is at risk when offsite is on but unusable — configured is not the same as working', () => {
    const result = assessDeployment({
      ...protectedInput(),
      offsite: { enabled: true, ready: false, reason: 'no S3 access key is stored', label: undefined },
    })
    expect(result.verdict).toBe('risk')
    expect(result.findings[0]?.detail).toContain('access key')
  })

  it('needs attention when a version is configured and not deployed', () => {
    const result = assessDeployment({ ...protectedInput(), configuredVersion: '1.16.4' })
    expect(result.verdict).toBe('attention')
    expect(result.application.drift).toBe(true)
    expect(result.findings[0]?.title).toBe('1.16.4 is configured but 1.16.3 is running')
  })

  it('does not call "latest" drift — it names no version to differ from', () => {
    const result = assessDeployment({ ...protectedInput(), configuredVersion: 'latest' })
    expect(result.application.drift).toBe(false)
  })

  it('needs attention without a recovery passphrase, and says what that costs', () => {
    const result = assessDeployment({
      ...protectedInput(),
      recovery: { passphraseSet: false, lastCopiedAt: undefined, verifiedAt: undefined },
    })
    expect(result.verdict).toBe('attention')
    expect(result.findings[0]?.area).toBe('recovery')
  })

  it('needs attention when sign-in is not pinned to a hostname', () => {
    const result = assessDeployment({
      ...protectedInput(),
      signIn: { redirectUri: '', clientSecretSet: true, allowed: 1 },
    })
    expect(result.verdict).toBe('attention')
    expect(result.findings[0]?.area).toBe('sign-in')
  })

  it('treats an external database that answers as fine, and one that does not as risk', () => {
    const external = (reachable: boolean): ServiceView => ({
      ...running('postgres'),
      state: 'external',
      health: reachable ? 'healthy' : 'unhealthy',
      image: '',
      external: { host: '192.168.1.108', port: 5434, server: 'PostgreSQL 17.11', reachable, detail: reachable ? '' : 'connection refused' },
    })
    const base = protectedInput()
    const fine = assessDeployment({ ...base, services: [external(true), ...base.services.slice(1)] })
    expect(fine.verdict).toBe('protected')
    const down = assessDeployment({ ...base, services: [external(false), ...base.services.slice(1)] })
    expect(down.verdict).toBe('risk')
    expect(down.findings[0]?.area).toBe('database')
  })

  it('lists a required service that is not running as risk, and an optional one as attention', () => {
    const base = protectedInput()
    const appDown = assessDeployment({
      ...base,
      services: base.services.map((s) => (s.id === 'app' ? { ...s, state: 'exited', health: '' } : s)),
    })
    expect(appDown.verdict).toBe('risk')

    const emailSick = assessDeployment({
      ...base,
      services: [...base.services, { ...running('email', false), health: 'unhealthy' }],
    })
    expect(emailSick.verdict).toBe('attention')
    // Absent and optional is simply off, not a finding.
    const emailOff = assessDeployment({
      ...base,
      services: [...base.services, { ...running('email', false), state: 'absent', health: '' }],
    })
    expect(emailOff.verdict).toBe('protected')
  })

  it('ranks risk above attention when both are present', () => {
    const result = assessDeployment({
      ...protectedInput(),
      configuredVersion: '1.16.4',
      dockerError: 'Cannot connect to the Docker daemon',
    })
    expect(result.verdict).toBe('risk')
    expect(result.findings.map((f) => f.level)).toEqual(['risk', 'warn'])
  })
})
