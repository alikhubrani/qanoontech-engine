import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/** Small primitives in the application's visual language. No library. */

export function Button({
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' }) {
  const styles = {
    default:
      'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50',
    primary: 'bg-brand text-white hover:bg-blue-800 disabled:opacity-50',
    danger: 'border border-red-200 bg-white text-bad hover:bg-red-50 disabled:opacity-50',
  }[variant]
  return (
    <button
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-blue-100"
      {...props}
    />
  )
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      {title && (
        <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
          {title}
        </h2>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Badge({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'muted'
  children: ReactNode
}) {
  const styles = {
    ok: 'bg-emerald-50 text-ok border-emerald-200',
    warn: 'bg-amber-50 text-warn border-amber-200',
    bad: 'bg-red-50 text-bad border-red-200',
    muted: 'bg-slate-50 text-slate-500 border-slate-200',
  }[tone]
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${styles}`}>
      {children}
    </span>
  )
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-bad">
      {children}
    </p>
  )
}
