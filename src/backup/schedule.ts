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

/**
 * Is a backup due right now?
 *
 * Overdue — nothing on disk, or the newest set older than a day plus slack —
 * means now, whatever the hour: a box that was off at the scheduled hour
 * should not wait another night. Otherwise a set is taken when the clock is
 * inside the backup hour and the newest set is old enough that this is not
 * the same night's run seen twice.
 */
export function backupDue(input: {
  readonly newestAt: number | undefined
  readonly now: number
  readonly backupHour: number
  readonly timezone: string
}): boolean {
  const { newestAt, now, backupHour, timezone } = input
  if (newestAt === undefined) return true
  const age = now - newestAt
  if (age > 26 * HOUR_MS) return true
  return hourIn(timezone, now) === backupHour && age > 20 * HOUR_MS
}
