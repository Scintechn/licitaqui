import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import type { TenderListResponse } from '@/lib/radar/contract'
import { isCnpjRequired, loadingStatus, scopeFor } from './bare-radar'
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
 * what is pinned is the **mechanism** — the decisions of `bare-radar.ts` as
 * functions of their inputs, and the two states the screen may render while it
 * does not yet know.
 *
 * **D60 deleted a decision from this file and D58/D60's review put one back.**
 * `scopeFor` is the last `describe` below, and it is here for exactly the reason
 * the rest of this file is: it spent one commit inline in `radar-screen.tsx`,
 * where a mutation to the pre-fix behaviour — the one that took the *Voltar*
 * journey from 60 cards to 20 — left **all 101 unit tests green**, because
 * `environment: 'node'` cannot mount a client component. Only a 20-minute
 * `next build` could see it.
 *
 * **D60 deleted a test from this file too**, and that is worth stating rather
 * than leaving as a shorter suite. `wholeListFromCookie` was the third decision here:
 * which query shapes have their whole list decided by the cookie, and therefore
 * had the snapshot cache switched off. Its last assertion recorded that
 * `/radar?q=…` answering `false` was deliberate. Both shapes are now keyed by
 * the caller instead of excluded (`lib/radar/scope.ts`), so there is no
 * predicate left to assert; what replaced those assertions is
 * `lib/radar/scope.test.ts` for the digest, `lib/radar/list-cache-scope.test.ts`
 * for what it does to the key, and the two journeys in
 * `e2e/journeys/radar-snapshot-identity.spec.ts`. The **result** is `e2e/journeys/radar-bare.spec.ts`,
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
    query: { cnpj: null, states: [], q: null, group: 'compatible' },
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
})

describe('D58/D60 · which scope names this list', () => {
  /** Two values that could not be mistaken for each other in a failure message. */
  const scopes = { viewer: 'viewer-scope', device: 'device-scope' } as const

  it('keys by the viewer when the CNPJ is in the URL', () => {
    /*
     * The route uses `params.cnpj` and never reaches the `visitors.cnpj`
     * fallback, so the cookie cannot change this answer — and this is the only
     * address that posts a CNPJ, whose response stamps `lq_scope` and can mint
     * `lq_visitor` **after** the page computed both digests. Keying on the
     * cookie here discriminated on something that cannot change the answer and
     * went stale inside the document doing the saving: that was B1.
     */
    expect(scopeFor(CNPJ, scopes)).toBe(scopes.viewer)
  })

  it('keys by the device when the URL names no CNPJ', () => {
    // Both halves invert: nothing is posted, the jar holds still, and the
    // cookie is the only thing that names the list at all (D60).
    expect(scopeFor(null, scopes)).toBe(scopes.device)
  })

  it('never returns the other one, which is the whole of the regression', () => {
    // Stated as an inequality as well as an equality, so a function that
    // returned `scopes.device` for every address — the pre-fix behaviour —
    // fails here rather than only in a browser.
    expect(scopeFor(CNPJ, scopes)).not.toBe(scopes.device)
    expect(scopeFor(null, scopes)).not.toBe(scopes.viewer)
  })
})
