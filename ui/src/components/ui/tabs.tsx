import * as React from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/*
 * One primitive, two looks, as in the application.
 *
 *   line     a row of labels over a hairline, the active one underlined in
 *            ink. For the sections of a page.
 *   default  the segmented tray, for switching views inside a panel.
 */
type TabsVariant = 'line' | 'default'
const VariantContext = React.createContext<TabsVariant>('line')

const Tabs = TabsPrimitive.Root

function TabsList({
  className,
  variant = 'line',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & { variant?: TabsVariant }) {
  return (
    <VariantContext.Provider value={variant}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        className={cn(
          variant === 'line'
            ? 'flex w-full items-center gap-6 overflow-x-auto border-b border-border text-muted-foreground'
            : 'inline-flex h-9 items-center rounded-md bg-muted p-1 text-muted-foreground',
          className,
        )}
        {...props}
      />
    </VariantContext.Provider>
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = React.useContext(VariantContext)
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
        variant === 'line'
          ? '-mb-px border-b-2 border-transparent px-0.5 py-2.5 hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground'
          : 'rounded-sm px-3 py-1 data-[state=active]:bg-background data-[state=active]:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('mt-6 outline-none', className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
