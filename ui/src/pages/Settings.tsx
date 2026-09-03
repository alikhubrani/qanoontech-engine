import { useEffect, useState, type FormEvent } from 'react'
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

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

      <EngineCard />
    </div>
  )
}

/**
 * The engine updating itself — the last operation that needed a shell. The
 * POST detaches a helper and this very server is replaced under us, so the
 * card watches GET /api/engine until the reported version changes; an update
 * whose pull fails leaves the old engine answering on the old number, and
 * saying so is the failure report.
 */
export function EngineCard() {
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
    // The server is now being replaced. Poll until a different version answers.
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
    <Card>
      <CardHeader>
        <CardTitle>{S.engineTitle}</CardTitle>
        <CardDescription>{S.engineExplainer}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          <span className="text-muted-foreground">{S.engineRunning}: </span>
          <span className="font-mono font-semibold">{running}</span>
        </p>
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
            <Input
              className="w-44"
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
              placeholder={S.engineChoose}
            />
          )}
          <Button
            disabled={!chosen || phase === 'updating'}
            onClick={() => setConfirming(true)}
          >
            {phase === 'updating' ? S.workingEllipsis : S.engineUpdate}
          </Button>
        </div>
        {phase === 'updating' && <p className="text-sm text-warn">{S.engineUpdating}</p>}
        {phase === 'done' && <p className="text-sm text-ok">{S.engineUpdated(running)}</p>}
        {phase === 'stuck' && <ErrorNote>{S.engineUpdateStuck(running)}</ErrorNote>}
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{S.engineUpdateDialogTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {S.engineUpdateDialogBody(running, chosen)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{S.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={update}>{S.engineUpdate}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
