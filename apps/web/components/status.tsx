import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * The three buckets the Radar sorts tenders into. Board section
 * "Badges e status". The dot carries no meaning on its own — the label always
 * ships with it, so colour is never the only signal.
 */
export type StatusKind =
  /** The company's CNAE covers it. */
  | 'compatible'
  /** Possible extra requirements: worth checking. */
  | 'check'
  /** Found by keyword only, outside the CNAE match. */
  | 'keyword'
  /**
   * A fact squarely in the company's favour — "Exclusivo ME/EPP" on the offer
   * page's example screening card. Added by task D2; the green is the board's
   * success pair, so no new colour enters the system.
   */
  | 'positive'

const KIND: Record<StatusKind, { box: string; dot: string }> = {
  compatible: { box: 'bg-blue-soft text-blue', dot: 'bg-blue' },
  check: { box: 'bg-attention-soft text-attention', dot: 'bg-attention' },
  keyword: { box: 'bg-fill-muted text-muted', dot: 'bg-muted' },
  positive: { box: 'bg-success-soft text-success', dot: 'bg-success' },
}

export type StatusProps = {
  kind: StatusKind
  children: ReactNode
  className?: string
}

export function Status({ kind, children, className }: StatusProps) {
  const tone = KIND[kind]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-badge px-2 py-[3px]',
        'font-mono text-label font-medium tracking-[0.06em] uppercase',
        tone.box,
        className,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-pill', tone.dot)} />
      {children}
    </span>
  )
}
