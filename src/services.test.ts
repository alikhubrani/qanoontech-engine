import { describe, expect, it } from 'vitest'
import { parsePs, runningVersion, serviceRows } from './services.js'

const ps = (rows: object[]) => parsePs(rows.map((r) => JSON.stringify(r)).join('\n'))

describe('serviceRows', () => {
  it('says where an external database is, instead of "not created"', () => {
    // The falsehood 0.19.3 stated on a box whose database had been moved off it.
    const rows = serviceRows(ps([{ Service: 'app', State: 'running', Health: 'healthy', Image: 'ghcr.io/alikhubrani/qanoontech:1.16.3' }]), {
      host: '192.168.1.108',
      port: 5434,
      server: 'PostgreSQL 17.11',
      reachable: true,
      detail: '',
    })
    const db = rows.find((r) => r.id === 'postgres')!
    expect(db.state).toBe('external')
    expect(db.health).toBe('healthy')
    expect(db.status).toBe('PostgreSQL 17.11 at 192.168.1.108:5434')
    expect(db.external?.reachable).toBe(true)
  })

  it('marks an external database that does not answer unhealthy, with the reason', () => {
    const rows = serviceRows(new Map(), {
      host: '192.168.1.108',
      port: 5434,
      server: undefined,
      reachable: false,
      detail: 'connection refused',
    })
    const db = rows.find((r) => r.id === 'postgres')!
    expect(db.health).toBe('unhealthy')
    expect(db.status).toBe('connection refused')
  })

  it('reads the local database from docker as before', () => {
    const rows = serviceRows(ps([{ Service: 'postgres', State: 'running', Health: 'healthy', Image: 'postgres:17-alpine' }]), undefined)
    const db = rows.find((r) => r.id === 'postgres')!
    expect(db.state).toBe('running')
    expect(db.external).toBeUndefined()
  })
})

describe('runningVersion', () => {
  it('is the tag of the application image', () => {
    const rows = serviceRows(ps([{ Service: 'app', State: 'running', Image: 'ghcr.io/alikhubrani/qanoontech:1.16.3' }]), undefined)
    expect(runningVersion(rows)).toBe('1.16.3')
  })

  it('is unknown when the application has no container', () => {
    expect(runningVersion(serviceRows(new Map(), undefined))).toBeUndefined()
  })
})

describe('parsePs', () => {
  it('accepts one object per line and an array alike', () => {
    expect(parsePs('{"Service":"app","State":"running"}\n{"Service":"nginx","State":"running"}').size).toBe(2)
    expect(parsePs('[{"Service":"app","State":"running"}]').size).toBe(1)
    expect(parsePs('').size).toBe(0)
  })
})
