import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { tenderHref } from '@/lib/radar/client'
import type { TenderCard } from '@/lib/radar/contract'
import { FavouriteStar } from './favourite-star'
import { TenderCardView } from './tender-card'

/**
 * D23's star on a Radar card — the **mechanism**, pinned where a string
 * assertion can pin it.
 *
 * `vitest.config.mts` has no jsdom, so there is nothing here that clicks and
 * nothing that measures: `useEffect` never runs and there are no boxes
 * (CLAUDE.md §4c). What this file can prove is the one thing the whole
 * placement exists for — that the control is **not inside the anchor** — plus
 * the two reserved numbers that keep it off the countdown and off the title.
 * The result, in a browser with real rectangles and a real click, is
 * `e2e/journeys/favourite-on-card.spec.ts`.
 */

const copy = messages.radar.favourites
const NOW = new Date('2026-09-17T15:00:00.000Z')

const TENDER: TenderCard = {
  id: '51885242000140-1-000744/2026',
  object: 'Registro de preços de baterias e pilhas',
  shortTitle: 'Baterias e pilhas',
  agencyName: 'Prefeitura de Campinas',
  city: 'Campinas',
  state: 'SP',
  modalityName: 'Pregão eletrônico',
  // Two days out, so the card draws a countdown in the top row — the one piece
  // of content the star could collide with.
  proposalsCloseAt: '2026-09-19T11:30:00.000Z',
  estimatedValue: '48196.00',
  confidentialBudget: false,
  priceRegistration: true,
  meEppSummary: 'exclusive',
  favoredTreatment: true,
  itemCount: 7,
  segments: ['Gráfico / Escritório'],
  matchedSegments: [],
  group: 'compatible',
  status: 'Divulgada no PNCP',
  pncpUpdatedAt: '2026-09-16T10:00:00.000Z',
}

const HREF = tenderHref(TENDER.id, { cnpj: '51885242000140', group: 'compatible' })

function withStar(marked = false): string {
  return renderToStaticMarkup(
    <TenderCardView
      tender={TENDER}
      now={NOW}
      href={HREF}
      action={<FavouriteStar tenderId={TENDER.id} marked={marked} onChange={() => {}} />}
    />,
  )
}

function withoutStar(): string {
  return renderToStaticMarkup(<TenderCardView tender={TENDER} now={NOW} href={HREF} />)
}

/**
 * Everything between the card's `<a>` and its `</a>`.
 *
 * The card contains no other anchor, so the first `</a>` closes the one that
 * opened — which is the whole reason this assertion is worth making: if a
 * `<button>` were ever moved inside, it would appear in this substring and
 * nowhere else would change.
 */
function insideAnchor(html: string): string {
  const open = html.indexOf('<a ')
  const close = html.indexOf('</a>')
  expect(open, 'the card is an anchor').toBeGreaterThanOrEqual(0)
  expect(close, 'the anchor closes').toBeGreaterThan(open)
  return html.slice(open, close)
}

describe('where the star is', () => {
  it('is not inside the anchor — nested interactive content is the defect', () => {
    const html = withStar()
    // It is on the card…
    expect(html).toContain('<button')
    expect(html).toContain(`aria-label="${copy.add}"`)
    // …and not in the link. A `<button>` inside an `<a>` is what made the
    // "Objeto completo" `<details>` wrong, and it is why D23 left this control
    // off the card until the placement was decided rather than guessing.
    expect(insideAnchor(html), 'a button inside the card anchor').not.toContain('<button')
  })

  it('is a sibling of the anchor, inside a positioned wrapper', () => {
    const html = withStar()
    // The wrapper is what the overlay is positioned against; without
    // `relative` on it the star would be placed against the viewport.
    expect(html).toMatch(/^<div class="[^"]*\brelative\b[^"]*"/)
    expect(html).toContain('class="absolute top-1.5 right-1.5"')
  })

  it('adds no wrapper at all when there is no action', () => {
    // `/conta/favoritos` and the Landing's example panel pass no action, and
    // their markup must not change: the card is still the anchor itself.
    expect(withoutStar()).toMatch(/^<a /)
  })
})

describe('the space the top row gives up for it', () => {
  /**
   * The arithmetic is in `tender-card.tsx`: a 14px card padding (`p-3.5`), a
   * 44px control (`size-touch`) inset 6px, so the control intrudes
   * 6 + 44 − 14 = **36px** from the right and 50 − 14 = **36px** down. `pr-9`
   * and `min-h-9` are those two numbers.
   *
   * Pinned as classes because `environment: 'node'` cannot measure the result —
   * the browser does that in `favourite-on-card.spec.ts`.
   */
  it('reserves 36px to the right and 36px of height when a star is drawn', () => {
    expect(withStar()).toContain('class="flex items-center justify-between gap-2 min-h-9 pr-9"')
  })

  it('reserves nothing when no star is drawn', () => {
    const html = withoutStar()
    expect(html).toContain('class="flex items-center justify-between gap-2"')
    expect(html).not.toContain('pr-9')
  })

  it('still draws the countdown the star has to sit beside', () => {
    // If this ever stops being true the reserved space is guarding nothing, and
    // the two assertions above would keep passing on their own.
    expect(withStar()).toContain('2 dias')
  })
})

describe('what the star says', () => {
  it('reads Favoritar when the tender is not marked, and is not pressed', () => {
    const html = withStar(false)
    expect(html).toContain(`aria-label="${copy.add}"`)
    expect(html).toContain('aria-pressed="false"')
  })

  it('reads Favoritado when it is, and fills the glyph', () => {
    const html = withStar(true)
    expect(html).toContain(`aria-label="${copy.added}"`)
    expect(html).toContain('aria-pressed="true"')
    // `aria-pressed` alone was D23's own defect on the opportunity screen: a
    // toggle that reports its state only to a screen reader.
    expect(html).toContain('fill="currentColor"')
  })

  it('leaves the glyph hollow when it is not', () => {
    expect(withStar(false)).toContain('fill="none"')
  })

  it('carries the label in `title` as well, so a pointer can reach it', () => {
    // The star is an icon with no text; the refusal a visitor gets has nowhere
    // else to go on a list card (D54).
    expect(withStar(false)).toContain(`title="${copy.add}"`)
  })
})
