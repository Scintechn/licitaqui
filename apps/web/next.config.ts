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

/**
 * Security headers for every response (audit finding, 2026-09-25): before this
 * there was no `middleware.ts`/`proxy.ts` matching anything but `/admin`, no
 * `vercel.json` header block, and `next.config.ts` set only `Cache-Control` and
 * `Referrer-Policy` on `/radar*`. Nothing anywhere set a frame policy, HSTS,
 * `X-Content-Type-Options` or `Permissions-Policy` — on a public lead-capture
 * form (`/fundadores`) taking name, e-mail, WhatsApp and CNPJ, on a repo that
 * just went public.
 *
 * `X-Frame-Options: DENY` and the CSP `frame-ancestors 'none'` below both close
 * the same hole — clickjacking the founders signup inside an invisible iframe —
 * for old and new browsers respectively; shipping both costs nothing.
 *
 * `Referrer-Policy` here is the site-wide default; `RADAR_HEADERS` above still
 * overrides it to the stricter `same-origin` for `/radar*`, where the URL
 * itself carries a CNPJ.
 */
const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // 2 years, subdomains included. No `preload`: that is a one-way submission
  // to browsers' hardcoded preload lists, effectively permanent, and not this
  // PR's call to make for every subdomain that may exist under the apex.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Nothing on the product uses any of these; deny them all rather than name
  // only the ones a reviewer happens to think of today.
  {
    key: 'Permissions-Policy',
    value:
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), ' +
      'magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()',
  },
  /**
   * Deliberately partial. GTM (container GTM-5V6M75R7, `app/layout.tsx`) is
   * live and, once loaded, can inject further inline scripts for whatever
   * tags are configured inside that container in Google's UI — which this
   * repository does not enumerate and cannot enumerate from source. A
   * `script-src` strict enough to matter (no `'unsafe-inline'`, a nonce or a
   * hash allowlist) would allow or break those tags silently, invisibly to
   * anyone reading a diff here, exactly what this task was warned against
   * ("a CSP that breaks GTM silently is worse than none").
   *
   * So this ships only the directives that cannot interact with GTM, GA4,
   * Vercel Analytics/Speed Insights or `next/image` at all, because none of
   * them govern script execution or asset origins:
   *
   *  - `object-src 'none'`   — no Flash/plugin content anywhere on the site;
   *  - `base-uri 'self'`     — a `<base>` tag cannot be used to retarget the
   *                            page's relative URLs (a classic injection
   *                            primitive) to another origin;
   *  - `frame-ancestors 'none'` — the CSP-native form of `X-Frame-Options`
   *                            above, redundant with it by design;
   *  - `form-action 'self'` — every native `<form>` on the site (Radar's
   *                            search box, the admin CSV export, every Server
   *                            Action) already posts same-origin; the founders
   *                            signup itself goes through `fetch()`, which
   *                            this directive does not govern at all.
   *
   * `script-src`, `style-src`, `img-src` and `connect-src` are not set here —
   * omitting a directive leaves it unrestricted, not blocked, so GTM's
   * `googletagmanager.com` script tag, GA4's `google-analytics.com` beacons,
   * `next/image`'s optimizer and the Vercel Analytics/Speed Insights beacons
   * are all unaffected. Tightening those needs an audit of what is actually
   * configured inside the GTM container plus either a nonce threaded through
   * `app/layout.tsx`'s `<Script>` tag (GTM's own supported mechanism, per
   * Google's docs) or a nonced/hashed `next.config.ts` build — real work,
   * carded as H2 in `docs/DEVELOPMENT_PLAN.md` §5, not a `later` left unlogged.
   */
  {
    key: 'Content-Security-Policy',
    value: "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  },
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
      { source: '/:path*', headers: SECURITY_HEADERS },
      { source: '/radar', headers: RADAR_HEADERS },
      { source: '/radar/:path*', headers: RADAR_HEADERS },
    ]
  },
}

export default nextConfig
