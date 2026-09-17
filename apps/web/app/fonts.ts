import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'

/**
 * Self-hosted through `next/font/google`: the files are downloaded at build time
 * and served from our own origin, so the PWA works offline and there is no
 * render-blocking request to fonts.googleapis.com.
 *
 * Spec §11: Archivo must be loaded WITH the width axis — the wordmark is
 * weight 800 at wdth 85%, letter-spacing -3%.
 */
export const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
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
