import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CATALOGUE } from '../catalogue/index.js'
import * as docker from '../docker/index.js'
import { writeJsonAtomic } from '../lib/json-files.js'
import { loadState, stateDir } from '../state/store.js'

/**
 * What enforcement does, and — as important — what it leaves alone.
 *
 *   STOPPED                    STILL RUNNING
 *     app                        postgres    the firm's data, intact
 *     nginx                      the engine  this panel, and a new-licence form
 *     optional modules           backups     nightly copies continue
 *
 * The firm cannot use the system. The firm can still get their records out.
 * That line is deliberate and does not move: suspending access to software is
 * one act; withholding a client's own files is another, and this engine is
 * built to be incapable of the second.
 */

const ENFORCED_MARKER = 'enforced.json'

export function isEnforced(dir = stateDir()): boolean {
  return existsSync(join(dir, ENFORCED_MARKER))
}

/** The services enforcement touches: everything except the database. */
export function enforcementTargets(dir = stateDir()): string[] {
  const enabled = new Set(loadState(dir).enabled)
  return CATALOGUE.filter((m) => m.id !== 'postgres' && (m.required || enabled.has(m.id))).map(
    (m) => m.id,
  )
}

export async function enforceStop(dir = stateDir()): Promise<{ ok: boolean; detail: string }> {
  const targets = enforcementTargets(dir)
  const result = await docker.stop(targets)
  // The marker records that enforcement *succeeded*, so it acts once rather
  // than on every tick. A failed stop writes nothing and is retried on the
  // next tick — a marker describing an action that did not happen would be a
  // stored conclusion disagreeing with reality, the exact thing this module
  // avoids. It is an action record, never a judgement about the licence,
  // which stays computed.
  if (result.code === 0) {
    writeJsonAtomic(join(dir, ENFORCED_MARKER), { at: new Date().toISOString(), targets })
    return { ok: true, detail: targets.join(', ') }
  }
  return { ok: false, detail: (result.stderr || 'docker refused').trim() }
}

/** A good licence lifts enforcement and brings the deployment back. */
export async function enforceClear(dir = stateDir()): Promise<{ ok: boolean; detail: string }> {
  const targets = enforcementTargets(dir)
  const result = await docker.start(targets)
  rmSync(join(dir, ENFORCED_MARKER), { force: true })
  return {
    ok: result.code === 0,
    detail: result.code === 0 ? targets.join(', ') : (result.stderr || 'docker refused').trim(),
  }
}
