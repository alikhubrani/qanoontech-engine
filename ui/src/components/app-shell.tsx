import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/app-sidebar'
import { titleFor } from '../routes'
import { S } from '../strings'
import type { Operator } from '../api'

/**
 * The frame: the sidebar and the page. No header bar -- the page's title
 * lives in the page, as it does in every console worth copying -- except on a
 * narrow screen, where the sidebar is a drawer and something has to open it.
 */
export function AppShell({
  engineVersion,
  operator,
  onSignOut,
}: {
  engineVersion?: string | undefined
  operator: Operator | null
  onSignOut: () => void
}) {
  const location = useLocation()

  useEffect(() => {
    document.title = `${titleFor(location.pathname)} · ${S.productName}`
  }, [location.pathname])

  return (
    <SidebarProvider className="[--sidebar-width:15rem] [--sidebar-width-icon:3.25rem]">
      <AppSidebar engineVersion={engineVersion} operator={operator} onSignOut={onSignOut} />
      <SidebarInset className="bg-background">
        <div className="flex h-12 items-center gap-2 border-b border-border px-3 md:hidden">
          <SidebarTrigger />
          <span className="text-sm font-medium">{titleFor(location.pathname)}</span>
        </div>
        <main className="flex flex-1 flex-col px-5 py-8 md:px-10 md:py-10">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
