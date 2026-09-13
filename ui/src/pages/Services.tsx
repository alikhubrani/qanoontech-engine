import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError, type ServiceView } from '../api'
import { S } from '../strings'
import { useOverview } from '../overview-context'
import { serviceStateLabel, serviceTone } from '@/lib/tones'
import { Note, Page, PageHeader } from '@/components/page'
import { Pill } from '@/components/ui/pill'
import { Button } from '@/components/ui/button'
import { RowMenu, type RowAction } from '@/components/row-menu'
import { Confirm } from '@/components/confirm'
import { LogsView } from '@/components/logs-view'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

/** Stopping one of these takes the firm's system down; it asks first. */
const FRONT_DOOR = new Set(['app', 'nginx'])

export function Services() {
  const { data, refresh } = useOverview()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stopping, setStopping] = useState<ServiceView | null>(null)
  const [logsFor, setLogsFor] = useState<ServiceView | null>(null)

  async function act(service: ServiceView, action: 'start' | 'stop' | 'restart') {
    setBusy(`${service.id}:${action}`)
    setError(null)
    try {
      await api.post(`/api/services/${service.id}/${action}`)
      toast.success(S.toastServiceDone(S.serviceVerbDone[action], service.title))
      await refresh()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(null)
    }
  }

  function actionsFor(service: ServiceView): RowAction[] {
    if (service.state === 'external') return []
    const disabled = busy !== null
    if (service.state === 'running') {
      return [
        { label: S.actionRestart, onSelect: () => void act(service, 'restart'), disabled },
        {
          label: S.actionStop,
          danger: true,
          disabled,
          onSelect: () => (FRONT_DOOR.has(service.id) ? setStopping(service) : void act(service, 'stop')),
        },
      ]
    }
    return [{ label: S.actionStart, onSelect: () => void act(service, 'start'), disabled: disabled || service.state === 'absent' }]
  }

  return (
    <Page>
      <PageHeader title={S.navServices} description={S.servicesExplainer} />
      {error && <Note tone="destructive">{error}</Note>}
      {data.dockerError && (
        <Note tone="destructive">
          {S.dockerUnreachable} {data.dockerError}
        </Note>
      )}

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-0">{S.serviceColumn}</TableHead>
            <TableHead className="w-36">{S.stateColumn}</TableHead>
            <TableHead className="hidden lg:table-cell">{S.detailColumn}</TableHead>
            <TableHead className="w-28 pr-0 text-right">{S.actionsColumn}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.services.map((service) => (
            <TableRow key={service.id} className="hover:bg-transparent">
              <TableCell className="py-3 pl-0 align-top">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{service.title}</span>
                  {service.required && (
                    <Pill size="sm" tone="neutral">
                      {S.requiredBadge}
                    </Pill>
                  )}
                </div>
                <div className="mt-0.5 max-w-[48ch] text-xs text-muted-foreground">{service.summary}</div>
              </TableCell>
              <TableCell className="py-3 align-top">
                <Pill tone={serviceTone(service)} dot>
                  {serviceStateLabel(service)}
                </Pill>
              </TableCell>
              <TableCell className="hidden py-3 align-top text-xs text-muted-foreground lg:table-cell">
                <ServiceDetail service={service} />
              </TableCell>
              <TableCell className="py-2.5 pr-0 text-right align-top">
                <div className="flex items-center justify-end gap-1">
                  {service.state !== 'external' && (
                    <Button variant="ghost" size="sm" onClick={() => setLogsFor(service)}>
                      {S.actionLogs}
                    </Button>
                  )}
                  {actionsFor(service).length > 0 && <RowMenu actions={actionsFor(service)} />}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Confirm
        open={stopping !== null}
        title={S.stopDialogTitle(stopping?.title ?? '')}
        body={<p>{S.stopDialogBody}</p>}
        confirmLabel={S.actionStop}
        danger
        busy={busy !== null}
        onConfirm={() => {
          const target = stopping
          setStopping(null)
          if (target) void act(target, 'stop')
        }}
        onClose={() => setStopping(null)}
      />

      <LogsSheet service={logsFor} onClose={() => setLogsFor(null)} />
    </Page>
  )
}

function ServiceDetail({ service }: { service: ServiceView }) {
  if (service.external) {
    return (
      <span>
        {service.external.reachable
          ? `${service.external.server ?? 'PostgreSQL'} · ${service.external.host}:${service.external.port}`
          : `${service.external.host}:${service.external.port} — ${service.external.detail}`}
      </span>
    )
  }
  const tag = service.image ? service.image.slice(service.image.lastIndexOf('/') + 1) : ''
  return (
    <span className="flex flex-col gap-0.5">
      {tag && (
        <span className="font-mono" title={service.image}>
          {tag}
        </span>
      )}
      {service.status && <span>{service.status}</span>}
    </span>
  )
}

function LogsSheet({ service, onClose }: { service: ServiceView | null; onClose: () => void }) {
  const [lines, setLines] = useState(300)
  const [follow, setFollow] = useState(false)
  const [text, setText] = useState('')

  const fetchLogs = useCallback(async () => {
    if (!service) return
    try {
      const data = await api.get<{ logs: string }>(`/api/services/${service.id}/logs?lines=${lines}`)
      setText(data.logs)
    } catch (caught) {
      setText(caught instanceof ApiError ? caught.message : S.errorGeneric)
    }
  }, [service, lines])

  useEffect(() => {
    setText('')
    void fetchLogs()
  }, [fetchLogs])

  useEffect(() => {
    if (!follow || !service) return
    const timer = setInterval(() => void fetchLogs(), 3000)
    return () => clearInterval(timer)
  }, [follow, service, fetchLogs])

  return (
    <Sheet open={service !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-3 p-4 sm:max-w-3xl">
        <SheetHeader className="p-0">
          <SheetTitle>{service ? S.logsTitle(service.title) : ''}</SheetTitle>
          <SheetDescription>{S.logsRecent(lines)}</SheetDescription>
        </SheetHeader>
        <LogsView text={text} lines={lines} onLines={setLines} follow={follow} onFollow={setFollow} />
      </SheetContent>
    </Sheet>
  )
}
