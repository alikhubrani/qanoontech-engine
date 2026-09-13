import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { S } from '../strings'

/**
 * Where output is read: monospace on the ink surface, with the four controls
 * a person reading a log actually reaches for -- how many lines, whether
 * long ones wrap, copy it all, and follow the end while it grows.
 */
export function LogsView({
  text,
  lines,
  onLines,
  follow,
  onFollow,
  className,
  height = 'h-[calc(100vh-11rem)]',
}: {
  text: string
  lines?: number
  onLines?: (next: number) => void
  follow?: boolean
  onFollow?: (next: boolean) => void
  className?: string
  height?: string
}) {
  const [wrap, setWrap] = useState(true)
  const [copied, setCopied] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)

  // Follow the log while it grows: the interesting line is always the newest.
  useEffect(() => {
    if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [text, follow])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* the clipboard is not always available over http; the selection still works */
    }
  }

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-lg bg-ink text-ink-foreground', className)}>
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5 text-xs">
        {onLines && (
          <div className="flex items-center gap-0.5">
            {[100, 300, 1000].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onLines(n)}
                className={cn(
                  'rounded-sm px-2 py-1 tabular-nums hover:bg-white/10',
                  lines === n ? 'bg-white/15 text-white' : 'text-ink-foreground/70',
                )}
              >
                {n}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {onFollow && (
            <Toggle on={Boolean(follow)} onClick={() => onFollow(!follow)}>
              {S.logsFollow}
            </Toggle>
          )}
          <Toggle on={wrap} onClick={() => setWrap(!wrap)}>
            {S.logsWrap}
          </Toggle>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={copy}
            className="text-ink-foreground/70 hover:bg-white/10 hover:text-white"
          >
            {copied ? <Check /> : <Copy />}
            {copied ? S.logsCopied : S.logsCopy}
          </Button>
        </div>
      </div>
      <div ref={viewport} className={cn('overflow-auto px-4 py-3', height)}>
        <pre
          className={cn(
            'font-mono text-[12px] leading-[1.6]',
            wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
          )}
        >
          {text || S.logsEmpty}
        </pre>
      </div>
    </div>
  )
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'rounded-sm px-2 py-1 hover:bg-white/10',
        on ? 'bg-white/15 text-white' : 'text-ink-foreground/70',
      )}
    >
      {children}
    </button>
  )
}
