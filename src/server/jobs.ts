import { listBackups, takeBackup } from '../backup/service.js'
import * as docker from '../docker/index.js'
import { pullImages, type ImageProgress } from '../docker/pull.js'
import { buildPlan, writePlan } from '../plan.js'
import { REGISTRY, storedRegistryAuth } from '../registry.js'
import {
  ensureGeneratedSecrets,
  loadSecrets,
  loadState,
  saveSecrets,
  saveState,
  type EngineState,
} from '../state/store.js'

/**
 * The deploy job: render → validate → pull → apply, one at a time, watchable.
 *
 * One at a time is a rule, not a limitation — two concurrent applies against
 * one compose project is a race with the firm's uptime as the stake. The log
 * is held in memory and polled: a deploy is minutes long and its transcript
 * matters until the next one, not after a restart. What happened durably —
 * the version change — is in the state file and the audit log.
 */

export interface DeployJob {
  readonly startedAt: number
  finishedAt?: number
  ok?: boolean
  log: string
  /** What the deploy is doing now, for a one-line status. */
  step: 'render' | 'validate' | 'pull' | 'backup' | 'apply' | 'done'
  /** The version being deployed, so the UI can say "running X, deploying Y". */
  targetVersion: string
  /** Per-image download state during the pull step. */
  images: ImageProgress[]
}

export class JobRunner {
  private job: DeployJob | undefined

  constructor(private readonly dir: string) {}

  current(): DeployJob | undefined {
    return this.job
  }

  isRunning(): boolean {
    return this.job !== undefined && this.job.finishedAt === undefined
  }

  /** Start a deploy. Returns false if one is already running. */
  startDeploy(): boolean {
    if (this.isRunning()) return false
    const job: DeployJob = {
      startedAt: Date.now(),
      log: '',
      step: 'render',
      targetVersion: loadState(this.dir).version,
      images: [],
    }
    this.job = job
    void this.run(job)
    return true
  }

  private append(job: DeployJob, text: string): void {
    // Bounded: a runaway pull cannot grow the process without limit.
    job.log = (job.log + text).slice(-200_000)
  }

  private async run(job: DeployJob): Promise<void> {
    const onOutput = (chunk: string) => this.append(job, chunk)
    try {
      // Nobody types the generated secrets, so nothing should have to ask for
      // them either: the first deploy creates whichever are missing. Existing
      // values are never touched — regenerating DB_PASSWORD orphans a
      // database. (Found on the first real box: the browser flow had no step
      // that generated them, because only the CLI ever had.)
      const { secrets, created } = ensureGeneratedSecrets(loadSecrets(this.dir))
      if (created.length > 0) {
        saveSecrets(secrets, this.dir)
        this.append(job, `Generated: ${created.join(', ')}. Values are not shown.\n`)
      }

      this.append(job, '── Rendering ──\n')
      const plan = await buildPlan(this.dir)
      if (!plan.ok) {
        this.append(job, plan.problems.map((p) => `✗ ${p}\n`).join(''))
        this.finish(job, false)
        return
      }
      const path = writePlan(plan.yaml, this.dir)
      this.append(job, `Wrote ${path} — ${plan.moduleIds.length} services.\n`)

      job.step = 'validate'
      const valid = await docker.validate({ composeFile: path })
      if (valid.code !== 0) {
        this.append(job, `Docker refused the generated file (an engine bug, not your configuration):\n${valid.stderr}`)
        this.finish(job, false)
        return
      }

      // Pull before anything running is touched: a download that fails has
      // changed nothing, which is what makes an update safe to attempt.
      job.step = 'pull'
      this.append(job, '\n── Downloading images ──\n')

      const imagesResult = await docker.plannedImages({ composeFile: path })
      const images = imagesResult.stdout.split('\n').map((l) => l.trim()).filter(Boolean)

      const auth = storedRegistryAuth(this.dir)
      // Log the daemon in as well as authenticating the resilient pull: the
      // pull streams its own credential over the API, but the apply step runs
      // `docker compose up`, and compose's registry checks use the daemon's
      // stored login — without this, apply fails `unauthorized` even though
      // every image is already present. (Found on the staging box; .18 only
      // worked because a manual login was left behind while debugging.)
      if (auth) await docker.login(REGISTRY, auth.username, auth.token)
      // Pull one image at a time, resuming through stalls. On a firm's weak
      // connection a large layer freezes without erroring; the resilient
      // puller watches bytes, not the log, and retries from the partial blob.
      job.images = images.map((image) => ({
        image,
        state: 'waiting' as const,
        downloaded: 0,
        total: 0,
        percent: -1,
        attempt: 0,
        detail: '',
      }))
      const pulled = await pullImages(images, {
        ...(auth ? { auth } : {}),
        onProgress: (p) => {
          const i = job.images.findIndex((x) => x.image === p.image)
          if (i >= 0) job.images[i] = p
          if (p.state === 'stalled') this.append(job, `${p.image}: stalled, retrying…\n`)
          if (p.state === 'done') this.append(job, `${p.image}: done\n`)
        },
      })
      if (!pulled.ok) {
        const failed = pulled.images.find((i) => i.state === 'failed')
        this.append(job, `\nDownload failed${failed ? ` on ${failed.image}` : ''}. Nothing running has been touched.\n`)
        this.finish(job, false)
        return
      }

      // Between pull and apply: the backup that makes a rollback possible.
      // A failed backup aborts exactly like a failed pull — nothing running
      // has been touched — with one exception: the very first deploy, where
      // there is no database yet and nothing to protect.
      if (listBackups(this.dir).length > 0 || (await this.databaseExists())) {
        job.step = 'backup'
        this.append(job, '\n── Backup before touching anything ──\n')
        const backup = await takeBackup('pre-update', this.dir)
        this.append(job, backup.detail + '\n')
        if (!backup.ok) {
          this.append(job, 'Deploy stopped. Nothing running has been touched.\n')
          this.finish(job, false)
          return
        }
      }

      job.step = 'apply'
      this.append(job, '\n── Applying ──\n')
      const applied = await docker.apply({ composeFile: path, onOutput })
      this.finish(job, applied.code === 0)
    } catch (error) {
      this.append(job, `\n${error instanceof Error ? error.message : String(error)}\n`)
      this.finish(job, false)
    }
  }

  /** Is there a running postgres to dump? First deploys have none. */
  private async databaseExists(): Promise<boolean> {
    const result = await docker.ps()
    return result.code === 0 && result.stdout.includes('postgres')
  }

  private finish(job: DeployJob, ok: boolean): void {
    job.finishedAt = Date.now()
    job.ok = ok
    job.step = 'done'
    this.append(job, ok ? '\n✓ Deployed.\n' : '\n✗ Failed.\n')
  }
}

/** Version bookkeeping shared by update and rollback. */
export function setVersion(version: string, dir: string): EngineState {
  const state = loadState(dir)
  if (state.version === version) return state
  const next = { ...state, previousVersion: state.version, version }
  saveState(next, dir)
  return next
}

export function rollbackVersion(dir: string): { ok: boolean; version?: string; detail: string } {
  const state = loadState(dir)
  if (!state.previousVersion) {
    return { ok: false, detail: 'There is no previous version recorded to roll back to.' }
  }
  const target = state.previousVersion
  saveState({ ...state, previousVersion: state.version, version: target }, dir)
  return {
    ok: true,
    version: target,
    detail: `Rolled the configured version back to ${target}. The application migrates its database forward on start, so an older version may refuse a newer database — that is what the pre-update backup is for.`,
  }
}
