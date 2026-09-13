import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUDIT_EVENTS, AuditLog, describeEvent } from './audit.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audit-test-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the audit catalogue', () => {
  it('describes every event the engine can write, and no description is a raw slug', () => {
    for (const [event, description] of Object.entries(AUDIT_EVENTS)) {
      // A slug is lowercase words joined by hyphens; a label is a sentence.
      expect(description.label, event).not.toMatch(/^[a-z]+(-[a-z]+)*$/)
      expect(description.label, event).not.toBe(event)
    }
  })

  it('reads history the engine can no longer write as history, not as slugs', () => {
    expect(describeEvent('snapshot-copied')).toEqual({ label: 'Engine state copied offsite', kind: 'routine' })
    expect(describeEvent('password-changed').kind).toBe('security')
  })

  it('shows rather than hides a name it has never seen', () => {
    // `change` and not `routine`: the way to keep a new event off the overview
    // is to classify it, not to forget to.
    expect(describeEvent('something-new')).toEqual({ label: 'Something new', kind: 'change' })
  })
})

describe('recent()', () => {
  it('filters by kind, pages by timestamp, and carries the description', () => {
    const log = new AuditLog(dir)
    const lines = [
      { at: '2026-09-13T10:00:00.000Z', event: 'backup-taken' },
      { at: '2026-09-13T10:05:00.000Z', event: 'login', subject: 'a@example.com' },
      { at: '2026-09-13T10:10:00.000Z', event: 'offsite-uploaded' },
      { at: '2026-09-13T10:15:00.000Z', event: 'backup-failed' },
      { at: '2026-09-13T10:20:00.000Z', event: 'snapshot-copied' },
    ]
    writeFileSync(join(dir, 'audit.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const notable = log.recent({ kinds: ['security', 'change', 'failure'] })
    expect(notable.map((e) => e.event)).toEqual(['backup-failed', 'login'])
    expect(notable[0]).toMatchObject({ label: 'Backup failed', kind: 'failure' })

    const all = log.recent({ limit: 2 })
    expect(all.map((e) => e.event)).toEqual(['snapshot-copied', 'backup-failed'])
    const next = log.recent({ limit: 2, before: all.at(-1)!.at })
    expect(next.map((e) => e.event)).toEqual(['offsite-uploaded', 'login'])
  })

  it('still answers a bare number, as the support bundle asks', () => {
    const log = new AuditLog(dir)
    log.record('login')
    expect(log.recent(1)).toHaveLength(1)
  })
})
