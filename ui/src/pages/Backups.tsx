import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError, type BackupSet, type OffsiteConfig, type RemoteSet, type RestoreResult } from '../api'
import { S } from '../strings'
import { useOverview } from '../overview-context'
import { ago, bytes, exact, when } from '@/lib/time'
import { backupLevelTone } from '@/lib/tones'
import { Empty, Fact, FactsRow, Note, Page, PageHeader, Row, Rows, Section } from '@/components/page'
import { Pill } from '@/components/ui/pill'
import { Button } from '@/components/ui/button'
import { RowMenu } from '@/components/row-menu'
import { Confirm } from '@/components/confirm'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type Pending = { kind: 'restore' | 'delete'; set: BackupSet } | null

export function Backups() {
  const { data, refresh } = useOverview()
  const a = data.assessment
  const [backups, setBackups] = useState<BackupSet[] | null>(null)
  const [offsite, setOffsite] = useState<OffsiteConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restore, setRestore] = useState<RestoreResult | null>(null)
  const [pending, setPending] = useState<Pending>(null)

  const load = useCallback(() => {
    void api
      .get<{ backups: BackupSet[]; offsiteConfig: OffsiteConfig }>('/api/backups')
      .then((result) => {
        setBackups(result.backups)
        setOffsite(result.offsiteConfig)
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
      void refresh()
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
      void act(async () => setRestore(await api.post<RestoreResult>(`/api/backups/${action.set.id}/restore`)))
    } else {
      void act(async () => void (await api.delete(`/api/backups/${action.set.id}`)))
    }
  }

  return (
    <Page>
      <PageHeader
        title={S.navBackups}
        description={S.backupsPageExplainer}
        actions={
          <Button
            size="sm"
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
        }
      />
      {error && <Note tone="destructive">{error}</Note>}

      <FactsRow className="border-t-0 pt-0">
        <Fact eyebrow={S.factBackups} value={a.backups.newestAt ? ago(a.backups.newestAt) : S.never} caption={a.backups.level === 'ok' ? S.backupsVerified : a.backups.detail} tone={backupLevelTone(a.backups.level)} />
        <Fact eyebrow={S.nextDue} value={a.backups.nextDueAt ? ago(a.backups.nextDueAt) : '—'} caption={S.everyInterval} />
        <Fact
          eyebrow={S.factOffsite}
          figure={false}
          value={a.offsite.enabled ? (a.offsite.ready ? (a.offsite.label ?? S.offsiteOn) : S.offsiteNotUsable) : S.offsiteOff}
          caption={
            !a.offsite.enabled ? S.factOffsiteOffCaption : !a.offsite.ready ? (a.offsite.reason ?? '') : a.backups.offsitePending ? S.factOffsitePending(a.backups.offsitePending) : S.factOffsiteCurrent
          }
          tone={!a.offsite.enabled || !a.offsite.ready ? 'destructive' : a.backups.offsitePending ? 'warning' : 'success'}
        />
        <Fact eyebrow={S.kept} value={String(a.backups.sets)} caption={S.keptCaption} />
      </FactsRow>

      <Section title={S.setsTitle}>
        {backups === null ? null : backups.length === 0 ? (
          <Empty>{S.backupEmpty}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-0">{S.backupColumnSet}</TableHead>
                <TableHead>{S.backupColumnKind}</TableHead>
                <TableHead className="hidden md:table-cell">{S.backupColumnContents}</TableHead>
                <TableHead>{S.factOffsite}</TableHead>
                <TableHead className="w-10 pr-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map((set) => (
                <TableRow key={set.id} className="hover:bg-transparent">
                  <TableCell className="pl-0">
                    <div className="font-medium" title={exact(set.takenAt)}>
                      {when(set.takenAt)}
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground">{set.id}</div>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <Pill size="sm">{kindLabel(set)}</Pill>
                      <span className="text-xs text-muted-foreground">v{set.appVersion}</span>
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {bytes(set.databaseBytes)} {S.databaseWord}
                    {set.includesUploads && ` · ${bytes(set.uploadsBytes)} ${S.documentsWord}`}
                  </TableCell>
                  <TableCell>
                    {offsite?.enabled ? (
                      set.offsite.uploadedAt ? (
                        <Pill tone="success" dot size="sm" title={exact(set.offsite.uploadedAt)}>
                          {S.offsiteSent}
                        </Pill>
                      ) : set.offsite.lastError ? (
                        <Pill tone="destructive" dot size="sm" title={set.offsite.lastError}>
                          {S.offsiteError}
                        </Pill>
                      ) : (
                        <Pill tone="warning" dot size="sm">
                          {S.offsitePending}
                        </Pill>
                      )
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="pr-0 text-right">
                    <RowMenu
                      actions={[
                        { label: S.backupRestore, onSelect: () => setPending({ kind: 'restore', set }), disabled: busy },
                        ...(offsite?.ready && !set.offsite.uploadedAt
                          ? [{ label: S.backupCopyOffsite, onSelect: () => void act(async () => void (await api.post(`/api/backups/${set.id}/offsite`))), disabled: busy }]
                          : []),
                        { label: S.backupDelete, danger: true, onSelect: () => setPending({ kind: 'delete', set }), disabled: busy },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      {restore && (
        <Section title={S.restoreStepsTitle}>
          <Rows>
            {restore.steps.map((step) => (
              <Row key={step.step}>
                <Pill tone={step.ok ? 'success' : 'destructive'} dot size="sm" className="w-14 justify-center">
                  {step.ok ? 'done' : 'failed'}
                </Pill>
                <span>{step.step}</span>
                {step.detail && <span className="text-muted-foreground">{step.detail}</span>}
              </Row>
            ))}
          </Rows>
        </Section>
      )}

      <OffsiteSection offsite={offsite} busy={busy} onError={setError} onChanged={load} />

      <Section title={S.supportTitle} description={S.supportExplainer}>
        <Button variant="outline" size="sm" asChild>
          <a href="/api/support-bundle" download>
            {S.supportDownload}
          </a>
        </Button>
      </Section>

      <Confirm
        open={pending !== null}
        title={pending?.kind === 'restore' ? S.backupRestoreDialogTitle : S.backupDeleteDialogTitle}
        body={<p>{pending?.kind === 'restore' ? S.backupRestoreConfirm(pending.set.id) : S.backupDeleteConfirm(pending?.set.id ?? '')}</p>}
        confirmLabel={pending?.kind === 'restore' ? S.backupRestore : S.backupDelete}
        danger={pending?.kind === 'delete'}
        onConfirm={confirmPending}
        onClose={() => setPending(null)}
      />
    </Page>
  )
}

/** What a set is, in the words for it: hourly is the database alone, daily carries documents. */
function kindLabel(set: BackupSet): string {
  if (set.trigger === 'scheduled') return set.includesUploads ? S.backupTrigger['daily']! : S.backupTrigger['hourly']!
  return S.backupTrigger[set.trigger] ?? set.trigger
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
  const [remote, setRemote] = useState<RemoteSet[] | null>(null)
  const [remoteDetail, setRemoteDetail] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  async function look() {
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
      await look()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setWorking(false)
    }
  }

  return (
    <Section
      title={S.offsiteTitle}
      description={S.offsiteExplainer}
      actions={
        offsite?.ready ? (
          <Button variant="outline" size="sm" disabled={working} onClick={look}>
            {working ? S.workingEllipsis : S.offsiteRemoteLoad}
          </Button>
        ) : undefined
      }
    >
      {offsite && !offsite.ready && <Note tone={offsite.enabled ? 'destructive' : 'neutral'}>{offsite.reason ?? S.offsiteNotConfigured}</Note>}
      {remoteDetail && <Note tone="destructive">{remoteDetail}</Note>}
      {remote && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{S.offsiteRemoteExplainer}</p>
          {remote.length === 0 ? (
            <Empty>{S.backupEmpty}</Empty>
          ) : (
            <Rows>
              {remote.map((set) => (
                <Row key={set.name}>
                  <span className="font-mono text-xs">{set.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {set.files} files · {bytes(set.bytes)}
                  </span>
                  <span className="ml-auto">
                    {set.local ? (
                      <Pill size="sm">{S.offsiteLocalToo}</Pill>
                    ) : (
                      <Button variant="outline" size="xs" disabled={working || busy} onClick={() => bringBack(set.name)}>
                        {S.offsiteBringBack}
                      </Button>
                    )}
                  </span>
                </Row>
              ))}
            </Rows>
          )}
        </div>
      )}
    </Section>
  )
}
