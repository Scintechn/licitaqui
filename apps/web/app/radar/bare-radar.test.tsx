import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import type { TenderListResponse } from '@/lib/radar/contract'
import { wholeListFromCookie, isCnpjRequired, loadingStatus } from './bare-radar'
import { RadarView, type RadarStatus, type RadarViewProps } from './radar-view'

/**
 * D55 — bare `/radar` must ask the route before it refuses.
 *
 * `radar-screen.tsx` short-circuited on `if (!cnpj && !q)` and drew
 * `needCnpjTitle` with no request made. `cnpj` there is the **URL's**, and
 * `/radar` carries none — while `GET /api/radar/tenders` resolves
 * `?cnpj= ?? visitors.cnpj` from a cookie that is `httpOnly`. `/radar` is the
 * address the rail, the drawer, the signed-in landing, both `/fundadores` CTAs,
 * `/conta` and the 404 point at, so the refusal met almost every returning
 * visitor.
 *
 * ## What this file pins, and what it cannot
 *
 * This suite is `environment: 'node'` with no jsdom (CLAUDE.md §4c): the whole
 * cause needs a cookie, a mount and a response, and no effect runs here. So
 * what is pinned is the **mechanism** — the three decisions of `bare-radar.ts`
 * as functions of their inputs, and the two states the screen may render while
 * it does not yet know. The **result** is `e2e/journeys/radar-bare.spec.ts`,
 * which opens `/radar` with no `?cnpj=` and no `?q=` in either direction.
 *
 * The one thing deliberately asserted twice over is that the in-flight state is
 * not the refusal. D24 is the same shape in reverse — a value that was correct
 * for exactly one frame — and a bare `/radar` that printed "Comece pelo CNPJ da
 * sua empresa" and then replaced it with that company's list would be a
 * sentence the product contradicts a response later.
 */

const copy = messages.radar
const list = copy.list

const CNPJ = '11222333000181'

function render(status: RadarStatus, overrides: Partial<RadarViewProps> = {}): string {
  const props: RadarViewProps = {
    // The bare address: no CNPJ, no keyword, no UF.
    query: { cnpj: null, state: null, q: null, group: 'compatible' },
    status,
    grouping: null,
    visitor: null,
    counts: null,
    tenders: [],
    freshness: null,
    now: new Date('2026-10-06T12:00:00.000Z'),
    ...overrides,
  }
  return renderToStaticMarkup(<RadarView {...props} />)
}

describe('D55 · what a bare /radar may decide for itself', () => {
  it('waits on the list, not on a CNPJ nobody posted', () => {
    // No `?cnpj=` means `POST /api/radar/cnpj` never happens, so naming it
    // would describe a request that does not exist.
    expect(loadingStatus(null)).toEqual({ kind: 'analyzing', what: 'list' })
    expect(loadingStatus(CNPJ)).toEqual({ kind: 'analyzing', what: 'company' })
  })

  it('and never refuses while it is still waiting', () => {
    const out = render(loadingStatus(null))

    // The refusal is not on screen, and neither is the other read's wording.
    expect(out).not.toContain(copy.states.needCnpjTitle)
    expect(out).not.toContain(copy.states.analyzingCompanyTitle)
    expect(out).toContain(copy.states.analyzingListTitle)

    // Nor does the header decide anything in the meantime: a CNPJ may be behind
    // the cookie and be invisible from here, so unknown is rendered as unknown
    // (D19's `cnaeState`) — not as "Sem empresa informada", and with no claim
    // about a CNAE either way.
    expect(out).toContain(list.companyFallback)
    expect(out).not.toContain(list.noCompany)
    expect(out).not.toContain(list.groupHintNoCnae)
    expect(out).not.toContain(list.groupHint.compatible)
  })

  it('refuses only on the route’s own `cnpjRequired`', () => {
    // The route could resolve no CNPJ from the URL **or** from the cookie, and
    // there is no keyword either: the one answer that means "informe um CNPJ".
    expect(
      isCnpjRequired({
        state: 'error',
        error: 'validation',
        fields: { cnpj: 'cnpjRequired' },
      }),
    ).toBe(true)

    // Everything else keeps the card it had. `cnpjInvalid` is the same
    // `validation` code about a CNPJ that *was* given: answering it with an
    // empty state would hide the reader's typo.
    const notTheRefusal: TenderListResponse[] = [
      { state: 'error', error: 'validation', fields: { cnpj: 'cnpjInvalid' } },
      { state: 'error', error: 'validation', fields: { state: 'stateInvalid' } },
      { state: 'error', error: 'validation' },
      { state: 'error', error: 'server_error' },
      { state: 'error', error: 'rate_limited' },
      { state: 'error', error: 'bad_request', fields: { cnpj: 'cnpjRequired' } },
      { state: 'analyzing', job: { id: 1, kind: 'company_lookup' } },
    ]
    for (const answer of notTheRefusal) {
      expect(isCnpjRequired(answer), JSON.stringify(answer)).toBe(false)
    }
  })

  it('and when that is the answer, the state card is the one it always was', () => {
    const out = render({ kind: 'needCnpj' })
    expect(out).toContain(copy.states.needCnpjTitle)
    expect(out).toContain(copy.states.needCnpjAction)
    // `needCnpj` is the one unanswered status that does know there is no
    // company, so here the header may say so (D19's `cnaeState`).
    expect(out).toContain(list.noCompany)
  })

  it('knows the one shape whose key constrains nothing at all', () => {
    // `listKey` cannot see `visitors.cnpj` — `httpOnly`, and D19 took it out of
    // `GroupedBy` so it never reaches `sessionStorage`. With neither half in the
    // URL the key constrains nothing: the rows, the groups and the header are
    // all the cookie's, so the snapshot is filed under another list's name.
    expect(wholeListFromCookie(null, null)).toBe(true)

    // A CNPJ in the URL and the route never reads the cookie at all.
    expect(wholeListFromCookie(CNPJ, null)).toBe(false)
    expect(wholeListFromCookie(CNPJ, 'expediente')).toBe(false)

    /*
     * **A keyword alone is `false`, and that is a line drawn on purpose rather
     * than a complete answer** — found by a review of this diff.
     *
     * `GET /api/radar/tenders` resolves the cookie *before* it checks for a
     * keyword, so `/radar?q=expediente` with a cookie CNPJ is grouped by that
     * company: `groupedBy`, `counts` and which tab each row lands in are the
     * cookie's, and only the row set is the keyword's. Its snapshot is mis-keyed
     * the same way, one degree less badly, and it has been since before D55 —
     * so switching it off here would take the cache from every keyword search,
     * including D19's own journey, which is a product cost and not a fix. D60
     * carries both shapes. This assertion exists to record that the `false` is
     * deliberate: if it ever becomes `true`, D60 is what did it.
     */
    expect(wholeListFromCookie(null, 'expediente')).toBe(false)
  })
})
