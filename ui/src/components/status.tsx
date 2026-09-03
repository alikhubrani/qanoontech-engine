import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** Status badge in the application's semantic colours. */
export function StatusBadge({
  tone,
  children,
  className,
  title,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'muted'
  children: ReactNode
  className?: string
  title?: string
}) {
  const styles = {
    ok: 'border-emerald-200 bg-emerald-50 text-ok',
    warn: 'border-amber-200 bg-amber-50 text-warn',
    bad: 'border-red-200 bg-red-50 text-bad',
    muted: 'border-border bg-muted text-muted-foreground',
  }[tone]
  return (
    <Badge variant="outline" className={cn(styles, className)} title={title}>
      {children}
    </Badge>
  )
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="size-4" />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}
