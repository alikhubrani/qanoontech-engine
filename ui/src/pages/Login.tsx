import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../api'
import { Button, Card, ErrorNote, Input } from '../components'
import { S } from '../strings'

/** First-run setup and sign-in: the same page, differing only in what it asks. */
export function Login({ needsSetup, onDone }: { needsSetup: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post(needsSetup ? '/api/setup' : '/api/session', { password })
      onDone()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : S.errorGeneric)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-lg font-semibold text-brand-dark">{S.productName}</h1>
        <Card title={needsSetup ? S.setupTitle : S.loginTitle}>
          <form onSubmit={submit} className="space-y-3">
            {needsSetup && <p className="text-sm text-slate-500">{S.setupExplainer}</p>}
            <Input
              type="password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={S.loginPassword}
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
            />
            {needsSetup && <p className="text-xs text-slate-400">{S.setupPasswordRule}</p>}
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button variant="primary" type="submit" disabled={busy} className="w-full">
              {busy ? S.workingEllipsis : needsSetup ? S.setupSubmit : S.loginSubmit}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  )
}
