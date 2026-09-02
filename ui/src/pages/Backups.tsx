import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type BackupSet, type RestoreResult } from '../api'
import { Badge, Button, Card, ErrorNote } from '../components'
import { S } from '../strings'

export function Backups({ onChanged }: { onChanged: () => void }) {
  const [backups, setBackups] = useState<BackupSet[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restore, setRestore] = useState<RestoreResult | null>(null)

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

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-brand-dark">{S.backupsTitle}</h1>
      {error && <ErrorNote>{error}</ErrorNote>}

      <Card>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-slate-500">{S.backupsExplainer}</p>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => act(async () => void (await api.post('/api/backups')))}
          >
            {busy ? S.backupTaking : S.backupTakeNow}
          </Button>
        </div>
      </Card>

      <Card>
        {backups.length === 0 ? (
          <p className="text-sm text-slate-400">{S.backupEmpty}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {backups.map((set) => (
              <li key={set.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-slate-800">{set.id}</span>
                    <Badge tone="muted">{S.backupTrigger[set.trigger] ?? set.trigger}</Badge>
                    <Badge tone="muted">v{set.appVersion}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {formatBytes(set.databaseBytes)} database
                    {set.includesUploads && ` · ${formatBytes(set.uploadsBytes)} documents`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(S.backupRestoreConfirm(set.id))) return
                      void act(async () => {
                        const result = await api.post<RestoreResult>(`/api/backups/${set.id}/restore`)
                        setRestore(result)
                      })
                    }}
                  >
                    {S.backupRestore}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(S.backupDeleteConfirm(set.id))) return
                      void act(async () => void (await api.delete(`/api/backups/${set.id}`)))
                    }}
                  >
                    {S.backupDelete}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {restore && (
        <Card title={S.restoreStepsTitle}>
          <ul className="space-y-1.5 text-sm">
            {restore.steps.map((step) => (
              <li key={step.step} className="flex items-baseline gap-2">
                <Badge tone={step.ok ? 'ok' : 'bad'}>{step.ok ? 'done' : 'failed'}</Badge>
                <span className="text-slate-700">{step.step}</span>
                {step.detail && <span className="text-slate-400">{step.detail}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={S.supportTitle}>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-slate-500">{S.supportExplainer}</p>
          <a
            className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            href="/api/support-bundle"
            download
          >
            {S.supportDownload}
          </a>
        </div>
      </Card>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
