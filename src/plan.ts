import { writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolve as resolveCatalogue, type Problem } from './catalogue/index.js'
import { composeFilePath } from './docker/index.js'
import { currentEntitlements } from './licence/index.js'
import { render, type RenderProblem } from './render/compose.js'
import { loadSecrets, loadState, stateDir } from './state/store.js'

/**
 * State on disk becomes a compose file, or the reasons it cannot.
 *
 * The two halves are kept apart on purpose. Resolution answers "may this be
 * deployed" — dependencies, entitlements, configuration. Rendering answers
 * "what does it look like" and can still refuse, but only over things
 * resolution cannot see, like a missing secret. Neither decides what the other
 * decides.
 */

export type PlanResult =
  | { readonly ok: true; readonly yaml: string; readonly moduleIds: readonly string[] }
  | { readonly ok: false; readonly problems: readonly string[] }

export async function buildPlan(dir = stateDir()): Promise<PlanResult> {
  const state = loadState(dir)
  const secrets = loadSecrets(dir)

  const licence = await currentEntitlements(dir)
  if (!licence.ok) {
    return { ok: false, problems: [licence.problem] }
  }

  const resolution = resolveCatalogue({
    enabled: state.enabled,
    config: state.config,
    entitlements: licence.entitlements,
  })

  if (!resolution.ok) {
    return { ok: false, problems: resolution.problems.map(describeProblem) }
  }

  const rendered = render({
    modules: resolution.modules,
    version: state.version,
    settings: state.settings,
    secrets,
  })

  if (!rendered.ok) {
    return { ok: false, problems: rendered.problems.map(describeRenderProblem) }
  }

  return {
    ok: true,
    yaml: rendered.yaml,
    moduleIds: resolution.modules.map((m) => m.module.id),
  }
}

/**
 * Write the compose file.
 *
 * The file is the deployment's own explanation of itself, so it is written
 * before anything is asked to run it and left there afterwards — including
 * when the engine later stops.
 */
export function writePlan(yaml: string, dir = stateDir()): string {
  const path = composeFilePath(dir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, yaml, { mode: 0o600 })
  return path
}

function describeProblem(problem: Problem): string {
  return problem.message
}

function describeRenderProblem(problem: RenderProblem): string {
  return problem.message
}
