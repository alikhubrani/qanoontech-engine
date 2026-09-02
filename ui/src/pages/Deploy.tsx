import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { api, ApiError, type DeployStatus, type PreflightCheck } from '../api'
import { S } from '../strings'
import { ErrorNote, StatusBadge } from '@/components/status'
import {
  SchemaForm,
  SecretFields,
  type ObjectSchema,
  type SecretDeclaration,
} from '@/components/module-form'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'

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
}

interface Settings {
  bindAddress: string
  appPort: number
  timezone: string
  defaultLanguage: 'ar' | 'en'
}

/**
 * The whole install-and-update surface, as ordered sections rather than a
 * modal wizard: every section shows its state, works on a fresh box and on a
 * running one, and the order on the page is the order that makes sense to do
 * them in. A wizard that locks steps is wrong the day you need step 4 alone.
 */
export function Deploy({
  version,
  previousVersion,
  onChanged,
}: {
  version: string
  previousVersion: string | null
  onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [deploying, setDeploying] = useState(false)

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      {error && <ErrorNote>{error}</ErrorNote>}
      <RegistrySection onError={setError} />
      <SettingsSection onError={setError} onChanged={onChanged} />
      <ModulesSection onError={setError} onChanged={onChanged} />
      <VersionSection
        version={version}
        previousVersion={previousVersion}
        deploying={deploying}
        onError={setError}
        onChanged={onChanged}
      />
      <PreflightSection />
      <DeploySection onChanged={onChanged} onRunning={setDeploying} />
    </div>
  )
}

function RegistrySection({ onError }: { onError: (message: string | null) => void }) {
  const [configuredAs, setConfiguredAs] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void api
      .get<{ configured: boolean; username: string | null }>('/api/registry')
      .then((data) => setConfiguredAs(data.username))
      .catch(() => undefined)
  }, [])

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    onError(null)
    try {
      const result = await api.put<{ detail: string }>('/api/registry', { username, token })
      setNotice(result.detail)
      setConfiguredAs(username)
      setToken('')
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{S.registryTitle}</CardTitle>
        <CardDescription>{S.registryExplainer}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-3">
          {configuredAs && <p className="text-sm text-ok">{S.registryConfigured(configuredAs)}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="reg-user">{S.registryUsername}</Label>
              <Input
                id="reg-user"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reg-token">{S.registryToken}</Label>
              <Input
                id="reg-token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
          <Button type="submit" disabled={busy || !username || !token}>
            {busy ? S.workingEllipsis : S.registrySave}
          </Button>
        </form>
      </CardContent>
    </Card>
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
  const [saved, setSaved] = useState(false)

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
    setSaved(false)
    try {
      await api.put('/api/settings', {
        bindAddress: settings!.bindAddress,
        appPort: Number(settings!.appPort),
        timezone: settings!.timezone,
        defaultLanguage: settings!.defaultLanguage,
      })
      setSaved(true)
      toast.success(S.settingsSaved)
      onChanged()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{S.settingsTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{S.settingsBindAddress}</Label>
              <Input
                value={settings.bindAddress}
                onChange={(event) => setSettings({ ...settings, bindAddress: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{S.settingsBindAddressHint}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{S.settingsAppPort}</Label>
              <Input
                type="number"
                value={settings.appPort}
                onChange={(event) =>
                  setSettings({ ...settings, appPort: Number(event.target.value) })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>{S.settingsTimezone}</Label>
              <Input
                value={settings.timezone}
                onChange={(event) => setSettings({ ...settings, timezone: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{S.settingsLanguage}</Label>
              <Select
                value={settings.defaultLanguage}
                onValueChange={(next) =>
                  setSettings({ ...settings, defaultLanguage: next as 'ar' | 'en' })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ar">العربية</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {saved && <p className="text-sm text-ok">{S.settingsSaved}</p>}
          <Button type="submit" disabled={busy}>
            {busy ? S.workingEllipsis : S.settingsSave}
          </Button>
        </form>
      </CardContent>
    </Card>
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
  const [open, setOpen] = useState<string | null>(null)
  const [configDraft, setConfigDraft] = useState<Record<string, unknown>>({})
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

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

  function openConfig(module: ModuleRow) {
    if (open === module.id) {
      setOpen(null)
      return
    }
    setOpen(module.id)
    setSaved(false)
    setConfigDraft((module.config as Record<string, unknown>) ?? {})
    setSecretDraft({})
  }

  async function save(module: ModuleRow) {
    setBusy(true)
    onError(null)
    setSaved(false)
    try {
      // Secrets first: a failed config save should not discard typed keys.
      if (Object.keys(secretDraft).length > 0) {
        await api.put(`/api/modules/${module.id}/secrets`, { values: secretDraft })
        setSecretDraft({})
      }
      if (module.configSchema) {
        await api.put(`/api/modules/${module.id}/config`, { config: configDraft })
      }
      setSaved(true)
      toast.success(S.moduleConfigSaved)
      load()
      onChanged()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{S.modulesTitle}</CardTitle>
        <CardDescription>{S.modulesExplainer}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {modules
            .filter((module) => !module.required)
            .map((module) => (
              <li key={module.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{module.title}</span>
                      <StatusBadge tone={module.enabled ? 'ok' : 'muted'}>
                        {module.enabled ? 'on' : 'off'}
                      </StatusBadge>
                      <span className="text-xs text-muted-foreground">{module.cost.image}</span>
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">{module.summary}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {(module.configSchema || module.secrets.length > 0) && (
                      <Button variant="outline" size="sm" onClick={() => openConfig(module)}>
                        {S.moduleConfigure}
                      </Button>
                    )}
                    <Button
                      variant={module.enabled ? 'destructive' : 'default'}
                      size="sm"
                      disabled={busy}
                      onClick={() => toggle(module)}
                    >
                      {module.enabled ? S.moduleDisable : S.moduleEnable}
                    </Button>
                  </div>
                </div>
                {open === module.id && (
                  <div className="mt-4 space-y-4">
                    <Separator />
                    {module.secrets.length > 0 && (
                      <SecretFields
                        secrets={module.secrets}
                        values={secretDraft}
                        onChange={setSecretDraft}
                      />
                    )}
                    {module.configSchema && (
                      <SchemaForm
                        schema={module.configSchema}
                        value={configDraft}
                        onChange={setConfigDraft}
                      />
                    )}
                    <div className="flex items-center gap-3">
                      <Button size="sm" disabled={busy} onClick={() => save(module)}>
                        {busy ? S.workingEllipsis : S.moduleConfigSave}
                      </Button>
                      {saved && <span className="text-sm text-ok">{S.moduleConfigSaved}</span>}
                    </div>
                  </div>
                )}
              </li>
            ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function VersionSection({
  version,
  previousVersion,
  deploying,
  onError,
  onChanged,
}: {
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
      onChanged()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{S.versionTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          <span className="text-muted-foreground">{S.versionCurrent}: </span>
          <span className="font-mono font-semibold">{version}</span>
          {previousVersion && (
            <span className="ml-4 text-muted-foreground">
              {S.versionPrevious}: <span className="font-mono">{previousVersion}</span>
            </span>
          )}
        </p>
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
            <Input
              className="w-44"
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
              placeholder={S.versionChoose}
            />
          )}
          <Button
            disabled={busy || deploying || !chosen}
            onClick={() => act('/api/version', { version: chosen })}
          >
            {S.versionSet}
          </Button>
          {previousVersion && (
            <Button variant="outline" disabled={busy || deploying} onClick={() => act('/api/rollback')}>
              {S.versionRollback}
            </Button>
          )}
        </div>
        {available.length === 0 && detail && (
          <p className="text-xs text-muted-foreground">{detail}</p>
        )}
        {previousVersion && <p className="text-xs text-muted-foreground">{S.versionRollbackWarn}</p>}
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>{S.preflightTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button variant="outline" disabled={busy} onClick={run}>
          {busy ? S.workingEllipsis : S.preflightRun}
        </Button>
        {checks && (
          <ul className="space-y-1.5 text-sm">
            {checks.map((check) => (
              <li key={check.id} className="flex items-baseline gap-2">
                <StatusBadge
                  tone={check.status === 'pass' ? 'ok' : check.status === 'warn' ? 'warn' : 'bad'}
                >
                  {check.status}
                </StatusBadge>
                <span className="font-medium">{check.title}</span>
                <span className="text-muted-foreground">{check.detail}</span>
              </li>
            ))}
          </ul>
        )}
        {blocked && <ErrorNote>{S.preflightBlocked}</ErrorNote>}
      </CardContent>
    </Card>
  )
}

function DeploySection({
  onChanged,
  onRunning,
}: {
  onChanged: () => void
  onRunning: (running: boolean) => void
}) {
  const [status, setStatus] = useState<DeployStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
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

  // Follow the log while it grows — the operator is watching a deploy, and
  // the interesting line is always the newest one.
  useEffect(() => {
    const viewport = logRef.current?.querySelector('[data-slot="scroll-area-viewport"]')
    if (viewport && status?.running) viewport.scrollTop = viewport.scrollHeight
  }, [status?.log, status?.running])

  async function start() {
    setError(null)
    try {
      await api.post('/api/deploy')
      await poll()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{S.deployRunTitle}</CardTitle>
        <CardDescription>{S.deployExplainer}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex items-center gap-3">
          <Button disabled={status?.running ?? false} onClick={start}>
            {status?.running ? S.deployRunning : S.deployStart}
          </Button>
          {status && !status.running && status.ok === true && (
            <span className="text-sm text-ok">{S.deployDone}</span>
          )}
          {status && !status.running && status.ok === false && (
            <span className="text-sm text-bad">{S.deployFailed}</span>
          )}
        </div>
        {status?.log && (
          <ScrollArea ref={logRef} className="h-80 rounded-lg bg-brand-dark p-4">
            <pre className="font-mono text-xs leading-relaxed text-slate-100">{status.log}</pre>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
