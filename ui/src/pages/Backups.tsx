import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError, type BackupSet, type OffsiteConfig, type RemoteSet, type RestoreResult } from '../api'
import { S } from '../strings'
import { ErrorNote, StatusBadge } from '@/components/status'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type PendingAction = { kind: 'restore' | 'delete'; id: string } | null

export function Backups({ onChanged }: { onChanged: () => void }) {
  const [backups, setBackups] = useState<BackupSet[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restore, setRestore] = useState<RestoreResult | null>(null)
  const [pending, setPending] = useState<PendingAction>(null)
  const [offsite, setOffsite] = useState<OffsiteConfig | null>(null)

  const load = useCallback(() => {
    void api
      .get<{ backups: BackupSet[]; offsiteConfig: OffsiteConfig }>('/api/backups')
      .then((data) => {
        setBackups(data.backups)
        setOffsite(data.offsiteConfig)
      })
      .catch(() => undefined)
  }, [])
  useEffect(load, [load])

  async function act(work: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await work()
      load()
      onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  function confirmPending() {
    const action = pending
    setPending(null)
    if (!action) return
    if (action.kind === 'restore') {
      void act(async () => {
        const result = await api.post<RestoreResult>(`/api/backups/${action.id}/restore`)
        setRestore(result)
      })
    } else {
      void act(async () => void (await api.delete(`/api/backups/${action.id}`)))
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      {error && <ErrorNote>{error}</ErrorNote>}

      <Card>
        <CardHeader>
          <CardTitle>{S.backupsTitle}</CardTitle>
          <CardDescription>{S.backupsExplainer}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api.post('/api/backups')
                toast.success(S.toastBackupTaken)
              })
            }
          >
            {busy ? S.backupTaking : S.backupTakeNow}
          </Button>
        </CardContent>
      </Card>

      <div className="rounded-lg border bg-card">
        {backups.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">{S.backupEmpty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{S.backupColumnSet}</TableHead>
                <TableHead>{S.backupColumnKind}</TableHead>
                <TableHead className="hidden md:table-cell">{S.backupColumnContents}</TableHead>
                <TableHead className="text-right">{S.actionsColumn}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map((set) => (
                <TableRow key={set.id}>
                  <TableCell>
                    <span className="font-mono text-xs">{set.id}</span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone="muted">{S.backupTrigger[set.trigger] ?? set.trigger}</StatusBadge>
                    <StatusBadge tone="muted" className="ml-1.5">
                      v{set.appVersion}
                    </StatusBadge>
                    {offsite?.enabled &&
                      (set.offsite.uploadedAt ? (
                        <StatusBadge tone="ok" className="ml-1.5">
                          {S.offsiteSent}
                        </StatusBadge>
                      ) : set.offsite.lastError ? (
                        <StatusBadge tone="bad" className="ml-1.5" title={set.offsite.lastError}>
                          {S.offsiteError}
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="warn" className="ml-1.5">
                          {S.offsitePending}
                        </StatusBadge>
                      ))}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {formatBytes(set.databaseBytes)} database
                    {set.includesUploads && ` · ${formatBytes(set.uploadsBytes)} documents`}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => setPending({ kind: 'restore', id: set.id })}
                      >
                        {S.backupRestore}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-bad hover:text-bad"
                        disabled={busy}
                        onClick={() => setPending({ kind: 'delete', id: set.id })}
                      >
                        {S.backupDelete}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {restore && (
        <Card>
          <CardHeader>
            <CardTitle>{S.restoreStepsTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm">
              {restore.steps.map((step) => (
                <li key={step.step} className="flex items-baseline gap-2">
                  <StatusBadge tone={step.ok ? 'ok' : 'bad'}>
                    {step.ok ? 'done' : 'failed'}
                  </StatusBadge>
                  <span>{step.step}</span>
                  {step.detail && <span className="text-muted-foreground">{step.detail}</span>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <OffsiteSection offsite={offsite} busy={busy} onError={setError} onChanged={load} />

      <Card>
        <CardHeader>
          <CardTitle>{S.supportTitle}</CardTitle>
          <CardDescription>{S.supportExplainer}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <a href="/api/support-bundle" download>
              {S.supportDownload}
            </a>
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === 'restore' ? S.backupRestoreDialogTitle : S.backupDeleteDialogTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'restore'
                ? S.backupRestoreConfirm(pending?.id ?? '')
                : S.backupDeleteConfirm(pending?.id ?? '')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{S.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmPending}>
              {pending?.kind === 'restore' ? S.backupRestore : S.backupDelete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}


function OffsiteSection({
  offsite,
  busy,
  onError,
  onChanged,
}: {
  offsite: OffsiteConfig | null
  busy: boolean
  onError: (message: string | null) => void
  onChanged: () => void
}) {
  const [enabled, setEnabled] = useState(false)
  const [driveId, setDriveId] = useState('')
  const [remote, setRemote] = useState<RemoteSet[] | null>(null)
  const [remoteDetail, setRemoteDetail] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    if (offsite) {
      setEnabled(offsite.enabled)
      setDriveId(offsite.driveId)
    }
  }, [offsite])

  async function save() {
    setWorking(true)
    onError(null)
    try {
      await api.put('/api/settings', { backupOffsiteEnabled: enabled, backupOffsiteDriveId: driveId })
      onChanged()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setWorking(false)
    }
  }

  async function lookInDrive() {
    setWorking(true)
    try {
      const data = await api.get<{ sets: RemoteSet[]; detail?: string }>('/api/backups/offsite')
      setRemote(data.sets)
      setRemoteDetail(data.detail ?? null)
    } finally {
      setWorking(false)
    }
  }

  async function bringBack(name: string) {
    setWorking(true)
    onError(null)
    try {
      await api.post('/api/backups/offsite/fetch', { name })
      onChanged()
      await lookInDrive()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setWorking(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{S.offsiteTitle}</CardTitle>
        <CardDescription>{S.offsiteExplainer}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox checked={enabled} onCheckedChange={(next) => setEnabled(next === true)} />
            {S.offsiteEnable}
          </label>
          <div className="min-w-56 space-y-1.5">
            <Label htmlFor="offsite-drive">{S.offsiteDriveId}</Label>
            <Input
              id="offsite-drive"
              value={driveId}
              onChange={(event) => setDriveId(event.target.value)}
              placeholder="0A…"
            />
          </div>
          <Button size="sm" disabled={working || busy} onClick={save}>
            {working ? S.workingEllipsis : S.offsiteSave}
          </Button>
        </div>
        {offsite?.reason && <ErrorNote>{offsite.reason}</ErrorNote>}

        {offsite?.ready && (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">{S.offsiteRemoteTitle}</span>
              <Button variant="outline" size="sm" disabled={working} onClick={lookInDrive}>
                {working ? S.workingEllipsis : S.offsiteRemoteLoad}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{S.offsiteRemoteExplainer}</p>
            {remoteDetail && <ErrorNote>{remoteDetail}</ErrorNote>}
            {remote && remote.length > 0 && (
              <ul className="space-y-1.5 text-sm">
                {remote.map((set) => (
                  <li key={set.name} className="flex items-center gap-3">
                    <span className="font-mono text-xs">{set.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {set.files} files · {(set.bytes / 1024 ** 2).toFixed(1)} MB
                    </span>
                    {set.local ? (
                      <StatusBadge tone="muted">{S.offsiteLocalToo}</StatusBadge>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={working || busy}
                        onClick={() => bringBack(set.name)}
                      >
                        {S.offsiteBringBack}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
