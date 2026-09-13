import { backupHealth, type BackupHealth } from '../backup/health.js'
import { offsiteClient } from '../backup/offsite.js'
import { newestBackupAt } from '../backup/service.js'
import { RECOVERY_PASSPHRASE, readSnapshotMarker } from '../backup/snapshot.js'
import { databaseTarget } from '../backup/target.js'
import { buildPlan } from '../plan.js'
import { storedRegistryAuth } from '../registry.js'
import { listServices, runningVersion, type ServiceView } from '../services.js'
import { loadSecrets, loadState, stateDir } from '../state/store.js'

/**
 * Is this deployment safe right now — one answer, computed from the things
 * themselves, shared by the panel's overview and `engine status`.
 *
 * The panel used to say "All services healthy" and mean it: the sentence was
 * derived from `docker compose ps` and nothing else, while backups had stopped
 * for three days and offsite had failed for ten. Every screen was green
 * because every screen was asking a different, narrower question. This asks
 * the one question the operator has — *is the firm's data safe?* — and it
 * asks it of the disk and of Docker at request time, never of a stored
 * conclusion, because a record trusted over the thing it describes is the
 * shape of every bug this programme has found.
 *
 * `assessDeployment` is pure over its inputs and tested like `assessBackups`;
 * `readDeployment` gathers those inputs off the box.
 */

export type Verdict = 'protected' | 'attention' | 'risk'

/** Where a finding points: the page that fixes it. The panel maps this to a route. */
export type Area =
  | 'services'
  | 'deploy'
  | 'backups'
  | 'offsite'
  | 'recovery'
  | 'sign-in'
  | 'database'
  | 'registry'

export interface Finding {
  readonly level: 'warn' | 'risk'
  readonly area: Area
  readonly title: string
  readonly detail: string
}

export interface DeploymentInput {
  readonly now: number
  readonly configuredVersion: string
  readonly runningVersion: string | undefined
  readonly services: readonly ServiceView[]
  readonly dockerError: string | undefined
  readonly plan: { deployable: true; services: number } | { deployable: false; problems: string[] }
  readonly backups: BackupHealth
  readonly intervalMinutes: number
  readonly newestBackupAt: number | undefined
  readonly offsite: {
    readonly enabled: boolean
    /** A client could be built: bucket, endpoint and keys are all present. */
    readonly ready: boolean
    readonly reason: string | undefined
    readonly label: string | undefined
  }
  readonly recovery: {
    readonly passphraseSet: boolean
    readonly lastCopiedAt: string | undefined
    readonly verifiedAt: string | undefined
  }
  readonly signIn: {
    readonly redirectUri: string
    readonly clientSecretSet: boolean
    readonly allowed: number
  }
  readonly registryConfigured: boolean
  readonly database: {
    readonly external: boolean
    readonly host: string
    readonly port: number
    readonly reachable: boolean | undefined
    readonly server: string | undefined
  }
}

export interface Assessment {
  readonly verdict: Verdict
  readonly findings: readonly Finding[]
  readonly plan: DeploymentInput['plan']
  readonly application: {
    readonly running: string | undefined
    readonly configured: string
    /** Configured and running differ: a version chosen and not yet deployed. */
    readonly drift: boolean
  }
  readonly backups: {
    readonly level: BackupHealth['level']
    readonly detail: string
    readonly newestAt: string | undefined
    readonly nextDueAt: string | undefined
    readonly sets: number
    readonly offsitePending: number | undefined
  }
  readonly offsite: DeploymentInput['offsite']
  readonly recovery: DeploymentInput['recovery']
  readonly signIn: DeploymentInput['signIn']
  readonly database: DeploymentInput['database']
}

const iso = (ms: number | undefined): string | undefined =>
  ms === undefined || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString()

export function assessDeployment(input: DeploymentInput): Assessment {
  const findings: Finding[] = []
  const risk = (area: Area, title: string, detail: string) => findings.push({ level: 'risk', area, title, detail })
  const warn = (area: Area, title: string, detail: string) => findings.push({ level: 'warn', area, title, detail })

  // -- the application ------------------------------------------------------
  if (input.dockerError) {
    risk('services', 'Docker did not answer', input.dockerError)
  } else {
    for (const service of input.services) {
      if (!service.required) {
        // Optional and present: it should be well. Optional and absent: it is off.
        if (service.state === 'running' && service.health === 'unhealthy') {
          warn('services', `${service.title} is unhealthy`, service.status || 'The container reports unhealthy.')
        } else if (service.state !== 'running' && service.state !== 'absent' && service.state !== 'external') {
          warn('services', `${service.title} is ${service.state}`, service.status || '')
        }
        continue
      }
      if (service.state === 'external') {
        if (service.external && !service.external.reachable) {
          risk('database', 'The database is not answering', service.external.detail)
        }
        continue
      }
      if (service.state !== 'running') {
        risk('services', `${service.title} is ${service.state === 'absent' ? 'not running' : service.state}`, service.status || 'A required service is not running.')
      } else if (service.health === 'unhealthy') {
        risk('services', `${service.title} is unhealthy`, service.status || 'The container reports unhealthy.')
      }
    }
  }
  if (!input.plan.deployable) {
    risk('deploy', 'The deployment cannot be rendered', input.plan.problems.join(' '))
  }
  const drift =
    input.runningVersion !== undefined &&
    input.configuredVersion !== 'latest' &&
    input.runningVersion !== input.configuredVersion
  if (drift) {
    warn(
      'deploy',
      `${input.configuredVersion} is configured but ${input.runningVersion} is running`,
      'Deploy to apply the configured version, or set the running one back.',
    )
  }
  if (!input.registryConfigured) {
    warn('registry', 'No registry credential', 'Images cannot be downloaded until one is stored.')
  }

  // -- backups --------------------------------------------------------------
  if (input.backups.level === 'stale' || input.backups.level === 'none') {
    risk('backups', 'Backups have stopped', input.backups.detail)
  } else if (input.backups.level === 'warn') {
    warn('backups', 'Backups are late', input.backups.detail)
  }

  // -- offsite --------------------------------------------------------------
  if (!input.offsite.enabled) {
    risk('offsite', 'No offsite copy', 'Every backup is on this box only. A stolen or dead box loses all of them.')
  } else if (!input.offsite.ready) {
    risk('offsite', 'Offsite storage is not usable', input.offsite.reason ?? 'The bucket or its credentials are not set.')
  }

  // -- recovery -------------------------------------------------------------
  if (!input.recovery.passphraseSet) {
    warn(
      'recovery',
      'No recovery passphrase',
      'The engine’s own state is not being copied offsite; a dead box would need its settings and credentials re-entered by hand.',
    )
  } else if (input.offsite.enabled && input.offsite.ready && !input.recovery.lastCopiedAt) {
    warn('recovery', 'Engine state not yet copied', 'The first snapshot goes on the next tick.')
  }

  // -- sign-in --------------------------------------------------------------
  if (!input.signIn.clientSecretSet) {
    warn('sign-in', 'No Entra client secret', 'The panel cannot be signed in to; set one from the shell.')
  }
  if (!input.signIn.redirectUri) {
    warn('sign-in', 'Sign-in is not pinned to a hostname', 'Set the redirect URI so the panel answers only at its own address.')
  }
  if (input.signIn.allowed === 0) {
    warn('sign-in', 'Nobody is allowed to sign in', 'The allow-list is empty.')
  }

  const verdict: Verdict = findings.some((f) => f.level === 'risk')
    ? 'risk'
    : findings.length > 0
      ? 'attention'
      : 'protected'

  const nextDue =
    input.newestBackupAt === undefined || !Number.isFinite(input.newestBackupAt)
      ? input.now
      : input.newestBackupAt + input.intervalMinutes * 60_000

  return {
    verdict,
    findings,
    plan: input.plan,
    application: { running: input.runningVersion, configured: input.configuredVersion, drift },
    backups: {
      level: input.backups.level,
      detail: input.backups.detail,
      newestAt: iso(input.newestBackupAt),
      nextDueAt: iso(nextDue),
      sets: input.backups.sets,
      offsitePending: input.backups.offsitePending,
    },
    offsite: input.offsite,
    recovery: input.recovery,
    signIn: input.signIn,
    database: input.database,
  }
}

/**
 * Gather the inputs off the box. `services` may be passed in when the caller
 * has just listed them, so the overview does not ask Docker twice.
 */
export async function readDeployment(
  dir = stateDir(),
  prefetched?: { services: ServiceView[]; dockerError?: string | undefined },
  now = Date.now(),
): Promise<Assessment> {
  const state = loadState(dir)
  const secrets = loadSecrets(dir)
  const [plan, listed] = await Promise.all([buildPlan(dir), prefetched ?? listServices(dir)])
  const offsite = offsiteClient(dir)
  const marker = readSnapshotMarker(dir)
  const target = databaseTarget(dir)
  const external = listed.services.find((service) => service.id === 'postgres')?.external

  return assessDeployment({
    now,
    configuredVersion: state.version,
    runningVersion: runningVersion(listed.services),
    services: listed.services,
    dockerError: listed.dockerError,
    plan: plan.ok
      ? { deployable: true, services: plan.moduleIds.length }
      : { deployable: false, problems: [...plan.problems] },
    backups: backupHealth(dir, now),
    intervalMinutes: state.settings.backupIntervalMinutes,
    newestBackupAt: newestBackupAt(dir),
    offsite: {
      enabled: state.settings.backupOffsiteEnabled,
      ready: offsite.client !== null,
      reason: offsite.client === null && offsite.reason !== 'off' ? offsite.reason : undefined,
      label: offsite.client?.label,
    },
    recovery: {
      passphraseSet: Boolean(secrets[RECOVERY_PASSPHRASE]),
      lastCopiedAt: marker.uploadedAt,
      verifiedAt: marker.verifiedAt,
    },
    signIn: {
      redirectUri: state.settings.entraRedirectUri,
      clientSecretSet: Boolean(secrets['ENTRA_CLIENT_SECRET']),
      allowed: state.settings.entraAllowedObjectIds.length,
    },
    registryConfigured: storedRegistryAuth(dir) !== undefined,
    database: target.ok
      ? {
          external: target.target.external,
          host: target.target.host,
          port: target.target.port,
          reachable: external?.reachable,
          server: external?.server,
        }
      : { external: false, host: '', port: 0, reachable: undefined, server: undefined },
  })
}
