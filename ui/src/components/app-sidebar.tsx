import { cn } from '@/lib/utils'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { navGroups, type Page } from '@/components/app-shared'
import { CustomTrigger } from '@/components/custom-trigger'
import { S } from '../strings'

export function AppSidebar({
  page,
  onNavigate,
  engineVersion,
}: {
  page: Page
  onNavigate: (page: Page) => void
  engineVersion?: string
}) {
  return (
    <Sidebar
      className={cn('*:data-[slot=sidebar-inner]:bg-background')}
      collapsible="icon"
      variant="sidebar"
    >
      <SidebarHeader className="h-(--app-header-height,3rem) flex-row items-center justify-between">
        <div className="flex min-w-0 items-center gap-2 px-1">
          <div className="flex size-6 shrink-0 items-center justify-center rounded bg-primary text-xs font-bold text-primary-foreground">
            Q
          </div>
          <div className="min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
            <span className="block truncate text-sm font-medium">{S.productName}</span>
            {engineVersion && (
              <span className="block font-mono text-[10px] text-muted-foreground">
                v{engineVersion}
              </span>
            )}
          </div>
        </div>
        <CustomTrigger place="sidebar" />
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel className="group-data-[collapsible=icon]:pointer-events-none">
              {group.label}
            </SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.page}>
                  <SidebarMenuButton
                    isActive={item.page === page}
                    onClick={() => onNavigate(item.page)}
                    tooltip={item.title}
                  >
                    {item.icon}
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
