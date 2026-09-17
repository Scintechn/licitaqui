import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Icon } from './icon'

/**
 * The four states on the board's "Estados" panel. They are the honest answer
 * whenever the database has nothing yet — spec §2's golden rule: no screen
 * waits on PNCP or the AI inside a request, it shows `analyzing` and updates.
 */
export type StateKind =
  /** A job is running. Polite live region: announced without stealing focus. */
  | 'analyzing'
  /** The analysis finished and found something. */
  | 'found'
  /** Nothing matched. Always pair it with an `action` that widens the search. */
  | 'empty'
  /** The visitor or plan allowance ran out. */
  | 'limit'

export type StateCardProps = {
  kind: StateKind
  title: ReactNode
  description?: ReactNode
  /** A `Button variant="link"` or an anchor: the way out of this state. */
  action?: ReactNode
  className?: string
}

const TITLE_TONE: Record<StateKind, string> = {
  analyzing: 'text-ink',
  found: 'text-success',
  empty: 'text-ink',
  limit: 'text-attention',
}

function Indicator({ kind }: { kind: StateKind }) {
  switch (kind) {
    case 'analyzing':
      return (
        <span
          aria-hidden
          className="size-6.5 shrink-0 animate-ds-spin rounded-pill border-[3px] border-blue-soft border-t-blue"
        />
      )
    case 'found':
      return (
        <span
          aria-hidden
          className="inline-flex size-6.5 shrink-0 items-center justify-center rounded-pill bg-success"
        >
          <Icon name="check" size={15} strokeWidth={2.6} className="text-surface" />
        </span>
      )
    case 'empty':
      return <Icon name="tender" size={26} className="text-muted" />
    case 'limit':
      return <Icon name="locked" size={26} className="text-attention" />
  }
}

export function StateCard({ kind, title, description, action, className }: StateCardProps) {
  const live = kind === 'analyzing'
  return (
    <div
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      className={cn(
        'flex items-start gap-3 rounded-card border border-line bg-surface p-3.5',
        className,
      )}
    >
      <Indicator kind={kind} />
      <div className="flex flex-col gap-1">
        <div className={cn('text-body font-semibold', TITLE_TONE[kind])}>{title}</div>
        {description ? (
          <div className="text-meta leading-relaxed text-muted">{description}</div>
        ) : null}
        {action ? <div className="pt-0.5">{action}</div> : null}
      </div>
    </div>
  )
}
