import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '../api'
import { S } from '../strings'
import { Note, Page, PageHeader, Section } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Confirm } from '@/components/confirm'

/**
 * Settings. In this release, the engine itself; sign-in, the database and
 * the credentials arrive with 0.22 (docs/panel.md), and until then they are
 * configured from the shell.
 */
export function Settings() {
  return (
    <Page>
      <PageHeader title={S.navSettings} description={S.settingsPageExplainer} />
      <EngineSection />
      <Section title={S.supportTitle} description={S.supportExplainer}>
        <Button variant="outline" size="sm" asChild>
          <a href="/api/support-bundle" download>
            {S.supportDownload}
          </a>
        </Button>
      </Section>
    </Page>
  )
}

/**
 * The engine updating itself. The POST detaches a helper and this very server
 * is replaced under us, so the section watches GET /api/engine until the
 * reported version changes; an update whose pull fails leaves the old engine
 * answering on the old number, and saying so is the failure report.
 */
function EngineSection() {
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
  )
}
