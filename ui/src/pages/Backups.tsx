import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  api,
  ApiError,
  type BackupSet,
  type DrillResult,
  type OffsiteConfig,
  type OffsiteStatus,
  type ProbeResult,
  type RecoveryStatus,
  type RemoteListing,
  type RestoreResult,
} from '../api'
import { S } from '../strings'
import { useOverview } from '../overview-context'
import { ago, bytes, exact, when } from '@/lib/time'
import { backupLevelTone } from '@/lib/tones'
import { Empty, Fact, FactsRow, Field, Note, Page, PageHeader, Row, Rows, Section } from '@/components/page'
import { Pill } from '@/components/ui/pill'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RowMenu } from '@/components/row-menu'
import { Confirm } from '@/components/confirm'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type Tab = 'sets' | 'offsite' | 'schedule' | 'recovery'
const TABS: Tab[] = ['sets', 'offsite', 'schedule', 'recovery']

/**
 * Backups: the sets on this box, the copy of each in the bucket, when they
 * are taken and how long they are kept, and whether this deployment could be
 * brought back at all. Four tabs, one health strip over all of them.
 */
export function Backups() {
  const { data, refresh } = useOverview()
  const a = data.assessment
  const location = useLocation()
  const navigate = useNavigate()
  const tab = (TABS.find((t) => location.pathname === `/backups/${t}`) ?? 'sets') as Tab
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function takeNow() {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/backups')
      toast.success(S.toastBackupTaken)
      void refresh()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page>
      <PageHeader
        title={S.navBackups}
        description={S.backupsPageExplainer}
        actions={
          <Button size="sm" disabled={busy} onClick={() => void takeNow()}>
            {busy ? S.backupTaking : S.backupTakeNow}
          </Button>
        }
      >
        <FactsRow className="border-t-0 pt-0">
          <Fact
            eyebrow={S.factBackups}
            value={a.backups.newestAt ? ago(a.backups.newestAt) : S.never}
            caption={a.backups.level === 'ok' ? S.backupsVerified : a.backups.detail}
            tone={backupLevelTone(a.backups.level)}
          />
          <Fact eyebrow={S.nextDue} value={a.backups.nextDueAt ? ago(a.backups.nextDueAt) : '—'} caption={S.everyInterval} />
          <Fact
            eyebrow={S.factOffsite}
            figure={false}
            value={a.offsite.enabled ? (a.offsite.ready ? (a.offsite.label ?? S.offsiteOn) : S.offsiteNotUsable) : S.offsiteOff}
            caption={
              !a.offsite.enabled
                ? S.factOffsiteOffCaption
                : !a.offsite.ready
                  ? (a.offsite.reason ?? '')
                  : a.backups.offsitePending
                    ? S.factOffsitePending(a.backups.offsitePending)
                    : S.factOffsiteCurrent
            }
            tone={!a.offsite.enabled || !a.offsite.ready ? 'destructive' : a.backups.offsitePending ? 'warning' : 'success'}
          />
          <Fact
            eyebrow={S.factRecovery}
            value={a.recovery.passphraseSet ? (a.recovery.lastCopiedAt ? ago(a.recovery.lastCopiedAt) : S.notYet) : S.noPassphrase}
            figure={a.recovery.passphraseSet && Boolean(a.recovery.lastCopiedAt)}
            caption={a.recovery.passphraseSet ? (a.recovery.verifiedAt ? S.factRecoveryVerified(ago(a.recovery.verifiedAt)) : S.factRecoveryCaption) : S.factRecoveryNoPassphrase}
            tone={a.recovery.passphraseSet && a.recovery.lastCopiedAt ? 'success' : 'warning'}
          />
        </FactsRow>
        <Tabs value={tab} onValueChange={(next) => navigate(next === 'sets' ? '/backups' : `/backups/${next}`)}>
          <TabsList>
            <TabsTrigger value="sets">{S.tabSets}</TabsTrigger>
            <TabsTrigger value="offsite">{S.tabOffsite}</TabsTrigger>
            <TabsTrigger value="schedule">{S.tabSchedule}</TabsTrigger>
            <TabsTrigger value="recovery">{S.tabRecovery}</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

      {error && <Note tone="destructive">{error}</Note>}

      {tab === 'sets' && <SetsTab onError={setError} />}
      {tab === 'offsite' && <OffsiteTab onError={setError} />}
      {tab === 'schedule' && <ScheduleTab onError={setError} />}
      {tab === 'recovery' && <RecoveryTab onError={setError} />}
    </Page>
  )
}

// -- Sets -------------------------------------------------------------------

type Pending = { kind: 'restore' | 'delete'; set: BackupSet } | null

function SetsTab({ onError }: { onError: (message: string | null) => void }) {
  const { refresh } = useOverview()
  const [backups, setBackups] = useState<BackupSet[] | null>(null)
  const [offsite, setOffsite] = useState<OffsiteConfig | null>(null)
  const [busy, setBusy] = useState(false)
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
    onError(null)
    try {
      await work()
      load()
      void refresh()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
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
    <>
      <Section title={S.setsTitle} description={S.setsExplainer}>
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

      <Confirm
        open={pending !== null}
        title={pending?.kind === 'restore' ? S.backupRestoreDialogTitle : S.backupDeleteDialogTitle}
        body={<p>{pending?.kind === 'restore' ? S.backupRestoreConfirm(pending.set.id) : S.backupDeleteConfirm(pending?.set.id ?? '')}</p>}
        confirmLabel={pending?.kind === 'restore' ? S.backupRestore : S.backupDelete}
        danger={pending?.kind === 'delete'}
        onConfirm={confirmPending}
        onClose={() => setPending(null)}
      />
    </>
  )
}

/** What a set is, in the words for it: hourly is the database alone, daily carries documents. */
function kindLabel(set: BackupSet): string {
  if (set.trigger === 'scheduled') return set.includesUploads ? S.backupTrigger['daily']! : S.backupTrigger['hourly']!
  return S.backupTrigger[set.trigger] ?? set.trigger
}

// -- Offsite ----------------------------------------------------------------

function OffsiteTab({ onError }: { onError: (message: string | null) => void }) {
  const { refresh } = useOverview()
  const [status, setStatus] = useState<OffsiteStatus | null>(null)
  const [form, setForm] = useState({ enabled: false, endpoint: '', bucket: '', region: 'auto', prefix: '', accessKeyId: '', secretAccessKey: '' })
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [remote, setRemote] = useState<RemoteListing | null>(null)

  const load = useCallback(() => {
    void api
      .get<OffsiteStatus>('/api/offsite')
      .then((data) => {
        setStatus(data)
        setForm((current) => ({ ...current, enabled: data.enabled, endpoint: data.endpoint, bucket: data.bucket, region: data.region || 'auto', prefix: data.prefix }))
      })
      .catch(() => undefined)
  }, [])
  useEffect(load, [load])

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    onError(null)
    try {
      const body: Record<string, unknown> = { enabled: form.enabled, endpoint: form.endpoint, bucket: form.bucket, region: form.region, prefix: form.prefix }
      if (form.accessKeyId) body['accessKeyId'] = form.accessKeyId
      if (form.secretAccessKey) body['secretAccessKey'] = form.secretAccessKey
      await api.put('/api/offsite', body)
      setForm((current) => ({ ...current, accessKeyId: '', secretAccessKey: '' }))
      setProbe(null)
      toast.success(S.settingsSaved)
      load()
      void refresh()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    setBusy(true)
    onError(null)
    try {
      setProbe(await api.post<ProbeResult>('/api/offsite/test'))
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  async function look() {
    setBusy(true)
    try {
      setRemote(await api.get<RemoteListing>('/api/backups/offsite'))
    } finally {
      setBusy(false)
    }
  }

  async function bringBack(name: string) {
    setBusy(true)
    onError(null)
    try {
      await api.post('/api/backups/offsite/fetch', { name })
      await look()
      void refresh()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null

  return (
    <>
      <Section title={S.offsiteWhereTitle} description={S.offsiteWhereExplainer}>
        {status.enabled && !status.ready && status.reason && <Note tone="destructive">{status.reason}</Note>}
        <form onSubmit={save} className="space-y-5">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.enabled} onCheckedChange={(next) => setForm({ ...form, enabled: next === true })} />
            {S.offsiteEnable}
          </label>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={S.offsiteEndpoint} help={S.offsiteEndpointHelp}>
              <Input value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder="https://<account>.r2.cloudflarestorage.com" autoComplete="off" />
            </Field>
            <Field label={S.offsiteBucket} help={S.offsiteBucketHelp}>
              <Input value={form.bucket} onChange={(e) => setForm({ ...form, bucket: e.target.value })} autoComplete="off" />
            </Field>
            <Field label={S.offsiteRegion} help={S.offsiteRegionHelp}>
              <Input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} autoComplete="off" />
            </Field>
            <Field label={S.offsitePrefix} help={S.offsitePrefixHelp}>
              <Input value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} autoComplete="off" />
            </Field>
            <Field
              label={
                <span className="flex items-center gap-2">
                  {S.offsiteAccessKey}
                  {status.keys.accessKeyId && <Pill tone="success" size="sm" dot>{S.secretSet}</Pill>}
                </span>
              }
            >
              <Input value={form.accessKeyId} onChange={(e) => setForm({ ...form, accessKeyId: e.target.value })} placeholder={status.keys.accessKeyId ? S.secretReplacePlaceholder : ''} autoComplete="off" />
            </Field>
            <Field
              label={
                <span className="flex items-center gap-2">
                  {S.offsiteSecretKey}
                  {status.keys.secretAccessKey && <Pill tone="success" size="sm" dot>{S.secretSet}</Pill>}
                </span>
              }
              help={S.offsiteKeysHelp}
            >
              <Input type="password" value={form.secretAccessKey} onChange={(e) => setForm({ ...form, secretAccessKey: e.target.value })} placeholder={status.keys.secretAccessKey ? S.secretReplacePlaceholder : ''} autoComplete="off" />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? S.workingEllipsis : S.settingsSave}
            </Button>
            {status.ready && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void test()}>
                {S.offsiteTest}
              </Button>
            )}
          </div>
        </form>
        {probe && (
          <Rows>
            {probe.steps.map((step) => (
              <Row key={step.step}>
                <Pill tone={step.ok ? 'success' : 'destructive'} dot size="sm" className="w-16 justify-center">
                  {step.step}
                </Pill>
                <span className="text-sm text-muted-foreground">{step.detail}</span>
              </Row>
            ))}
            <Row>
              <span className={probe.ok ? 'text-sm text-success' : 'text-sm text-destructive'}>{probe.ok ? S.offsiteTestOk(status.label ?? '') : S.offsiteTestFailed}</span>
            </Row>
          </Rows>
        )}
      </Section>

      {status.ready && (
        <Section
          title={S.offsiteRemoteTitle}
          description={S.offsiteRemoteExplainer}
          actions={
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void look()}>
              {busy ? S.workingEllipsis : S.offsiteRemoteLoad}
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">
            {S.offsiteHereSummary(status.sets, status.pending)}
          </p>
          {remote?.detail && <Note tone="destructive">{remote.detail}</Note>}
          {remote && (
            <>
              {remote.documents && (
                <p className="text-sm">
                  {S.offsiteDocumentsSummary(remote.documents.files, bytes(remote.documents.bytes))}
                </p>
              )}
              {remote.sets.length === 0 ? (
                <Empty>{S.backupEmpty}</Empty>
              ) : (
                <Rows>
                  {remote.sets.map((set) => (
                    <Row key={set.name}>
                      <span className="font-mono text-xs">{set.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {set.files} files · {bytes(set.bytes)}
                      </span>
                      <span className="ml-auto">
                        {set.local ? (
                          <Pill size="sm">{S.offsiteLocalToo}</Pill>
                        ) : (
                          <Button variant="outline" size="xs" disabled={busy} onClick={() => void bringBack(set.name)}>
                            {S.offsiteBringBack}
                          </Button>
                        )}
                      </span>
                    </Row>
                  ))}
                </Rows>
              )}
            </>
          )}
        </Section>
      )}
    </>
  )
}

// -- Schedule ---------------------------------------------------------------

interface ScheduleSettings {
  backupIntervalMinutes: number
  backupHour: number
  backupRetentionDays: number
  backupIncludeUploads: boolean
  timezone: string
}

function ScheduleTab({ onError }: { onError: (message: string | null) => void }) {
  const { refresh } = useOverview()
  const [form, setForm] = useState<ScheduleSettings | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api
      .get<{ settings: ScheduleSettings }>('/api/settings')
      .then((data) => setForm(data.settings))
      .catch(() => undefined)
  }, [])

  if (!form) return null

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!form) return
    setBusy(true)
    onError(null)
    try {
      await api.put('/api/settings', {
        backupIntervalMinutes: Number(form.backupIntervalMinutes),
        backupHour: Number(form.backupHour),
        backupRetentionDays: Number(form.backupRetentionDays),
        backupIncludeUploads: form.backupIncludeUploads,
      })
      toast.success(S.settingsSaved)
      void refresh()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={S.scheduleTitle} description={S.scheduleExplainer}>
      <form onSubmit={save} className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={S.scheduleInterval} help={S.scheduleIntervalHelp}>
            <Input type="number" min={5} max={1440} value={form.backupIntervalMinutes} onChange={(e) => setForm({ ...form, backupIntervalMinutes: Number(e.target.value) })} />
          </Field>
          <Field label={S.scheduleHour} help={S.scheduleHourHelp(form.timezone)}>
            <Select value={String(form.backupHour)} onValueChange={(next) => setForm({ ...form, backupHour: Number(next) })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, hour) => (
                  <SelectItem key={hour} value={String(hour)}>
                    {String(hour).padStart(2, '0')}:00
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={S.scheduleRetention} help={S.scheduleRetentionHelp}>
            <Input type="number" min={1} max={3650} value={form.backupRetentionDays} onChange={(e) => setForm({ ...form, backupRetentionDays: Number(e.target.value) })} />
          </Field>
          <Field label={S.scheduleDocuments} help={S.scheduleDocumentsHelp}>
            <label className="flex items-center gap-2 pt-2 text-sm">
              <Checkbox checked={form.backupIncludeUploads} onCheckedChange={(next) => setForm({ ...form, backupIncludeUploads: next === true })} />
              {S.scheduleDocumentsLabel}
            </label>
          </Field>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? S.workingEllipsis : S.settingsSave}
        </Button>
      </form>
    </Section>
  )
}

// -- Recovery ---------------------------------------------------------------

function RecoveryTab({ onError }: { onError: (message: string | null) => void }) {
  const { refresh } = useOverview()
  const [status, setStatus] = useState<RecoveryStatus | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [drill, setDrill] = useState<DrillResult | null>(null)

  const load = useCallback(() => {
    void api.get<RecoveryStatus>('/api/recovery').then(setStatus).catch(() => undefined)
  }, [])
  useEffect(load, [load])

  async function setIt(event: FormEvent) {
    event.preventDefault()
    if (passphrase !== again) {
      onError(S.passphraseMismatch)
      return
    }
    setBusy(true)
    onError(null)
    try {
      const result = await api.put<{ replacing: boolean }>('/api/recovery/passphrase', { passphrase })
      setPassphrase('')
      setAgain('')
      toast.success(result.replacing ? S.passphraseReplaced : S.passphraseSetToast)
      load()
      void refresh()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  async function runDrill() {
    setBusy(true)
    onError(null)
    try {
      setDrill(await api.post<DrillResult>('/api/backups/drill'))
      load()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null
  const last = drill ?? status.lastDrill

  return (
    <>
      <Section title={S.snapshotTitle} description={S.snapshotExplainer}>
        <FactsRow className="border-t-0 pt-0 md:grid-cols-3">
          <Fact eyebrow={S.snapshotPassphrase} figure={false} value={status.passphraseSet ? S.secretSet : S.notSet} tone={status.passphraseSet ? 'success' : 'warning'} />
          <Fact eyebrow={S.snapshotCopied} value={status.snapshot.uploadedAt ? ago(status.snapshot.uploadedAt) : S.never} caption={status.snapshot.verifiedAt ? S.factRecoveryVerified(ago(status.snapshot.verifiedAt)) : undefined} />
          <Fact
            eyebrow={S.snapshotInStore}
            figure={false}
            value={status.store === null ? S.offsiteOff : status.snapshot.inStore === null ? S.unknown : status.snapshot.inStore ? S.yes : S.no}
            caption={status.snapshot.bytes ? `${bytes(status.snapshot.bytes)} · ${status.snapshot.key}` : status.store?.label}
            tone={status.snapshot.inStore ? 'success' : status.snapshot.inStore === false ? 'destructive' : 'neutral'}
          />
        </FactsRow>
        <form onSubmit={setIt} className="space-y-4">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={status.passphraseSet ? S.passphraseReplace : S.passphraseSetLabel} help={S.passphraseHelp}>
              <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
            </Field>
            <Field label={S.passphraseAgain}>
              <Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
          <Note tone="warning">{S.passphraseWarning}</Note>
          <Button type="submit" disabled={busy || passphrase.length < 12}>
            {busy ? S.workingEllipsis : status.passphraseSet ? S.passphraseReplace : S.passphraseSetLabel}
          </Button>
        </form>
      </Section>

      <Section
        title={S.drillTitle}
        description={S.drillExplainer}
        actions={
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void runDrill()}>
            {busy ? S.workingEllipsis : S.drillRun}
          </Button>
        }
      >
        {last ? (
          <div className="space-y-3">
            <Note tone={last.ok ? 'success' : 'destructive'}>
              {last.detail}
              {last.at && <span className="text-muted-foreground"> · {when(last.at)}</span>}
            </Note>
            {last.ok && last.restoreMs !== undefined && (
              <FactsRow className="border-t-0 pt-0 md:grid-cols-3">
                <Fact eyebrow={S.drillTime} value={`${(last.restoreMs / 1000).toFixed(1)} s`} caption={S.drillTimeCaption} />
                <Fact eyebrow={S.drillTables} value={String(last.tables ?? '—')} />
                <Fact
                  eyebrow={S.drillRows}
                  value={String(Object.values(last.rows ?? {}).reduce((sum, n) => sum + n, 0))}
                  caption={Object.entries(last.rows ?? {})
                    .slice(0, 3)
                    .map(([table, n]) => `${table} ${n}`)
                    .join(' · ')}
                />
              </FactsRow>
            )}
          </div>
        ) : (
          <Empty>{S.drillNever}</Empty>
        )}
      </Section>

      <Section title={S.recoveryNeedsTitle} description={S.recoveryNeedsExplainer}>
        <Rows>
          {S.recoveryNeeds.map((item) => (
            <Row key={item}>
              <span className="text-sm">{item}</span>
            </Row>
          ))}
        </Rows>
        <pre className="overflow-x-auto rounded-lg bg-ink px-4 py-3 font-mono text-[12px] leading-[1.6] text-ink-foreground">{S.recoveryCommand}</pre>
      </Section>
    </>
  )
}
