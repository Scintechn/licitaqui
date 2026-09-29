import type { SVGProps } from 'react'
import { cn } from '@/lib/cn'

/**
 * The icon set drawn on the design system board ("Ícones · traço 1.8").
 * All paths are on a 24 grid, stroked in `currentColor` at 1.8, round caps.
 * Add a new name here rather than inlining an <svg> in a screen.
 */
const PATHS = {
  // Board row: Busca · Prazo · Edital · Alerta · Empresa · Travado · Margem
  search: ['M18 18a7 7 0 1 0-9.9-9.9A7 7 0 0 0 18 18Z', 'M20 20l-3.5-3.5'],
  deadline: ['M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z', 'M8 3v4M16 3v4M4 10h16'],
  tender: ['M7 3h7l5 5v13H7z', 'M14 3v5h5M10 13h6M10 17h6'],
  alert: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 20a2 2 0 0 0 4 0'],
  company: ['M4 20V8l8-4 8 4v12', 'M9 20v-6h6v6'],
  locked: ['M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  margin: ['M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M8 7h8M8 12h2M12 12h2M16 12h0M8 16h2M12 16h2'],

  // Navigation and affordances used across the screens
  arrowRight: ['M5 12h14M13 6l6 6-6 6'],
  chevronRight: ['M9 6l6 6-6 6'],
  chevronLeft: ['M15 18l-6-6 6-6'],
  check: ['M5 12l5 5 9-10'],
  /** "Copiar" — two sheets. Added for the PNCP id on canvas 03. */
  copy: ['M10 8h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z', 'M5 16V6a1 1 0 0 1 1-1h9'],
  account: ['M16 8a4 4 0 1 0-8 0 4 4 0 0 0 8 0Z', 'M4 21a8 8 0 0 1 16 0'],
  /**
   * "Favoritar" — a five-point star on the same 24 grid, card **D23**.
   *
   * A star rather than a bookmark because the board has no bookmark and the
   * gesture Sci described is "marked as Favorite", not "read later". Stroked
   * like everything else here; the *filled* state is the button's job, not a
   * second path, so one icon serves both and they cannot drift apart.
   */
  star: ['M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z'],
  filters: ['M4 6h16M7 12h10M10 18h4'],
  /** The app bar's hamburger on canvas 01 (`Main.dc.html`). Added by task D3. */
  menu: ['M4 7h16M4 12h16M4 17h16'],
  visitor: ['M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0Z', 'M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0Z', 'M12 12l6-6'],

  // Public pages (task D2), transcribed from paginas/oferta_fundadores.html
  money: ['M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z', 'M14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z'],
  send: ['M21 4L3 11l6 2 2 6 3-4 5 4z'],
  warning: ['M12 3l9 16H3z', 'M12 10v4M12 17h.01'],
  close: ['M6 6l12 12M18 6L6 18'],
  /**
   * The founders timeline (task D7) — a moment, and a subscription link.
   *
   * No `calendar`: `deadline` above already *is* one, drawn on the same grid,
   * and a second name for the same two paths is a fork waiting to drift.
   */
  clock: ['M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0Z', 'M12 7.5v5l3.5 2'],
  link: [
    'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
    'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  ],
  help: ['M12 21a9 9 0 100-18 9 9 0 000 18z', 'M9.5 9.5a2.5 2.5 0 113 2.45V14', 'M12 17h.01'],
} as const

export type IconName = keyof typeof PATHS

export const ICON_NAMES = Object.keys(PATHS) as IconName[]

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'name'> & {
  name: IconName
  /** Pixel size for both axes. The board draws icons at 22, inline glyphs at 14–18. */
  size?: number
  /** Accessible name. Omit it (the default) to hide the icon from assistive tech. */
  title?: string
  /**
   * Fill the shape instead of outlining it — for a toggle that is **on**.
   *
   * The set is stroked, which says nothing about state. The *Favoritar* star
   * (D23) shipped without this and changed `aria-pressed` and nothing else a
   * person could see.
   */
  filled?: boolean
}

export function Icon({
  name,
  size = 22,
  title,
  className,
  strokeWidth = 1.8,
  filled = false,
  ...props
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      /*
        **`filled` is how a toggle shows it is on.** The set is stroked at
        1.8 on a 24 grid, which is right for navigation and says nothing about
        state — so the *Favoritar* star changed `aria-pressed` and nothing a
        person could see (D23). A filled shape is the difference between a
        button that reports its state and one that only claims to.

        One path, filled or not, rather than a second "star-filled" entry:
        two paths drift, and the outline would eventually stop being the same
        star as the fill.
      */
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      {...props}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
