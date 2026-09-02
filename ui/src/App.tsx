import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type LicenceInfo, type Overview as OverviewData } from './api'
import { Login } from './pages/Login'
import { Overview } from './pages/Overview'
import { Services } from './pages/Services'
import { Deploy } from './pages/Deploy'
import { Backups } from './pages/Backups'
import { Licence } from './pages/Licence'
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
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [signedIn, setSignedIn] = useState(false)
  const [page, setPage] = useState<Page>('overview')
  const [data, setData] = useState<OverviewData | null>(null)
  const [licence, setLicence] = useState<LicenceInfo | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [overview, licenceInfo] = await Promise.all([
        api.get<OverviewData>('/api/overview'),
        api.get<LicenceInfo>('/api/licence'),
      ])
      setData(overview)
      setLicence(licenceInfo)
      setSignedIn(true)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setSignedIn(false)
        setData(null)
        setLicence(null)
      }
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const setup = await api.get<{ needed: boolean }>('/api/setup').catch(() => ({ needed: false }))
      setNeedsSetup(setup.needed)
      if (!setup.needed) await refresh()
    })()
  }, [refresh])

  useEffect(() => {
    if (!signedIn) return
    const timer = setInterval(() => void refresh(), 10_000)
    return () => clearInterval(timer)
  }, [signedIn, refresh])

  if (needsSetup === null) return null

  if (!signedIn) {
    return (
      <Login
        needsSetup={needsSetup}
        onDone={() => {
          setNeedsSetup(false)
          void refresh()
        }}
      />
    )
  }

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
          setLicence(null)
        }}
        engineVersion={data?.engineVersion}
        banner={
          licence && licence.standing !== 'ok' ? <LicenceBanner licence={licence} /> : undefined
        }
      >
        {data === null ? null : page === 'overview' ? (
          <Overview data={data} licence={licence} />
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
        ) : licence ? (
          <Licence licence={licence} onChanged={() => void refresh()} />
        ) : null}
      </AppShell>
      <Toaster position="top-right" />
    </>
  )
}

/**
 * The escalation the design promises: quiet amber while grace runs, red when
 * the deployment has been stopped. Above every page — an operator on the
 * Services tab does not get to not know.
 */
function LicenceBanner({ licence }: { licence: LicenceInfo }) {
  const stopped = licence.standing === 'enforce' || licence.enforced
  return (
    <div
      className={`px-6 py-2.5 text-sm font-medium ${
        stopped ? 'bg-destructive text-destructive-foreground' : 'bg-amber-100 text-amber-900'
      }`}
    >
      {stopped ? S.licenceEnforcedBanner : licence.message}
    </div>
  )
}
