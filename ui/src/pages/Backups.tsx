import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError, type BackupSet, type RestoreResult } from '../api'
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

  const load = useCallback(() => {
    void api
      .get<{ backups: BackupSet[] }>('/api/backups')
      .then((data) => setBackups(data.backups))
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
