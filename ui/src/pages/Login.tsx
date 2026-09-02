import { useState, type FormEvent } from 'react'
import { LockIcon } from 'lucide-react'
import { api, ApiError } from '../api'
import { S } from '../strings'
import { cn } from '@/lib/utils'
import { ErrorNote } from '@/components/status'
import { AuthDivider } from '@/components/auth-divider'
import { DecorIcon } from '@/components/decor-icon'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'

/**
 * First-run setup and sign-in — the efferd auth block, asking for the one
 * thing this panel authenticates with: the operator password.
 */
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
    <div className="relative flex h-screen w-full items-center justify-center overflow-hidden bg-background px-6 md:px-8">
      <div
        className={cn(
          'relative flex w-full max-w-sm flex-col justify-between p-6 md:p-8',
          'dark:bg-[radial-gradient(50%_80%_at_20%_0%,--theme(--color-foreground/.1),transparent)]',
        )}
      >
        <div className="absolute -inset-y-6 -left-px w-px bg-border" />
        <div className="absolute -inset-y-6 -right-px w-px bg-border" />
        <div className="absolute -inset-x-6 -top-px h-px bg-border" />
        <div className="absolute -inset-x-6 -bottom-px h-px bg-border" />
        <DecorIcon position="top-left" />
        <DecorIcon position="bottom-right" />

        <div className="w-full max-w-sm animate-in space-y-8">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md bg-primary font-bold text-primary-foreground">
              Q
            </div>
            <span className="font-semibold">{S.productName}</span>
          </div>
          <div className="flex flex-col space-y-1">
            <h1 className="font-bold text-2xl tracking-wide">
              {needsSetup ? S.setupTitle : S.loginTitle}
            </h1>
            <p className="text-base text-muted-foreground">
              {needsSetup ? S.setupExplainer : S.loginExplainer}
            </p>
          </div>
          <form onSubmit={submit} className="space-y-3">
            <InputGroup>
              <InputGroupInput
                type="password"
                autoFocus
                placeholder={S.loginPassword}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={needsSetup ? 'new-password' : 'current-password'}
              />
              <InputGroupAddon align="inline-start">
                <LockIcon />
              </InputGroupAddon>
            </InputGroup>
            {needsSetup && (
              <>
                <AuthDivider>{S.setupPasswordRule}</AuthDivider>
              </>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button className="w-full" type="submit" disabled={busy}>
              {busy ? S.workingEllipsis : needsSetup ? S.setupSubmit : S.loginSubmit}
            </Button>
          </form>
          <p className="text-muted-foreground text-sm">{S.loginFootnote}</p>
        </div>
      </div>
    </div>
  )
}
