/** Plain English for a moment, because "2026-09-13T10:48:00.000Z" is not a fact anyone reads. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "12 min ago", "2 h ago", "3 d ago". Future moments read "in 48 min". */
export function ago(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return '—'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '—'
  const delta = now - at
  const future = delta < 0
  const span = Math.abs(delta)
  const text =
    span < MINUTE
      ? 'just now'
      : span < HOUR
        ? `${Math.round(span / MINUTE)} min`
        : span < DAY
          ? `${(span / HOUR).toFixed(span < 10 * HOUR ? 1 : 0).replace(/\.0$/, '')} h`
          : `${Math.round(span / DAY)} d`
  if (text === 'just now') return future ? 'now' : text
  return future ? `in ${text}` : `${text} ago`
}

/** "13 Sep, 13:40" in the browser's zone — the operator's own clock. */
export function when(iso: string | undefined | null): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** The full timestamp, for a title attribute. */
export function exact(iso: string | undefined | null): string {
  if (!iso) return ''
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString()
}

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}
