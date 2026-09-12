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
 * Settings.
 *
 * There is no password card any more: the panel has no password. Identity is
 * Microsoft Entra's, and who may sign in is configured from a shell
 * (`auth allow`, `auth redirect`) rather than from the page those settings
 * would lock — configuring a lock from behind the door it locks is how a
 * deployment gets locked out of itself.
 */
export function Settings({ onSignedOut }: { onSignedOut: () => void }) {
  void onSignedOut

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
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
