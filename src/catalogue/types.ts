import type { z } from 'zod'

/**
 * A module is one service in a deployment. Required modules are the system
 * itself; optional ones are what a firm turns on, off by default because the
 * resource cost is real and a feature nobody has committed to should not be
 * costing them 2 GB.
 *
 * Every module is declared here, once. Nothing else may define one: a second
 * place that says what a module is, is a second place that can disagree.
 */

/**
 * Where the image comes from.
 *
 * `versioned` follows the deployment's QanoonTech version, so the whole system
 * moves together when a version changes. `pinned` does not, and the distinction
 * matters more than it looks: Postgres is pinned to a major on purpose, because
 * a major-version jump leaves a data directory the new binary refuses to open
 * and the firm meets it as an outage.
 */
export type ImageSource =
  | { readonly kind: 'versioned'; readonly repository: string }
  | { readonly kind: 'pinned'; readonly reference: string }

/**
 * What enabling this costs, in the words the operator needs to decide. Shown
 * next to the toggle, not buried in documentation — the whole point of an
 * optional module is that someone is choosing to spend this.
 */
export interface ResourceCost {
  /** Roughly what the download and disk footprint is, e.g. '~2 GB'. */
  readonly image: string
  /** Compose memory limit, e.g. '2G'. */
  readonly memory: string
  /** Compose CPU limit, e.g. '2'. */
  readonly cpus: string
}

export interface HealthCheck {
  readonly test: readonly string[]
  readonly interval?: string
  readonly timeout?: string
  readonly retries?: number
  readonly startPeriod?: string
}

export interface VolumeMount {
  /** Named volume; declared at the top level of the generated compose file. */
  readonly volume: string
  readonly path: string
  readonly readOnly?: boolean
}

export interface PortBinding {
  /** Host address. Never 0.0.0.0 by default — see the renderer. */
  readonly host: string
  readonly hostPort: number
  readonly containerPort: number
}

/**
 * A rendered service. A narrow subset of the compose schema on purpose: the
 * renderer can only emit what this allows, so a module cannot smuggle in a
 * bind mount of the host root by returning a richer object.
 */
export interface RenderedService {
  readonly image: string
  readonly restart: 'unless-stopped' | 'no'
  readonly environment?: Readonly<Record<string, string>>
  readonly volumes?: readonly VolumeMount[]
  readonly ports?: readonly PortBinding[]
  readonly command?: readonly string[]
  readonly healthcheck?: HealthCheck
  /** Host networking, for the tunnel alone. See the tunnel module for why. */
  readonly hostNetwork?: boolean
}

/** What a module's `render` is given. It gets no more than this. */
export interface RenderContext<TConfig> {
  /** The QanoonTech version this deployment is on. */
  readonly version: string
  /** Deployment-wide settings: addresses, ports, locale, limits. */
  readonly settings: DeploymentSettings
  /** This module's own validated configuration. */
  readonly config: TConfig
  /** A secret by name, from the engine's own store. Throws if absent. */
  readonly secret: (name: string) => string
  /** Whether another module is enabled. For wiring, never for gating. */
  readonly isEnabled: (moduleId: string) => boolean
}

export interface DeploymentSettings {
  /** Address nginx and the engine bind to. Never 0.0.0.0 — see renderer. */
  readonly bindAddress: string
  readonly appPort: number
  readonly dbName: string
  readonly dbUser: string
  readonly timezone: string
  readonly defaultLanguage: 'ar' | 'en'
  readonly logLevel: 'error' | 'warn' | 'info' | 'debug'
  readonly maxFileSizeBytes: number
}

export interface ModuleDefinition<TConfig = void> {
  readonly id: string
  readonly title: string
  /** One line, shown next to the toggle. */
  readonly summary: string

  /**
   * Required modules are the system. They cannot be disabled, and the renderer
   * refuses a state that tries.
   */
  readonly required: boolean
  readonly defaultEnabled: boolean

  /**
   * Licence entitlement that must be present to enable this. Required modules
   * carry none — a licensed deployment is entitled to the system itself, and
   * the licence gates what is *added* to it.
   */
  readonly entitlement?: string

  readonly image: ImageSource
  readonly cost: ResourceCost

  /** Module ids that must be enabled for this one to run. */
  readonly requires: readonly string[]

  /**
   * Configuration schema. Validated before the module can start — a module
   * that cannot describe its own configuration cannot be shipped.
   */
  readonly config: z.ZodType<TConfig>

  /** Named volumes this module needs declared. */
  readonly volumes: readonly string[]

  readonly render: (ctx: RenderContext<TConfig>) => RenderedService
}

/**
 * Modules are stored together despite differing config types. The cast is
 * contained here rather than spread across the catalogue, and it is sound
 * because a module's `config` and its `render` are declared together and are
 * never separated afterwards.
 */
export type AnyModule = ModuleDefinition<never>

export function defineModule<TConfig>(m: ModuleDefinition<TConfig>): AnyModule {
  return m as unknown as AnyModule
}
