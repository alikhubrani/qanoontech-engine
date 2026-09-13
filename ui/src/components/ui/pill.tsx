import type * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import type { Tone } from '@/lib/tones'

/*
 * A pill: tinted ground, darker text of the same hue, 4px corners, and an
 * optional leading dot. No border and no full rounding -- a capsule with a
 * ring around it reads as a button, and a row of them as a row of buttons.
 * The variants are the tones in lib/tones.ts, so a state passes straight
 * through: `<Pill tone={serviceTone(service)} dot>`.
 */
const pillVariants = cva(
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm font-medium leading-4',
  {
    variants: {
      tone: {
        neutral: 'bg-secondary text-secondary-foreground',
        success: 'bg-success/10 text-success',
        warning: 'bg-warning/10 text-warning',
        destructive: 'bg-destructive/10 text-destructive',
        info: 'bg-info/10 text-info',
        bronze: 'bg-bronze/10 text-bronze',
      } satisfies Record<Tone, string>,
      size: {
        sm: 'px-1.5 py-0 text-[11px]',
        default: 'px-2 py-0.5 text-xs',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'default' },
  },
)

export function Pill({
  className,
  tone,
  size,
  dot = false,
  children,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof pillVariants> & { dot?: boolean }) {
  return (
    <span className={cn(pillVariants({ tone, size }), className)} {...props}>
      {dot && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  )
}

/** A dot on its own, for a list row or a figure: the mark of a state without a label. */
export function Dot({ tone = 'neutral', className }: { tone?: Tone; className?: string }) {
  const colour: Record<Tone, string> = {
    neutral: 'bg-muted-foreground',
    success: 'bg-success',
    warning: 'bg-warning',
    destructive: 'bg-destructive',
    info: 'bg-info',
    bronze: 'bg-bronze',
  }
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', colour[tone], className)} />
}
