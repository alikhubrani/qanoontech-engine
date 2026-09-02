import { useState, type FormEvent } from 'react'
import { api, ApiError, type LicenceInfo } from '../api'
import { S } from '../strings'
import { ErrorNote, StatusBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

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
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <StatusBadge
              tone={licence.standing === 'ok' ? 'ok' : licence.standing === 'grace' ? 'warn' : 'bad'}
            >
              {licence.standing}
            </StatusBadge>
            {licence.claims?.override && <StatusBadge tone="warn">{S.licenceOverrideBadge}</StatusBadge>}
          </CardTitle>
          <CardDescription>{licence.message}</CardDescription>
        </CardHeader>
        {licence.claims && (
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              <Row label={S.licenceFirm} value={licence.claims.firmName} />
              <Row label={S.licenceId} value={licence.claims.licenceId} mono />
              <Row
                label={S.licenceExpires}
                value={new Date(licence.claims.expiresAt).toLocaleDateString()}
              />
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
            {licence.heartbeat.lastError && (
              <p className="mt-3 text-sm text-warn">{licence.heartbeat.lastError}</p>
            )}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{S.licenceInstallTitle}</CardTitle>
          <CardDescription>{S.licenceInstallExplainer}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={install} className="space-y-3">
            <Textarea
              className="h-28 font-mono text-xs"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="v4.public.…"
            />
            {error && <ErrorNote>{error}</ErrorNote>}
            {notice && <p className="text-sm text-ok">{notice}</p>}
            <Button type="submit" disabled={busy || token.trim() === ''}>
              {busy ? S.workingEllipsis : S.licenceInstallSubmit}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 sm:block">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-xs' : ''}>{value}</dd>
    </div>
  )
}
