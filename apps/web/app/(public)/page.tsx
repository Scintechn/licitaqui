import type { Metadata } from 'next'
import Link from 'next/link'
import { Icon, Logo, SectionLabel } from '@/components'
import { founderSeats, type FounderSeatsView } from '@/lib/founders/seat-count'
import { FOUNDER_SEATS } from '@/lib/founders/seats'
import { format, messages } from '@/lib/messages'
import { openTenderStats } from '@/lib/radar/stats'
import { ACCOUNT_HREF } from '@/lib/routes'
import { ExampleRadar } from './example-radar'
import { Wrap } from './page-parts'
import { Alerts, Faq, Footer, Guarantees, HowItWorks, Opportunity, Plans } from './sections'
import { SearchForm } from './search-form'

/**
 * `/` — the Landing.
 *
 * Task D3 built the hero from canvas 01 (`Main.dc.html`) and stopped there,
 * which left the page about a third of the approved document. This is the rest
 * of `paginas/landing_radar.html`, in its order: the founders strip, the nav,
 * the example Radar panel beside the search card, "Como funciona", the
 * opportunity example, the Telegram alert, the plans, the guarantees and the
 * questions — each nav anchor pointing at a section that exists.
 *
 * Two things in the source are deliberately not here:
 *
 *  - the **"Prévia" banner**, which only ever existed to mark the file as a
 *    draft for review;
 *  - the source's `[N]` seat placeholder, which is real data here — see
 *    `FoundersStrip`.
 *
 * The hero's headline, sentence and search card are D3's and untouched: they
 * are the approved canvas-01 copy in `messages.radar.landing`, other lanes read
 * those keys, and the alternative headline the desktop source uses is a copy
 * decision for Sci rather than something to change in passing.
 *
 * Spec §3.3: public, statically rendered, revalidated every ten minutes. The
 * only server data on the page is the pair of counts in "Hoje no Brasil" and
 * the founder seat count — both read at revalidation, both omitted rather than
 * guessed when the database cannot be reached.
 */

const copy = messages.radar.landing

export const metadata: Metadata = {
  title: messages.radar.meta.title,
  description: messages.radar.meta.description,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    siteName: messages.brand.name,
    title: messages.radar.meta.title,
    description: messages.radar.meta.description,
  },
}

export const dynamic = 'force-static'
export const revalidate = 600

/* ------------------------------------------------------------------ pieces */

function TrustLine({ icon, children }: { icon: 'visitor' | 'tender'; children: string }) {
  return (
    <li className="flex items-center gap-2">
      <Icon name={icon} size={16} className="text-muted" />
      {children}
    </li>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="font-display text-[26px] leading-none font-semibold tabular-nums">
        {value.toLocaleString('pt-BR')}
      </div>
      <div className="pt-1 text-meta text-muted">{label}</div>
    </div>
  )
}

/**
 * The strip above the header: the founder price, how many seats are left, and
 * the way to the offer.
 *
 * The seat count is F1's — the same `founders_list` count `/fundadores` shows —
 * read on the server at revalidation (`lib/founders/seat-count.ts`). When it
 * cannot be read the strip drops the "restam N" clause entirely and says only
 * how many seats the offer has. It never prints a number nobody counted: this
 * is a scarcity claim on a paid offer, and inventing one would be a lie told to
 * every visitor at the top of the page.
 */
function FoundersStrip({ seats }: { seats: FounderSeatsView | null }) {
  const { founderStrip } = copy
  const line = seats
    ? format(founderStrip.seats, { count: seats.left, total: seats.total })
    : format(founderStrip.seatsUnknown, { total: FOUNDER_SEATS })

  return (
    <div className="bg-attention-soft text-ink">
      <Wrap className="flex min-h-touch flex-wrap items-center justify-center gap-x-2.5 gap-y-1 py-1.5 text-center text-body leading-[1.45]">
        <span>
          <b className="font-semibold text-attention">{founderStrip.label}</b>{' '}
          {format(founderStrip.offer, { preco: messages.plans.promo.price })} · {line}
        </span>
        <Link href="/fundadores" className="font-semibold text-blue no-underline hover:text-blue-hover">
          {founderStrip.cta}
        </Link>
      </Wrap>
    </div>
  )
}

/**
 * Everything a nav link needs **except** its `display`. The display utility is
 * per-link: `lib/cn.ts` is a plain join, so `hidden` and `inline-flex` in the
 * same class list would be settled by stylesheet order rather than by intent —
 * which is how these three anchors first shipped visible on a 390px phone,
 * pushing the document 97px wider than the screen.
 */
const NAV_LINK =
  'min-h-touch items-center px-3 text-lead font-medium text-ink no-underline hover:text-blue'

/**
 * The header of the approved page: the wordmark and four links.
 *
 * Below 900px the source hides everything but "Entrar", and so does this: the
 * three anchors point at sections of this same document, which a phone reaches
 * by scrolling, and a row of five tap targets across a 390px bar would push the
 * wordmark off the screen.
 */
function Header() {
  const { nav } = copy
  return (
    <header>
      <Wrap className="flex min-h-16 items-center justify-between gap-3">
        <Link href="/" aria-label={messages.radar.nav.home} className="inline-flex min-h-touch items-center">
          <Logo size={32} />
        </Link>

        <nav aria-label={nav.label} className="flex items-center gap-1">
          <a href="#como-funciona" className={`hidden min-[900px]:inline-flex ${NAV_LINK}`}>
            {nav.howItWorks}
          </a>
          <a href="#planos" className={`hidden min-[900px]:inline-flex ${NAV_LINK}`}>
            {nav.plans}
          </a>
          <a href="#perguntas" className={`hidden min-[900px]:inline-flex ${NAV_LINK}`}>
            {nav.faq}
          </a>
          {/* `/conta/criar` is U1's and does not exist yet, so this — like
              every other account control — goes through `lib/routes.ts`. */}
          <Link
            href={ACCOUNT_HREF}
            className={`inline-flex ${NAV_LINK} ml-1.5 rounded-control border border-line-strong bg-surface`}
          >
            {nav.signIn}
          </Link>
        </nav>
      </Wrap>
    </header>
  )
}

/* -------------------------------------------------------------------- page */

export default async function LandingPage() {
  const [stats, seats] = await Promise.all([openTenderStats(), founderSeats()])

  return (
    <div className="flex min-h-dvh flex-col bg-ivory text-base leading-[1.55] text-ink">
      <a
        href="#inicio"
        className="sr-only focus:not-sr-only focus:absolute focus:m-2 focus:rounded-control focus:bg-surface focus:px-3 focus:py-2"
      >
        {messages.radar.nav.skip}
      </a>

      <FoundersStrip seats={seats} />
      <Header />

      <main id="inicio" className="grow">
        {/*
          The hero. On a phone: the words, the search card, the two trust lines
          and then the example panel — the board's mobile order. From 900px the
          words and the card are the left column and the panel is the right,
          which is the split the approved desktop landing uses.
        */}
        <div className="pt-4 pb-10 min-[900px]:pt-7 min-[900px]:pb-14">
          <Wrap className="grid items-start gap-7 min-[900px]:grid-cols-2 min-[900px]:gap-14">
            <div className="flex flex-col gap-4.5">
              <span className="inline-flex items-center gap-2 self-start rounded-badge bg-blue-soft px-2.5 py-1.5 font-mono text-caption font-medium tracking-[0.06em] text-blue uppercase">
                <span aria-hidden className="inline-block size-[7px] rounded-pill bg-blue" />
                {copy.trial}
              </span>

              <h1 className="font-display text-[30px] leading-[1.12] font-semibold tracking-[-0.01em] text-balance min-[900px]:text-[44px]">
                {copy.title}
              </h1>

              <p className="text-lead leading-[1.5] text-muted min-[900px]:text-intro">
                {copy.subtitle}
              </p>

              <SearchForm />

              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-meta text-muted">
                <TrustLine icon="tender">{copy.sources}</TrustLine>
              </ul>

              <p className="text-meta">
                <Link href="/fundadores" className="font-semibold text-blue">
                  {copy.founders}
                </Link>
              </p>

              {stats ? (
                <section className="flex flex-col gap-2 border-t border-line pt-3.5">
                  <SectionLabel tone="muted">{copy.todayLabel}</SectionLabel>
                  <div className="grid grid-cols-2 gap-3">
                    <Stat value={stats.open} label={copy.todayOpen} />
                    <div className="border-l border-line pl-3">
                      <Stat value={stats.meEpp} label={copy.todayMeEpp} />
                    </div>
                  </div>
                </section>
              ) : null}
            </div>

            <ExampleRadar />
          </Wrap>
        </div>

        <HowItWorks />
        <Opportunity />
        <Alerts />
        <Plans seats={seats} />
        <Guarantees />
        <Faq />
      </main>

      <Footer />
    </div>
  )
}
