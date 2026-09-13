import { loadSecrets, loadState, stateDir } from '../state/store.js'

/**
 * Where the application's database is — the one answer every helper uses.
 *
 * Two shapes, decided by one fact: whether a `DATABASE_URL` secret is stored.
 *
 *  - **Absent** — the database is the `postgres` module in this deployment's
 *    compose file, reached by name on the project network. This is every
 *    deployment before Phase 3 and needs nothing set.
 *  - **Present** — the database is wherever the URL says: a VM on the LAN, a
 *    managed service, a Postgres on the same machine outside compose. The
 *    `postgres` module is not rendered, and the helpers reach the host directly.
 *
 * It is a *secret* and not a setting because it carries the password, and a
 * URL with a password in a settings file is a password in every support bundle
 * and every `state.json` diff. Redaction already scrubs stored secret values
 * wherever they appear; a setting would not be scrubbed.
 *
 * And it is one fact rather than a mode plus a URL because two things that
 * must agree eventually do not. Presence *is* the mode.
 *
 * Only this function knows both shapes. `dumpDatabase`, `restoreDatabase`,
 * `psqlQuery`, the drill and the preflight all take what it returns; none of
 * them decides anything about where the database is.
 */

export const DATABASE_URL = 'DATABASE_URL'

export interface DatabaseTarget {
  readonly host: string
  readonly port: number
  readonly dbName: string
  readonly dbUser: string
  readonly password: string
  /** `prefer` on a LAN, `require` across the internet. Passed to psql as PGSSLMODE. */
  readonly sslmode: string
  /** True when the database is not the compose module — the helper leaves the project network. */
  readonly external: boolean
}

/** The in-compose default, when no URL is stored. */
export const LOCAL_HOST = 'postgres'
export const LOCAL_PORT = 5432

/**
 * Parse a `postgresql://` URL into a target, or say what is wrong with it.
 *
 * Strict about the scheme and about the parts that cannot be defaulted. A URL
 * missing its database name would connect somewhere and dump the wrong thing,
 * which is worse than refusing. The password is URL-decoded, because a
 * password with `@` or `/` in it arrives percent-encoded and psql wants the
 * real characters.
 */
export function parseDatabaseUrl(
  raw: string,
): { ok: true; target: DatabaseTarget } | { ok: false; detail: string } {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, detail: 'That is not a URL.' }
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    return { ok: false, detail: `Expected postgresql://, got ${url.protocol}//` }
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!dbName) return { ok: false, detail: 'The URL names no database (nothing after the host).' }
  if (!url.username) return { ok: false, detail: 'The URL has no user.' }
  if (!url.hostname) return { ok: false, detail: 'The URL has no host.' }

  const sslmode = url.searchParams.get('sslmode') ?? 'prefer'
  return {
    ok: true,
    target: {
      host: url.hostname,
      port: url.port ? Number(url.port) : LOCAL_PORT,
      dbName,
      dbUser: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      sslmode,
      external: true,
    },
  }
}

/**
 * The target for this deployment, or the reason there is none.
 *
 * `undefined` password on the local shape means the deployment has not been
 * set up yet, which `takeBackup` already reports politely.
 */
export function databaseTarget(
  dir = stateDir(),
): { ok: true; target: DatabaseTarget } | { ok: false; detail: string } {
  const secrets = loadSecrets(dir)
  const url = secrets[DATABASE_URL]
  if (url) return parseDatabaseUrl(url)

  const password = secrets['DB_PASSWORD']
  if (!password) return { ok: false, detail: 'No DB_PASSWORD is stored; there is no database to reach yet.' }
  const settings = loadState(dir).settings
  return {
    ok: true,
    target: {
      host: LOCAL_HOST,
      port: LOCAL_PORT,
      dbName: settings.dbName,
      dbUser: settings.dbUser,
      password,
      sslmode: 'disable',
      external: false,
    },
  }
}

/**
 * Whether an sslmode makes the *application's* driver insist on TLS.
 *
 * `prefer` means two different things. To libpq — psql, pg_dump, every helper
 * the engine runs — it means "try TLS, fall back to plain". To node-postgres,
 * which the application's entrypoint uses to wait for the database, it is an
 * alias for `verify-full`: no fallback, and a server with `ssl = off` is
 * refused with "The server does not support SSL connections". The driver
 * prints a warning saying exactly this.
 *
 * So the engine's own probe passed and the application it had just configured
 * could not connect, and the entrypoint's loop said "PostgreSQL is
 * unavailable" for twenty minutes because it discards the error. `database
 * use` now asks the server whether it has TLS and refuses these modes when it
 * does not — the question the application will ask, not the one libpq would.
 */
export function sslmodeDemandsTls(sslmode: string): boolean {
  return ['prefer', 'require', 'verify-ca', 'verify-full'].includes(sslmode)
}

/** Whether the database lives outside this deployment's compose file. */
export function databaseIsExternal(dir = stateDir()): boolean {
  return Boolean(loadSecrets(dir)[DATABASE_URL])
}
