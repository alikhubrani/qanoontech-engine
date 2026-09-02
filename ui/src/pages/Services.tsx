import { useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError, type ServiceView } from '../api'
import { S } from '../strings'
import { ErrorNote, StatusBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

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
      toast.success(S.toastServiceDone(action, id))
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
    <div className="mx-auto max-w-5xl space-y-4">
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{S.serviceColumn}</TableHead>
              <TableHead>{S.stateColumn}</TableHead>
              <TableHead className="hidden md:table-cell">{S.imageColumn}</TableHead>
              <TableHead className="text-right">{S.actionsColumn}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {services.map((service) => (
              <TableRow key={service.id}>
                <TableCell>
                  <div className="font-medium">{service.title}</div>
                  <div className="text-xs text-muted-foreground">{service.summary}</div>
                </TableCell>
                <TableCell>
                  <StateBadge service={service} />
                  {service.required && (
                    <StatusBadge tone="muted" className="ml-1.5">
                      {S.requiredBadge}
                    </StatusBadge>
                  )}
                </TableCell>
                <TableCell className="hidden max-w-56 truncate font-mono text-xs text-muted-foreground md:table-cell">
                  {service.image || '—'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => showLogs(service.id)}>
                      {S.actionLogs}
                    </Button>
                    {service.state === 'running' ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => act(service.id, 'restart')}
                        >
                          {busy === `${service.id}:restart` ? S.workingEllipsis : S.actionRestart}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-bad hover:text-bad"
                          disabled={busy !== null}
                          onClick={() => act(service.id, 'stop')}
                        >
                          {busy === `${service.id}:stop` ? S.workingEllipsis : S.actionStop}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busy !== null || service.state === 'absent'}
                        onClick={() => act(service.id, 'start')}
                      >
                        {busy === `${service.id}:start` ? S.workingEllipsis : S.actionStart}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Sheet open={logsFor !== null} onOpenChange={(open) => !open && setLogsFor(null)}>
        <SheetContent side="right" className="w-full sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{logsFor ? S.logsTitle(logsFor) : ''}</SheetTitle>
            <SheetDescription>{S.logsRecent}</SheetDescription>
          </SheetHeader>
          <ScrollArea className="h-[calc(100vh-8rem)] px-4">
            <pre className="pb-6 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {logs || S.logsEmpty}
            </pre>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function StateBadge({ service }: { service: ServiceView }) {
  if (service.state === 'absent') return <StatusBadge tone="muted">{S.stateAbsent}</StatusBadge>
  if (service.state !== 'running') return <StatusBadge tone="bad">{service.state}</StatusBadge>
  if (service.health === 'unhealthy') return <StatusBadge tone="bad">unhealthy</StatusBadge>
  if (service.health === 'starting') return <StatusBadge tone="warn">starting</StatusBadge>
  return <StatusBadge tone="ok">{service.health || 'running'}</StatusBadge>
}
