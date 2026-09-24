import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Icon, type IconName } from './icon'

export type LockedBlockProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className'> & {
  title: ReactNode
  /** Second line: what it unlocks, and which plan it belongs to. */
  description?: ReactNode
  /** Defaults to the padlock; the price block uses `margin`. */
  icon?: IconName
  className?: string
}

/**
 * The upsell surface: a dashed block over the muted fill, standing where the
 * real content will be once the user has an account or a plan.
 *
 * It is a real link, never a disabled control — the whole point is that it can
 * be reached with the keyboard and leads somewhere.
 */
export function LockedBlock({
  title,
  description,
  icon = 'locked',
  className,
  ...anchor
}: LockedBlockProps) {
  return (
    <a
      {...anchor}
      className={cn(
        'flex items-center gap-3 rounded-card border border-dashed border-field-line',
        'bg-fill-muted p-3.5 text-ink no-underline transition-colors hover:bg-surface',
        className,
      )}
    >
      <Icon name={icon} size={22} className="text-blue" />
      <span className="grow">
        <span className="block text-lead font-semibold">{title}</span>
        {description ? (
          <span className="block text-meta text-muted">{description}</span>
        ) : null}
      </span>
      <Icon name="chevronRight" size={18} className="text-muted" />
    </a>
  )
}

export type LockedValueProps = {
  /**
   * Bar width. A number is px — the board masks figures at 64 and big numbers
   * at 110. A string is any CSS length, for the masked price band on the
   * Landing, where the two bars are a proportion of the block they sit in.
   */
  width?: number | string
  /** Bar height in px: 14 for a table value, 30 for a headline figure. */
  height?: number
  /**
   * What is hidden, for screen readers — in Brazilian Portuguese, supplied by
   * the screen. Without it the bar is hidden from assistive tech entirely.
   */
  label?: string
  className?: string
}

/** A grey bar standing in for a figure the current plan cannot see. */
export function LockedValue({ width = 64, height = 14, label, className }: LockedValueProps) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width, height }}
      className={cn('inline-block rounded bg-line-strong align-middle', className)}
    />
  )
}
