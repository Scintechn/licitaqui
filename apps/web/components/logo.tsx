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
  brand: { licita: 'fill-ink', qui: 'fill-blue' },
  mono: { licita: 'fill-ink', qui: 'fill-ink' },
  inverse: { licita: 'fill-ivory', qui: 'fill-blue-light' },
  ivory: { licita: 'fill-ivory', qui: 'fill-ivory' },
}

/*
 * The wordmark, as outlines.
 *
 * It used to be live text: `font-family: Archivo; font-weight: 800;
 * font-stretch: 85%; letter-spacing: -0.03em`. That one declaration was the
 * only thing in the product using Archivo's **width axis**, and carrying the
 * axis meant loading Archivo as a two-axis variable font - 90KB of Latin,
 * preloaded on every route, for nine characters that never change.
 *
 * Outlines cost 2.4KB in this file, render identically whether or not a font
 * has loaded - no FOUT on the brand name, which is the one word that must not
 * reflow - and let `fonts.ts` pin Archivo to the weights the product actually
 * sets. Generated from Archivo[wdth,wght].ttf at wght=800 / wdth=85, shaped by
 * HarfBuzz so the kerning is the font's own, with -30/1000 em of tracking
 * applied between glyphs.
 *
 * ## The coordinate system, so this can be regenerated
 *
 * Paths are in font units (1000/em), y **up**, baseline at y=0 - hence the
 * `scale(1,-1)` on the group. The viewBox reproduces the box the old CSS text
 * occupied exactly, so nothing in the layout moved: with `line-height: 1` the
 * line box is 1000 units tall and, from Archivo's typo metrics (ascender 878,
 * descender -210, USE_TYPO_METRICS set), its baseline sits
 * `(1000 - (878 + 210)) / 2 + 878 = 834` units below the top.
 */
const WORDMARK_WIDTH = 3731
const WORDMARK_BASELINE = 834
const WORDMARK_LICITA =
  'M63 0V687H232V141H523V0Z M562 600V724H714V600ZM562 0V527H714V0Z M1005 -12Q928 -12 876 18Q823 48 796 109Q769 170 769 264Q769 359 797 420Q824 481 877 510Q930 540 1006 540Q1058 540 1099 527Q1141 515 1171 489Q1201 462 1216 421Q1232 379 1232 320H1082Q1082 357 1074 380Q1066 403 1049 413Q1033 423 1006 423Q977 423 959 410Q941 396 933 367Q924 339 924 293V233Q924 192 933 163Q941 134 959 119Q978 104 1009 104Q1035 104 1053 114Q1070 124 1079 147Q1087 170 1087 207H1232Q1232 152 1217 111Q1201 70 1171 42Q1142 15 1100 2Q1058 -12 1005 -12Z M1290 600V724H1442V600ZM1290 0V527H1442V0Z M1676 -12Q1631 -12 1601 3Q1570 17 1555 46Q1541 76 1541 117V411H1482V527H1545L1575 682H1693V527H1778V411H1693V155Q1693 130 1701 118Q1710 105 1733 105H1778V4Q1763 0 1745 -4Q1727 -8 1709 -10Q1691 -12 1676 -12Z M1955 -12Q1924 -12 1896 -4Q1868 3 1846 20Q1825 38 1813 66Q1800 94 1800 135Q1800 186 1820 221Q1840 256 1878 278Q1916 300 1971 310Q2027 320 2098 320V363Q2098 383 2092 397Q2085 411 2071 419Q2057 427 2034 427Q2012 427 1997 420Q1981 413 1974 402Q1967 390 1967 374V365H1820Q1819 370 1819 373Q1819 377 1819 382Q1819 432 1845 467Q1871 502 1920 521Q1969 539 2038 539Q2099 539 2147 523Q2195 507 2223 470Q2251 434 2251 372V139Q2251 123 2259 114Q2267 104 2282 104H2310V6Q2296 0 2273 -6Q2250 -12 2222 -12Q2192 -12 2169 -3Q2147 5 2133 20Q2118 35 2113 55H2108Q2092 36 2071 21Q2050 6 2021 -3Q1993 -12 1955 -12ZM2014 100Q2032 100 2048 107Q2064 114 2075 126Q2086 138 2092 155Q2098 172 2098 192V234Q2049 234 2018 225Q1986 216 1971 199Q1955 181 1955 156Q1955 138 1963 125Q1970 113 1983 107Q1996 100 2014 100Z'
const WORDMARK_QUI =
  'M2741 -131 2645 -10Q2641 -11 2635 -11Q2630 -11 2625 -11Q2529 -11 2461 27Q2394 66 2358 145Q2323 224 2323 344Q2323 465 2359 544Q2396 623 2465 661Q2535 699 2635 699Q2736 699 2805 661Q2875 623 2911 544Q2948 465 2948 344Q2948 222 2911 144Q2874 65 2803 26L2936 -131ZM2635 124Q2671 124 2698 137Q2724 149 2741 172Q2759 196 2767 230Q2775 264 2775 307V380Q2775 423 2767 457Q2759 491 2741 515Q2724 538 2698 551Q2671 563 2635 563Q2599 563 2573 551Q2546 538 2529 515Q2512 491 2504 457Q2495 423 2495 380V307Q2495 264 2504 230Q2512 196 2529 172Q2546 149 2573 137Q2599 124 2635 124Z M3156 -12Q3081 -12 3044 30Q3007 73 3007 157V527H3159V188Q3159 170 3163 157Q3167 144 3174 135Q3182 126 3193 121Q3205 117 3220 117Q3244 117 3261 130Q3279 143 3288 167Q3297 190 3297 220V527H3450V0H3322L3312 70H3307Q3291 44 3268 26Q3246 7 3217 -2Q3189 -12 3156 -12Z M3526 600V724H3678V600ZM3526 0V527H3678V0Z'

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
 * with -3% tracking, drawn as outlines rather than set as text - see
 * `WORDMARK_LICITA` above for what that bought and how to regenerate it.
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
      {/* The old text box was `font-size: round(size * 0.733)px` with
          `line-height: 1`, so its height was exactly that font size. Same box,
          same flex centring against the symbol, same pixels. */}
      <svg
        aria-hidden
        height={Math.round(size * 0.733)}
        width={(Math.round(size * 0.733) * WORDMARK_WIDTH) / 1000}
        viewBox={`0 ${-WORDMARK_BASELINE} ${WORDMARK_WIDTH} 1000`}
        className="block shrink-0"
      >
        <g transform="scale(1,-1)">
          <path d={WORDMARK_LICITA} className={word.licita} />
          <path d={WORDMARK_QUI} className={word.qui} />
        </g>
      </svg>
    </Tag>
  )
}
