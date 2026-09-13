import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { api, ApiError, type DeployStatus, type ImageProgress, type PreflightCheck } from '../api'
import { S } from '../strings'
import { useOverview } from '../overview-context'
import { checkTone } from '@/lib/tones'
import { Field, Note, Page, PageHeader, Row, Rows, Section } from '@/components/page'
import { Pill } from '@/components/ui/pill'
import { SchemaForm, SecretFields, type ObjectSchema, type SecretDeclaration } from '@/components/module-form'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Confirm } from '@/components/confirm'
import { cn } from '@/lib/utils'

interface ModuleRow {
  id: string
  title: string
  summary: string
  required: boolean
  cost: { image: string; memory: string; cpus: string }
  enabled: boolean
  config: unknown
  configSchema: ObjectSchema | null
  secrets: SecretDeclaration[]
  resources: { memory: string; cpus: string; defaultMemory: string; defaultCpus: string }
}

interface Settings {
  bindAddress: string
  appPort: number
  timezone: string
  defaultLanguage: 'ar' | 'en'
}

/**
 * The install-and-update surface as ordered sections: every section shows
 * its state, works on a fresh box and on a running one, and the order on the
 * page is the order that makes sense to do them in. A wizard that locks steps
 * is wrong the day you need step 4 alone.
 */
type Tab = 'release' | 'modules' | 'configuration'
const TABS: Tab[] = ['release', 'modules', 'configuration']

export function Deploy() {
  const { data, refresh } = useOverview()
  const location = useLocation()
  const navigate = useNavigate()
  const tab = (TABS.find((t) => location.pathname === `/deploy/${t}`) ?? 'release') as Tab
  const [error, setError] = useState<string | null>(null)
  const [deploying, setDeploying] = useState(false)
  const onChanged = useCallback(() => void refresh(), [refresh])

  return (
    <Page>
      <PageHeader title={S.deployTitle} description={S.deployPageExplainer}>
        <Tabs value={tab} onValueChange={(next) => navigate(next === 'release' ? '/deploy' : `/deploy/${next}`)}>
          <TabsList>
            <TabsTrigger value="release">{S.tabRelease}</TabsTrigger>
            <TabsTrigger value="modules">{S.tabModules}</TabsTrigger>
            <TabsTrigger value="configuration">{S.tabConfiguration}</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>
      {error && <Note tone="destructive">{error}</Note>}
      {tab === 'release' && (
        <>
          <VersionSection
            running={data.runningVersion}
            version={data.version}
            previousVersion={data.previousVersion}
            deploying={deploying}
            onError={setError}
            onChanged={onChanged}
          />
          <PreflightSection />
          <DeploySection version={data.runningVersion ?? data.version} onChanged={onChanged} onRunning={setDeploying} />
        </>
      )}
      {tab === 'modules' && <ModulesSection onError={setError} onChanged={onChanged} />}
      {tab === 'configuration' && <SettingsSection onError={setError} onChanged={onChanged} />}
    </Page>
  )
}

function VersionSection({
  running,
  version,
  previousVersion,
  deploying,
  onError,
  onChanged,
}: {
  running: string | null
  version: string
  previousVersion: string | null
  deploying: boolean
  onError: (message: string | null) => void
  onChanged: () => void
}) {
  const [available, setAvailable] = useState<string[]>([])
  const [detail, setDetail] = useState<string | null>(null)
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)

  useEffect(() => {
    void api
      .get<{ versions: string[]; detail?: string }>('/api/versions')
      .then((data) => {
        setAvailable(data.versions)
        setDetail(data.detail ?? null)
      })
      .catch(() => undefined)
  }, [])

  async function act(url: string, body?: unknown) {
    setBusy(true)
    onError(null)
    try {
      await api.post(url, body)
      setChosen('')
      onChanged()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  const drift = running !== null && version !== 'latest' && running !== version

  return (
    <Section title={S.versionTitle}>
      <div className="grid grid-cols-3 gap-6 py-1">
        <Mini eyebrow={S.versionRunning} value={running ?? S.notRunning} />
        <Mini eyebrow={S.versionCurrent} value={version} note={drift ? S.versionNotDeployed : undefined} />
        <Mini eyebrow={S.versionPrevious} value={previousVersion ?? '—'} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {available.length > 0 ? (
          <Select value={chosen} onValueChange={setChosen}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder={S.versionChoose} />
            </SelectTrigger>
            <SelectContent>
              {available.map((tag) => (
                <SelectItem key={tag} value={tag}>
                  {tag}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input className="w-44" value={chosen} onChange={(event) => setChosen(event.target.value)} placeholder={S.versionChoose} />
        )}
        <Button disabled={busy || deploying || !chosen} onClick={() => act('/api/version', { version: chosen })}>
          {S.versionSet}
        </Button>
        {previousVersion && (
          <Button variant="outline" disabled={busy || deploying} onClick={() => setRollingBack(true)}>
            {S.versionRollback}
          </Button>
        )}
      </div>
      {available.length === 0 && detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      {previousVersion && <p className="max-w-[70ch] text-xs text-muted-foreground">{S.versionRollbackWarn}</p>}
      <Confirm
        open={rollingBack}
        title={S.versionRollback}
        body={
          <>
            <p>
              {S.versionCurrent}: {version} → {previousVersion}. {S.rollbackBody}
            </p>
            <p>{S.versionRollbackWarn}</p>
          </>
        }
        confirmLabel={S.versionRollback}
        busy={busy}
        onConfirm={() => {
          setRollingBack(false)
          void act('/api/rollback')
        }}
        onClose={() => setRollingBack(false)}
      />
    </Section>
  )
}

function Mini({ eyebrow, value, note }: { eyebrow: string; value: string; note?: string | undefined }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{eyebrow}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="font-mono text-base font-medium">{value}</span>
        {note && <span className="text-xs text-warning">{note}</span>}
      </div>
    </div>
  )
}

function PreflightSection() {
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    try {
      const data = await api.get<{ checks: PreflightCheck[] }>('/api/preflight')
      setChecks(data.checks)
    } finally {
      setBusy(false)
    }
  }

  const blocked = checks?.some((check) => check.status === 'fail') ?? false

  return (
    <Section
      title={S.preflightTitle}
      description={S.preflightExplainer}
      actions={
        <Button variant="outline" size="sm" disabled={busy} onClick={run}>
          {busy ? S.workingEllipsis : S.preflightRun}
        </Button>
      }
    >
      {checks && (
        <Rows>
          {checks.map((check) => (
            <Row key={check.id}>
              <Pill tone={checkTone(check.status)} dot className="w-16 justify-center">
                {check.status}
              </Pill>
              <span className="font-medium">{check.title}</span>
              <span className="min-w-0 truncate text-muted-foreground" title={check.detail}>
                {check.detail}
              </span>
            </Row>
          ))}
        </Rows>
      )}
      {blocked && <Note tone="destructive">{S.preflightBlocked}</Note>}
    </Section>
  )
}

function DeploySection({
  version,
  onChanged,
  onRunning,
}: {
  version: string
  onChanged: () => void
  onRunning: (running: boolean) => void
}) {
  const [status, setStatus] = useState<DeployStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const poll = useCallback(async () => {
    const data = await api.get<DeployStatus | null>('/api/deploy').catch(() => null)
    setStatus(data)
    onRunning(data?.running ?? false)
    return data
  }, [onRunning])

  useEffect(() => {
    void poll()
  }, [poll])

  useEffect(() => {
    if (!status?.running) return
    const timer = setInterval(async () => {
      const next = await poll()
      if (next && !next.running) {
        onChanged()
        if (next.ok === true) toast.success(S.toastDeployDone)
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [status?.running, poll, onChanged])

  // Follow the log while it grows — the interesting line is always the newest one.
  useEffect(() => {
    if (logRef.current && status?.running) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [status?.log, status?.running])

  async function start() {
    setConfirming(false)
    setError(null)
    try {
      await api.post('/api/deploy')
      await poll()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    }
  }

  return (
    <Section
      title={S.deployRunTitle}
      description={S.deployExplainer}
      actions={
        <Button size="sm" disabled={status?.running ?? false} onClick={() => setConfirming(true)}>
          {status?.running ? S.deployRunning : S.deployStart}
        </Button>
      }
    >
      {error && <Note tone="destructive">{error}</Note>}
      {status?.running && status.targetVersion && (
        <p className="text-sm text-muted-foreground">{S.deployRunningVersion(version, status.targetVersion)}</p>
      )}
      {status && !status.running && status.ok === true && <Note tone="success">{S.deployDone}</Note>}
      {status && !status.running && status.ok === false && <Note tone="destructive">{S.deployFailed}</Note>}

      {status?.step === 'pull' && status.images && status.images.length > 0 && (
        <div className="space-y-2">
          {status.images.map((img) => (
            <ImageRow key={img.image} img={img} />
          ))}
        </div>
      )}

      {status?.log && (
        <div ref={logRef} className="h-64 overflow-auto rounded-lg bg-ink px-4 py-3 text-ink-foreground">
          <pre className="font-mono text-[12px] leading-[1.6] whitespace-pre-wrap">{status.log}</pre>
        </div>
      )}

      <Confirm
        open={confirming}
        title={S.deployStart}
        body={<p>{S.deployConfirmBody}</p>}
        confirmLabel={S.deployStart}
        onConfirm={() => void start()}
        onClose={() => setConfirming(false)}
      />
    </Section>
  )
}

function ModulesSection({
  onError,
  onChanged,
}: {
  onError: (message: string | null) => void
  onChanged: () => void
}) {
  const [modules, setModules] = useState<ModuleRow[]>([])
  const [open, setOpen] = useState<ModuleRow | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void api
      .get<{ modules: ModuleRow[] }>('/api/modules')
      .then((data) => setModules(data.modules))
      .catch(() => undefined)
  }, [])
  useEffect(load, [load])

  async function toggle(module: ModuleRow) {
    setBusy(true)
    onError(null)
    try {
      await api.post(`/api/modules/${module.id}/${module.enabled ? 'disable' : 'enable'}`)
      load()
      onChanged()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={S.modulesTitle} description={S.modulesExplainer}>
      <Rows>
        {modules
          .filter((module) => !module.required)
          .map((module) => (
            <Row key={module.id} className="py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{module.title}</span>
                  <Pill tone={module.enabled ? 'success' : 'neutral'} dot={module.enabled} size="sm">
                    {module.enabled ? S.moduleOn : S.moduleOff}
                  </Pill>
                  <span className="text-xs text-muted-foreground">{module.cost.memory}</span>
                </div>
                <p className="mt-0.5 max-w-[60ch] text-xs text-muted-foreground">{module.summary}</p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                {(module.configSchema || module.secrets.length > 0) && (
                  <Button variant="outline" size="sm" onClick={() => setOpen(module)}>
                    {S.moduleConfigure}
                  </Button>
                )}
                <Button variant={module.enabled ? 'outline' : 'default'} size="sm" disabled={busy} onClick={() => toggle(module)}>
                  {module.enabled ? S.moduleDisable : S.moduleEnable}
                </Button>
              </div>
            </Row>
          ))}
      </Rows>
      <ModuleSheet
        module={open}
        onClose={() => setOpen(null)}
        onSaved={() => {
          load()
          onChanged()
        }}
      />
    </Section>
  )
}

/**
 * A module's configuration, in a sheet, so the page never reflows. The
 * database URL is not a module's secret and is left out of every module's
 * form: it belongs to the database, under Settings.
 */
function ModuleSheet({ module, onClose, onSaved }: { module: ModuleRow | null; onClose: () => void; onSaved: () => void }) {
  const [configDraft, setConfigDraft] = useState<Record<string, unknown>>({})
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({})
  const [memoryDraft, setMemoryDraft] = useState('')
  const [cpusDraft, setCpusDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!module) return
    setConfigDraft((module.config as Record<string, unknown>) ?? {})
    setSecretDraft({})
    setMemoryDraft(module.resources.memory)
    setCpusDraft(module.resources.cpus)
    setError(null)
  }, [module])

  async function save() {
    if (!module) return
    setBusy(true)
    setError(null)
    try {
      // Secrets first: a failed config save should not discard typed keys.
      if (Object.keys(secretDraft).length > 0) {
        await api.put(`/api/modules/${module.id}/secrets`, { values: secretDraft })
        setSecretDraft({})
      }
      if (module.configSchema) {
        await api.put(`/api/modules/${module.id}/config`, { config: configDraft })
      }
      if (memoryDraft !== module.resources.memory || cpusDraft !== module.resources.cpus) {
        await api.put(`/api/modules/${module.id}/resources`, { memory: memoryDraft, cpus: cpusDraft })
      }
      toast.success(S.moduleConfigSaved)
      onSaved()
      onClose()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  const secrets = module?.secrets.filter((secret) => secret.name !== 'DATABASE_URL') ?? []

  return (
    <Sheet open={module !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{module?.title}</SheetTitle>
          <SheetDescription>{module?.summary}</SheetDescription>
        </SheetHeader>
        {module && (
          <div className="space-y-8 px-4 pb-6">
            {error && <Note tone="destructive">{error}</Note>}
            {secrets.length > 0 && <SecretFields secrets={secrets} values={secretDraft} onChange={setSecretDraft} />}
            {module.configSchema && <SchemaForm schema={module.configSchema} value={configDraft} onChange={setConfigDraft} />}
            <div className="space-y-3">
              <h3 className="text-sm font-medium">{S.moduleResources}</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={S.moduleMemory}>
                  <Input value={memoryDraft} onChange={(e) => setMemoryDraft(e.target.value)} placeholder={module.resources.defaultMemory} />
                </Field>
                <Field label={S.moduleCpus}>
                  <Input value={cpusDraft} onChange={(e) => setCpusDraft(e.target.value)} placeholder={module.resources.defaultCpus} />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">
                {S.moduleResourceHint(module.resources.defaultMemory, module.resources.defaultCpus)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? S.workingEllipsis : S.moduleConfigSave}
              </Button>
              <Button variant="ghost" onClick={onClose}>
                {S.cancel}
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function SettingsSection({
  onError,
  onChanged,
}: {
  onError: (message: string | null) => void
  onChanged: () => void
}) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api
      .get<{ settings: Settings }>('/api/settings')
      .then((data) => setSettings(data.settings))
      .catch(() => undefined)
  }, [])

  if (!settings) return null

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    onError(null)
    try {
      await api.put('/api/settings', {
        bindAddress: settings!.bindAddress,
        appPort: Number(settings!.appPort),
        timezone: settings!.timezone,
        defaultLanguage: settings!.defaultLanguage,
      })
      toast.success(S.settingsSaved)
      onChanged()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={S.settingsTitle} description={S.settingsExplainer}>
      <form onSubmit={save} className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={S.settingsBindAddress} help={S.settingsBindAddressHint}>
            <Input value={settings.bindAddress} onChange={(event) => setSettings({ ...settings, bindAddress: event.target.value })} />
          </Field>
          <Field label={S.settingsAppPort}>
            <Input
              type="number"
              value={settings.appPort}
              onChange={(event) => setSettings({ ...settings, appPort: Number(event.target.value) })}
            />
          </Field>
          <Field label={S.settingsTimezone}>
            <Input value={settings.timezone} onChange={(event) => setSettings({ ...settings, timezone: event.target.value })} />
          </Field>
          <Field label={S.settingsLanguage}>
            <Select value={settings.defaultLanguage} onValueChange={(next) => setSettings({ ...settings, defaultLanguage: next as 'ar' | 'en' })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ar">العربية</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? S.workingEllipsis : S.settingsSave}
        </Button>
      </form>
    </Section>
  )
}

function formatMB(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

function ImageRow({ img }: { img: ImageProgress }) {
  const label = img.image.split('/').pop() ?? img.image
  const stateText =
    img.state === 'done'
      ? S.imgDone
      : img.state === 'failed'
        ? S.imgFailed
        : img.state === 'stalled'
          ? S.imgStalled
          : img.state === 'extracting'
            ? S.imgExtracting
            : img.state === 'downloading'
              ? S.imgDownloading
              : S.imgWaiting
  const bad = img.state === 'stalled' || img.state === 'failed'
  const pct = img.percent >= 0 ? img.percent : img.state === 'done' ? 100 : 0

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono">{label}</span>
        <span className={bad ? 'text-destructive' : img.state === 'done' ? 'text-success' : 'text-muted-foreground'}>
          {img.total > 0 && img.state !== 'done' ? `${formatMB(img.downloaded)} / ${formatMB(img.total)} · ${stateText}` : stateText}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full transition-all', bad ? 'bg-destructive' : img.state === 'done' ? 'bg-success' : 'bg-foreground')}
          style={{ width: `${img.state === 'stalled' ? 100 : pct}%` }}
        />
      </div>
    </div>
  )
}
