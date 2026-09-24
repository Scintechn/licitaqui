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
  /**
   * `primary`, inverted for the brand panel. White fill, blue label — because
   * a blue button on a blue panel is its own background.
   */
  | 'onBrand'
  /**
   * The blue-outlined alternative, for a second action **beside** a primary
   * one on the light ground: same weight of voice, visibly not the main ask.
   *
   * Neither existing alternative fits that slot. `secondary` is an ink label
   * on a `field-line` hairline — the "back" voice, which reads as retreat
   * next to a call to action rather than as a second way forward. `onBrand`
   * is a white fill with a white border and exists for the blue panel; on
   * ivory its border measures 1.07:1 and disappears.
   */
  | 'outline'

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-control px-4 text-lead font-semibold ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-60'

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'min-h-control border border-blue bg-blue text-surface hover:border-blue-hover hover:bg-blue-hover',
  secondary:
    'min-h-control border border-field-line bg-surface text-ink hover:bg-fill-muted',
  locked:
    'min-h-control border border-dashed border-line-strong bg-fill-muted text-muted hover:text-ink',
  link: 'min-h-touch border border-transparent bg-transparent text-blue hover:text-blue-hover',
  /**
   * The primary action **on the brand panel**, inverted.
   *
   * `primary` is blue on white; on a blue panel it disappears into its own
   * background — Sci saw it and said so. White ground with blue text is the
   * inversion, and it measures better in both directions than the original
   * did: the button is 11.49:1 against `--color-brand-panel`, and its label is
   * 6.16:1 against the button.
   */
  onBrand:
    'min-h-control border border-surface bg-surface text-blue hover:border-blue-soft hover:bg-blue-soft',
  /**
   * Measured with `styles/contrast.test.ts`'s own formula, on the two grounds
   * this actually sits on:
   *
   *   label `--color-blue` on `--color-surface`   **6.16:1**  (AA needs 4.5)
   *   border `--color-blue` on `--color-ivory`    **5.78:1**  (1.4.11 needs 3)
   *   label on the hover fill `--color-blue-soft` **5.30:1**
   *
   * The border is measured against the *page*, not against the button's own
   * fill: a control's boundary has to be findable against what surrounds it,
   * which is the mistake `onBrand` on ivory would make (1.07:1). The fill is
   * `surface` rather than transparent so the ratios above hold wherever it is
   * placed on the light ground.
   */
  outline:
    'min-h-control border border-blue bg-surface text-blue hover:bg-blue-soft hover:text-blue-hover',
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
