import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { tenderApiPath } from '@/lib/radar/client'
import { OpportunityView } from './opportunity-view'
import { FavouriteButton } from './favourite-button'

/**
 * That the *Favoritar* control is **reachable**, and that what it replaced is
 * gone — card **D23**.
 *
 * The edital screen used to carry an `AppBarActionLink` labelled *"Seguir
 * edital"* pointing at the alerts **preferences** page. Alerts are weekly,
 * keyword- and CNAE-based, and know nothing about the tender you are looking
 * at, so the control could not follow this edital and never did.
 *
 * **No test noticed when I replaced it**, which is the reason this file
 * exists: the whole suite passed both before and after, because nothing
 * asserted that a label and its destination agree. That is the same gap that
 * let a menu ship without its trigger and an `Acompanhar` live only in a
 * mockup.
 *
 * `environment: 'node'`, so this is markup — whether the toggle *toggles* is
 * a browser test (E16's territory). Whether anything can reach it is here.
 */

const copy = messages.radar.favourites

describe('the Favoritar control', () => {
  it('renders nothing until it knows the state', () => {
    // A toggle that paints "not marked" and corrects itself has lied, on the
    // one control whose entire job is reporting a state. `useEffect` does not
    // run under `renderToStaticMarkup`, so this is exactly the pre-answer
    // render — and it must be empty.
    expect(renderToStaticMarkup(<FavouriteButton tenderId="45699626000176-1-000463/2026" />)).toBe(
      '',
    )
  })

  it('offers the three labels it can show, all from the catalogue', () => {
    // Guards against a literal creeping into the button as its states grow.
    expect(copy.add).toBeTruthy()
    expect(copy.added).toBeTruthy()
    expect(copy.signedOut).toBeTruthy()
    expect(new Set([copy.add, copy.added, copy.signedOut]).size).toBe(3)
  })
})

describe('what the edital screen no longer promises', () => {
  it('has stopped offering "Seguir edital" as a link to the alerts settings', () => {
    // The string stays in the catalogue for whoever decides what, if
    // anything, should link there from here — but nothing renders it, and a
    // label promising to follow *this* edital must not reappear on a control
    // that cannot.
    const html = renderToStaticMarkup(
      <OpportunityView
        tender={null}
        status={{ kind: 'analyzing' }}
        backHref="/radar"
        search={{}}
        freshness={{ state: 'fresh', updatedAt: null, ageSeconds: 0 }}
      />,
    )
    expect(html).not.toContain(messages.radar.opportunity.follow)
  })
})

describe('the URL it actually calls', () => {
  /**
   * **The assertion that was missing, and would have caught this on the day.**
   *
   * A `numeroControlePNCP` contains a slash — `51327708000192-1-000084/2026`.
   * The button first built its request with `encodeURI`, which does not encode
   * `/`, so every call went to `/api/tenders/…-000084/2026/favorito`: two path
   * segments where `app/api/tenders/[id]/favorito` declares one. Every request
   * 404'd and the button stayed absent for ever.
   *
   * The test above — "renders nothing until it knows" — **passed the whole
   * time**, because a permanent 404 and a request still in flight produce
   * exactly the same empty render. It asserted the unit and not the path,
   * which is the shape CLAUDE.md §4b names.
   *
   * `client.ts` had `tenderApiPath` all along, added when the band route hit
   * this same wall, carrying the comment "The single-segment spelling
   * /api/tenders/[id] matches".
   */
  it('encodes the slash, so the single-segment route matches', () => {
    const id = '51327708000192-1-000084/2026'
    const url = `/api/tenders/${tenderApiPath(id)}/favorito`

    expect(url).not.toContain('000084/2026')
    expect(url).toBe('/api/tenders/51327708000192-1-000084%2F2026/favorito')
    // One segment between `tenders` and `favorito`, which is what the route
    // file declares. Two is a 404.
    expect(url.split('/').filter(Boolean)).toHaveLength(4)
  })

  it('is what the button uses, not a hand-rolled encoding', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./favourite-button.tsx', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('tenderApiPath(tenderId)')
    // `encodeURI` is the one that let the slash through.
    expect(source).not.toMatch(/encodeURI\(tenderId\)/)
  })
})
