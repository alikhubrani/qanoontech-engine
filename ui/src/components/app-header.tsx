import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb'
import { CustomTrigger } from '@/components/custom-trigger'
import { NavUser } from '@/components/nav-user'

export function AppHeader({ title, onSignOut }: { title: string; onSignOut: () => void }) {
  return (
    <header className="sticky top-0 z-50 flex h-(--app-header-height) w-full shrink-0 items-center justify-between gap-2 border-b bg-background px-4 md:px-6">
      <div className="flex items-center gap-3">
        <CustomTrigger place="navbar" />
      </div>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>{title}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex items-center gap-3">
        <NavUser onSignOut={onSignOut} />
      </div>
    </header>
  )
}
