import { describe, expect, it } from 'vitest'
import { NO_STREAK, TICKS_BEFORE_REPORT, advanceStreak, clockOf } from './streak.js'

const failed = { ok: false, detail: 'fetch failed (ECONNRESET) on GET /b' }
const fine = { ok: true, detail: 'Copied.' }
const at = (minute: number) => `2026-09-13T20:${String(minute).padStart(2, '0')}:00.000Z`

describe('a run of failed ticks', () => {
  it('says nothing about a blip the next tick heals', () => {
    const one = advanceStreak(NO_STREAK, failed, at(0))
    expect(one.event).toBeNull()
    expect(advanceStreak(one.streak, fine, at(5))).toEqual({ streak: NO_STREAK, event: null })
  })

  it('reports once it has lasted three ticks, naming when it began', () => {
    let step = advanceStreak(NO_STREAK, failed, at(0))
    step = advanceStreak(step.streak, failed, at(5))
    expect(step.event).toBeNull()
    step = advanceStreak(step.streak, { ...failed, detail: 'later reason' }, at(10))
    expect(step.event).toBe('report')
    expect(step.streak).toEqual({ failures: TICKS_BEFORE_REPORT, reported: true, since: at(0), lastError: 'later reason' })
  })

  it('reports a run once, not on every tick it continues', () => {
    let step = advanceStreak(NO_STREAK, failed, at(0))
    for (let i = 1; i < 8; i += 1) step = advanceStreak(step.streak, failed, at(i * 5))
    expect(step.streak.failures).toBe(8)
    expect(step.event).toBeNull()
  })

  it('records the recovery of a run it reported, and only of one it reported', () => {
    let step = advanceStreak(NO_STREAK, failed, at(0))
    step = advanceStreak(step.streak, failed, at(5))
    step = advanceStreak(step.streak, failed, at(10))
    const back = advanceStreak(step.streak, fine, at(15))
    expect(back).toEqual({ streak: NO_STREAK, event: 'recovered' })
    const quiet = advanceStreak(advanceStreak(NO_STREAK, failed, at(0)).streak, fine, at(5))
    expect(quiet.event).toBeNull()
  })

  it('reads a stamp as a clock time', () => {
    expect(clockOf('2026-09-13T20:00:36.703Z')).toBe('20:00 UTC')
  })
})
