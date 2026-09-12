import { listBackups, newestBackupAt, newestFullBackupAt } from './service.js'
import { readOffsite } from './offsite.js'
import { loadState, stateDir } from '../state/store.js'

/**
 * Is the backup system actually backing up — and say so where people look.
 *
 * This exists because of a silence. A hand-written manifest made the newest
 * set's timestamp unparseable, the schedule read that as "backed up a moment
 * ago", and a firm's database went three days without a copy. The audit trail
 * held five `backup-taken` events and **no failures**, because nothing failed:
 * it stopped being asked. Every screen said green.
 *
 * A backup system that can stop quietly is not a backup system, so the state
 * is computed here, once, and reported by `engine status`, the panel's
 * overview and `engine preflight` — the three places somebody is already
 * looking. It is deliberately not an email: the mailer drains a table in the
 * application's database, the engine holds no SQL connection on purpose, and a
 * warning that depends on the application is one more thing that goes out when
 * the application does.
 */

export type BackupHealthLevel = 'ok' | 'warn' | 'stale' | 'none'

export interface BackupHealth {
  readonly level: BackupHealthLevel
  /** Age of the newest set, in minutes. Undefined when there is none. */
  readonly ageMinutes?: number | undefined
  /** Age of the newest set carrying documents. */
  readonly fullAgeMinutes?: number | undefined
  readonly sets: number
  /** Sets taken but not yet copied offsite, when offsite is on. */
  readonly offsitePending?: number | undefined
  readonly detail: string
}

/*
 * How late is late.
 *
 * A snapshot can be a tick or two behind its interval without anything being
 * wrong — the tick is five minutes and a dump takes a moment. Twice the
 * interval plus a quarter-hour is comfortably outside that and comfortably
 * inside "somebody should look". Four times it, or a day, is the shape the
 * three-day silence had.
 */
const warnAfter = (intervalMinutes: number): number => intervalMinutes * 2 + 15
const staleAfter = (intervalMinutes: number): number =>
  Math.min(Math.max(intervalMinutes * 4, 180), 24 * 60)

/** Plain English for a duration, because "1440 minutes" is not a warning. */
export function humanMinutes(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)} minutes`
  const hours = minutes / 60
  if (hours < 48) return `${hours.toFixed(1)} hours`
  return `${Math.round(hours / 24)} days`
}

export function assessBackups(input: {
  readonly newestAt: number | undefined
  readonly newestFullAt: number | undefined
  readonly now: number
  readonly intervalMinutes: number
  readonly sets: number
  readonly offsitePending?: number | undefined
  /** When the oldest un-sent set was taken. Undefined when none is waiting. */
  readonly oldestPendingAt?: number | undefined
}): BackupHealth {
  const { newestAt, newestFullAt, now, intervalMinutes, sets, offsitePending, oldestPendingAt } = input

  if (newestAt === undefined || !Number.isFinite(newestAt)) {
    return {
      level: 'none',
      sets,
      detail:
        sets > 0
          ? 'There are backup directories but none the engine can read. Nothing here can be restored.'
          : 'No backup has ever been taken.',
    }
  }

  const ageMinutes = (now - newestAt) / 60000
  const fullAgeMinutes =
    newestFullAt === undefined || !Number.isFinite(newestFullAt)
      ? undefined
      : (now - newestFullAt) / 60000

  const age = humanMinutes(ageMinutes)
  const common = { ageMinutes, fullAgeMinutes, sets, offsitePending }

  if (ageMinutes > staleAfter(intervalMinutes)) {
    return {
      ...common,
      level: 'stale',
      detail: `The newest backup is ${age} old, against an interval of ${intervalMinutes} minutes. Backups have stopped.`,
    }
  }
  if (ageMinutes > warnAfter(intervalMinutes)) {
    return {
      ...common,
      level: 'warn',
      detail: `The newest backup is ${age} old, against an interval of ${intervalMinutes} minutes.`,
    }
  }
  // Documents ride the daily set, so they are late on a different clock.
  if (fullAgeMinutes !== undefined && fullAgeMinutes > 36 * 60) {
    return {
      ...common,
      level: 'warn',
      detail: `The database is current (${age}), but the newest backup carrying documents is ${humanMinutes(fullAgeMinutes)} old.`,
    }
  }
  /*
   * An offsite copy that has been failing for a day is not a backlog, it is a
   * second copy that does not exist -- and the whole reason for having one is
   * the box being gone. On the staging box this had been failing for ten days
   * behind 122 audit lines nobody reads, which is why it escalates rather than
   * sitting at warn forever.
   */
  if (oldestPendingAt !== undefined && Number.isFinite(oldestPendingAt) && now - oldestPendingAt > 24 * 60 * 60 * 1000) {
    return {
      ...common,
      level: 'stale',
      detail: `The database is backed up (${age}), but nothing has reached offsite storage since ${humanMinutes((now - oldestPendingAt) / 60000)} ago. There is only one copy.`,
    }
  }
  if (offsitePending !== undefined && offsitePending > 3) {
    return {
      ...common,
      level: 'warn',
      detail: `Backups are current (${age}), but ${offsitePending} have not reached offsite storage.`,
    }
  }
  return {
    ...common,
    level: 'ok',
    detail: `Newest backup ${age} old; ${sets} set(s) kept.`,
  }
}

/** The same assessment, read off disk. */
export function backupHealth(dir = stateDir(), now = Date.now()): BackupHealth {
  const state = loadState(dir)
  const sets = listBackups(dir)
  const waiting = state.settings.backupOffsiteEnabled
    ? sets.filter((set) => !readOffsite(set.id, dir).uploadedAt)
    : []
  // Sets come back newest-first, so the last one waiting is the oldest.
  const oldest = waiting.at(-1)
  return assessBackups({
    newestAt: newestBackupAt(dir),
    newestFullAt: newestFullBackupAt(dir),
    now,
    intervalMinutes: state.settings.backupIntervalMinutes,
    sets: sets.length,
    offsitePending: state.settings.backupOffsiteEnabled ? waiting.length : undefined,
    oldestPendingAt: oldest ? Date.parse(oldest.takenAt) : undefined,
  })
}
