import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Icon, type IconName } from './icon'

export type ButtonVariant =
  /** Blue fill. One per screen: the thing we want the user to do next. */
  | 'primary'
  /** White fill, hairline border. Alternatives and "back" actions. */
  | 'secondary'
  /**
   * Dashed border on the muted fill. NOT disabled: the action exists but needs
   * an account or a plan, so it stays focusable and leads to the upsell.
   */
  | 'locked'
  /** Text only. Inline, secondary navigation. */
  | 'link'

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-control px-4 text-lead font-semibold ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-60'

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'min-h-control border border-blue bg-blue text-surface hover:border-blue-hover hover:bg-blue-hover',
  secondary:
    'min-h-control border border-line-strong bg-surface text-ink hover:bg-fill-muted',
  locked:
    'min-h-control border border-dashed border-line-strong bg-fill-muted text-muted hover:text-ink',
  link: 'min-h-touch border border-transparent bg-transparent text-blue hover:text-blue-hover',
}

type SharedProps = {
  variant?: ButtonVariant
  /** Icon before the label. `locked` gets the padlock automatically. */
  iconStart?: IconName
  /** Icon after the label. The board pairs the primary CTA with `arrowRight`. */
  iconEnd?: IconName
  /** Stretches to the container. Mobile CTAs are full width; inline ones are not. */
  fullWidth?: boolean
  children: ReactNode
  className?: string
}

export type ButtonProps = SharedProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> & { href?: undefined }

export type ButtonLinkProps = SharedProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children' | 'className'> & { href: string }

function content(
  variant: ButtonVariant,
  iconStart: IconName | undefined,
  iconEnd: IconName | undefined,
  children: ReactNode,
) {
  const start = iconStart ?? (variant === 'locked' ? 'locked' : undefined)
  return (
    <>
      {start ? <Icon name={start} size={16} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={16} /> : null}
    </>
  )
}

/**
 * Renders a real `<button>`, or a real `<a>` when `href` is given — never a div
 * with a click handler, so keyboard and screen-reader behaviour comes for free.
 * The focus ring is the global one from tokens.css.
 */
export function Button(props: ButtonProps): React.JSX.Element
export function Button(props: ButtonLinkProps): React.JSX.Element
export function Button({
  variant = 'primary',
  iconStart,
  iconEnd,
  fullWidth = false,
  children,
  className,
  ...rest
}: ButtonProps | ButtonLinkProps) {
  const classes = cn(BASE, VARIANT[variant], fullWidth && 'w-full', className)
  const inner = content(variant, iconStart, iconEnd, children)

  if (typeof (rest as ButtonLinkProps).href === 'string') {
    const anchorProps = rest as AnchorHTMLAttributes<HTMLAnchorElement>
    return (
      <a {...anchorProps} className={cn(classes, 'no-underline')}>
        {inner}
      </a>
    )
  }

  const buttonProps = rest as ButtonHTMLAttributes<HTMLButtonElement>
  return (
    <button {...buttonProps} type={buttonProps.type ?? 'button'} className={classes}>
      {inner}
    </button>
  )
}
