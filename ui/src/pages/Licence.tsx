import { useState, type FormEvent } from 'react'
import { api, ApiError, type LicenceInfo } from '../api'
import { Badge, Button, Card, ErrorNote } from '../components'
import { S } from '../strings'

export function Licence({ licence, onChanged }: { licence: LicenceInfo; onChanged: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function install(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.put('/api/licence', { token: token.trim() })
      setToken('')
      setNotice(S.licenceInstalled)
      onChanged()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-brand-dark">{S.licenceTitle}</h1>

      <Card>
        <div className="flex items-center gap-2">
          <StandingBadge licence={licence} />
          {licence.claims?.override && <Badge tone="warn">{S.licenceOverrideBadge}</Badge>}
          <span className="text-sm text-slate-600">{licence.message}</span>
        </div>
        {licence.claims && (
          <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <Row label={S.licenceFirm} value={licence.claims.firmName} />
            <Row label={S.licenceId} value={licence.claims.licenceId} mono />
            <Row label={S.licenceExpires} value={new Date(licence.claims.expiresAt).toLocaleDateString()} />
            <Row
              label={S.licenceSeats}
              value={licence.claims.seats === 0 ? S.licenceSeatsUnlimited : String(licence.claims.seats)}
            />
            <Row label={S.licenceEntitlements} value={licence.claims.entitlements.join(', ') || '—'} />
            {licence.heartbeat.lastSuccessAt && (
              <Row
                label={S.licenceHeartbeatOk}
                value={new Date(licence.heartbeat.lastSuccessAt).toLocaleString()}
              />
            )}
          </dl>
        )}
        {licence.heartbeat.lastError && (
          <p className="mt-3 text-sm text-warn">{licence.heartbeat.lastError}</p>
        )}
      </Card>

      <Card title={S.licenceInstallTitle}>
        <form onSubmit={install} className="space-y-3">
          <p className="text-sm text-slate-500">{S.licenceInstallExplainer}</p>
          <textarea
            className="h-28 w-full rounded-md border border-slate-300 p-3 font-mono text-xs outline-none focus:border-brand focus:ring-2 focus:ring-blue-100"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="v4.public.…"
          />
          {error && <ErrorNote>{error}</ErrorNote>}
          {notice && <p className="text-sm text-ok">{notice}</p>}
          <Button variant="primary" type="submit" disabled={busy || token.trim() === ''}>
            {busy ? S.workingEllipsis : S.licenceInstallSubmit}
          </Button>
        </form>
      </Card>
    </div>
  )
}

function StandingBadge({ licence }: { licence: LicenceInfo }) {
  const tone =
    licence.standing === 'ok' ? 'ok' : licence.standing === 'grace' ? 'warn' : 'bad'
  return <Badge tone={tone}>{licence.standing}</Badge>
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 sm:block">
      <dt className="text-slate-400">{label}</dt>
      <dd className={`text-slate-700 ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}
