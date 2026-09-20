import type { Metadata } from 'next'
import Link from 'next/link'
import { AppBar, AppBarActionLink, Icon, Logo, SectionLabel } from '@/components'
import { messages } from '@/lib/messages'
import { openTenderStats } from '@/lib/radar/stats'
import { SearchForm } from './search-form'

/**
 * `/` — the Landing, canvas 01 (`Main.dc.html`).
 *
 * A transcription of the approved 390 px frame: the app bar, the headline, the
 * sentence under it, the search card, the two trust lines and the "Hoje no
 * Brasil" strip pinned to the bottom. From 900 px the same blocks become two
 * columns — the words on the left, the card on the right — which is the split
 * the approved desktop landing (`paginas/landing_radar.html`) uses for its
 * hero. Nothing is added: the desktop layout reflows the mobile content.
 *
 * Spec §3.3: a public page, so it is statically rendered and revalidated
 * every ten minutes. The only server data on it is the pair of counts in the
 * strip, which is read at revalidation and left out entirely when there is no
 * database to read (see `openTenderStats`).
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

export default async function LandingPage() {
  const stats = await openTenderStats()

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#inicio"
        className="sr-only focus:not-sr-only focus:absolute focus:m-2 focus:rounded-control focus:bg-surface focus:px-3 focus:py-2"
      >
        {messages.radar.nav.skip}
      </a>

      <AppBar
        leading={<Logo size={30} />}
        actions={
          <AppBarActionLink icon="menu" label={messages.radar.nav.menu} href="/conta/criar" />
        }
      />

      {/*
        Three children, in the board's order on a phone: the words above the
        card, the card, the words below it. From 900px they become two columns
        — the two text blocks stacked in column 1, the card alongside them in
        column 2 across both rows, which is the split the approved desktop
        landing uses for its hero.

        The rows are declared (`grid-rows-[auto_1fr]`) because `row-span-2`
        needs a second explicit row line to span to; with implicit rows only,
        the card collapses back into row 1 and pushes the sentence below the
        fold. The card is rendered ONCE either way: a second copy behind
        `hidden` would put two `id="cnpj"` inputs in the document and break
        every label on the page.
      */}
      <main
        id="inicio"
        className={
          'mx-auto flex w-full max-w-[1120px] grow flex-col gap-4.5 px-gutter pt-3 pb-5 ' +
          'min-[900px]:grid min-[900px]:grid-cols-[1fr_minmax(0,400px)] ' +
          'min-[900px]:grid-rows-[auto_1fr] min-[900px]:gap-x-12 min-[900px]:pt-12'
        }
      >
        <div className="flex flex-col gap-4.5 min-[900px]:col-start-1 min-[900px]:row-start-1">
          <h1 className="font-display text-[30px] leading-[1.12] font-semibold tracking-[-0.01em] text-balance min-[900px]:text-[44px]">
            {copy.title}
          </h1>
          <p className="text-lead leading-[1.5] text-muted min-[900px]:text-intro">
            {copy.subtitle}
          </p>
        </div>

        <div className="min-[900px]:col-start-2 min-[900px]:row-start-1 min-[900px]:row-span-2">
          <SearchForm />
        </div>

        <div className="flex grow flex-col gap-4.5 min-[900px]:col-start-1 min-[900px]:row-start-2">
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-meta text-muted">
            <TrustLine icon="visitor">{copy.trial}</TrustLine>
            <TrustLine icon="tender">{copy.sources}</TrustLine>
          </ul>

          <p className="text-meta">
            <Link href="/fundadores" className="font-semibold text-blue">
              {copy.founders}
            </Link>
          </p>

          {stats ? (
            <section className="mt-auto flex flex-col gap-2 border-t border-line pt-3.5">
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
      </main>
    </div>
  )
}
