import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { format, messages } from '@/lib/messages'
import type { TenderCard } from '@/lib/radar/contract'
import { deadlineShort, money } from '@/lib/radar/format'
import { EXAMPLE_AS_OF, EXAMPLE_TENDERS } from '@/lib/radar/landing-example'

// Same stub as `page.test.tsx`: the hero's search card calls `useRouter()` and
// there is no app router under `react-dom/server`.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }))

const { default: LandingPage } = await import('./page')

const copy = messages.radar.landing.example
const card = messages.radar.card

/**
 * **The guard card D11 was missing.**
 *
 * The Landing's example panel showed three real tenders closing on 30/09/2026
 * under a countdown measured from a frozen 17/09/2026, so every card read
 * "13 dias" and "Proposta até 30/09" — correct on the day it was written, and
 * from 01/10/2026 three passed deadlines under a live-looking countdown on the
 * page that introduces the product. Six days before launch, and no test had
 * anything to say about it: every assertion in the suite was written against
 * the same frozen clock the panel was, so the panel and its tests agreed with
 * each other and disagreed with the calendar.
 *
 * ## Why this moves the clock instead of dating the example
 *
 * The obvious guard — *fail when a deadline is in the past relative to today* —
 * would fail every build from 01/10/2026, because these tenders really did
 * close then and the example is honestly dated ("como estavam em 17/09/2026").
 * It also only bites **after** the rot: it passes today, red tomorrow. That is
 * the shape of the bug, not of a guard.
 *
 * So the property under test is the one that cannot go stale: **at every
 * instant, the panel's time claims are true at that instant.** Five clocks
 * below, two of them past every deadline and one of them in 2030. Nothing here
 * has a date that needs revisiting, and re-freezing the countdown on any
 * constant — 17/09/2026, or any later one — turns these red immediately.
 *
 * ## It renders the page, not the panel
 *
 * `LandingPage()`, not `<ExampleRadar />`: the defect lives in what the page
 * hands the panel, so a test that rendered the component and passed it a clock
 * of its own would be exercising the unit and not the path (CLAUDE.md §4b).
 * There is no injected `now` anywhere in this file — the system clock is moved
 * instead, which is the only way to ask "does the shipped page read the real
 * clock?".
 *
 * ## Clocks
 *
 * Probes are UTC instants (`setSystemTime` takes one, and the database and the
 * logs are UTC) and every comment names the Brasília time it is, because the
 * product's day — and `daysUntil`'s calendar difference — is
 * `America/Sao_Paulo`. The 29/09 23:00 BRT probe exists precisely to pin that:
 * it is already 30/09 in UTC, and a gate that counted UTC days would answer
 * "último dia" there instead of "1 dia".
 */

/** The example panel's own markup, cut out of the whole page's. */
async function panelAt(instant: string): Promise<string> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(instant))
  const out = renderToStaticMarkup(await LandingPage())

  // The panel runs from its `aria-label` to the end of its caption, which is
  // its last element. Asserted, not assumed: a `slice` from -1 would silently
  // hand every test below the whole document, where "dias" appears in copy that
  // has nothing to do with the example ("Entrega · 15 dias").
  const caption = format(copy.caption, { data: EXAMPLE_AS_OF })
  const start = out.indexOf(copy.panelLabel)
  const end = out.indexOf(caption)
  expect(start, 'the example panel is on the page').toBeGreaterThan(-1)
  expect(end, 'the panel caption is on the page').toBeGreaterThan(start)
  // Both markers must be unique, or `indexOf` could take the panel's opening
  // from one place and its end from another and hand back a region that is not
  // the panel — passing or failing for reasons that have nothing to do with the
  // deadline. A second element carrying either string should fail here loudly
  // rather than quietly widen the slice.
  expect(out.split(copy.panelLabel)).toHaveLength(2)
  expect(out.split(caption)).toHaveLength(2)
  return out.slice(start, end + caption.length)
}

/**
 * The three cards, each one's markup on its own, keyed by tender id.
 *
 * Asserting over the whole panel is not enough and the first version of this
 * file made exactly that mistake: three cards share one region, so
 * `expect(panel).toContain('último dia')` passes while *one* of the three has
 * silently lost its countdown — its neighbour supplies the string. Every
 * deadline assertion below is therefore scoped to the card it is about.
 */
async function cardsAt(instant: string): Promise<Map<string, string>> {
  const panel = await panelAt(instant)
  // The cards are list items; so are the three group chips above them, which is
  // why each card is found by its own title rather than by position.
  const items = panel.split('<li')
  const cards = new Map<string, string>()
  for (const tender of EXAMPLE_TENDERS) {
    const found = items.filter((item) => item.includes(tender.object))
    expect(found, `exactly one card renders ${tender.id}`).toHaveLength(1)
    cards.set(tender.id, found[0])
  }
  return cards
}

/** "Proposta até 30/09 · 08:30" — the claim that a window is still open. */
function openClaim(tender: TenderCard): string {
  return format(card.proposalsUntil, { quando: shortDeadline(tender) })
}

/** "Data anterior 30/09 · 08:30" — the same date, no longer claiming that. */
function pastClaim(tender: TenderCard): string {
  return format(card.previousDeadline, { quando: shortDeadline(tender) })
}

/**
 * The date these two claims are built around. Asserted rather than defaulted to
 * `''`: an empty `quando` would leave both expectations as bare prefixes —
 * "Proposta até " and "Data anterior " — which match almost anything and would
 * make the pair below agree with a card that printed neither date.
 */
function shortDeadline(tender: TenderCard): string {
  const quando = deadlineShort(tender.proposalsCloseAt)
  expect(quando, `${tender.id} has a deadline to render`).not.toBeNull()
  return quando ?? ''
}

/** Any countdown, in every form `card.daysLeft` can take. */
const COUNTDOWN = /\bdias?\b/

const [BATTERIES, HOSPITAL, SAAS] = EXAMPLE_TENDERS

afterEach(() => {
  vi.useRealTimers()
})

describe('the Landing example panel, against the real clock', () => {
  it('counts real days down while the tenders are open', async () => {
    // 24/09/2026, 09:00 in Brasília. Six Brasília days to 30/09.
    const cards = await cardsAt('2026-09-24T12:00:00.000Z')

    for (const tender of EXAMPLE_TENDERS) {
      const own = cards.get(tender.id) ?? ''
      expect(own).toContain(format(card.daysLeft, { count: 6 }))
      // Not the number the frozen clock used to print. On this card.
      expect(own).not.toContain(format(card.daysLeft, { count: 13 }))
      expect(own).toContain(openClaim(tender))
      expect(own).not.toContain(pastClaim(tender))
    }
  })

  it('counts Brasília days, not UTC ones', async () => {
    // 29/09/2026, 23:00 in Brasília — already 30/09 in UTC. One Brasília day
    // to a deadline on the 30th; "último dia" here would be a day early.
    const cards = await cardsAt('2026-09-30T02:00:00.000Z')

    for (const tender of EXAMPLE_TENDERS) {
      const own = cards.get(tender.id) ?? ''
      expect(own).toContain(format(card.daysLeft, { count: 1 }))
      expect(own).not.toContain(format(card.daysLeft, { count: 0 }))
    }
  })

  it('stops claiming a window is open at the hour it closes, card by card', async () => {
    // 30/09/2026, 08:00 in Brasília: the SaaS session (07:30) has passed, the
    // batteries (08:30) and the hospital one (09:00) have not. Three cards on
    // one day, and the day is not what decides — `daysUntil` answers 0 for all
    // three, which is the bug `headline.ts` records as sixteen hours of "último
    // dia" after a deadline had passed.
    const cards = await cardsAt('2026-09-30T11:00:00.000Z')

    for (const tender of [BATTERIES, HOSPITAL]) {
      const own = cards.get(tender.id) ?? ''
      expect(own).toContain(format(card.daysLeft, { count: 0 }))
      expect(own).toContain(openClaim(tender))
      expect(own).not.toContain(pastClaim(tender))
    }

    const closed = cards.get(SAAS.id) ?? ''
    expect(closed).not.toMatch(COUNTDOWN)
    expect(closed).toContain(pastClaim(SAAS))
    expect(closed).not.toContain(openClaim(SAAS))
  })

  /**
   * 01/10/2026 is the date on the card: the day the old panel started showing
   * three passed deadlines under "13 dias", and the week the founders list
   * opens to the product.
   */
  it.each([
    ['01/10/2026, 09:00 in Brasília — the day the old panel went stale', '2026-10-01T12:00:00.000Z'],
    ['01/01/2030 — and it is not going to rot then either', '2030-01-01T12:00:00.000Z'],
  ])('shows no countdown once every deadline has passed (%s)', async (_when, instant) => {
    const cards = await cardsAt(instant)

    for (const tender of EXAMPLE_TENDERS) {
      const own = cards.get(tender.id) ?? ''
      // Not "13 dias", not "1 dia", not "último dia": no duration at all.
      expect(own).not.toMatch(COUNTDOWN)
      // The date stays — it says which edital this was — and says it is past.
      expect(own).toContain(pastClaim(tender))
      expect(own).not.toContain(openClaim(tender))
      // The 22px anchor is the money, on every clock, because all three carry a
      // value (`cardHeadline`). Pinned because it decides which branch the two
      // assertions above are testing: drop a value from the example and the
      // deadline is promoted into the anchor instead, where `promoted()` would
      // print "encerrado" and this test would be watching the wrong slot.
      expect(own).toContain(money(tender.estimatedValue))
      expect(own).not.toContain(card.closed)
    }
  })

  /**
   * The disclosure is not a function of the clock. Whatever instant the page is
   * built at, the caption still names the date the three were transcribed and
   * still says this is not a live search — and no card is a link to a tender
   * page that would 404 or show something else entirely.
   */
  it.each(['2026-09-24T12:00:00.000Z', '2026-10-01T12:00:00.000Z', '2030-01-01T12:00:00.000Z'])(
    'stays visibly a dated example at %s',
    async (instant) => {
      const panel = await panelAt(instant)

      expect(panel).toContain(copy.label)
      expect(panel).toContain(format(copy.caption, { data: EXAMPLE_AS_OF }))
      expect(panel).toContain(EXAMPLE_AS_OF)
      expect(panel).not.toContain('/radar/edital/')
    },
  )
})
