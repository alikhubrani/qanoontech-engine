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
  keptBackupIds,
  listBackups,
  newBackupId,
  pruneBackups,
  restoreBackup,
  takeBackup,
} from './service.js'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

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
    /*
     * Five sets, each in a different month and all far past the 30-day daily
     * window. Retention is a shape now, not a cutoff: these survive as the
     * monthly keepers, which is the "what did this look like in March"
     * question a firm eventually asks. Only a sixth set in a month that
     * already has one would go.
     */
    const ids = [ancient(40, 1), ancient(50, 2), ancient(60, 3), ancient(70, 4), ancient(80, 5)]
    expect(pruneBackups(dir)).toEqual([])
    expect(listBackups(dir)).toHaveLength(ids.length)
  })

  /*
   * The shape itself, tested as a pure function so it needs no directories:
   * everything for two days, then one a day for the retention window, then one
   * a month for a year. A flat cutoff was right at one set a night and wrong
   * at one an hour -- it would have held 720 directories, and 720 uploads to
   * the firm's Drive, to answer a question nobody asks about 3am last Tuesday.
   */
  describe('the shape it keeps', () => {
    const now = Date.UTC(2026, 8, 11, 12, 0, 0)
    const at = (msAgo: number, tag: string) => ({
      id: `set-${tag}`,
      takenAt: new Date(now - msAgo).toISOString(),
      trigger: 'scheduled' as const,
      appVersion: '1.0.0',
      includesUploads: false,
      databaseBytes: 1,
      uploadsBytes: 0,
    })
    const DAY = 24 * HOUR
    const kept = (sets: ReturnType<typeof at>[]) => keptBackupIds(sets, now, 30)

    it('keeps every set inside two days', () => {
      const sets = [at(1 * HOUR, 'a'), at(10 * HOUR, 'b'), at(47 * HOUR, 'c')]
      expect(kept(sets).size).toBe(3)
    })

    it('thins to one a day behind that, and keeps the oldest of each day', () => {
      // Newest first, as listBackups returns them.
      const sets = [
        at(4 * DAY + 1 * HOUR, 'day4-late'),
        at(4 * DAY + 9 * HOUR, 'day4-early'),
        at(5 * DAY, 'day5'),
      ]
      const keep = kept(sets)
      // The newest three are always kept, so widen the list to see thinning.
      const many = [...sets, at(6 * DAY + 1 * HOUR, 'day6-late'), at(6 * DAY + 9 * HOUR, 'day6-early')]
      const keepMany = kept(many)
      expect(keep.size).toBe(3)
      expect(keepMany.has('set-day6-early')).toBe(true)
      expect(keepMany.has('set-day6-late')).toBe(false)
    })

    it('keeps one a month beyond the daily window', () => {
      /*
       * Explicit dates, not day-offsets. Two sets in the same month is the
       * case under test, and "sixty days ago" and "seventy-five days ago" are
       * in different months -- which is a fact about the calendar that a test
       * should not be quietly asserting.
       */
      const on = (year: number, month: number, day: number, tag: string) =>
        at(now - Date.UTC(year, month - 1, day, 12, 0, 0), tag)
      const sets = [
        at(1 * HOUR, 'now1'),
        at(2 * HOUR, 'now2'),
        at(3 * HOUR, 'now3'),
        on(2026, 7, 20, 'july-late'),
        on(2026, 7, 3, 'july-early'),
        on(2026, 6, 5, 'june'),
      ]
      const keep = kept(sets)
      expect(keep.has('set-june')).toBe(true)
      // Two in July: the older one is the keeper, because the useful copy of a
      // period is the one taken before its work rather than after it.
      expect(keep.has('set-july-early')).toBe(true)
      expect(keep.has('set-july-late')).toBe(false)
    })

    it('never prunes everything, however old the newest is', () => {
      const sets = [at(900 * DAY, 'ancient1'), at(910 * DAY, 'ancient2'), at(920 * DAY, 'ancient3')]
      // Beyond every window, so only the newest-three floor saves them.
      expect(kept(sets).size).toBe(3)
    })
  })
})

describe('the schedule', () => {
  const base = { backupHour: 2, timezone: 'UTC', intervalMinutes: 60 }
  const day = (hour: number, minute = 0) => Date.UTC(2026, 8, 2, hour, minute, 0)
  /* A full set taken at 2am today, so only the interval is under test. */
  const freshFull = (now: number) => now - 3 * HOUR

  it('is due immediately when nothing exists', () => {
    expect(backupDue({ newestAt: undefined, newestFullAt: undefined, now: Date.now(), ...base })).toBe('full')
  })

  it('takes the database on the interval, not once a day', () => {
    const now = day(15)
    const full = freshFull(now)
    expect(backupDue({ newestAt: now - 61 * MINUTE, newestFullAt: full, now, ...base })).toBe('database')
    expect(backupDue({ newestAt: now - 59 * MINUTE, newestFullAt: full, now, ...base })).toBe('none')
  })

  it('counts a tick landing exactly on the interval as on time', () => {
    const now = day(15)
    expect(backupDue({ newestAt: now - 60 * MINUTE, newestFullAt: freshFull(now), now, ...base })).toBe('database')
  })

  it('honours a shorter interval', () => {
    const now = day(15)
    const at = { ...base, intervalMinutes: 15 }
    expect(backupDue({ newestAt: now - 16 * MINUTE, newestFullAt: freshFull(now), now, ...at })).toBe('database')
    expect(backupDue({ newestAt: now - 14 * MINUTE, newestFullAt: freshFull(now), now, ...at })).toBe('none')
  })

  /*
   * The bug this replaced. `backupDue` forced a set only once the newest was
   * older than 26 hours, which is exactly the widest window measured on the
   * firm's box: 26.1 hours, 09-03 20:00 to 09-04 22:04.
   */
  it('never leaves a day-long hole, whatever the hour', () => {
    const now = day(15)
    expect(backupDue({ newestAt: now - 25 * HOUR, newestFullAt: now - 25 * HOUR, now, ...base })).not.toBe('none')
    expect(backupDue({ newestAt: now - 2 * HOUR, newestFullAt: freshFull(now), now, ...base })).toBe('database')
  })

  describe('the daily full set', () => {
    it('runs at the backup hour and carries the documents', () => {
      const twoAm = day(2, 10)
      expect(backupDue({ newestAt: twoAm - 30 * MINUTE, newestFullAt: twoAm - 24 * HOUR, now: twoAm, ...base })).toBe('full')
    })

    it('is not taken twice in the same hour', () => {
      const twoAm = day(2, 40)
      expect(backupDue({ newestAt: twoAm - 30 * MINUTE, newestFullAt: twoAm - 30 * MINUTE, now: twoAm, ...base })).toBe('none')
    })

    it('runs whatever the hour once a day and a bit has passed — the box was off', () => {
      const threePm = day(15)
      expect(backupDue({ newestAt: threePm - 30 * MINUTE, newestFullAt: threePm - 27 * HOUR, now: threePm, ...base })).toBe('full')
    })

    /*
     * Without this, a run of hourly snapshots keeps `newestAt` young forever
     * and the documents stop being copied on a box that looks like it is
     * backing up every hour.
     */
    it('is not held off by hourly snapshots', () => {
      const twoAm = day(2, 5)
      expect(backupDue({ newestAt: twoAm - 5 * MINUTE, newestFullAt: twoAm - 23 * HOUR, now: twoAm, ...base })).toBe('full')
    })
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
