import * as docker from '../docker/index.js'
import { parseDatabaseUrl, sslmodeDemandsTls, type DatabaseTarget } from './target.js'

/**
 * Prove a database URL before it is stored — shared by `database use` and the
 * panel, so the two refuse the same things for the same reasons.
 *
 * A URL that is saved and then found not to work has already been rendered
 * into the compose file, and the application is the thing that discovers it.
 * Three checks, each found the hard way:
 *
 *  - it answers `SELECT version()` at all;
 *  - `sslmode` does not promise TLS a server with `ssl = off` cannot give —
 *    node-postgres treats `prefer` as `verify-full` and will not fall back,
 *    so a URL every engine helper is happy with can leave the application
 *    unable to connect (found on staging, hidden behind "PostgreSQL is
 *    unavailable");
 *  - the role can CREATE DATABASE, because the drill needs a scratch one.
 */
export interface DatabaseProof {
  readonly ok: boolean
  readonly target?: DatabaseTarget
  /** "PostgreSQL 17.11", when it answered. */
  readonly server?: string
  readonly tables?: number
  readonly detail: string
}

export async function proveDatabaseUrl(url: string): Promise<DatabaseProof> {
  const parsed = parseDatabaseUrl(url)
  if (!parsed.ok) return { ok: false, detail: parsed.detail }
  const target = parsed.target

  const probe = await docker.psqlQuery(target, 'SELECT version()')
  if (probe.code !== 0) {
    return { ok: false, target, detail: `Could not connect: ${(probe.stderr || '').trim().slice(0, 300)}` }
  }
  const server = probe.stdout.trim().split(' ').slice(0, 2).join(' ')

  if (sslmodeDemandsTls(target.sslmode)) {
    const ssl = await docker.psqlQuery(target, 'SHOW ssl')
    if (ssl.code === 0 && ssl.stdout.trim() === 'off') {
      return {
        ok: false,
        target,
        server,
        detail:
          `The server has ssl = off, but the URL says sslmode=${target.sslmode}. The engine's tools would fall back to plain text; the application's driver will not, and would refuse to connect. ` +
          'Either use sslmode=disable (true to what this server offers) or turn ssl on in the server first.',
      }
    }
  }

  const can = await docker.psqlQuery(target, 'SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user')
  if (can.code === 0 && can.stdout.trim() !== 't') {
    return {
      ok: false,
      target,
      server,
      detail: `The role ${target.dbUser} cannot CREATE DATABASE, so backup drills would fail against this server. Grant CREATEDB and try again.`,
    }
  }

  const count = await docker.psqlQuery(target, "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
  const tables = count.code === 0 ? Number(count.stdout.trim()) : undefined

  return {
    ok: true,
    target,
    server,
    ...(tables !== undefined && Number.isFinite(tables) ? { tables } : {}),
    detail: `${server} at ${target.host}:${target.port}/${target.dbName}${tables !== undefined ? `, ${tables} tables` : ''}.`,
  }
}
