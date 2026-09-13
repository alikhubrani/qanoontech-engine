import { z } from 'zod'
import { CATALOGUE } from './catalogue/index.js'
import * as docker from './docker/index.js'
import { databaseTarget, type DatabaseTarget } from './backup/target.js'
import { stateDir } from './state/store.js'

/**
 * The services the deployment defines and what state each is in.
 *
 * Docker knows about the containers. It does not know about the database once
 * that is external, and until 0.20.0 the Database row on a box whose database
 * had deliberately been moved off it read "not created · required" — exactly
 * what a fresh box with no database looks like. The row is now derived from
 * the database *target*, and an external one is probed, because a screen that
 * can state a falsehood about the one service holding every case record is
 * worse than no screen.
 */

/** One line of `docker compose ps --format json` — the fields we read. */
const psLine = z.object({
  Service: z.string(),
  State: z.string(),
  Health: z.string().optional().default(''),
  Status: z.string().optional().default(''),
  Image: z.string().optional().default(''),
})

export type PsRow = z.infer<typeof psLine>

export interface ExternalDatabase {
  readonly host: string
  readonly port: number
  /** "PostgreSQL 17.11", when it answered. */
  readonly server: string | undefined
  readonly reachable: boolean
  readonly detail: string
}

export interface ServiceView {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly required: boolean
  /** 'running' | 'exited' | ... from docker, 'absent' when no container exists, 'external' for a database elsewhere. */
  readonly state: string
  /** 'healthy' | 'unhealthy' | 'starting' | '' */
  readonly health: string
  readonly status: string
  readonly image: string
  readonly external?: ExternalDatabase
}

/** Parse whatever `compose ps` printed — one object per line, or an array. */
export function parsePs(text: string): Map<string, PsRow> {
  const rows: unknown[] = []
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    try {
      rows.push(...(JSON.parse(trimmed) as unknown[]))
    } catch {
      /* fall through with nothing parsed */
    }
  } else if (trimmed !== '') {
    for (const line of trimmed.split('\n')) {
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* a non-JSON line; skip it */
      }
    }
  }
  const running = new Map<string, PsRow>()
  for (const row of rows) {
    const parsed = psLine.safeParse(row)
    if (parsed.success) running.set(parsed.data.Service, parsed.data)
  }
  return running
}

/**
 * The rows, from what docker said and where the database is. Pure, so the
 * external case can be tested without a database to probe.
 */
export function serviceRows(
  running: ReadonlyMap<string, PsRow>,
  external: ExternalDatabase | undefined,
): ServiceView[] {
  return CATALOGUE.map((module): ServiceView => {
    if (module.id === 'postgres' && external) {
      return {
        id: module.id,
        title: module.title,
        summary: module.summary,
        required: module.required,
        state: 'external',
        health: external.reachable ? 'healthy' : 'unhealthy',
        status: external.reachable
          ? `${external.server ?? 'PostgreSQL'} at ${external.host}:${external.port}`
          : external.detail,
        image: '',
        external,
      }
    }
    const row = running.get(module.id)
    return {
      id: module.id,
      title: module.title,
      summary: module.summary,
      required: module.required,
      state: row?.State ?? 'absent',
      health: row?.Health ?? '',
      status: row?.Status ?? '',
      image: row?.Image ?? '',
    }
  })
}

/** The version actually running: the tag of the application's image. */
export function runningVersion(services: readonly ServiceView[]): string | undefined {
  const image = services.find((service) => service.id === 'app')?.image
  if (!image) return undefined
  const tag = image.slice(image.lastIndexOf('/') + 1).split(':')[1]
  return tag || undefined
}

/*
 * One probe a minute, not one per poll. The panel asks every ten seconds and
 * a probe is a helper container, so without this it would be six `docker run`s
 * a minute to learn a fact that changes about once a year.
 */
const PROBE_TTL_MS = 60 * 1000
let probeCache: { key: string; at: number; result: ExternalDatabase } | undefined

async function probeExternal(target: DatabaseTarget, now = Date.now()): Promise<ExternalDatabase> {
  const key = `${target.host}:${target.port}/${target.dbName}`
  if (probeCache && probeCache.key === key && now - probeCache.at < PROBE_TTL_MS) return probeCache.result
  const probe = await docker.psqlQuery(target, 'SELECT version()')
  const result: ExternalDatabase =
    probe.code === 0
      ? {
          host: target.host,
          port: target.port,
          server: probe.stdout.trim().split(' ').slice(0, 2).join(' '),
          reachable: true,
          detail: '',
        }
      : {
          host: target.host,
          port: target.port,
          server: undefined,
          reachable: false,
          detail: (probe.stderr || probe.stdout).trim().slice(0, 200) || 'The database did not answer.',
        }
  probeCache = { key, at: now, result }
  return result
}

/** Forget the cached probe — after the database is switched, the next poll must ask. */
export function forgetProbe(): void {
  probeCache = undefined
}

export async function listServices(
  dir = stateDir(),
): Promise<{ services: ServiceView[]; dockerError?: string }> {
  const result = await docker.ps()
  const running = result.code === 0 ? parsePs(result.stdout) : new Map<string, PsRow>()
  const dockerError =
    result.code === 0 ? undefined : (result.stderr || result.stdout).trim() || 'Docker did not answer.'

  const resolved = databaseTarget(dir)
  const external =
    resolved.ok && resolved.target.external ? await probeExternal(resolved.target) : undefined

  const services = serviceRows(running, external)
  return dockerError === undefined ? { services } : { services, dockerError }
}
