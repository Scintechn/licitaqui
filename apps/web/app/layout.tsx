import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import type { Metadata, Viewport } from 'next'
import { fontVariables } from './fonts'
import './globals.css'

export const metadata: Metadata = {
  title: 'LicitaQui',
  description: 'Encontre licitações públicas que a sua MEI ou ME consegue atender.',
  icons: {
    icon: [
      { url: '/brand/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/brand/favicon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: '/brand/icone-192.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#FBF7F3',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={fontVariables}>
      <body>
        {children}
        {/*
          Vercel Analytics and Speed Insights (spec §5: "events table + Vercel
          Analytics"). Both are cookieless and store no personal data, which is
          why they sit outside the LGPD consent flow — unlike the `events` table,
          which is ours and does identify a user or visitor.

          They are the page-level numbers (traffic, Core Web Vitals); the Phase 0
          gate metrics in §14 come from `events` and /admin, not from here.
        */}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  )
}
