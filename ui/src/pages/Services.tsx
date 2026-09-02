import { useState } from 'react'
import { api, ApiError, type ServiceView } from '../api'
import { Badge, Button, Card, ErrorNote } from '../components'
import { S } from '../strings'

export function Services({
  services,
  onChanged,
}: {
  services: ServiceView[]
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [logs, setLogs] = useState('')

  async function act(id: string, action: 'start' | 'stop' | 'restart') {
    setBusy(`${id}:${action}`)
    setError(null)
    try {
      await api.post(`/api/services/${id}/${action}`)
      onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(null)
    }
  }

  async function showLogs(id: string) {
    setLogsFor(id)
    setLogs('')
    try {
      const data = await api.get<{ logs: string }>(`/api/services/${id}/logs?lines=300`)
      setLogs(data.logs)
    } catch (caught) {
      setLogs(caught instanceof ApiError ? caught.message : S.errorGeneric)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-brand-dark">{S.servicesTitle}</h1>
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="space-y-3">
        {services.map((service) => (
          <Card key={service.id}>
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-800">{service.title}</span>
                  <StateBadge service={service} />
                  {service.required && <Badge tone="muted">{S.requiredBadge}</Badge>}
                </div>
                <p className="mt-0.5 truncate text-sm text-slate-500">{service.summary}</p>
                {service.image && (
                  <p className="mt-0.5 truncate font-mono text-xs text-slate-400">{service.image}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button onClick={() => showLogs(service.id)}>{S.actionLogs}</Button>
                {service.state === 'running' ? (
                  <>
                    <Button
                      disabled={busy !== null}
                      onClick={() => act(service.id, 'restart')}
                    >
                      {busy === `${service.id}:restart` ? S.workingEllipsis : S.actionRestart}
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy !== null}
                      onClick={() => act(service.id, 'stop')}
                    >
                      {busy === `${service.id}:stop` ? S.workingEllipsis : S.actionStop}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    disabled={busy !== null || service.state === 'absent'}
                    onClick={() => act(service.id, 'start')}
                  >
                    {busy === `${service.id}:start` ? S.workingEllipsis : S.actionStart}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {logsFor && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-6"
          onClick={() => setLogsFor(null)}
        >
          <div
            className="flex max-h-full w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-700">{S.logsTitle(logsFor)}</h2>
              <Button onClick={() => setLogsFor(null)}>{S.close}</Button>
            </div>
            <pre className="overflow-auto p-4 font-mono text-xs leading-relaxed text-slate-700">
              {logs || S.logsEmpty}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

function StateBadge({ service }: { service: ServiceView }) {
  if (service.state === 'absent') return <Badge tone="muted">{S.stateAbsent}</Badge>
  if (service.state !== 'running') return <Badge tone="bad">{service.state}</Badge>
  if (service.health === 'unhealthy') return <Badge tone="bad">unhealthy</Badge>
  if (service.health === 'starting') return <Badge tone="warn">starting</Badge>
  return <Badge tone="ok">{service.health || 'running'}</Badge>
}
