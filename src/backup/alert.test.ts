import { describe, expect, it } from 'vitest'
import { alertDue } from './alert.js'

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
   */
  it('does not email for a backup that is merely late', () => {
    expect(alertDue({ level: 'warn', last: undefined, now })).toBe(false)
  })
})
