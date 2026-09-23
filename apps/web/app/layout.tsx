import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
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
      <head>
        {/*
          Google Tag Manager (container GTM-5V6M75R7).

          `beforeInteractive` is what GTM's own instructions mean by "as high in
          the <head> as possible": Next hoists it into the document head at build
          time rather than injecting it after hydration, so a tag that must see
          the first pageview does.

          NOTE FOR WHOEVER READS THIS NEXT: GA4 through GTM sets `_ga` cookies,
          which is a third-party tracking cookie carrying a per-visitor id.
          `politica-de-privacidade.md` §10 has had its "não usamos cookies de
          rastreamento de terceiros" sentence removed on Sci's instruction, but
          two claims in that same paragraph are still narrower than what GA4
          does — "apenas cookies necessários" and "as métricas de uso são
          agregadas e não identificam você individualmente" — and §9's processor
          table still lists Google for sign-in only. Those sentences are Sci's
          to write (legal brief §5); this must not ship until he has.

          The Vercel components below are a different case and the comment there
          explains why.
        */}
        <Script id="gtm" strategy="beforeInteractive">
          {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-5V6M75R7');`}
        </Script>
      </head>
      <body>
        {/* GTM's no-JavaScript fallback, immediately after <body> as it requires. */}
        <noscript>
          <iframe
            src="https://www.googletagmanager.com/ns.html?id=GTM-5V6M75R7"
            height="0"
            width="0"
            style={{ display: 'none', visibility: 'hidden' }}
          />
        </noscript>
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
