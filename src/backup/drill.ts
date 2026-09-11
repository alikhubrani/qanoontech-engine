import { join } from 'node:path'
import * as docker from '../docker/index.js'
import { loadSecrets, loadState, stateDir } from '../state/store.js'
import { BACKUPS_DIR, listBackups } from './service.js'

/**
 * Restore a backup into a scratch database, time it, and throw it away.
 *
 * **This is the only acceptance criterion that matters.** Everything else in
 * the backup system is plumbing, and none of it is true until a restore has
 * been performed: a backup nobody has restored is a claim, not a backup. The
 * standing example is this deployment's own — `apply` was documented as taking
 * one, did not, and the belief survived until somebody looked.
 *
 * It answers a number nobody had. `pgbackrest verify` and `gzip -t` prove an
 * archive is internally consistent; they do not say how long a real restore
 * takes, and that duration *is* the recovery time objective. Until it has been
 * measured it is unknown, which is the same class of error as believing a
 * backup was being taken.
 *
 * Read-only with respect to the deployment. It creates a database of its own,
 * replays into that, counts rows, and drops it — the live database is never
 * the target and is never stopped, so this is safe to run on a working box in
 * the middle of the day. That matters: a drill nobody dares run is a drill
 * nobody runs.
 */

export interface DrillResult {
  readonly ok: boolean
  readonly id?: string
  /** The recovery time objective, measured rather than estimated. */
  readonly restoreMs?: number
  readonly tables?: number
  readonly rows?: Record<string, number>
  readonly detail: string
}

/*
 * What a restored copy has to contain to count as restored.
 *
 * Table presence is not enough — `--clean --if-exists` produces a schema from
 * a dump that failed halfway just as happily as from a whole one. These are
 * the tables whose emptiness would mean a firm had lost its practice, so a
 * count of zero in any of them is a failed drill rather than a quiet pass.
 */
const MUST_HAVE_ROWS = ['users', 'cases', 'clients'] as const

/** A scratch name that cannot collide with anything a firm would call a database. */
const scratchName = (at = new Date()): string =>
  `qt_drill_${at.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`

export async function runDrill(
  id?: string,
  dir = stateDir(),
): Promise<DrillResult> {
  const sets = listBackups(dir)
  const set = id ? sets.find((candidate) => candidate.id === id) : sets[0]
  if (!set) {
    return { ok: false, detail: id ? `No backup named ${id}.` : 'There are no backups to drill against.' }
  }

  const state = loadState(dir)
  const password = loadSecrets(dir)['DB_PASSWORD']
  if (!password) return { ok: false, id: set.id, detail: 'No DB_PASSWORD is stored.' }
  const target = { dbName: state.settings.dbName, dbUser: state.settings.dbUser, password }

  const scratch = scratchName()
  const dumpPath = `/state/${BACKUPS_DIR}/${set.id}/database.sql.gz`

  /*
   * Dropped first as well as last. A drill killed halfway leaves its scratch
   * database behind, and the next run would then restore onto a populated one
   * and count rows that came from the run before it.
   */
  const drop = async () =>
    docker.psqlQuery(target, `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`, { database: 'postgres' })

  await drop()
  const created = await docker.psqlQuery(target, `CREATE DATABASE "${scratch}"`, { database: 'postgres' })
  if (created.code !== 0) {
    return { ok: false, id: set.id, detail: `Could not create a scratch database: ${(created.stderr || '').trim()}` }
  }

  try {
    // The measurement. Nothing between these two lines but the restore.
    const startedAt = Date.now()
    const restored = await docker.restoreDatabaseInto(target, scratch, dumpPath)
    const restoreMs = Date.now() - startedAt

    if (restored.code !== 0) {
      return { ok: false, id: set.id, restoreMs, detail: `The restore failed: ${(restored.stderr || '').trim()}` }
    }

    const counted = await docker.psqlQuery(
      target,
      `select count(*) from information_schema.tables where table_schema = 'public'`,
      { database: scratch },
    )
    const tables = Number.parseInt((counted.stdout || '').trim(), 10)
    if (!Number.isFinite(tables) || tables === 0) {
      return { ok: false, id: set.id, restoreMs, detail: 'The restored copy has no tables.' }
    }

    const rows: Record<string, number> = {}
    for (const table of MUST_HAVE_ROWS) {
      const result = await docker.psqlQuery(target, `select count(*) from "${table}"`, { database: scratch })
      const n = Number.parseInt((result.stdout || '').trim(), 10)
      if (!Number.isFinite(n)) {
        return { ok: false, id: set.id, restoreMs, tables, detail: `The restored copy has no ${table} table.` }
      }
      rows[table] = n
    }

    const empty = MUST_HAVE_ROWS.filter((table) => rows[table] === 0)
    if (empty.length > 0) {
      return {
        ok: false,
        id: set.id,
        restoreMs,
        tables,
        rows,
        detail: `The restore produced a schema but no data in: ${empty.join(', ')}.`,
      }
    }

    const seconds = (restoreMs / 1000).toFixed(1)
    const counts = MUST_HAVE_ROWS.map((table) => `${rows[table]} ${table}`).join(', ')
    return {
      ok: true,
      id: set.id,
      restoreMs,
      tables,
      rows,
      detail: `Restored ${set.id} into a scratch database in ${seconds}s: ${tables} tables, ${counts}.`,
    }
  } finally {
    // Whatever happened. A scratch copy of a firm's database is the same data
    // as the firm's database, and it does not get to outlive the drill.
    await drop()
  }
}

/** Where the drill's own record lives, so "when did we last prove it" has an answer. */
export const DRILL_FILE = join(BACKUPS_DIR, 'last-drill.json')
