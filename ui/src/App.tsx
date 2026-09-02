import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type Overview as OverviewData } from './api'
import { Button } from './components'
import { Login } from './pages/Login'
import { Overview } from './pages/Overview'
import { Services } from './pages/Services'
import { S } from './strings'

type Page = 'overview' | 'services'

/**
 * The shell: an auth gate, a sidebar, and a poll.
 *
 * The overview answers everything the pages draw from, so one request loop
 * feeds the whole interface, refreshed every ten seconds while signed in.
 */
export function App() {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [signedIn, setSignedIn] = useState(false)
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
    <div className="flex min-h-screen bg-slate-50">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-4">
          <p className="text-sm font-semibold text-brand-dark">{S.productName}</p>
          {data && <p className="mt-0.5 font-mono text-xs text-slate-400">v{data.engineVersion}</p>}
        </div>
        <nav className="flex-1 space-y-1 p-2">
          <NavItem label={S.navOverview} active={page === 'overview'} onClick={() => setPage('overview')} />
          <NavItem label={S.navServices} active={page === 'services'} onClick={() => setPage('services')} />
        </nav>
        <div className="border-t border-slate-100 p-2">
          <Button
            className="w-full"
            onClick={async () => {
              await api.delete('/api/session').catch(() => undefined)
              setSignedIn(false)
              setData(null)
            }}
          >
            {S.logout}
          </Button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-6">
        {data === null ? null : page === 'overview' ? (
          <Overview data={data} />
        ) : (
          <Services services={data.services} onChanged={() => void refresh()} />
        )}
      </main>
    </div>
  )
}

function NavItem({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
        active ? 'bg-blue-50 text-brand' : 'text-slate-600 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  )
}
