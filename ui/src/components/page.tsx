import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Dot } from '@/components/ui/pill'
import type { Tone } from '@/lib/tones'

/**
 * The page's furniture: a title, a line beneath it, an action at the end;
 * sections headed over a hairline; a row of facts. Structure comes from type,
 * rules and space -- never from a box around each thing. See docs/panel.md.
 */

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-[72rem] space-y-10 pb-16', className)}>{children}</div>
}

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  /** Tabs, when the page has them. */
  children?: ReactNode
}) {
  return (
    <header className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-1.5">
          <h1 className="type-title">{title}</h1>
          {description && <p className="max-w-[60ch] text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  )
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-border pb-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {description && <p className="mt-0.5 max-w-[70ch] text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** A row of facts, separated by hairlines. Each is an eyebrow, a figure, a caption. */
export function FactsRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-y-6 border-y border-border py-5 md:grid-cols-4 md:divide-x md:divide-border',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function Fact({
  eyebrow,
  value,
  caption,
  tone,
  to,
  figure = true,
}: {
  eyebrow: string
  value: ReactNode
  caption?: ReactNode
  tone?: Tone
  /** Where the fact leads; the whole cell is a link. */
  to?: string
  /** Set false when the value is a word, not a number. */
  figure?: boolean
}) {
  const body = (
    <>
      <div className="eyebrow">{eyebrow}</div>
      <div className={cn('mt-2 flex items-center gap-2', figure ? 'type-figure' : 'text-base font-medium leading-tight')}>
        {tone && <Dot tone={tone} />}
        <span className="min-w-0 truncate">{value}</span>
      </div>
      {caption && <div className="mt-1.5 truncate text-xs text-muted-foreground">{caption}</div>}
    </>
  )
  const cell = 'group min-w-0 px-1 md:px-6 md:first:pl-1 md:last:pr-1'
  return to ? (
    <Link to={to} className={cn(cell, 'rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50')}>
      {body}
    </Link>
  ) : (
    <div className={cell}>{body}</div>
  )
}

/** A list of rows on hairlines: the page ground is the list's ground. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn('divide-y divide-border border-b border-border', className)}>{children}</ul>
}

export function Row({
  children,
  className,
  to,
}: {
  children: ReactNode
  className?: string
  to?: string
}) {
  const classes = cn('flex min-h-11 items-center gap-4 py-2.5', className)
  if (to) {
    return (
      <li>
        <Link to={to} className={cn(classes, 'group -mx-2 rounded-sm px-2 hover:bg-accent/60')}>
          {children}
          <ArrowUpRight className="ml-auto size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </Link>
      </li>
    )
  }
  return <li className={classes}>{children}</li>
}

/** Nothing here, said plainly. Never a claim about data that has not arrived. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>
}

/** A note in the flow: a reason, a refusal, a warning. Not a toast. */
export function Note({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone
  children: ReactNode
  className?: string
}) {
  const ground: Record<Tone, string> = {
    neutral: 'bg-muted text-foreground',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    destructive: 'bg-destructive/10 text-destructive',
    info: 'bg-info/10 text-info',
    bronze: 'bg-bronze/10 text-bronze',
  }
  return <div className={cn('rounded-md px-3 py-2 text-sm', ground[tone], className)}>{children}</div>
}

/** A label/field/help stack, the shape every form field takes. */
export function Field({
  label,
  help,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode
  help?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {help && <p className="text-xs leading-relaxed text-muted-foreground">{help}</p>}
    </div>
  )
}
