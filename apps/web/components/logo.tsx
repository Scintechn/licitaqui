import { cn } from '@/lib/cn'

/**
 * Brand geometry, spec §11 / public/brand/LEIAME.md: three bars on a 64 grid,
 * bar height 11, gaps 4. The stagger IS the mark — never right-align the bars
 * and never sort them by length.
 */
const BARS = [
  { x: 34, y: 12, width: 22, tone: 'accent' },
  { x: 8, y: 27, width: 48, tone: 'ink' },
  { x: 14, y: 42, width: 42, tone: 'ink' },
] as const

export type LogoTone =
  /** Blue short bar + graphite bars. The default, for Ivory and white surfaces. */
  | 'brand'
  /** Every bar in graphite: one-colour printing and stamps. */
  | 'mono'
  /** Light blue + ivory, for dark (graphite) backgrounds. */
  | 'inverse'
  /**
   * Every bar in Ivory. The only correct tone ON BLUE — LEIAME.md: "azul sobre
   * azul desaparece". This is what the Telegram bot avatar uses.
   */
  | 'ivory'

const BAR_FILL: Record<LogoTone, { accent: string; ink: string }> = {
  brand: { accent: 'fill-blue', ink: 'fill-ink' },
  mono: { accent: 'fill-ink', ink: 'fill-ink' },
  inverse: { accent: 'fill-blue-light', ink: 'fill-ivory' },
  ivory: { accent: 'fill-ivory', ink: 'fill-ivory' },
}

const WORDMARK_TONE: Record<LogoTone, { licita: string; qui: string }> = {
  brand: { licita: 'text-ink', qui: 'text-blue' },
  mono: { licita: 'text-ink', qui: 'text-ink' },
  inverse: { licita: 'text-ivory', qui: 'text-blue-light' },
  ivory: { licita: 'text-ivory', qui: 'text-ivory' },
}

export type LogoSymbolProps = {
  size?: number
  tone?: LogoTone
  className?: string
}

/** The symbol alone, without the name. Decorative by default. */
export function LogoSymbol({ size = 30, tone = 'brand', className }: LogoSymbolProps) {
  const fills = BAR_FILL[tone]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden
      className={cn('block shrink-0', className)}
    >
      {BARS.map((bar) => (
        <rect
          key={bar.y}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={11}
          className={fills[bar.tone]}
        />
      ))}
    </svg>
  )
}

export type LogoProps = {
  /** `full` = symbol + wordmark (the assinatura). `symbol` = mark only. */
  variant?: 'full' | 'symbol'
  tone?: LogoTone
  /** Symbol size in px; the wordmark scales with it. */
  size?: number
  /**
   * Renders the accessible name as an <h1> when the logo IS the page heading
   * (the landing hero). Everywhere else it stays a plain element.
   */
  as?: 'div' | 'span'
  className?: string
}

/**
 * The brand name is always "LicitaQui" — one word, capital L and Q, and only
 * "Qui" takes the blue (spec §11). The wordmark is Archivo 800 at wdth 85%
 * with -3% tracking, which is why Archivo is loaded with its width axis.
 */
export function Logo({
  variant = 'full',
  tone = 'brand',
  size = 30,
  as: Tag = 'div',
  className,
}: LogoProps) {
  if (variant === 'symbol') {
    return (
      <Tag className={cn('inline-flex', className)} aria-label="LicitaQui" role="img">
        <LogoSymbol size={size} tone={tone} />
      </Tag>
    )
  }

  const word = WORDMARK_TONE[tone]
  return (
    <Tag className={cn('inline-flex items-center gap-1', className)} aria-label="LicitaQui" role="img">
      <LogoSymbol size={size} tone={tone} />
      <span
        aria-hidden
        className={cn('font-display leading-none', word.licita)}
        style={{
          fontWeight: 800,
          fontStretch: '85%',
          letterSpacing: '-0.03em',
          fontSize: `${Math.round(size * 0.733)}px`,
        }}
      >
        Licita<span className={word.qui}>Qui</span>
      </span>
    </Tag>
  )
}
