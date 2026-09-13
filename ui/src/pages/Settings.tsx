import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  api,
  ApiError,
  type AlertsStatus,
  type AuthStatus,
  type DatabaseProof,
  type DatabaseStatus,
  type SecretEntry,
} from '../api'
import { S } from '../strings'
import { useOverview } from '../overview-context'
import { ago, exact, when } from '@/lib/time'
import { Empty, Fact, FactsRow, Field, Note, Page, PageHeader, Row, Rows, Section } from '@/components/page'
import { Pill } from '@/components/ui/pill'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Confirm } from '@/components/confirm'
import { RowMenu } from '@/components/row-menu'

type Tab = 'sign-in' | 'database' | 'registry' | 'credentials' | 'alerts' | 'engine'
const TABS: Tab[] = ['sign-in', 'database', 'registry', 'credentials', 'alerts', 'engine']

/**
 * Settings: who may sign in, where the database is, the pull credential,
 * every credential by name, the alert address, and the engine itself. Each
 * tab is the panel's side of a CLI command group, and the one guard that
 * matters — you cannot remove yourself from the allow-list — is the server's.
 */
export function Settings() {
  const location = useLocation()
  const navigate = useNavigate()
  const tab = (TABS.find((t) => location.pathname === `/settings/${t}`) ?? 'sign-in') as Tab
  const [error, setError] = useState<string | null>(null)

  return (
    <Page>
      <PageHeader title={S.navSettings} description={S.settingsPageExplainer}>
        <Tabs value={tab} onValueChange={(next) => navigate(next === 'sign-in' ? '/settings' : `/settings/${next}`)}>
          <TabsList>
            <TabsTrigger value="sign-in">{S.tabSignIn}</TabsTrigger>
            <TabsTrigger value="database">{S.tabDatabase}</TabsTrigger>
            <TabsTrigger value="registry">{S.tabRegistry}</TabsTrigger>
            <TabsTrigger value="credentials">{S.tabCredentials}</TabsTrigger>
            <TabsTrigger value="alerts">{S.tabAlerts}</TabsTrigger>
            <TabsTrigger value="engine">{S.tabEngine}</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>
      {error && <Note tone="destructive">{error}</Note>}
      {tab === 'sign-in' && <SignInTab onError={setError} />}
      {tab === 'database' && <DatabaseTab onError={setError} />}
      {tab === 'registry' && <RegistryTab onError={setError} />}
      {tab === 'credentials' && <CredentialsTab onError={setError} />}
      {tab === 'alerts' && <AlertsTab onError={setError} />}
      {tab === 'engine' && (
        <>
          <PublicUrlSection onError={setError} />
          <EngineTab />
        </>
      )}
    </Page>
  )
}

// -- Sign-in ----------------------------------------------------------------

function SignInTab({ onError }: { onError: (message: string | null) => void }) {
  const { refresh } = useOverview()
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [redirect, setRedirect] = useState('')
  const [ids, setIds] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const load = useCallback(() => {
    void api
      .get<AuthStatus>('/api/auth')
      .then((data) => {
        setStatus(data)
        setRedirect(data.redirectUri)
        setIds(data.allowedObjectIds.join('\n'))
      })
      .catch(() => undefined)
  }, [])
  useEffect(load, [load])

  if (!status) return null

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    onError(null)
    try {
      const allowedObjectIds = ids.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
      const body: Record<string, unknown> = { redirectUri: redirect, allowedObjectIds }
      if (secret) body['clientSecret'] = secret
      const result = await api.put<{ restartNeeded: boolean }>('/api/auth', body)
      setSecret('')
      toast.success(result.restartNeeded ? S.authSavedRestart : S.settingsSaved)
      load()
      void refresh()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  async function signOutEveryone() {
    setSigningOut(false)
    try {
      await api.post('/api/auth/sign-out-everyone')
    } finally {
      window.location.assign('/')
    }
  }

  return (
    <>
      <Section title={S.authTitle} description={S.authExplainer}>
        <FactsRow className="border-t-0 pt-0 md:grid-cols-3">
          <Fact eyebrow={S.authTenant} figure={false} value={<span className="font-mono text-sm">{status.tenantId || S.notSet}</span>} />
          <Fact eyebrow={S.authClient} figure={false} value={<span className="font-mono text-sm">{status.clientId || S.notSet}</span>} />
          <Fact eyebrow={S.authSecret} figure={false} value={status.clientSecretSet ? S.secretSet : S.notSet} tone={status.clientSecretSet ? 'success' : 'warning'} />
        </FactsRow>
        <form onSubmit={save} className="space-y-5">
          <Field label={S.authRedirect} help={S.authRedirectHelp}>
            <Input value={redirect} onChange={(e) => setRedirect(e.target.value)} placeholder="https://portal.example.com/api/session/entra/callback" autoComplete="off" />
          </Field>
          <Field label={S.authAllowed} help={status.me ? S.authAllowedHelp(status.me.upn || status.me.oid) : S.authAllowedNoSubject}>
            <Textarea className="h-24 font-mono text-xs" value={ids} onChange={(e) => setIds(e.target.value)} />
          </Field>
          <Field
            label={
              <span className="flex items-center gap-2">
                {S.authClientSecret}
                {status.clientSecretSet && <Pill tone="success" size="sm" dot>{S.secretSet}</Pill>}
              </span>
            }
            help={S.authClientSecretHelp}
          >
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={status.clientSecretSet ? S.secretReplacePlaceholder : ''} autoComplete="off" />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? S.workingEllipsis : S.settingsSave}
          </Button>
        </form>
      </Section>
      <Section
        title={S.signOutEveryoneTitle}
        description={S.signOutEveryoneExplainer}
        actions={
          <Button variant="outline" size="sm" onClick={() => setSigningOut(true)}>
            {S.signOutEveryone}
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">{S.signOutEveryoneNote}</p>
      </Section>
      <Confirm
        open={signingOut}
        title={S.signOutEveryone}
        body={<p>{S.signOutEveryoneConfirm}</p>}
        confirmLabel={S.signOutEveryone}
        danger
        onConfirm={() => void signOutEveryone()}
        onClose={() => setSigningOut(false)}
      />
    </>
  )
}

// -- Database ---------------------------------------------------------------

function DatabaseTab({ onError }: { onError: (message: string | null) => void }) {
  const { refresh } = useOverview()
  const [status, setStatus] = useState<DatabaseStatus | null>(null)
  const [url, setUrl] = useState('')
  const [proof, setProof] = useState<DatabaseProof | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<'use' | 'local' | null>(null)

  const load = useCallback(() => {
    setStatus(null)
    void api.get<DatabaseStatus>('/api/database').then(setStatus).catch(() => undefined)
  }, [])
  useEffect(load, [load])

  async function test() {
    setBusy(true)
    onError(null)
    try {
      setProof(await api.post<DatabaseProof>('/api/database/test', { url }))
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  async function use() {
    setConfirming(null)
    setBusy(true)
    onError(null)
    try {
      await api.put('/api/database', { url })
      setUrl('')
      setProof(null)
      toast.success(S.databaseSwitched)
      load()
      void refresh()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  async function useLocal() {
    setConfirming(null)
    setBusy(true)
    onError(null)
    try {
      await api.delete('/api/database')
      toast.success(S.databaseSwitched)
      load()
      void refresh()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Section title={S.databaseTitle} description={S.databaseExplainer}>
        {status === null ? (
          <p className="text-sm text-muted-foreground">{S.databaseAsking}</p>
        ) : !status.ok ? (
          <Note tone="destructive">{status.detail}</Note>
        ) : (
          <FactsRow className="border-t-0 pt-0">
            <Fact eyebrow={S.databaseWhere} figure={false} value={status.external ? S.databaseExternal : S.databaseLocal} caption={`${status.host}:${status.port}/${status.dbName}`} />
            <Fact eyebrow={S.databaseServer} figure={false} value={status.server ?? S.databaseUnreachable} caption={status.reachable ? status.sslmode ? `sslmode=${status.sslmode}` : undefined : status.detail} tone={status.reachable ? 'success' : 'destructive'} />
            <Fact eyebrow={S.databaseTables} value={status.tables === null ? '—' : String(status.tables)} />
            <Fact eyebrow={S.databaseUser} figure={false} value={<span className="font-mono text-sm">{status.dbUser}</span>} />
          </FactsRow>
        )}
      </Section>

      <Section title={S.databaseSwitchTitle} description={S.databaseSwitchExplainer}>
        <Field label={S.databaseUrl} help={S.databaseUrlHelp}>
          <Input type="password" value={url} onChange={(e) => { setUrl(e.target.value); setProof(null) }} placeholder="postgresql://user:password@host:5432/dbname?sslmode=disable" autoComplete="off" />
        </Field>
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={busy || !url} onClick={() => void test()}>
            {busy ? S.workingEllipsis : S.databaseTest}
          </Button>
          <Button disabled={busy || !proof?.ok} onClick={() => setConfirming('use')}>
            {S.databaseUse}
          </Button>
          {status?.ok && status.external && (
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming('local')}>
              {S.databaseUseLocal}
            </Button>
          )}
        </div>
        {proof && <Note tone={proof.ok ? 'success' : 'destructive'}>{proof.detail}</Note>}
        <p className="text-xs text-muted-foreground">{S.databaseSwitchNote}</p>
      </Section>

      <Confirm
        open={confirming === 'use'}
        title={S.databaseUse}
        body={
          <>
            <p>{proof?.detail}</p>
            <p>{S.databaseUseConfirm}</p>
          </>
        }
        confirmLabel={S.databaseUse}
        onConfirm={() => void use()}
        onClose={() => setConfirming(null)}
      />
      <Confirm
        open={confirming === 'local'}
        title={S.databaseUseLocal}
        body={<p>{S.databaseUseLocalConfirm}</p>}
        confirmLabel={S.databaseUseLocal}
        danger
        onConfirm={() => void useLocal()}
        onClose={() => setConfirming(null)}
      />
    </>
  )
}

// -- Registry ---------------------------------------------------------------

function RegistryTab({ onError }: { onError: (message: string | null) => void }) {
  const { refresh } = useOverview()
  const [configuredAs, setConfiguredAs] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void api
      .get<{ configured: boolean; username: string | null }>('/api/registry')
      .then((data) => {
        setConfiguredAs(data.username)
        setEditing(data.username === null)
      })
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
      setEditing(false)
      void refresh()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title={S.registryTitle}
      description={S.registryExplainer}
      actions={
        configuredAs && !editing ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            {S.registryChange}
          </Button>
        ) : undefined
      }
    >
      {configuredAs && !editing ? (
        <p className="text-sm">{S.registryConfigured(configuredAs)}</p>
      ) : (
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={S.registryUsername} htmlFor="reg-user">
              <Input id="reg-user" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" />
            </Field>
            <Field label={S.registryToken} htmlFor="reg-token">
              <Input id="reg-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" />
            </Field>
          </div>
          {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !username || !token}>
              {busy ? S.workingEllipsis : S.registrySave}
            </Button>
            {configuredAs && (
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                {S.cancel}
              </Button>
            )}
          </div>
        </form>
      )}
    </Section>
  )
}

// -- Credentials ------------------------------------------------------------

function CredentialsTab({ onError }: { onError: (message: string | null) => void }) {
  const { refresh } = useOverview()
  const [list, setList] = useState<SecretEntry[] | null>(null)
  const [editing, setEditing] = useState<SecretEntry | null>(null)
  const [value, setValue] = useState('')
  const [removing, setRemoving] = useState<SecretEntry | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void api.get<{ secrets: SecretEntry[] }>('/api/secrets').then((data) => setList(data.secrets)).catch(() => undefined)
  }, [])
  useEffect(load, [load])

  async function save() {
    if (!editing) return
    setBusy(true)
    onError(null)
    try {
      await api.put(`/api/secrets/${editing.name}`, { value })
      toast.success(S.secretStored(editing.name))
      setEditing(null)
      setValue('')
      load()
      void refresh()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  async function remove(force: boolean) {
    if (!removing) return
    setBusy(true)
    onError(null)
    try {
      const result = await api.delete<{ detail: string }>(`/api/secrets/${removing.name}${force ? '?force=1' : ''}`)
      toast.success(`${S.secretRemoved(removing.name)} ${result.detail}`)
      setRemoving(null)
      load()
      void refresh()
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
      setRemoving(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Section title={S.credentialsTitle} description={S.credentialsExplainer}>
        {list === null ? null : list.length === 0 ? (
          <Empty>{S.credentialsEmpty}</Empty>
        ) : (
          <Rows>
            {list.map((secret) => (
              <Row key={secret.name}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{secret.name}</span>
                    {secret.set ? (
                      <Pill tone="success" size="sm" dot>
                        {S.secretSet}
                      </Pill>
                    ) : (
                      <Pill size="sm">{S.notSet}</Pill>
                    )}
                    {secret.generated && <Pill size="sm">{S.secretGenerated}</Pill>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[secret.title, secret.usedBy.length > 0 ? S.secretUsedBy(secret.usedBy.join(', ')) : S.secretUnused].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <RowMenu
                  actions={[
                    { label: secret.set ? S.secretReplace : S.secretSetAction, onSelect: () => { setEditing(secret); setValue('') } },
                    ...(secret.set ? [{ label: S.secretRemove, danger: true, onSelect: () => setRemoving(secret) }] : []),
                  ]}
                />
              </Row>
            ))}
          </Rows>
        )}
      </Section>

      {editing && (
        <Section title={editing.set ? S.secretReplace : S.secretSetAction} description={editing.name}>
          <Field label={S.secretValue} help={S.secretValueHelp}>
            <Textarea className="h-24 font-mono text-xs" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
          </Field>
          <div className="flex gap-2">
            <Button disabled={busy || !value.trim()} onClick={() => void save()}>
              {busy ? S.workingEllipsis : S.settingsSave}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {S.cancel}
            </Button>
          </div>
        </Section>
      )}

      <Confirm
        open={removing !== null}
        title={S.secretRemoveTitle(removing?.name ?? '')}
        body={
          <>
            <p>{removing?.inUse ? S.secretRemoveInUse(removing.usedBy.join(', ')) : S.secretRemoveBody}</p>
            <p>{S.secretRemoveSnapshotNote}</p>
          </>
        }
        confirmLabel={removing?.inUse ? S.secretRemoveAnyway : S.secretRemove}
        danger
        busy={busy}
        onConfirm={() => void remove(Boolean(removing?.inUse))}
        onClose={() => setRemoving(null)}
      />
    </>
  )
}

// -- Alerts -----------------------------------------------------------------

function AlertsTab({ onError }: { onError: (message: string | null) => void }) {
  const [status, setStatus] = useState<AlertsStatus | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api
      .get<AlertsStatus>('/api/alerts')
      .then((data) => {
        setStatus(data)
        setEmail(data.email)
      })
      .catch(() => undefined)
  }, [])

  if (!status) return null

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    onError(null)
    try {
      await api.put('/api/settings', { alertEmail: email.trim() })
      toast.success(S.settingsSaved)
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={S.alertsTitle} description={S.alertsExplainer}>
      <form onSubmit={save} className="space-y-5">
        <Field label={S.alertsEmail} help={S.alertsEmailHelp}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? S.workingEllipsis : S.settingsSave}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        {status.last ? S.alertsLast(status.last.level, when(status.last.sentAt), ago(status.last.sentAt)) : S.alertsNever}
      </p>
      {status.last && <span className="sr-only">{exact(status.last.sentAt)}</span>}
    </Section>
  )
}

// -- Engine -----------------------------------------------------------------

/**
 * The engine updating itself. The POST detaches a helper and this very server
 * is replaced under us, so the section watches GET /api/engine until the
 * reported version changes; an update whose pull fails leaves the old engine
 * answering on the old number, and saying so is the failure report.
 */
function PublicUrlSection({ onError }: { onError: (message: string | null) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api
      .get<{ settings: { publicUrl?: string } }>('/api/settings')
      .then((data) => setUrl(data.settings.publicUrl ?? ''))
      .catch(() => setUrl(''))
  }, [])

  if (url === null) return null

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    onError(null)
    try {
      await api.put('/api/settings', { publicUrl: (url ?? '').trim() })
      toast.success(S.settingsSaved)
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={S.publicUrlTitle} description={S.publicUrlExplainer}>
      <form onSubmit={save} className="space-y-5">
        <Field label={S.publicUrlLabel} help={S.publicUrlHelp}>
          <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoComplete="off" dir="ltr" />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? S.workingEllipsis : S.settingsSave}
        </Button>
      </form>
    </Section>
  )
}

function EngineTab() {
  const [running, setRunning] = useState<string | null>(null)
  const [available, setAvailable] = useState<string[]>([])
  const [detail, setDetail] = useState<string | null>(null)
  const [chosen, setChosen] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'updating' | 'done' | 'stuck'>('idle')

  useEffect(() => {
    void api
      .get<{ version: string; available: string[]; detail: string | null }>('/api/engine')
      .then((data) => {
        setRunning(data.version)
        setAvailable(data.available.filter((tag) => tag !== data.version))
        setDetail(data.detail)
      })
      .catch(() => undefined)
  }, [])

  async function update() {
    setConfirming(false)
    setPhase('updating')
    try {
      await api.post('/api/engine/update', { version: chosen })
    } catch {
      setPhase('stuck')
      return
    }
    const startedAt = Date.now()
    const timer = setInterval(async () => {
      try {
        const data = await api.get<{ version: string }>('/api/engine')
        if (data.version !== running) {
          clearInterval(timer)
          setRunning(data.version)
          setPhase('done')
          toast.success(S.engineUpdated(data.version))
        } else if (Date.now() - startedAt > 4 * 60_000) {
          clearInterval(timer)
          setPhase('stuck')
        }
      } catch {
        /* the panel is mid-restart; keep polling */
      }
    }, 3000)
  }

  if (running === null) return null

  return (
    <>
      <Section title={S.engineTitle} description={S.engineExplainer}>
        <div className="flex items-baseline gap-2 text-sm">
          <span className="text-muted-foreground">{S.engineRunning}</span>
          <span className="font-mono font-medium">{running}</span>
        </div>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {available.length > 0 ? (
            <Select value={chosen} onValueChange={setChosen}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder={S.engineChoose} />
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
            <Input className="w-44" value={chosen} onChange={(event) => setChosen(event.target.value)} placeholder={S.engineChoose} />
          )}
          <Button disabled={!chosen || phase === 'updating'} onClick={() => setConfirming(true)}>
            {phase === 'updating' ? S.workingEllipsis : S.engineUpdate}
          </Button>
        </div>
        {phase === 'updating' && <Note tone="warning">{S.engineUpdating}</Note>}
        {phase === 'done' && <Note tone="success">{S.engineUpdated(running)}</Note>}
        {phase === 'stuck' && <Note tone="destructive">{S.engineUpdateStuck(running)}</Note>}
        <Confirm
          open={confirming}
          title={S.engineUpdateDialogTitle}
          body={<p>{S.engineUpdateDialogBody(running, chosen)}</p>}
          confirmLabel={S.engineUpdate}
          onConfirm={() => void update()}
          onClose={() => setConfirming(false)}
        />
      </Section>
      <Section title={S.supportTitle} description={S.supportExplainer}>
        <Button variant="outline" size="sm" asChild>
          <a href="/api/support-bundle" download>
            {S.supportDownload}
          </a>
        </Button>
      </Section>
    </>
  )
}
