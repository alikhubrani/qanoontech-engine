import { NavLink } from 'react-router'
import { LogOutIcon, PanelLeftIcon } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { navGroups, settingsItem, type NavItem } from '../routes'
import { S } from '../strings'
import type { Operator } from '../api'
import { cn } from '@/lib/utils'

/**
 * The dark plate the ivory page sits beside, as in the application: the
 * product mark at the top, the three responsibilities as groups, Settings and
 * the account at the foot. Identity lives in one place -- there is no second
 * avatar in a header, because there is no header.
 */
export function AppSidebar({
  engineVersion,
  operator,
  onSignOut,
}: {
  engineVersion?: string | undefined
  operator: Operator | null
  onSignOut: () => void
}) {
  const { toggleSidebar, state } = useSidebar()
  const collapsed = state === 'collapsed'

  return (
    <Sidebar collapsible="icon" variant="sidebar" className="border-r-0">
      <SidebarHeader className="h-14 flex-row items-center gap-2.5 px-3">
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary font-serif text-[15px] font-medium text-sidebar-primary-foreground"
        >
          Q
        </span>
        <div className="min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
          <span className="block truncate text-sm font-medium text-sidebar-primary">{S.productName}</span>
          {engineVersion && (
            <span className="block truncate text-[11px] text-sidebar-muted">
              {S.engineWord} {engineVersion}
            </span>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-1 px-2 py-1">
        {navGroups.map((group) => (
          <SidebarGroup key={group.label} className="px-0 py-1.5">
            <SidebarGroupLabel className="eyebrow h-7 px-2 text-sidebar-muted group-data-[collapsible=icon]:pointer-events-none">
              {group.label}
            </SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => (
                <NavEntry key={item.path} item={item} />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="gap-1 border-t border-sidebar-border px-2 py-2">
        <SidebarMenu>
          <NavEntry item={settingsItem} />
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={collapsed ? S.sidebarExpand : S.sidebarCollapse}
              onClick={toggleSidebar}
              className="text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <PanelLeftIcon />
              <span>{collapsed ? S.sidebarExpand : S.sidebarCollapse}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  tooltip={operator?.name || operator?.upn || S.operatorLabel}
                  className="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-medium text-sidebar-accent-foreground">
                    {initials(operator)}
                  </span>
                  <div className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-sm">{operator?.name || S.operatorLabel}</span>
                    <span className="block truncate text-[11px] text-sidebar-muted">{operator?.upn || S.signedInViaEntra}</span>
                  </div>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <span className="block truncate text-sm font-medium">{operator?.name || S.operatorLabel}</span>
                  <span className="block truncate text-xs text-muted-foreground">{operator?.upn || S.signedInViaEntra}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onSignOut}>
                  <LogOutIcon />
                  {S.logout}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function NavEntry({ item }: { item: NavItem }) {
  return (
    <SidebarMenuItem>
      <NavLink to={item.path} end={item.path === '/' || !item.prefix}>
        {({ isActive }) => (
          <SidebarMenuButton
            isActive={isActive}
            tooltip={item.title}
            className={cn(
              'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              'data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground',
            )}
          >
            {item.icon}
            <span>{item.title}</span>
          </SidebarMenuButton>
        )}
      </NavLink>
    </SidebarMenuItem>
  )
}

function initials(operator: Operator | null): string {
  const source = operator?.name || operator?.upn || ''
  const parts = source.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean)
  const letters = parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')
  return letters || 'Q'
}
