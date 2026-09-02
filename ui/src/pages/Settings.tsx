import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { api, ApiError } from '../api'
import { S } from '../strings'
import { ErrorNote } from '@/components/status'
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

/**
 * The operator account. Changing the password signs every session out,
 * including this one — that is the point, and the page says so before the
 * button, not after.
 */
export function Settings({ onSignedOut }: { onSignedOut: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (next !== confirm) {
      setError(S.passwordMismatch)
      return
    }
    setBusy(true)
    try {
      await api.post('/api/password', { current, next })
      toast.success(S.passwordChanged)
      onSignedOut()
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
          <CardTitle>{S.passwordTitle}</CardTitle>
          <CardDescription>{S.passwordExplainer}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="max-w-sm space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pw-current">{S.passwordCurrent}</Label>
              <Input
                id="pw-current"
                type="password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-next">{S.passwordNew}</Label>
              <Input
                id="pw-next"
                type="password"
                value={next}
                onChange={(event) => setNext(event.target.value)}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">{S.setupPasswordRule}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-confirm">{S.passwordConfirm}</Label>
              <Input
                id="pw-confirm"
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
              />
            </div>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button type="submit" disabled={busy || !current || !next || !confirm}>
              {busy ? S.workingEllipsis : S.passwordSubmit}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
