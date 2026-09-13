import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface RowAction {
  label: string
  onSelect: () => void
  /** Drawn in the destructive tone and set apart by a rule. */
  danger?: boolean
  disabled?: boolean
}

/** The `···` at the end of a row: every action on the thing, one place. */
export function RowMenu({ actions, label = 'Actions' }: { actions: RowAction[]; label?: string }) {
  const safe = actions.filter((a) => !a.danger)
  const dangerous = actions.filter((a) => a.danger)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} className="text-muted-foreground">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {safe.map((action) => (
          <DropdownMenuItem key={action.label} disabled={action.disabled} onSelect={action.onSelect}>
            {action.label}
          </DropdownMenuItem>
        ))}
        {safe.length > 0 && dangerous.length > 0 && <DropdownMenuSeparator />}
        {dangerous.map((action) => (
          <DropdownMenuItem key={action.label} variant="destructive" disabled={action.disabled} onSelect={action.onSelect}>
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
