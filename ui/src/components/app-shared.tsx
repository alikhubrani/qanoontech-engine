import type { ReactNode } from 'react'
import {
  ArchiveIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  RocketIcon,
  ServerCogIcon,
  SettingsIcon,
} from 'lucide-react'

/** The engine's pages. One list; the sidebar and the header title read it. */
export type Page = 'overview' | 'services' | 'deploy' | 'backups' | 'licence' | 'settings'

export interface NavItem {
  page: Page
  title: string
  icon: ReactNode
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const navGroups: NavGroup[] = [
  {
    label: 'Operate',
    items: [
      { page: 'overview', title: 'Overview', icon: <LayoutDashboardIcon /> },
      { page: 'services', title: 'Services', icon: <ServerCogIcon /> },
    ],
  },
  {
    label: 'Change',
    items: [
      { page: 'deploy', title: 'Deploy', icon: <RocketIcon /> },
      { page: 'backups', title: 'Backups', icon: <ArchiveIcon /> },
    ],
  },
  {
    label: 'Account',
    items: [
      { page: 'licence', title: 'Licence', icon: <KeyRoundIcon /> },
      { page: 'settings', title: 'Settings', icon: <SettingsIcon /> },
    ],
  },
]

export const navItems: NavItem[] = navGroups.flatMap((group) => group.items)
