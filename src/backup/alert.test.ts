import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alertDue, noteHealthLevel } from './alert.js'

/**
 * When an alert goes out, and — mostly — when it does not.
 *
 * The interesting cases here are all refusals. An alert that fires every tick
 * is an alert somebody filters into a folder, and then the next real one is in
 * the folder too. The one that must always fire is the first: a firm's backups
 * stopped for three days and nothing said so.
 */

const HOUR = 60 * 60 * 1000
const now = Date.parse('2026-09-12T09:00:00Z')
const sent = (level: string, hoursAgo: number) => ({
  level,
  sentAt: new Date(now - hoursAgo * HOUR).toISOString(),
})

describe('deciding to send an alert', () => {
  it('sends the first time backups are found stopped', () => {
    expect(alertDue({ level: 'stale', last: undefined, now })).toBe(true)
  })

  it('sends when there is no backup at all', () => {
    expect(alertDue({ level: 'none', last: undefined, now })).toBe(true)
  })

  it('does not send again ten minutes later', () => {
    expect(alertDue({ level: 'stale', last: sent('stale', 0.2), now })).toBe(false)
  })

  it('reminds once the problem has stood for six hours', () => {
    expect(alertDue({ level: 'stale', last: sent('stale', 7), now })).toBe(true)
  })

  it('sends when the problem changes shape', () => {
    expect(alertDue({ level: 'none', last: sent('stale', 0.2), now })).toBe(true)
  })

  it('says so when backups come back, exactly once', () => {
    expect(alertDue({ level: 'ok', last: sent('stale', 1), now })).toBe(true)
    expect(alertDue({ level: 'ok', last: sent('ok', 1), now })).toBe(false)
  })

  it('stays quiet on a box that has always been fine', () => {
    expect(alertDue({ level: 'ok', last: undefined, now })).toBe(false)
  })

  /*
   * `warn` is late, not stopped -- a snapshot or two behind. Mailing somebody
   * about it at 3am would teach them to ignore the address.
   *
   * The first of these passed before the fix and proved nothing: with no
   * previous record the predicate short-circuited on `last !== undefined`, so
   * the case that actually mattered -- a box sitting at `warn` with a record
   * already written -- was never exercised. On staging that shipped as an email
   * every five minutes.
   */
  it('does not email for a backup that is merely late', () => {
    expect(alertDue({ level: 'warn', last: undefined, now })).toBe(false)
  })

  it('does not announce recovery while it is still only warning', () => {
    expect(alertDue({ level: 'warn', last: sent('warn', 0.1), now })).toBe(false)
    expect(alertDue({ level: 'warn', last: sent('warn', 48), now })).toBe(false)
    expect(alertDue({ level: 'warn', last: sent('stale', 1), now })).toBe(false)
  })

  it('announces recovery once, when it is actually back to ok', () => {
    expect(alertDue({ level: 'ok', last: sent('stale', 1), now })).toBe(true)
    expect(alertDue({ level: 'ok', last: sent('none', 1), now })).toBe(true)
    // A box that was only ever late has nothing to recover from.
    expect(alertDue({ level: 'ok', last: sent('warn', 1), now })).toBe(false)
  })
})

/**
 * The audit trail gets the same throttle the mailbox does.
 *
 * `backup-stale` was recorded on every tick. Staging held fifty identical lines
 * in one afternoon, in a trail that is a few kilobytes and exists to be read --
 * the same "people learn to ignore it" failure as an alert that repeats, one
 * surface along.
 */
describe('noting the health level', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'alert-note-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is news the first time', () => {
    expect(noteHealthLevel('stale', dir)).toBe(true)
  })

  it('is not news five minutes later', () => {
    noteHealthLevel('stale', dir)
    expect(noteHealthLevel('stale', dir)).toBe(false)
    expect(noteHealthLevel('stale', dir)).toBe(false)
  })

  it('is news again when the state actually changes', () => {
    noteHealthLevel('stale', dir)
    expect(noteHealthLevel('ok', dir)).toBe(true)
    expect(noteHealthLevel('stale', dir)).toBe(true)
  })

  /* It must not swallow the reminder the mailer decides on separately. */
  it('leaves the last-sent time alone, so reminders still come due', () => {
    noteHealthLevel('stale', dir)
    const before = alertDue({ level: 'stale', last: { level: 'stale', sentAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() }, now: Date.now() })
    expect(before).toBe(true)
  })
})
