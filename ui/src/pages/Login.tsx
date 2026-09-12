import { useEffect, useState } from 'react'
import { S } from '../strings'
import { cn } from '@/lib/utils'
import { ErrorNote } from '@/components/status'
import { DecorIcon } from '@/components/decor-icon'
import { Button } from '@/components/ui/button'

/**
 * Sign in with Microsoft Entra.
 *
 * There is no form, because there is nothing to type. The panel has no password
 * — identity belongs to Entra, and the only thing this page does is hand the
 * browser to it.
 *
 * A plain link and not a `fetch`: the flow is a redirect out to Microsoft and
 * back, so it has to be a real navigation. Fetching `/start` would follow the
 * 302 in the background, land the *page* nowhere, and lose the sign-in.
 */
export function Login() {
  const [error, setError] = useState<string | null>(null)

  /*
   * The callback refuses by sending the browser back here with a reason. Read
   * it from the URL and then clear it, so a reload does not re-accuse.
   */
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('error')
    if (!reason) return
    setError(reason)
    window.history.replaceState({}, '', window.location.pathname)
  }, [])

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
            <h1 className="font-bold text-2xl tracking-wide">{S.loginTitle}</h1>
            <p className="text-base text-muted-foreground">{S.loginExplainer}</p>
          </div>

          {error && <ErrorNote>{error}</ErrorNote>}

          <Button className="w-full" asChild>
            <a href="/api/session/entra/start">
              <MicrosoftMark />
              {S.loginSubmit}
            </a>
          </Button>

          <p className="text-muted-foreground text-sm">{S.loginFootnote}</p>
        </div>
      </div>
    </div>
  )
}

/** Microsoft's four squares. Inline rather than fetched: this page is the one
 *  that has to render when nothing else is reachable. */
function MicrosoftMark() {
  return (
    <svg viewBox="0 0 23 23" className="size-4" aria-hidden focusable="false">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  )
}
