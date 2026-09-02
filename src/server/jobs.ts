import * as docker from '../docker/index.js'
import { buildPlan, writePlan } from '../plan.js'
import { loadState, saveState, type EngineState } from '../state/store.js'

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
  step: 'render' | 'validate' | 'pull' | 'apply' | 'done'
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
    const job: DeployJob = { startedAt: Date.now(), log: '', step: 'render' }
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
      const pulled = await docker.pull({ composeFile: path, onOutput })
      if (pulled.code !== 0) {
        this.append(job, '\nDownload failed. Nothing running has been touched.\n')
        this.finish(job, false)
        return
      }

      // NOTE(phase 5): the design takes a backup here, between pull and
      // apply. The backup machinery does not exist yet; when it does, it
      // slots in at this line and a failed backup aborts like a failed pull.
      job.step = 'apply'
      this.append(job, '\n── Applying ──\n')
      const applied = await docker.apply({ composeFile: path, onOutput })
      this.finish(job, applied.code === 0)
    } catch (error) {
      this.append(job, `\n${error instanceof Error ? error.message : String(error)}\n`)
      this.finish(job, false)
    }
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
