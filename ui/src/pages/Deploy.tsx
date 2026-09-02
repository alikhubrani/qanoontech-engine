import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type DeployStatus, type PreflightCheck } from '../api'
import { Badge, Button, Card, ErrorNote, Input } from '../components'
import { S } from '../strings'

interface ModuleRow {
  id: string
  title: string
  summary: string
  required: boolean
  cost: { image: string; memory: string; cpus: string }
  enabled: boolean
  config: unknown
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

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-brand-dark">{S.deployTitle}</h1>
      {error && <ErrorNote>{error}</ErrorNote>}
      <RegistrySection onError={setError} />
      <SettingsSection onError={setError} onChanged={onChanged} />
      <ModulesSection onError={setError} onChanged={onChanged} />
      <VersionSection
        version={version}
        previousVersion={previousVersion}
        onError={setError}
        onChanged={onChanged}
      />
      <PreflightSection />
      <DeploySection onChanged={onChanged} />
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
    <Card title={S.registryTitle}>
      <form onSubmit={save} className="space-y-3">
        <p className="text-sm text-slate-500">{S.registryExplainer}</p>
        {configuredAs && <p className="text-sm text-ok">{S.registryConfigured(configuredAs)}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={S.registryUsername}
            autoComplete="off"
          />
          <Input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={S.registryToken}
            autoComplete="off"
          />
        </div>
        {notice && <p className="text-sm text-slate-500">{notice}</p>}
        <Button variant="primary" type="submit" disabled={busy || !username || !token}>
          {busy ? S.workingEllipsis : S.registrySave}
        </Button>
      </form>
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
      onChanged()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={S.settingsTitle}>
      <form onSubmit={save} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-500">{S.settingsBindAddress}</span>
            <Input
              value={settings.bindAddress}
              onChange={(event) => setSettings({ ...settings, bindAddress: event.target.value })}
            />
            <span className="block text-xs text-slate-400">{S.settingsBindAddressHint}</span>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-500">{S.settingsAppPort}</span>
            <Input
              type="number"
              value={settings.appPort}
              onChange={(event) => setSettings({ ...settings, appPort: Number(event.target.value) })}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-500">{S.settingsTimezone}</span>
            <Input
              value={settings.timezone}
              onChange={(event) => setSettings({ ...settings, timezone: event.target.value })}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-500">{S.settingsLanguage}</span>
            <select
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={settings.defaultLanguage}
              onChange={(event) =>
                setSettings({ ...settings, defaultLanguage: event.target.value as 'ar' | 'en' })
              }
            >
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        {saved && <p className="text-sm text-ok">{S.settingsSaved}</p>}
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? S.workingEllipsis : S.settingsSave}
        </Button>
      </form>
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
  const [configFor, setConfigFor] = useState<string | null>(null)
  const [configText, setConfigText] = useState('')
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

  async function saveConfig(id: string) {
    setBusy(true)
    onError(null)
    try {
      const parsed: unknown = JSON.parse(configText)
      await api.put(`/api/modules/${id}/config`, { config: parsed })
      setConfigFor(null)
      load()
      onChanged()
    } catch (caught) {
      onError(
        caught instanceof ApiError
          ? caught.message
          : caught instanceof SyntaxError
            ? 'That is not valid JSON.'
            : S.errorGeneric,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={S.modulesTitle}>
      <p className="mb-3 text-sm text-slate-500">{S.modulesExplainer}</p>
      <ul className="space-y-2">
        {modules
          .filter((module) => !module.required)
          .map((module) => (
            <li key={module.id} className="rounded-md border border-slate-100 p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">{module.title}</span>
                    <Badge tone={module.enabled ? 'ok' : 'muted'}>
                      {module.enabled ? 'on' : 'off'}
                    </Badge>
                    <span className="text-xs text-slate-400">{module.cost.image}</span>
                  </div>
                  <p className="mt-0.5 text-sm text-slate-500">{module.summary}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    onClick={() => {
                      setConfigFor(configFor === module.id ? null : module.id)
                      setConfigText(JSON.stringify(module.config ?? {}, null, 2))
                    }}
                  >
                    {S.moduleConfigure}
                  </Button>
                  <Button
                    variant={module.enabled ? 'danger' : 'primary'}
                    disabled={busy}
                    onClick={() => toggle(module)}
                  >
                    {module.enabled ? S.moduleDisable : S.moduleEnable}
                  </Button>
                </div>
              </div>
              {configFor === module.id && (
                <div className="mt-3 space-y-2">
                  <textarea
                    className="h-24 w-full rounded-md border border-slate-300 p-3 font-mono text-xs"
                    value={configText}
                    onChange={(event) => setConfigText(event.target.value)}
                  />
                  <Button variant="primary" disabled={busy} onClick={() => saveConfig(module.id)}>
                    {S.moduleConfigSave}
                  </Button>
                </div>
              )}
            </li>
          ))}
      </ul>
    </Card>
  )
}

function VersionSection({
  version,
  previousVersion,
  onError,
  onChanged,
}: {
  version: string
  previousVersion: string | null
  onError: (message: string | null) => void
  onChanged: () => void
}) {
  const [available, setAvailable] = useState<string[]>([])
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api
      .get<{ versions: string[] }>('/api/versions')
      .then((data) => setAvailable(data.versions))
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
    <Card title={S.versionTitle}>
      <div className="space-y-3 text-sm">
        <p>
          <span className="text-slate-400">{S.versionCurrent}: </span>
          <span className="font-mono font-semibold text-brand-dark">{version}</span>
          {previousVersion && (
            <span className="ml-4 text-slate-400">
              {S.versionPrevious}: <span className="font-mono">{previousVersion}</span>
            </span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {available.length > 0 ? (
            <select
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
            >
              <option value="">{S.versionChoose}</option>
              {available.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          ) : (
            <Input
              className="w-40"
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
              placeholder={S.versionChoose}
            />
          )}
          <Button
            variant="primary"
            disabled={busy || !chosen}
            onClick={() => act('/api/version', { version: chosen })}
          >
            {S.versionSet}
          </Button>
          {previousVersion && (
            <Button variant="danger" disabled={busy} onClick={() => act('/api/rollback')}>
              {S.versionRollback}
            </Button>
          )}
        </div>
        {previousVersion && <p className="text-xs text-slate-400">{S.versionRollbackWarn}</p>}
      </div>
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
    <Card title={S.preflightTitle}>
      <div className="space-y-3">
        <Button disabled={busy} onClick={run}>
          {busy ? S.workingEllipsis : S.preflightRun}
        </Button>
        {checks && (
          <ul className="space-y-1.5 text-sm">
            {checks.map((check) => (
              <li key={check.id} className="flex items-baseline gap-2">
                <Badge tone={check.status === 'pass' ? 'ok' : check.status === 'warn' ? 'warn' : 'bad'}>
                  {check.status}
                </Badge>
                <span className="font-medium text-slate-700">{check.title}</span>
                <span className="text-slate-500">{check.detail}</span>
              </li>
            ))}
          </ul>
        )}
        {blocked && <ErrorNote>{S.preflightBlocked}</ErrorNote>}
      </div>
    </Card>
  )
}

function DeploySection({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<DeployStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const poll = useCallback(async () => {
    const data = await api.get<DeployStatus | null>('/api/deploy').catch(() => null)
    setStatus(data)
    return data
  }, [])

  useEffect(() => {
    void poll()
  }, [poll])

  useEffect(() => {
    if (!status?.running) return
    const timer = setInterval(async () => {
      const next = await poll()
      if (next && !next.running) onChanged()
    }, 2000)
    return () => clearInterval(timer)
  }, [status?.running, poll, onChanged])

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
    <Card title={S.deployRunTitle}>
      <div className="space-y-3">
        <p className="text-sm text-slate-500">{S.deployExplainer}</p>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={status?.running ?? false} onClick={start}>
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
          <pre className="max-h-80 overflow-auto rounded-md bg-slate-900 p-4 font-mono text-xs leading-relaxed text-slate-100">
            {status.log}
          </pre>
        )}
      </div>
    </Card>
  )
}
