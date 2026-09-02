import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppHeader } from '@/components/app-header'
import { AppSidebar } from '@/components/app-sidebar'
import type { Page } from '@/components/app-shared'

/** The efferd app-shell block, holding this engine's pages. */
export function AppShell({
  page,
  title,
  onNavigate,
  onSignOut,
  engineVersion,
  banner,
  children,
}: {
  page: Page
  title: string
  onNavigate: (page: Page) => void
  onSignOut: () => void
  engineVersion?: string
  banner?: ReactNode
  children: ReactNode
}) {
  return (
    <SidebarProvider
      className={cn('[--app-wrapper-max-width:80rem]', '[--app-header-height:3rem]')}
    >
      <AppSidebar page={page} onNavigate={onNavigate} engineVersion={engineVersion} />
      <SidebarInset className="bg-muted dark:bg-background">
        <AppHeader title={title} onSignOut={onSignOut} />
        {banner}
        <div
          className={cn(
            'flex flex-1 flex-col p-4 md:p-6',
            'mx-auto w-full max-w-(--app-wrapper-max-width)',
          )}
        >
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
