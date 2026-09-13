import type { AuditKind, ServiceView, Verdict } from '../api'

/**
 * Where a state becomes a colour, and nowhere else.
 *
 * The application keeps this rule in lib/status-tones.ts and the panel keeps
 * it here: a component holding its own colour map is a bug, because the tree
 * ends up with several that disagree. The six tones are the Pill's variants,
 * so a call site is `<Pill tone={serviceTone(service)} dot>`.
 */
export type Tone = 'neutral' | 'success' | 'warning' | 'destructive' | 'info' | 'bronze'

export function verdictTone(verdict: Verdict): Tone {
  return verdict === 'protected' ? 'success' : verdict === 'attention' ? 'warning' : 'destructive'
}

export function serviceTone(service: Pick<ServiceView, 'state' | 'health' | 'required'>): Tone {
  if (service.state === 'absent') return 'neutral'
  if (service.state === 'external') return service.health === 'healthy' ? 'success' : 'destructive'
  if (service.state !== 'running') return service.required ? 'destructive' : 'warning'
  if (service.health === 'unhealthy') return 'destructive'
  if (service.health === 'starting') return 'warning'
  return 'success'
}

/** What a service row says beside its dot. */
export function serviceStateLabel(service: Pick<ServiceView, 'state' | 'health'>): string {
  if (service.state === 'absent') return 'off'
  if (service.state === 'external') return service.health === 'healthy' ? 'reachable' : 'unreachable'
  if (service.state !== 'running') return service.state
  if (service.health === 'unhealthy') return 'unhealthy'
  if (service.health === 'starting') return 'starting'
  return service.health || 'running'
}

export function backupLevelTone(level: 'ok' | 'warn' | 'stale' | 'none'): Tone {
  return level === 'ok' ? 'success' : level === 'warn' ? 'warning' : 'destructive'
}

export function findingTone(level: 'warn' | 'risk'): Tone {
  return level === 'risk' ? 'destructive' : 'warning'
}

/** Activity: only a failure is coloured; a sign-in is marked, a change is quiet. */
export function auditKindTone(kind: AuditKind): Tone {
  return kind === 'failure' ? 'destructive' : kind === 'security' ? 'info' : 'neutral'
}

export function checkTone(status: 'pass' | 'warn' | 'fail'): Tone {
  return status === 'pass' ? 'success' : status === 'warn' ? 'warning' : 'destructive'
}

/** Text colour for a tone, for a dot or a figure outside a pill. */
export const toneText: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  info: 'text-info',
  bronze: 'text-bronze',
}

export const toneDot: Record<Tone, string> = {
  neutral: 'bg-muted-foreground',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  info: 'bg-info',
  bronze: 'bg-bronze',
}
