import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What pg_dump actually produces, shortened.
 *
 * This fixture used to be `'dump'.repeat(100)` written as plain text — not
 * gzip, no structure, no end. It passed, because the only check was pg_dump's
 * exit status. The fixture was itself the bug in miniature: a stand-in that
 * could not be told from the real thing by anything the code did. `verifyDump`
 * rejects it, which is the point of `verifyDump`.
 *
 * The `\\restrict` / `\\unrestrict` wrapper and the position of the completion
 * marker are copied from a real 15.19 dump taken off the staging box.
 */
const SAMPLE_DUMP = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  '\\restrict SAMPLEtoken0000000000000000',
  '',
  '-- Dumped from database version 15.19',
  '',
  'CREATE TABLE public.cases (id uuid NOT NULL);',
  '',
  '--',
  '-- PostgreSQL database dump complete',
  '--',
  '',
  '\\unrestrict SAMPLEtoken0000000000000000',
  '',
].join('\n')

vi.mock('../docker/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../docker/index.js')>()
  const containerToHost = (dir: string, path: string) => join(dir, path.replace('/state/', ''))
  return {
    ...original,
    // The helpers "write" their outputs so sizes and manifests are real.
    dumpDatabase: vi.fn(async (_target: unknown, outPath: string) => {
      writeFileSync(containerToHost(process.env['TEST_DIR']!, outPath), gzipSync(SAMPLE_DUMP))
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
  newestBackupAt,
  newBackupId,
  pruneBackups,
  restoreBackup,
  takeBackup,
  verifyDump,
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
    expect(outcome.detail).toContain('DB_PASSWORD')
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
     * Five sets, all far past the 30-day window. Four are pruned; the newest
     * three survive only on the floor that stops a box waking from a long
     * sleep and pruning itself down to nothing.
     *
     * They used to survive as monthly keepers. That tier was removed on
     * 2026-09-13 so local retention and the bucket's lifecycle rule could state
     * the same horizon -- see `keptBackupIds`.
     */
    const ids = [ancient(40, 1), ancient(50, 2), ancient(60, 3), ancient(70, 4), ancient(80, 5)]
    const pruned = pruneBackups(dir)
    expect(pruned).toEqual(ids.slice(3))
    expect(listBackups(dir)).toHaveLength(3)
  })

  /*
   * The shape itself, tested as a pure function so it needs no directories:
   * everything for two days, then one a day for the retention window, then
   * nothing. A flat cutoff was wrong at one snapshot an hour -- it would have
   * held 720 directories, and 720 uploads to the firm's bucket, to answer a
   * question nobody asks about 3am last Tuesday. Thinning to one a day fixes
   * that without a third tier the offsite rule cannot express.
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

    it('keeps nothing beyond the retention window', () => {
      /*
       * Explicit dates, not day-offsets, because "sixty days ago" and
       * "seventy-five days ago" landing in different months is a fact about
       * the calendar that a test should not assert by accident.
       *
       * These three used to survive as monthly keepers. Now the window is the
       * whole horizon: past it, only the newest-three floor keeps anything, and
       * that floor is already spent on the three recent sets here.
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
      for (const tag of ['june', 'july-early', 'july-late']) {
        expect(keep.has(`set-${tag}`), tag).toBe(false)
      }
      expect(keep.size).toBe(3)
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

  /*
   * The bug that stopped a firm's backups for three days, in both the place it
   * was caused and the place it was felt.
   */
  describe('a manifest that does not say when', () => {
    it('is not a backup, so the schedule sees the one before it', () => {
      const root = join(dir, 'backups')
      const id = newBackupId(new Date())
      mkdirSync(join(root, id), { recursive: true })
      // Exactly what was on the firm's box beside a hand-made set.
      writeFileSync(
        join(root, id, 'manifest.json'),
        JSON.stringify({ taken: 'manual, after the 1.8.0 deploy', version: '1.8.0' }),
      )
      expect(listBackups(dir).some((set) => set.id === id)).toBe(false)
      expect(newestBackupAt(dir)).toBeUndefined()
    })

    it('never leaves the scheduler with a number it cannot reason about', () => {
      const now = day(15)
      // NaN compares false against everything, so before this it read as
      // "backed up a moment ago" and nothing was ever taken again.
      expect(backupDue({ newestAt: Number.NaN, newestFullAt: Number.NaN, now, ...base })).toBe('full')
    })
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
      config: { SETTINGS_ENCRYPTION_KEY: 'key-shaped-value', smtpHost: 'smtp.example.com' },
      nested: [{ apiToken: 'tok' }],
    }) as Record<string, never>
    const text = JSON.stringify(redacted)
    expect(JSON.parse(text)).toBeTruthy()
    expect(text).not.toContain('key-shaped-value')
    expect(text).not.toContain('"tok"')
    // A value under a name that is not secret-shaped is left alone.
    expect(text).toContain('smtp.example.com')
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

/**
 * The four ways a dump is not a dump.
 *
 * Each of these passed the old check, because the old check was pg_dump's exit
 * status and pg_dump had already exited by the time any of them happened. A
 * full disk truncates the file after the process is gone; a killed container
 * leaves a valid-looking prefix; a pipe closed at the wrong moment produces
 * well-formed gzip that simply stops. None of them announces itself, and all of
 * them restore into a database quietly missing tables — which is worse than a
 * backup that obviously failed, because the failure is discovered on the day it
 * is needed.
 */
describe('verifying a dump is a dump', () => {
  const write = (name: string, bytes: Uint8Array): string => {
    const path = join(dir, name)
    writeFileSync(path, bytes)
    return path
  }

  it('accepts a complete dump', async () => {
    const result = await verifyDump(write('good.sql.gz', gzipSync(SAMPLE_DUMP)))
    expect(result.ok).toBe(true)
  })

  it('refuses a truncated gzip — the full-disk case', async () => {
    const whole = gzipSync(SAMPLE_DUMP)
    // Cut the trailing CRC and length, which is what a short write costs.
    const result = await verifyDump(write('cut.sql.gz', whole.subarray(0, whole.length - 8)))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('did not read back')
  })

  it('refuses bytes that are not gzip at all', async () => {
    const result = await verifyDump(write('plain.sql.gz', Buffer.from('dump'.repeat(100))))
    expect(result.ok).toBe(false)
  })

  it('refuses valid gzip that stops before the end — the killed-process case', async () => {
    // Well-formed gzip of a dump missing its last tables and its marker.
    const short = SAMPLE_DUMP.slice(0, SAMPLE_DUMP.indexOf('-- PostgreSQL database dump complete'))
    const result = await verifyDump(write('short.sql.gz', gzipSync(short)))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('completion marker')
  })

  it('refuses an empty dump', async () => {
    const result = await verifyDump(write('empty.sql.gz', gzipSync('')))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('empty')
  })

  /*
   * The marker sits near the end but not at it -- a real dump closes with an
   * `\unrestrict` line after it. A check that only read the final bytes would
   * reject every genuine dump, so the window has to be a window.
   */
  it('finds the marker even though it is not the last line', async () => {
    expect(SAMPLE_DUMP.trimEnd().endsWith('-- PostgreSQL database dump complete')).toBe(false)
    const result = await verifyDump(write('real-shape.sql.gz', gzipSync(SAMPLE_DUMP)))
    expect(result.ok).toBe(true)
  })

  it('reads a dump larger than the tail window', async () => {
    const padding = 'INSERT INTO public.cases VALUES (gen_random_uuid());\n'.repeat(4000)
    const big = SAMPLE_DUMP.replace('CREATE TABLE public.cases (id uuid NOT NULL);', padding)
    expect(big.length).toBeGreaterThan(64 * 1024)
    const result = await verifyDump(write('big.sql.gz', gzipSync(big)))
    expect(result.ok).toBe(true)
  })
})
