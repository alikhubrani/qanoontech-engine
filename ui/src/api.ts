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

export interface ExternalDatabase {
  host: string
  port: number
  server: string | undefined
  reachable: boolean
  detail: string
}

export interface ServiceView {
  id: string
  title: string
  summary: string
  required: boolean
  /** docker's state, 'absent' with no container, 'external' for a database elsewhere. */
  state: string
  health: string
  status: string
  image: string
  external?: ExternalDatabase
}

export type AuditKind = 'security' | 'change' | 'failure' | 'routine'

export interface AuditEntry {
  at: string
  event: string
  detail?: string
  address?: string
  subject?: string
  label: string
  kind: AuditKind
}

export interface Operator {
  oid: string
  upn: string
  name: string
}

export type Verdict = 'protected' | 'attention' | 'risk'

export interface Finding {
  level: 'warn' | 'risk'
  area: string
  title: string
  detail: string
}

export interface Assessment {
  verdict: Verdict
  findings: Finding[]
  plan: { deployable: true; services: number } | { deployable: false; problems: string[] }
  application: { running: string | undefined; configured: string; drift: boolean }
  backups: {
    level: 'ok' | 'warn' | 'stale' | 'none'
    detail: string
    newestAt: string | undefined
    nextDueAt: string | undefined
    sets: number
    offsitePending: number | undefined
  }
  offsite: { enabled: boolean; ready: boolean; reason: string | undefined; label: string | undefined }
  recovery: { passphraseSet: boolean; lastCopiedAt: string | undefined; verifiedAt: string | undefined }
  signIn: { redirectUri: string; clientSecretSet: boolean; allowed: number }
  database: {
    external: boolean
    host: string
    port: number
    reachable: boolean | undefined
    server: string | undefined
  }
}

export interface Overview {
  engineVersion: string
  version: string
  previousVersion: string | null
  runningVersion: string | null
  bindAddress: string
  appPort: number
  timezone: string
  modulesOn: string[]
  plan: { deployable: true; services: number } | { deployable: false; problems: string[] }
  services: ServiceView[]
  dockerError?: string
  assessment: Assessment
  operator: Operator | null
  audit: AuditEntry[]
}

export interface PreflightCheck {
  id: string
  title: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

export interface ImageProgress {
  image: string
  state: 'waiting' | 'downloading' | 'extracting' | 'stalled' | 'done' | 'failed'
  downloaded: number
  total: number
  percent: number
  attempt: number
  detail: string
}

export interface DeployStatus {
  running: boolean
  step: string
  ok: boolean | null
  log: string
  startedAt: number
  targetVersion?: string
  images?: ImageProgress[]
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
  ready: boolean
  reason: string | null
}

export interface RemoteSet {
  name: string
  files: number
  bytes: number
  local: boolean
}

export interface RemoteListing {
  sets: RemoteSet[]
  detail?: string
  documents: { files: number; bytes: number } | null
}

export interface OffsiteStatus {
  enabled: boolean
  endpoint: string
  bucket: string
  region: string
  prefix: string
  keys: { accessKeyId: boolean; secretAccessKey: boolean }
  ready: boolean
  reason: string | null
  label: string | null
  sets: number
  pending: number
  oldestPending: string | null
}

export interface ProbeResult {
  ok: boolean
  steps: { step: 'write' | 'stat' | 'read' | 'remove'; ok: boolean; detail: string }[]
}

export interface DrillResult {
  ok: boolean
  id?: string
  restoreMs?: number
  tables?: number
  rows?: Record<string, number>
  detail: string
  at?: string
}

export interface RecoveryStatus {
  passphraseSet: boolean
  snapshot: {
    uploadedAt: string | null
    verifiedAt: string | null
    inStore: boolean | null
    bytes: number | null
    key: string
  }
  store: { label: string } | null
  lastDrill: DrillResult | null
}

export interface RestoreResult {
  ok: boolean
  steps: { step: string; ok: boolean; detail?: string }[]
}
