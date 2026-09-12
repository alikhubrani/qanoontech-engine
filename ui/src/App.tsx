import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type Overview as OverviewData } from './api'
import { Login } from './pages/Login'
import { Overview } from './pages/Overview'
import { Services } from './pages/Services'
import { Deploy } from './pages/Deploy'
import { Backups } from './pages/Backups'
import { Settings } from './pages/Settings'
import { S } from './strings'
import { AppShell } from '@/components/app-shell'
import { navItems, type Page } from '@/components/app-shared'
import { Toaster } from '@/components/ui/sonner'

/**
 * The shell: an auth gate, the app-shell block, and one poll. The overview
 * answers everything the pages draw from, so a single request loop feeds the
 * whole interface, refreshed every ten seconds while signed in.
 */
export function App() {
  /** null while the first request is in flight, so nothing flashes. */
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [page, setPage] = useState<Page>('overview')
  const [data, setData] = useState<OverviewData | null>(null)

  const refresh = useCallback(async () => {
    try {
      setData(await api.get<OverviewData>('/api/overview'))
      setSignedIn(true)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setSignedIn(false)
        setData(null)
      }
    }
  }, [])

  /*
   * One request decides it. There is no setup to ask about any more: either the
   * overview answers, or it 401s and the sign-in page is what to draw.
   */
  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!signedIn) return
    const timer = setInterval(() => void refresh(), 10_000)
    return () => clearInterval(timer)
  }, [signedIn, refresh])

  if (signedIn === null) return null
  if (!signedIn) return <Login />

  return (
    <>
      <AppShell
        page={page}
        title={navItems.find((item) => item.page === page)?.title ?? ''}
        onNavigate={setPage}
        onSignOut={async () => {
          await api.delete('/api/session').catch(() => undefined)
          setSignedIn(false)
          setData(null)
        }}
        engineVersion={data?.engineVersion}
      >
        {data === null ? null : page === 'overview' ? (
          <Overview data={data} />
        ) : page === 'services' ? (
          <Services services={data.services} onChanged={() => void refresh()} />
        ) : page === 'deploy' ? (
          <Deploy
            version={data.version}
            previousVersion={data.previousVersion}
            onChanged={() => void refresh()}
          />
        ) : page === 'backups' ? (
          <Backups onChanged={() => void refresh()} />
        ) : page === 'settings' ? (
          <Settings
            onSignedOut={() => {
              setSignedIn(false)
              setData(null)
            }}
          />
        ) : null}
      </AppShell>
      <Toaster position="top-right" />
    </>
  )
}
