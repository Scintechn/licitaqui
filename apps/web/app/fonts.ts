import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'

/**
 * Self-hosted through `next/font/google`: the files are downloaded at build time
 * and served from our own origin, so the PWA works offline and there is no
 * render-blocking request to fonts.googleapis.com.
 *
 * ## Why Archivo no longer carries the width axis
 *
 * Spec §11 used to require it, because the wordmark is weight 800 at wdth 85%.
 * `axes: ['wdth']` meant the whole two-axis variable font — weight 100..900
 * *and* width 62..125% — 90KB of Latin, preloaded on every route, and the width
 * axis was read in exactly one place: `components/logo.tsx`, on nine fixed
 * characters.
 *
 * The wordmark is now outlines in that file, so the axis has no reader left and
 * Archivo is pinned to the three weights the product actually sets:
 *
 *   600  `font-semibold` — card values, screen headings (23 call sites)
 *   700  `font-bold`, and `<strong>` inside `font-display` on the price screen
 *   800  `font-extrabold` — the standalone figures on the public pages
 *
 * Pinning is the point: a variable font would still ship every weight between
 * them. If a fourth weight is ever needed, add it here — an unpinned weight is
 * synthesised by the browser and looks wrong, which is a visible failure rather
 * than a silent one.
 */
export const archivo = Archivo({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  display: 'swap',
  variable: '--font-archivo',
})

export const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-plex-sans',
})

export const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-plex-mono',
})

export const fontVariables = `${archivo.variable} ${plexSans.variable} ${plexMono.variable}`
