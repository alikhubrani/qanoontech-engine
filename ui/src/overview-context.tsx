import { createContext, useContext } from 'react'
import type { Overview } from './api'

/**
 * One request feeds the whole interface. The overview answers everything the
 * pages draw from, refreshed every ten seconds while signed in, and each page
 * reads it from here rather than polling on its own.
 */
export interface OverviewState {
  readonly data: Overview
  /** When the data last arrived, for "checked 4 s ago". */
  readonly checkedAt: number
  readonly refresh: () => Promise<void>
}

export const OverviewContext = createContext<OverviewState | null>(null)

export function useOverview(): OverviewState {
  const value = useContext(OverviewContext)
  if (!value) throw new Error('useOverview outside the shell')
  return value
}
