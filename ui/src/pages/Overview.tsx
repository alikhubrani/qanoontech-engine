import { Badge, Card, ErrorNote } from '../components'
import { auditEventLabels, S } from '../strings'
import type { Overview as OverviewData } from '../api'

export function Overview({ data }: { data: OverviewData }) {
  const unhealthy = data.services.filter(
    (service) => service.state === 'running' && service.health === 'unhealthy',
  )
  const down = data.services.filter(
    (service) => service.state !== 'running' && service.state !== 'absent',
  )

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-brand-dark">{S.overviewTitle}</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label={S.versionLabel} value={data.version} />
        <Stat label={S.engineVersionLabel} value={data.engineVersion} />
        <Stat label={S.addressLabel} value={`${data.bindAddress}:${data.appPort}`} />
        <Stat
          label="Modules"
          value={String(data.modulesOn.length)}
          hint={data.modulesOn.join(', ')}
        />
      </div>

      {data.dockerError && (
        <ErrorNote>
          {S.dockerUnreachable} {data.dockerError}
        </ErrorNote>
      )}

      {!data.plan.deployable && (
        <Card title={S.planProblemsTitle}>
          <ul className="list-disc space-y-1 pl-5 text-sm text-bad">
            {data.plan.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={S.navServices}>
        {unhealthy.length === 0 && down.length === 0 && !data.dockerError ? (
          <p className="text-sm text-ok">{S.servicesHealthy}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {[...down, ...unhealthy].map((service) => (
              <li key={service.id} className="flex items-center gap-2">
                <Badge tone="bad">{service.state === 'running' ? service.health : service.state}</Badge>
                <span className="text-slate-700">{service.title}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={S.auditTitle}>
        {data.audit.length === 0 ? (
          <p className="text-sm text-slate-400">{S.auditEmpty}</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {data.audit.map((entry, index) => (
              <li key={index} className="flex items-baseline justify-between gap-4">
                <span className="text-slate-700">
                  {auditEventLabels[entry.event] ?? entry.event}
                  {entry.detail && <span className="text-slate-400"> — {entry.detail}</span>}
                </span>
                <time className="shrink-0 text-xs text-slate-400">
                  {new Date(entry.at).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-1 truncate font-mono text-sm font-semibold text-brand-dark" title={hint}>
        {value}
      </p>
    </div>
  )
}
