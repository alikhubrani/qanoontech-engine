import { describe, expect, it } from 'vitest'
import { assessBackups, humanMinutes } from './health.js'

/**
 * The reading that would have caught a three-day silence.
 *
 * A firm's backups stopped and every surface said green, because nothing had
 * failed -- the schedule stopped being asked. So this asks the only question
 * that would have noticed: how old is the newest one, against how old it should
 * be.
 */

const MINUTE = 60_000
const now = Date.parse('2026-09-12T09:00:00Z')
const base = { now, intervalMinutes: 60, sets: 12 }
const at = (minutesAgo: number) => now - minutesAgo * MINUTE

describe('assessing backups', () => {
  it('is fine when the newest is inside the interval', () => {
    expect(assessBackups({ ...base, newestAt: at(20), newestFullAt: at(600) }).level).toBe('ok')
  })

  it('warns once it is well past the interval', () => {
    expect(assessBackups({ ...base, newestAt: at(140), newestFullAt: at(600) }).level).toBe('warn')
  })

  it('calls it stopped at four intervals', () => {
    const health = assessBackups({ ...base, newestAt: at(300), newestFullAt: at(600) })
    expect(health.level).toBe('stale')
    expect(health.detail).toContain('stopped')
  })

  /* The shape the real failure had: three days, on an hourly interval. */
  it('calls three days stopped, loudly', () => {
    const health = assessBackups({ ...base, newestAt: at(3 * 24 * 60), newestFullAt: at(3 * 24 * 60) })
    expect(health.level).toBe('stale')
    expect(health.detail).toContain('3 days')
  })

  it('reports nothing to restore as its own state, not as "old"', () => {
    expect(assessBackups({ ...base, newestAt: undefined, newestFullAt: undefined, sets: 0 }).level).toBe('none')
  })

  /*
   * The bug that caused it: a timestamp that would not parse. NaN compares
   * false against everything, so it read as "backed up a moment ago".
   */
  it('treats an unreadable timestamp as nothing, never as fresh', () => {
    const health = assessBackups({ ...base, newestAt: Number.NaN, newestFullAt: Number.NaN, sets: 6 })
    expect(health.level).toBe('none')
    expect(health.detail).toContain('none the engine can read')
  })

  it('warns when the database is current but the documents are a day and a half behind', () => {
    const health = assessBackups({ ...base, newestAt: at(20), newestFullAt: at(40 * 60) })
    expect(health.level).toBe('warn')
    expect(health.detail).toContain('documents')
  })

  it('warns when copies are piling up unsent', () => {
    const health = assessBackups({ ...base, newestAt: at(20), newestFullAt: at(600), offsitePending: 9 })
    expect(health.level).toBe('warn')
    expect(health.detail).toContain('offsite')
  })

  /* Ten days of failing uploads behind 122 audit lines nobody reads. */
  it('calls an offsite copy that has not landed for a day a stopped one', () => {
    const health = assessBackups({
      ...base,
      newestAt: at(20),
      newestFullAt: at(600),
      offsitePending: 13,
      oldestPendingAt: at(10 * 24 * 60),
    })
    expect(health.level).toBe('stale')
    expect(health.detail).toContain('only one copy')
  })

  it('does not escalate a copy that went out an hour ago', () => {
    const health = assessBackups({
      ...base,
      newestAt: at(20),
      newestFullAt: at(600),
      offsitePending: 1,
      oldestPendingAt: at(60),
    })
    expect(health.level).toBe('ok')
  })

  it('does not warn about one or two still in flight', () => {
    expect(
      assessBackups({ ...base, newestAt: at(20), newestFullAt: at(600), offsitePending: 2 }).level,
    ).toBe('ok')
  })
})

describe('saying how old', () => {
  it('uses units a person would use', () => {
    expect(humanMinutes(45)).toBe('45 minutes')
    expect(humanMinutes(200)).toBe('3.3 hours')
    expect(humanMinutes(3 * 24 * 60)).toBe('3 days')
  })
})
