/**
 * A failure is worth reporting when it has lasted, not when it has happened.
 *
 * A firm's box wrote eight failure rows in one day, every one healed by the
 * next tick: an image pull saturating the line, the engine replacing itself
 * mid-request, the resolver blinking. Each was true and none was news. A
 * store still unreachable after three ticks -- a quarter of an hour, with a
 * retry inside every tick -- is news, and so is the moment it comes back,
 * which nothing recorded before.
 *
 * State lives in the tick's memory. A restarted engine begins with a clean
 * slate, which errs towards reporting late and never towards twice.
 */

export interface Streak {
  /** Ticks failed in a row. */
  readonly failures: number
  /** Whether this run has been written to the trail. */
  readonly reported: boolean
  /** When the run began, or null when nothing is failing. */
  readonly since: string | null
  /** The most recent reason, as the store's client put it. */
  readonly lastError: string
}

export const NO_STREAK: Streak = { failures: 0, reported: false, since: null, lastError: '' }

/** Three ticks: fifteen minutes, with a retry inside each. */
export const TICKS_BEFORE_REPORT = 3

export interface StreakStep {
  readonly streak: Streak
  /** What, if anything, the trail should hear about this tick. */
  readonly event: 'report' | 'recovered' | null
}

export function advanceStreak(
  previous: Streak,
  outcome: { readonly ok: boolean; readonly detail: string },
  now: string,
): StreakStep {
  if (outcome.ok) {
    return { streak: NO_STREAK, event: previous.reported ? 'recovered' : null }
  }
  const failures = previous.failures + 1
  const report = failures >= TICKS_BEFORE_REPORT && !previous.reported
  return {
    streak: {
      failures,
      reported: previous.reported || report,
      since: previous.since ?? now,
      lastError: outcome.detail,
    },
    event: report ? 'report' : null,
  }
}

/** `20:00 UTC`, from an ISO stamp, for a detail line a person reads. */
export function clockOf(iso: string): string {
  return `${iso.slice(11, 16)} UTC`
}
