import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Icon, type IconName } from './icon'

export type AppBarProps = {
  /** Left slot: the `Logo` on the Radar, or `AppBarBack` on a detail screen. */
  leading?: ReactNode
  /**
   * Middle slot. Deliberately not an `<h1>`: the board puts the page heading in
   * the body below the bar, so the screen owns its own heading level.
   */
  title?: ReactNode
  /** Right slot: `AppBarAction`s, or a `Tag` naming the plan. */
  actions?: ReactNode
  className?: string
}

/** The 60px top bar shared by every screen. Gutter matches the 390px frame. */
export function AppBar({ leading, title, actions, className }: AppBarProps) {
  return (
    <header
      className={cn(
        'flex min-h-[60px] shrink-0 items-center gap-3 px-gutter py-2',
        className,
      )}
    >
      {leading}
      {title ? (
        <div className="grow text-lead font-semibold">{title}</div>
      ) : (
        <div className="grow" />
      )}
      {actions ? <div className="flex items-center gap-0.5">{actions}</div> : null}
    </header>
  )
}

const ACTION =
  'inline-flex size-touch items-center justify-center rounded-pill border-0 bg-transparent ' +
  'text-ink no-underline transition-colors hover:bg-fill-muted'

export type AppBarActionProps = {
  icon: IconName
  /** Accessible name — the button shows an icon only, so this is required. */
  label: string
  className?: string
}

/** A 44px round icon button in the bar. Meets the board's touch-target rule. */
export function AppBarAction({
  icon,
  label,
  className,
  ...button
}: AppBarActionProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>) {
  return (
    <button
      {...button}
      type={button.type ?? 'button'}
      aria-label={label}
      className={cn(ACTION, className)}
    >
      <Icon name={icon} size={22} />
    </button>
  )
}

/** The same 44px target, as a link. */
export function AppBarActionLink({
  icon,
  label,
  className,
  ...anchor
}: AppBarActionProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'children'>) {
  return (
    <a {...anchor} aria-label={label} className={cn(ACTION, className)}>
      <Icon name={icon} size={22} />
    </a>
  )
}

/** "← Voltar" — the leading slot on detail screens. */
export function AppBarBack({
  children,
  className,
  ...anchor
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'children'> & {
  children: ReactNode
  className?: string
}) {
  return (
    <a
      {...anchor}
      className={cn(
        'inline-flex min-h-touch items-center gap-1 text-body text-ink no-underline',
        className,
      )}
    >
      <Icon name="chevronLeft" size={20} />
      {children}
    </a>
  )
}
