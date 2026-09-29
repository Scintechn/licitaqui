import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Favourite } from '@/lib/favourites/store'
import { messages } from '@/lib/messages'
import { deadlineShort } from '@/lib/radar/format'
import { FavouritesView } from './favourites-view'

/**
 * `/conta/favoritos` — card **D23**.
 *
 * The first version rendered the raw `object`, the agency and a date. Sci's
 * verdict was the right one: *"even closed of a good UX… tells nothing
 * worthy"*. `tenders.object` is a paragraph; the Radar's card shows the short
 * title, the value, the deadline countdown, the item count and the tags.
 *
 * So these assert what a card must carry — not that a component was called.
 */

const copy = messages.radar.favourites
const NOW = new Date('2026-09-29T12:00:00-03:00')

function favourite(over: Partial<Favourite['card']> = {}): Favourite {
  return {
    markedAt: new Date('2026-09-28T10:00:00Z'),
    card: {
      id: '27165588000190-1-000232/2026',
      object:
        'Renovação de licenças Google Workspace Frontline Starter, Enterprise Standard e Enterprise Plus por meio de licenciamento Software as a Service',
      shortTitle: 'Licenças Google Workspace',
      agencyName: 'MUNICIPIO DE CACHOEIRO DE ITAPEMIRIM',
      city: 'Cachoeiro de Itapemirim',
      state: 'ES',
      modalityName: 'Pregão - Eletrônico',
      proposalsCloseAt: '2026-09-30T15:00:00.000Z',
      estimatedValue: '4350000.00',
      confidentialBudget: false,
      priceRegistration: false,
      meEppSummary: 'none',
      favoredTreatment: true,
      itemCount: 3,
      segments: ['Software / Sistemas'],
      matchedSegments: [],
      group: 'compatible',
      status: 'Divulgada no PNCP',
      pncpUpdatedAt: null,
      ...over,
    },
  }
}

function render(favourites: Favourite[]) {
  return renderToStaticMarkup(
    <FavouritesView plan="essencial" planName="Essencial" favourites={favourites} now={NOW} />,
  )
}

describe('a favourited tender is drawn as the Radar draws it', () => {
  it('leads with the short title, not the paragraph', () => {
    // `object` is the wall of text the first version rendered whole.
    const out = render([favourite()])
    expect(out).toContain('Licenças Google Workspace')
  })

  it('carries the value, the item count and the deadline', () => {
    const out = render([favourite()])
    expect(out).toContain('4,35 mi')
    expect(out).toContain('3')
    // The deadline as `format.ts` writes it, rather than a shape guessed here.
    expect(out).toContain(deadlineShort('2026-09-30T15:00:00.000Z') as string)
  })

  it('shows the compatibility the account actually has', () => {
    // Computed from the account's CNPJ at read time, never stored — a badge
    // frozen when marked would keep claiming "compatível" after the CNPJ
    // changed (Sci's decision, 2026-09-29).
    // `list.badges`, which is the card's own vocabulary — `radar.groups` is
    // the Radar's *tab* labels ("Compatíveis"), a different set of words for
    // a different control.
    expect(render([favourite({ group: 'compatible' })])).toContain(
      messages.radar.list.badges.compatible,
    )
    expect(render([favourite({ group: 'check' })])).toContain(messages.radar.list.badges.check)
  })

  it('links to the tender', () => {
    expect(render([favourite()])).toContain('/radar/edital/')
  })

  it('names the control and where to find it when there is nothing yet', () => {
    // An empty Favoritos is not a failure — it is a control somebody has not
    // noticed. So it instructs rather than apologises.
    const out = render([])
    expect(out).toContain(copy.emptyTitle)
    expect(out).toContain(copy.emptyBody)
  })
})
