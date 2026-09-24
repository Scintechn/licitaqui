import type { NextConfig } from 'next'

/**
 * Spec §3.3 has two layers above the database:
 *
 *  - **public pages** (the Landing, the Offer) render statically and
 *    revalidate — each page sets its own `revalidate`;
 *  - **user data** (the Radar and everything under it) is dynamic and must
 *    never reach a CDN: `Cache-Control: private, no-store`.
 *
 * The second rule is stated here as well as by each page's `force-dynamic`,
 * because the failure it prevents is silent and severe: a cached Radar serves
 * the previous visitor's company, CNPJ and matches to the next one, and a page
 * that accidentally stopped being dynamic would not announce itself. The API
 * routes set the same header themselves (`PRIVATE_NO_STORE`).
 *
 * Verified on `next start`:
 *
 *     /radar, /radar/edital/*   private, no-store
 *     /                         s-maxage=600, stale-while-revalidate=…
 *     /api/radar/*              private, no-store
 *
 * `next dev` shows `no-cache, must-revalidate` on the two Radar paths instead.
 * That is the dev server's own no-caching header and not what ships; check
 * this against a production build, never against `next dev`.
 */

const RADAR_HEADERS = [
  { key: 'Cache-Control', value: 'private, no-store' },
  // A tender page's URL carries the company's CNPJ; keep it out of the Referer
  // sent to the agency portals the Opportunity screen links to.
  { key: 'Referrer-Policy', value: 'same-origin' },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /*
   * **The optimiser's quality allowlist.**
   *
   * Next 16 defaults this to `[75]` and *silently coerces* anything else to
   * the nearest allowed value — so `quality={90}` on the `/fundadores` hero
   * shot shipped as `q=75` and the only evidence was `&q=75` in the emitted
   * `srcSet`. It is an allowlist by design: the endpoint is public, and
   * without one anybody can make the server transcode at any quality it likes.
   *
   * 90 is here for one image: the Radar screenshot in that hero, whose
   * smallest type is about 11px. 75 is tuned for photographs and visibly
   * mushes glyph edges at that size. Everything else on the product is a
   * photograph or an icon and stays at 75.
   */
  images: { qualities: [75, 90] },
  async headers() {
    return [
      { source: '/radar', headers: RADAR_HEADERS },
      { source: '/radar/:path*', headers: RADAR_HEADERS },
    ]
  },
}

export default nextConfig
