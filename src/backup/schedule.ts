/**
 * When the next backup is due — derived from the newest set on disk, never
 * from process uptime.
 *
 * The lesson is inherited from the previous panel, where a timer started at
 * boot and the container was recreated on every update: a box updated daily
 * never took a scheduled backup at all. Here the only inputs are what is on
 * disk and what time it is, so restarts change nothing.
 */

const HOUR_MS = 60 * 60 * 1000

/** Hour-of-day (0–23) for a timestamp, read in the deployment's timezone. */
export function hourIn(timezone: string, at: number): number {
  try {
    const hour = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(new Date(at))
    return Number(hour)
  } catch {
    return new Date(at).getUTCHours()
  }
}

/** What the tick should take, if anything. */
export type BackupKind = 'none' | 'database' | 'full'

/**
 * What is due right now: nothing, the database alone, or the whole set.
 *
 * This used to answer yes or no, and the yes was rarer than it looked. It
 * forced a set only once the newest was older than **26 hours**, otherwise
 * waiting for the backup hour *and* twenty hours of age. On a firm's box that
 * showed up exactly as written: eighteen sets over nine days, and a widest
 * window with no backup of 26.1 hours. A day's filings, hearing notes and
 * correspondence, re-entered from memory if anyone remembers.
 *
 * Now the database is snapshotted on an interval -- hourly by default, and
 * cheap enough to be: 142 KB and 156 ms on that same box. Documents are the
 * slow half and change rarely, so the full set, with its tar of every
 * document, still runs once a day at `backupHour`.
 *
 * Same inputs as before: what is on disk and what time it is. Nothing derives
 * from process uptime, because a box updated daily used to take no scheduled
 * backup at all.
 */
export function backupDue(input: {
  readonly newestAt: number | undefined
  readonly newestFullAt: number | undefined
  readonly now: number
  readonly backupHour: number
  readonly intervalMinutes: number
  readonly timezone: string
}): BackupKind {
  const { newestAt, newestFullAt, now, backupHour, intervalMinutes, timezone } = input

  /*
   * Belt and braces against the failure that stopped a firm's backups.
   *
   * `newestBackupAt` no longer returns NaN, but this predicate is the thing
   * that decides whether a database gets copied, and a number it cannot reason
   * about must mean "back up", never "do nothing". Every comparison below is
   * false against NaN, so without this line an unusable input reads exactly
   * like "a backup was taken a moment ago".
   */
  if (newestAt !== undefined && !Number.isFinite(newestAt)) return 'full'

  /*
   * The daily full set wins when it is due, because it is also a database
   * snapshot -- taking both in the same tick would store the database twice.
   */
  const fullAge = newestFullAt === undefined ? Number.POSITIVE_INFINITY : now - newestFullAt
  const inBackupHour = hourIn(timezone, now) === backupHour
  // Twenty hours so a second tick inside the same hour is not a second set;
  // twenty-six so a box that was off at the hour does not wait another night.
  if (fullAge > 26 * HOUR_MS || (inBackupHour && fullAge > 20 * HOUR_MS)) return 'full'

  if (newestAt === undefined) return 'database'
  // `>=` and not `>`: a tick landing exactly on the interval is on time.
  return now - newestAt >= intervalMinutes * 60 * 1000 ? 'database' : 'none'
}
