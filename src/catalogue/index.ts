import type { AnyModule } from './types.js'
import { app } from './modules/app.js'
import { driveMirror } from './modules/drive-mirror.js'
import { nginx } from './modules/nginx.js'
import { ocr } from './modules/ocr.js'
import { postgres } from './modules/postgres.js'
import { tunnel } from './modules/tunnel.js'

export * from './types.js'

/**
 * The catalogue. Closed, fixed, versioned with the engine.
 *
 * A new module ships with an engine release, which is what makes "every
 * combination a firm can enable is one we have actually run" a true statement
 * rather than a hope. Nothing outside this list can be deployed.
 */
export const CATALOGUE: readonly AnyModule[] = [
  postgres,
  app,
  nginx,
  ocr,
  driveMirror,
  tunnel,
]

export function findModule(id: string): AnyModule | undefined {
  return CATALOGUE.find((m) => m.id === id)
}

export const REQUIRED_MODULE_IDS: readonly string[] = CATALOGUE.filter((m) => m.required).map(
  (m) => m.id,
)

export interface Problem {
  readonly moduleId?: string
  readonly code:
    | 'unknown-module'
    | 'required-disabled'
    | 'missing-entitlement'
    | 'missing-dependency'
    | 'invalid-config'
    | 'dependency-cycle'
  readonly message: string
}

export interface ResolvedModule {
  readonly module: AnyModule
  /** Validated, defaults applied. `undefined` for modules taking no config. */
  readonly config: unknown
}

export type Resolution =
  | { readonly ok: true; readonly modules: readonly ResolvedModule[] }
  | { readonly ok: false; readonly problems: readonly Problem[] }

export interface ResolveInput {
  /** Module ids the operator has turned on. Required ones may be omitted. */
  readonly enabled: readonly string[]
  /** Configuration per module id, as stored. Validated here, not before. */
  readonly config: Readonly<Record<string, unknown>>
  /** Entitlements from the licence. An optional module needs its own. */
  readonly entitlements: readonly string[]
}

/**
 * Turn what the operator asked for into what may actually be deployed, or the
 * complete list of reasons it may not.
 *
 * Every reason is collected rather than thrown on the first: an operator fixing
 * a deployment one error at a time, each requiring a round trip, is how a short
 * job becomes an afternoon.
 */
export function resolve(input: ResolveInput): Resolution {
  const problems: Problem[] = []

  for (const id of input.enabled) {
    if (!findModule(id)) {
      problems.push({
        moduleId: id,
        code: 'unknown-module',
        message: `No module named '${id}'. The catalogue is closed; nothing outside it can be deployed.`,
      })
    }
  }

  // Required modules are the system. Asking for them is redundant, and asking
  // for them to be absent is not a configuration, it is a broken deployment.
  const wanted = new Set(input.enabled.filter((id) => findModule(id)))
  for (const id of REQUIRED_MODULE_IDS) wanted.add(id)

  const entitlements = new Set(input.entitlements)
  const selected: AnyModule[] = []

  for (const module of CATALOGUE) {
    if (!wanted.has(module.id)) continue

    if (module.entitlement && !entitlements.has(module.entitlement)) {
      problems.push({
        moduleId: module.id,
        code: 'missing-entitlement',
        message: `'${module.title}' needs the entitlement '${module.entitlement}', which this licence does not carry.`,
      })
      continue
    }

    selected.push(module)
  }

  const selectedIds = new Set(selected.map((m) => m.id))

  for (const module of selected) {
    for (const dependency of module.requires) {
      if (!selectedIds.has(dependency)) {
        const known = findModule(dependency)
        problems.push({
          moduleId: module.id,
          code: 'missing-dependency',
          message: known
            ? `'${module.title}' needs '${known.title}', which is not enabled.`
            : `'${module.title}' declares a dependency on '${dependency}', which is not in the catalogue.`,
        })
      }
    }

    const supplied = input.config[module.id]
    const parsed = module.config.safeParse(supplied)
    if (!parsed.success) {
      // "expected object, received undefined" is true and useless. A module
      // turned on but never configured is a different situation from one
      // configured wrongly, and the operator needs to be told which.
      if (supplied === undefined) {
        problems.push({
          moduleId: module.id,
          code: 'invalid-config',
          message: `'${module.title}' has not been configured, and needs to be before it can be deployed.`,
        })
        continue
      }
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.')
        problems.push({
          moduleId: module.id,
          code: 'invalid-config',
          message: `'${module.title}' configuration${path ? ` (${path})` : ''}: ${issue.message}`,
        })
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems }

  const ordered = orderByDependency(selected)
  if (!ordered) {
    return {
      ok: false,
      problems: [
        {
          code: 'dependency-cycle',
          message:
            'Modules declare a dependency cycle. This is a bug in the catalogue, not in the deployment.',
        },
      ],
    }
  }

  return {
    ok: true,
    modules: ordered.map((module) => ({
      module,
      config: module.config.parse(input.config[module.id]),
    })),
  }
}

/**
 * Dependencies before dependants, so the rendered file reads in the order
 * things start. Compose does its own ordering from `depends_on`; this is for
 * the human reading the diff.
 *
 * Returns undefined on a cycle rather than looping.
 */
function orderByDependency(modules: readonly AnyModule[]): AnyModule[] | undefined {
  const byId = new Map(modules.map((m) => [m.id, m]))
  const ordered: AnyModule[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (module: AnyModule): boolean => {
    const seen = state.get(module.id)
    if (seen === 'done') return true
    if (seen === 'visiting') return false

    state.set(module.id, 'visiting')
    for (const id of module.requires) {
      const dependency = byId.get(id)
      if (dependency && !visit(dependency)) return false
    }
    state.set(module.id, 'done')
    ordered.push(module)
    return true
  }

  for (const module of modules) {
    if (!visit(module)) return undefined
  }
  return ordered
}
