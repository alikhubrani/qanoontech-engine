import { statfs } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { CATALOGUE } from '../catalogue/index.js'
import * as docker from '../docker/index.js'
import { currentLicence } from '../licence/index.js'
import { probeRegistry, storedRegistryAuth } from '../registry.js'
import { loadState, stateDir } from '../state/store.js'

/**
 * Preflight: conformance checks run before an install, re-runnable after.
 *
 * The point is that every failure gets its name *now*, at the moment it can
 * still be fixed cheaply — not four steps later wearing a different error's
 * clothes. A wrong registry token diagnosed here says "the token is wrong";
 * undiagnosed, it surfaces during deploy as `manifest unknown`, which this
 * project has already produced two bad error messages explaining.
 *
 * `fail` blocks. `warn` proceeds with acknowledgement. The one check that is
 * blocking-without-acknowledgement in the design — existing volumes on what
 * claims to be a fresh install — is reported as `warn` with wording that
 * carries the weight, because the acknowledgement itself is the UI's job.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface CheckResult {
  readonly id: string
  readonly title: string
  readonly status: CheckStatus
  readonly detail: string
}

const GB = 1024 ** 3
const DISK_FLOOR_GB = 5
const DISK_COMFORT_GB = 20
const CLOCK_SKEW_WARN_MS = 5 * 60 * 1000

export async function runPreflight(dir = stateDir()): Promise<CheckResult[]> {
  const state = loadState(dir)
  const results: CheckResult[] = []

  // -- docker ---------------------------------------------------------------
  const daemon = await docker.available()
  if (daemon.code === 0) {
    results.push({
      id: 'docker',
      title: 'Docker Engine',
      status: 'pass',
      detail: `Daemon answering, API ${daemon.stdout.trim()}.`,
    })
  } else {
    results.push({
      id: 'docker',
      title: 'Docker Engine',
      status: 'fail',
      detail: daemon.stderr.trim() || 'The daemon did not answer. Is Docker installed and running?',
    })
  }

  const compose = await docker.composeVersion()
  results.push(
    compose.code === 0
      ? {
          id: 'compose',
          title: 'Docker Compose v2',
          status: 'pass',
          detail: `Compose ${compose.stdout.trim()}.`,
        }
      : {
          id: 'compose',
          title: 'Docker Compose v2',
          status: 'fail',
          detail: 'Compose v2 is required (`docker compose`, not `docker-compose`).',
        },
  )

  // -- resources ------------------------------------------------------------
  try {
    const stats = await statfs(dir)
    const freeGb = (stats.bavail * stats.bsize) / GB
    results.push(
      freeGb < DISK_FLOOR_GB
        ? {
            id: 'disk',
            title: 'Free disk',
            status: 'fail',
            detail: `${freeGb.toFixed(1)} GB free. Below ${DISK_FLOOR_GB} GB there is no room for the images, the database and a single backup.`,
          }
        : freeGb < DISK_COMFORT_GB
          ? {
              id: 'disk',
              title: 'Free disk',
              status: 'warn',
              detail: `${freeGb.toFixed(1)} GB free. Enough to install; backups and documents will consume it quickly.`,
            }
          : {
              id: 'disk',
              title: 'Free disk',
              status: 'pass',
              detail: `${freeGb.toFixed(1)} GB free.`,
            },
    )
  } catch {
    results.push({
      id: 'disk',
      title: 'Free disk',
      status: 'warn',
      detail: 'Could not measure free space.',
    })
  }

  const enabled = new Set(state.enabled)
  const wantedModules = CATALOGUE.filter((m) => m.required || enabled.has(m.id))
  const wantedGb = wantedModules.reduce((sum, m) => sum + parseMemoryGb(m.cost.memory), 0)
  const haveGb = totalmem() / GB
  results.push(
    haveGb < wantedGb
      ? {
          id: 'memory',
          title: 'Memory',
          status: 'warn',
          detail: `${haveGb.toFixed(1)} GB installed; the enabled services are limited to ${wantedGb.toFixed(1)} GB between them. Expect swapping under load.`,
        }
      : {
          id: 'memory',
          title: 'Memory',
          status: 'pass',
          detail: `${haveGb.toFixed(1)} GB installed for ${wantedGb.toFixed(1)} GB of limits.`,
        },
  )

  // -- network --------------------------------------------------------------
  if (daemon.code === 0) {
    results.push(await checkPort(state.settings.bindAddress, state.settings.appPort))
  }

  // -- registry, which doubles as the clock source --------------------------
  const auth = storedRegistryAuth(dir)
  if (!auth) {
    results.push({
      id: 'registry',
      title: 'Registry credential',
      status: 'fail',
      detail: 'No registry credential is set. The software cannot be downloaded without one.',
    })
  } else {
    const probe = await probeRegistry(auth)
    results.push({
      id: 'registry',
      title: 'Registry credential',
      status: probe.ok ? 'pass' : 'fail',
      detail: probe.detail,
    })

    if (probe.serverDate !== undefined) {
      const skew = Math.abs(Date.now() - probe.serverDate)
      results.push(
        skew > CLOCK_SKEW_WARN_MS
          ? {
              id: 'clock',
              title: 'Clock',
              status: 'warn',
              detail: `This box's clock is ${Math.round(skew / 60_000)} minutes off. Licence and session validity depend on it; fix NTP.`,
            }
          : { id: 'clock', title: 'Clock', status: 'pass', detail: 'In step with the registry.' },
      )
    }
  }

  // -- licence --------------------------------------------------------------
  const licence = await currentLicence(dir)
  results.push({
    id: 'licence',
    title: 'Licence',
    status: licence.standing === 'ok' || licence.standing === 'grace' ? 'pass' : 'fail',
    detail: licence.message,
  })

  // -- is this actually a fresh install? ------------------------------------
  if (daemon.code === 0) {
    const existing = await docker.volumes()
    const names = existing.stdout.trim().split('\n').filter(Boolean)
    if (names.some((name) => name.includes('postgres_data'))) {
      results.push({
        id: 'existing-data',
        title: 'Existing data',
        status: 'warn',
        detail:
          'A database volume from a previous installation exists. Deploying will start the system on that data — which is right for a re-install and wrong for a new firm. Be sure which this is.',
      })
    } else {
      results.push({
        id: 'existing-data',
        title: 'Existing data',
        status: 'pass',
        detail: 'No volumes from a previous installation.',
      })
    }
  }

  return results
}

/**
 * The port check asks the daemon, not the local network stack — the engine
 * runs inside a container, where binding a test socket answers a question
 * about the wrong namespace. (Found on the first real box: the engine's own
 * listener made the host port read as taken.) The daemon sees every
 * published port; what it cannot see is a host process outside Docker, and
 * the pass message says so instead of overclaiming.
 */
async function checkPort(address: string, port: number): Promise<CheckResult> {
  const listing = await docker.publishedPorts()
  if (listing.code !== 0) {
    return { id: 'port', title: 'Application port', status: 'warn', detail: 'Could not list published ports.' }
  }
  const needle = `:${port}->`
  const holder = listing.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .find(([, ports]) => ports?.includes(needle))

  if (!holder) {
    return {
      id: 'port',
      title: 'Application port',
      status: 'pass',
      detail: `${address}:${port} is not published by any container. A host process outside Docker would not show here.`,
    }
  }
  const [name] = holder
  const ours = name?.startsWith('qanoontech')
  return {
    id: 'port',
    title: 'Application port',
    status: ours ? 'pass' : 'fail',
    detail: ours
      ? `${address}:${port} is published by this deployment's own '${name}'.`
      : `${address}:${port} is already published by '${name}', which is not part of this deployment.`,
  }
}

function parseMemoryGb(limit: string): number {
  const match = limit.match(/^([\d.]+)([GM])$/i)
  if (!match) return 0
  const value = Number(match[1])
  return match[2]!.toUpperCase() === 'G' ? value : value / 1024
}

export function preflightBlocked(results: readonly CheckResult[]): boolean {
  return results.some((r) => r.status === 'fail')
}
