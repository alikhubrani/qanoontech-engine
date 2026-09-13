import { useCallback, useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { api, ApiError, type Overview as OverviewData } from './api'
import { Login } from './pages/Login'
import { Overview } from './pages/Overview'
import { Activity } from './pages/Activity'
import { Services } from './pages/Services'
import { Deploy } from './pages/Deploy'
import { Backups } from './pages/Backups'
import { Settings } from './pages/Settings'
import { AppShell } from '@/components/app-shell'
import { Toaster } from '@/components/ui/sonner'
import { OverviewContext } from './overview-context'

/**
 * The shell: an auth gate, real routes, and one poll. The overview answers
 * everything the pages draw from, so a single request loop feeds the whole
 * interface, refreshed every ten seconds while signed in.
 */
export function App() {
  /** null while the first request is in flight, so nothing flashes. */
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [data, setData] = useState<OverviewData | null>(null)
  const [checkedAt, setCheckedAt] = useState(0)

  const refresh = useCallback(async () => {
    try {
      setData(await api.get<OverviewData>('/api/overview'))
      setCheckedAt(Date.now())
      setSignedIn(true)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setSignedIn(false)
        setData(null)
      }
    }
  }, [])

  /*
   * One request decides it: either the overview answers, or it 401s and the
   * sign-in page is what to draw.
   */
  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!signedIn) return
    const timer = setInterval(() => void refresh(), 10_000)
    return () => clearInterval(timer)
  }, [signedIn, refresh])

  const signOut = useCallback(async () => {
    await api.delete('/api/session').catch(() => undefined)
    setSignedIn(false)
    setData(null)
  }, [])

  const state = useMemo(() => (data ? { data, checkedAt, refresh } : null), [data, checkedAt, refresh])

  if (signedIn === null) return null
  if (!signedIn || !state) return <Login />

  return (
    <BrowserRouter>
      <OverviewContext.Provider value={state}>
        <Routes>
          <Route
            element={
              <AppShell engineVersion={state.data.engineVersion} operator={state.data.operator} onSignOut={signOut} />
            }
          >
            <Route index element={<Overview />} />
            <Route path="services" element={<Services />} />
            <Route path="activity" element={<Activity />} />
            <Route path="deploy/*" element={<Deploy />} />
            <Route path="backups/*" element={<Backups />} />
            <Route path="settings/*" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <Toaster position="bottom-right" />
      </OverviewContext.Provider>
    </BrowserRouter>
  )
}
