import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Small factual labels on a tender: benefit regime, extra licences, the plan a
 * feature belongs to. Board section "Badges e status", second row.
 */
export type TagTone =
  /** Something in the company's favour (exclusive to ME/EPP). */
  | 'blue'
  /** Plain fact, no judgement (quota, no quota). */
  | 'neutral'
  /** An extra requirement to look at (sanitary licence). */
  | 'attention'
  /** Off to the side: plan names, disabled facets. */
  | 'muted'

const TONE: Record<TagTone, string> = {
  blue: 'border-blue-line bg-blue-soft text-blue',
  neutral: 'border-line-strong bg-surface text-ink',
  attention: 'border-attention-line bg-attention-soft text-attention',
  muted: 'border-line-strong bg-fill-muted text-muted',
}

export type TagProps = {
  tone?: TagTone
  children: ReactNode
  className?: string
}

export function Tag({ tone = 'neutral', children, className }: TagProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-badge border px-2 py-[3px]',
        'text-caption font-medium whitespace-nowrap',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Wraps a row of tags with the board's 6px gap and lets them wrap on 390px. */
export function TagList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap gap-1.5', className)}>{children}</div>
}
