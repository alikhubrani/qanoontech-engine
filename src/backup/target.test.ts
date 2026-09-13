import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadState, saveSecrets, saveState } from '../state/store.js'
import { databaseIsExternal, databaseTarget, parseDatabaseUrl } from './target.js'

/**
 * One function decides where the database is, and every helper trusts it. So
 * the shapes it can return are the whole contract, and each edge that would
 * connect somewhere wrong is a test.
 */
describe('parsing a database URL', () => {
  it('reads every part, and defaults the port', () => {
    const r = parseDatabaseUrl('postgresql://firm:secret@db.example.com/qanoontech_firm')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.target).toMatchObject({
      host: 'db.example.com',
      port: 5432,
      dbName: 'qanoontech_firm',
      dbUser: 'firm',
      password: 'secret',
      sslmode: 'prefer',
      external: true,
    })
  })

  it('takes an explicit port and sslmode', () => {
    const r = parseDatabaseUrl('postgresql://u:p@192.168.1.108:5434/db?sslmode=require')
    expect(r.ok && r.target.port).toBe(5434)
    expect(r.ok && r.target.sslmode).toBe('require')
  })

  it('decodes a password that had to be percent-encoded to fit in a URL', () => {
    // `@` and `/` in a password are legal and arrive encoded; psql wants the
    // real characters, and a mis-decoded password is a connection refused
    // with no clue why.
    const r = parseDatabaseUrl('postgresql://u:p%40ss%2Fword@h/db')
    expect(r.ok && r.target.password).toBe('p@ss/word')
  })

  it('accepts the postgres: scheme too', () => {
    expect(parseDatabaseUrl('postgres://u:p@h/db').ok).toBe(true)
  })

  it('refuses a URL that names no database', () => {
    // It would connect to the user's default database and dump the wrong thing.
    const r = parseDatabaseUrl('postgresql://u:p@h/')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.detail).toContain('names no database')
  })

  it('refuses the wrong scheme, a missing user, a missing host, and rubbish', () => {
    expect(parseDatabaseUrl('mysql://u:p@h/db').ok).toBe(false)
    expect(parseDatabaseUrl('postgresql://h/db').ok).toBe(false)
    expect(parseDatabaseUrl('not a url').ok).toBe(false)
  })
})

describe('the deployment’s target', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'target-test-'))
    saveState(loadState(dir), dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is the compose module when no URL is stored', () => {
    saveSecrets({ DB_PASSWORD: 'local-pw' }, dir)
    const r = databaseTarget(dir)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.target.external).toBe(false)
    expect(r.target.host).toBe('postgres')
    expect(r.target.password).toBe('local-pw')
    expect(databaseIsExternal(dir)).toBe(false)
  })

  it('is the URL when one is stored, and the URL wins over the local settings', () => {
    saveSecrets({ DB_PASSWORD: 'local-pw', DATABASE_URL: 'postgresql://ext:ext-pw@db.example:5433/other' }, dir)
    const r = databaseTarget(dir)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.target.external).toBe(true)
    expect(r.target.host).toBe('db.example')
    expect(r.target.dbName).toBe('other')
    expect(r.target.password).toBe('ext-pw')
    expect(databaseIsExternal(dir)).toBe(true)
  })

  it('says why there is no target on a box not yet set up', () => {
    saveSecrets({}, dir)
    const r = databaseTarget(dir)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.detail).toContain('DB_PASSWORD')
  })
})
