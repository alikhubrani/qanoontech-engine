import { auditEventLabels, S } from '../strings'
import type { LicenceInfo, Overview as OverviewData } from '../api'
import { ErrorNote, StatusBadge } from '@/components/status'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export function Overview({ data, licence }: { data: OverviewData; licence: LicenceInfo | null }) {
  const unhealthy = data.services.filter(
    (service) => service.state === 'running' && service.health === 'unhealthy',
  )
  const down = data.services.filter(
    (service) => service.state !== 'running' && service.state !== 'absent',
  )

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label={S.versionLabel} value={data.version} />
        <Stat label={S.engineVersionLabel} value={data.engineVersion} />
        <Stat label={S.addressLabel} value={`${data.bindAddress}:${data.appPort}`} />
        <Stat
          label={S.navLicence}
          value={licence?.standing ?? '—'}
          hint={licence?.claims ? `${S.licenceExpires} ${new Date(licence.claims.expiresAt).toLocaleDateString()}` : undefined}
          tone={licence?.standing === 'ok' ? 'ok' : licence?.standing === 'grace' ? 'warn' : 'bad'}
        />
      </div>

      {data.dockerError && (
        <ErrorNote>
          {S.dockerUnreachable} {data.dockerError}
        </ErrorNote>
      )}

      {!data.plan.deployable && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{S.planProblemsTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-bad">
              {data.plan.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{S.navServices}</CardTitle>
        </CardHeader>
        <CardContent>
          {unhealthy.length === 0 && down.length === 0 && !data.dockerError ? (
            <p className="text-sm text-ok">{S.servicesHealthy}</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {[...down, ...unhealthy].map((service) => (
                <li key={service.id} className="flex items-center gap-2">
                  <StatusBadge tone="bad">
                    {service.state === 'running' ? service.health : service.state}
                  </StatusBadge>
                  <span>{service.title}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{S.auditTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">{S.auditEmpty}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{S.auditWhat}</TableHead>
                  <TableHead className="w-44 text-right">{S.auditWhen}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.audit.map((entry, index) => (
                  <TableRow key={index}>
                    <TableCell>
                      {auditEventLabels[entry.event] ?? entry.event}
                      {entry.detail && (
                        <span className="text-muted-foreground"> — {entry.detail}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {new Date(entry.at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'ok' | 'warn' | 'bad'
}) {
  const valueColor =
    tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-brand-dark'
  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`mt-1 truncate font-mono text-sm font-semibold ${valueColor}`} title={hint ?? value}>
          {value}
        </p>
        {hint && <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}
