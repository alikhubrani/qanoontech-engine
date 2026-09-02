import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../docker/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../docker/index.js')>()
  const containerToHost = (dir: string, path: string) => join(dir, path.replace('/state/', ''))
  return {
    ...original,
    // The helpers "write" their outputs so sizes and manifests are real.
    dumpDatabase: vi.fn(async (_target: unknown, outPath: string) => {
      writeFileSync(containerToHost(process.env['TEST_DIR']!, outPath), 'dump'.repeat(100))
      return { code: 0, stdout: '', stderr: '' }
    }),
    archiveUploads: vi.fn(async (outPath: string) => {
      writeFileSync(containerToHost(process.env['TEST_DIR']!, outPath), 'tar'.repeat(100))
      return { code: 0, stdout: '', stderr: '' }
    }),
    restoreDatabase: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    restoreUploads: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    stop: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    start: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  }
})

import * as docker from '../docker/index.js'
import { deepRedact, redactLines, scrubValues } from '../server/routes/support.js'
import { saveSecrets, saveState, loadState } from '../state/store.js'
import { backupDue } from './schedule.js'
import {
  listBackups,
  newBackupId,
  pruneBackups,
  restoreBackup,
  takeBackup,
} from './service.js'

const HOUR = 60 * 60 * 1000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-test-'))
  process.env['TEST_DIR'] = dir
  saveSecrets({ DB_PASSWORD: 'db-secret-value' }, dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('taking a backup', () => {
  it('produces a listed, verified set with a manifest', async () => {
    const outcome = await takeBackup('manual', dir)
    expect(outcome.ok).toBe(true)
    const [set] = listBackups(dir)
    expect(set?.id).toBe(outcome.id)
    expect(set?.trigger).toBe('manual')
    expect(set?.databaseBytes).toBeGreaterThan(0)
    expect(set?.includesUploads).toBe(true)
    expect(set?.uploadsBytes).toBeGreaterThan(0)
  })

  it('skips the documents when configured to', async () => {
    const state = loadState(dir)
    saveState({ ...state, settings: { ...state.settings, backupIncludeUploads: false } }, dir)
    await takeBackup('manual', dir)
    expect(vi.mocked(docker.archiveUploads)).not.toHaveBeenCalled()
    expect(listBackups(dir)[0]?.includesUploads).toBe(false)
  })

  it('leaves nothing behind when the dump fails', async () => {
    vi.mocked(docker.dumpDatabase).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'boom' })
    const outcome = await takeBackup('manual', dir)
    expect(outcome.ok).toBe(false)
    expect(listBackups(dir)).toHaveLength(0)
  })

  it('refuses politely when there is no database password yet', async () => {
    saveSecrets({}, dir)
    const outcome = await takeBackup('manual', dir)
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('no database to back up yet')
  })
})

describe('retention', () => {
  it('prunes old sets but always keeps the newest three', async () => {
    const root = join(dir, 'backups')
    const ancient = (days: number, index: number) => {
      const at = new Date(Date.now() - days * 24 * HOUR - index * HOUR)
      const id = newBackupId(at)
      mkdirSync(join(root, id), { recursive: true })
      writeFileSync(
        join(root, id, 'manifest.json'),
        JSON.stringify({
          takenAt: at.toISOString(),
          trigger: 'scheduled',
          appVersion: '1.0.0',
          includesUploads: false,
          databaseBytes: 1,
          uploadsBytes: 0,
        }),
      )
      return id
    }
    // Five sets, all far past the 30-day default.
    const ids = [ancient(40, 1), ancient(50, 2), ancient(60, 3), ancient(70, 4), ancient(80, 5)]
    const removed = pruneBackups(dir)
    expect(removed.sort()).toEqual([ids[3]!, ids[4]!].sort())
    expect(listBackups(dir)).toHaveLength(3)
  })
})

describe('the schedule', () => {
  const base = { backupHour: 2, timezone: 'UTC' }

  it('is due immediately when nothing exists', () => {
    expect(backupDue({ newestAt: undefined, now: Date.now(), ...base })).toBe(true)
  })

  it('is due whatever the hour once overdue — the box was off overnight', () => {
    const now = Date.UTC(2026, 8, 2, 14, 0, 0)
    expect(backupDue({ newestAt: now - 27 * HOUR, now, ...base })).toBe(true)
  })

  it('waits for the backup hour otherwise', () => {
    const twoAm = Date.UTC(2026, 8, 2, 2, 10, 0)
    const threePm = Date.UTC(2026, 8, 2, 15, 0, 0)
    expect(backupDue({ newestAt: twoAm - 24 * HOUR, now: twoAm, ...base })).toBe(true)
    expect(backupDue({ newestAt: threePm - 22 * HOUR, now: threePm, ...base })).toBe(false)
  })

  it('does not take the same night twice', () => {
    const twoAm = Date.UTC(2026, 8, 2, 2, 40, 0)
    expect(backupDue({ newestAt: twoAm - 30 * 60 * 1000, now: twoAm, ...base })).toBe(false)
  })
})

describe('restore', () => {
  it('runs safety backup → stop → database → documents → start, in order', async () => {
    const taken = await takeBackup('manual', dir)
    const result = await restoreBackup(taken.id!, dir)
    expect(result.ok).toBe(true)
    expect(result.steps.map((step) => step.step)).toEqual([
      'safety-backup',
      'stop-application',
      'restore-database',
      'restore-documents',
      'start-application',
    ])
    // The safety copy is itself a listed set.
    expect(listBackups(dir).some((set) => set.trigger === 'pre-restore')).toBe(true)
    // Postgres was never stopped.
    expect(vi.mocked(docker.stop).mock.calls[0]?.[0]).toEqual(['app', 'nginx'])
  })

  it('stops where it fails and reports how far it got', async () => {
    const taken = await takeBackup('manual', dir)
    vi.mocked(docker.restoreDatabase).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'bad dump' })
    const result = await restoreBackup(taken.id!, dir)
    expect(result.ok).toBe(false)
    const last = result.steps[result.steps.length - 1]!
    expect(last.step).toBe('restore-database')
    expect(last.ok).toBe(false)
    expect(vi.mocked(docker.start)).not.toHaveBeenCalled()
  })

  it('refuses an id that is not a timestamp, before any path is built', async () => {
    const result = await restoreBackup('../../../etc/passwd', dir)
    expect(result.ok).toBe(false)
    expect(result.steps[0]?.step).toBe('resolve')
  })
})

describe('redaction', () => {
  it('scrubs stored values from any text, wherever they appear', () => {
    const secrets = { DB_PASSWORD: 'a9c0b8424206deadbeef', GHCR_TOKEN: 'ghp_realtoken123456' }
    const text =
      'DATABASE_URL: postgresql://q:a9c0b8424206deadbeef@postgres/db\n' +
      'error: login failed for token ghp_realtoken123456'
    const scrubbed = scrubValues(text, secrets)
    for (const value of Object.values(secrets)) expect(scrubbed).not.toContain(value)
  })

  it('masks sensitive keys line by line without eating the line structure', () => {
    const yaml = 'POSTGRES_PASSWORD: hunter2\n  JWT_SECRET: abc\nDEFAULT_LANGUAGE: ar'
    const redacted = redactLines(yaml)
    expect(redacted).toContain('POSTGRES_PASSWORD: «redacted»')
    expect(redacted).toContain('JWT_SECRET: «redacted»')
    expect(redacted).toContain('DEFAULT_LANGUAGE: ar')
    expect(redacted.split('\n')).toHaveLength(3)
  })

  it('walks objects and masks by key, leaving the structure parseable', () => {
    const redacted = deepRedact({
      config: { SETTINGS_ENCRYPTION_KEY: 'key-shaped-value', sharedDriveId: '0ABC' },
      nested: [{ apiToken: 'tok' }],
    }) as Record<string, never>
    const text = JSON.stringify(redacted)
    expect(JSON.parse(text)).toBeTruthy()
    expect(text).not.toContain('key-shaped-value')
    expect(text).not.toContain('"tok"')
    expect(text).toContain('0ABC')
  })

  it('covers the real generated secret names by value', async () => {
    // Adding a secret the scrubber misses should fail here, not ship.
    const { GENERATED_SECRETS } = await import('../state/store.js')
    for (const { name, generate } of GENERATED_SECRETS) {
      const value = generate()
      expect(scrubValues(`${name}=${value}`, { [name]: value })).not.toContain(value)
    }
  })
})
