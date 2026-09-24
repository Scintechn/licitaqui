import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

const SURFACE = 'rounded-card border border-line bg-surface'

const PADDING = {
  none: '',
  sm: 'p-3.5', // 14px — the board's state cards
  md: 'p-4', // 16px — content cards
} as const

export type CardProps = {
  padding?: keyof typeof PADDING
  /** Blue hairline instead of the neutral one: the card being highlighted. */
  accent?: boolean
  children: ReactNode
  className?: string
}

/** The white surface the whole product is built from: radius 12, hairline border. */
export function Card({ padding = 'md', accent = false, children, className }: CardProps) {
  return (
    <div className={cn(SURFACE, accent && 'border-blue-line', PADDING[padding], className)}>
      {children}
    </div>
  )
}

export type CardLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className'> & {
  padding?: keyof typeof PADDING
  children: ReactNode
  className?: string
}

/**
 * The same surface as a real link — used for the tender cards in the Radar
 * list, so the whole card is one keyboard stop and one screen-reader target.
 */
export function CardLink({ padding = 'sm', children, className, ...anchor }: CardLinkProps) {
  return (
    <a
      {...anchor}
      className={cn(
        SURFACE,
        PADDING[padding],
        'block text-ink no-underline transition-colors hover:border-line-strong',
        className,
      )}
    >
      {children}
    </a>
  )
}

/**
 * A row inside a card: label left, value right, hairline underneath.
 * `last` drops the rule — the board never underlines the final row.
 */
export function CardRow({
  label,
  value,
  aside,
  last = false,
  className,
}: {
  label: ReactNode
  value: ReactNode
  /** Right-most slot: a page reference ("p.43") or a chevron. */
  aside?: ReactNode
  last?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 py-2.5 text-body',
        !last && 'border-b border-line',
        className,
      )}
    >
      <span className="grow">{label}</span>
      <span className="font-medium">{value}</span>
      {aside ? (
        <span className="min-w-7 text-right font-mono text-label text-muted">{aside}</span>
      ) : null}
    </div>
  )
}

/** The mono, uppercase, letter-spaced caption that titles every board section. */
export function SectionLabel({
  children,
  className,
  tone = 'ink',
  size = 'label',
}: {
  children: ReactNode
  className?: string
  /**
   * `inverse` is the same label on a graphite panel (public pages, task D2).
   * `accent` is the blue eyebrow over the recommended plan on the Landing.
   *
   * A tone rather than a `text-blue` from the caller: `lib/cn.ts` is a plain
   * join, so a colour utility passed in `className` would sit next to this
   * component's own and be settled by stylesheet order — which is how the
   * "Para começar a vender" eyebrow first shipped graphite.
   */
  tone?: 'ink' | 'muted' | 'inverse' | 'accent'
  /**
   * `label` (11px) is the board's in-app size. `caption` (12px) is the eyebrow
   * on the public pages, which sit on a wider measure (task D2).
   *
   * This is a prop and not a `className` on purpose: two font-size utilities
   * would fight over stylesheet order, which `lib/cn.ts` warns about.
   */
  size?: 'label' | 'caption'
}) {
  const TONE = {
    ink: 'text-ink',
    muted: 'text-muted',
    // The only dark panel in the product is the brand-blue one; the
    // graphite ramp's faint tier measures 3.22:1 there. `on-brand-faint`
    // is 6.00:1, measured in `tokens.css`.
    inverse: 'text-on-brand-faint',
    accent: 'text-blue',
  } as const
  return (
    <div
      className={cn(
        'font-mono font-medium tracking-[0.08em] uppercase',
        size === 'label' ? 'text-label' : 'text-caption',
        TONE[tone],
        className,
      )}
    >
      {children}
    </div>
  )
}
