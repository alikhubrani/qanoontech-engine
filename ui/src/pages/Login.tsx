import { useEffect, useState } from 'react'
import { S } from '../strings'
import { Note } from '@/components/page'
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
    <div className="flex min-h-screen w-full bg-background">
      <aside className="hidden w-[38%] flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-md bg-sidebar-primary font-serif text-[15px] font-medium text-sidebar-primary-foreground">
            Q
          </span>
          <span className="text-sm font-medium text-sidebar-primary">{S.productName}</span>
        </div>
        <p className="max-w-[28ch] font-serif text-[30px] leading-[1.15] tracking-[-0.01em] text-sidebar-primary">
          {S.loginTagline}
        </p>
        <p className="text-xs text-sidebar-muted">{S.loginFootnote}</p>
      </aside>

      <main className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex items-center gap-2.5 lg:hidden">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary font-serif text-[15px] font-medium text-primary-foreground">
              Q
            </span>
            <span className="text-sm font-medium">{S.productName}</span>
          </div>
          <div className="space-y-2">
            <h1 className="type-title">{S.loginTitle}</h1>
            <p className="text-sm text-muted-foreground">{S.loginExplainer}</p>
          </div>

          {error && <Note tone="destructive">{error}</Note>}

          <Button className="w-full" size="lg" asChild>
            <a href="/api/session/entra/start">
              <MicrosoftMark />
              {S.loginSubmit}
            </a>
          </Button>
        </div>
      </main>
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
