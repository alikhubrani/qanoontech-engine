import type { ReactNode } from 'react'
import {
  ActivityIcon,
  ArchiveIcon,
  GaugeIcon,
  RocketIcon,
  ServerCogIcon,
  SettingsIcon,
} from 'lucide-react'
import { S } from './strings'

/**
 * The pages, once. The sidebar reads it for its groups, the shell for the
 * document title, and a finding's `area` maps here to the page that fixes it.
 *
 * The groups are the three responsibilities in docs/panel.md -- assurance,
 * change, recovery -- with Settings on its own at the foot.
 */
export interface NavItem {
  path: string
  title: string
  icon: ReactNode
  /** Match child routes too (`/deploy/modules` lights up Deploy). */
  prefix?: boolean
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const navGroups: NavGroup[] = [
  {
    label: S.groupAssurance,
    items: [
      { path: '/', title: S.navOverview, icon: <GaugeIcon /> },
      { path: '/services', title: S.navServices, icon: <ServerCogIcon /> },
      { path: '/activity', title: S.navActivity, icon: <ActivityIcon /> },
    ],
  },
  {
    label: S.groupChange,
    items: [{ path: '/deploy', title: S.navDeploy, icon: <RocketIcon />, prefix: true }],
  },
  {
    label: S.groupRecovery,
    items: [{ path: '/backups', title: S.navBackups, icon: <ArchiveIcon />, prefix: true }],
  },
]

export const settingsItem: NavItem = { path: '/settings', title: S.navSettings, icon: <SettingsIcon />, prefix: true }

export const navItems: NavItem[] = [...navGroups.flatMap((group) => group.items), settingsItem]

/** Where a finding sends the operator. The server names the area; the panel names the page. */
export const areaRoutes: Record<string, string> = {
  services: '/services',
  deploy: '/deploy',
  backups: '/backups',
  offsite: '/backups/offsite',
  recovery: '/backups/recovery',
  'sign-in': '/settings',
  database: '/settings/database',
  registry: '/settings/registry',
}

export function titleFor(pathname: string): string {
  const item = navItems.find((entry) =>
    entry.path === '/' ? pathname === '/' : entry.prefix ? pathname.startsWith(entry.path) : pathname === entry.path,
  )
  return item?.title ?? S.productName
}
