import { join } from 'node:path'
import { z } from 'zod'
import { readJsonFile, writeJsonAtomic } from '../lib/json-files.js'
import { stateDir } from '../state/store.js'

/**
 * The engine's notion of "now", hardened against the clock being set back.
 *
 * Grace measured against the system clock is grace an operator can extend
 * forever by winding the clock backwards. The defence is a high-water mark:
 * every observation records the latest time the engine has ever seen, and
 * when the system clock is behind that mark, the mark wins. Time that has
 * been seen has elapsed, whatever the clock now claims.
 *
 * A *forward* jump is left alone: it only shortens grace, an operator gains
 * nothing by it, and correcting a slow clock is routine.
 */

const CLOCK_FILE = 'clock.json'

const clockSchema = z.object({ highWaterMark: z.number().default(0) })

export function observedNow(dir = stateDir()): number {
  const path = join(dir, CLOCK_FILE)
  const raw = readJsonFile(path, { lenient: true })
  const parsed = clockSchema.safeParse(raw ?? {})
  const mark = parsed.success ? parsed.data.highWaterMark : 0

  const system = Date.now()
  const now = Math.max(system, mark)
  if (now > mark) {
    writeJsonAtomic(path, { highWaterMark: now })
  }
  return now
}

/** Whether the system clock is currently behind what has already been seen. */
export function clockRolledBack(dir = stateDir()): boolean {
  const raw = readJsonFile(join(dir, CLOCK_FILE), { lenient: true })
  const parsed = clockSchema.safeParse(raw ?? {})
  const mark = parsed.success ? parsed.data.highWaterMark : 0
  // A minute of slack: NTP steps a clock by seconds all the time, and an
  // alarm that fires on every adjustment teaches people to ignore it.
  return Date.now() < mark - 60_000
}
