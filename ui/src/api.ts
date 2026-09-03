/** The API client. Same-origin, cookie-authenticated, no state of its own. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
    credentials: 'same-origin',
  })
  const json = (await response.json().catch(() => ({}))) as {
    success?: boolean
    data?: T
    error?: string
  }
  if (!response.ok || json.success !== true) {
    throw new ApiError(response.status, json.error ?? `Request failed (${response.status})`)
  }
  return json.data as T
}

export const api = {
  get: <T>(url: string) => call<T>('GET', url),
  post: <T>(url: string, body?: unknown) => call<T>('POST', url, body),
  put: <T>(url: string, body?: unknown) => call<T>('PUT', url, body),
  delete: <T>(url: string) => call<T>('DELETE', url),
}

// -- shapes the server sends ------------------------------------------------

export interface ServiceView {
  id: string
  title: string
  summary: string
  required: boolean
  state: string
  health: string
  status: string
  image: string
}

export interface AuditEntry {
  at: string
  event: string
  detail?: string
  address?: string
}

export interface Overview {
  engineVersion: string
  version: string
  previousVersion: string | null
  bindAddress: string
  appPort: number
  modulesOn: string[]
  plan: { deployable: true; services: number } | { deployable: false; problems: string[] }
  services: ServiceView[]
  dockerError?: string
  audit: AuditEntry[]
}

export interface LicenceInfo {
  standing: 'ok' | 'grace' | 'enforce' | 'missing' | 'invalid'
  message: string
  problem: string | null
  graceUsedDays: number | null
  graceDays: number | null
  enforced: boolean
  claims: {
    firmName: string
    licenceId: string
    expiresAt: string
    entitlements: string[]
    seats: number
    override: boolean
  } | null
  heartbeat: { lastSuccessAt: number | null; lastError: string | null }
}

export interface PreflightCheck {
  id: string
  title: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

export interface DeployStatus {
  running: boolean
  step: string
  ok: boolean | null
  log: string
  startedAt: number
}

export interface ModuleInfo {
  id: string
  title: string
  summary: string
  required: boolean
  cost: { image: string; memory: string; cpus: string }
}

export interface BackupSet {
  id: string
  takenAt: string
  trigger: string
  appVersion: string
  includesUploads: boolean
  databaseBytes: number
  uploadsBytes: number
  offsite: { uploadedAt: string; attempts: number; lastError: string }
}

export interface OffsiteConfig {
  enabled: boolean
  driveId: string
  ready: boolean
  reason: string | null
}

export interface RemoteSet {
  name: string
  files: number
  bytes: number
  local: boolean
}

export interface RestoreResult {
  ok: boolean
  steps: { step: string; ok: boolean; detail?: string }[]
}
