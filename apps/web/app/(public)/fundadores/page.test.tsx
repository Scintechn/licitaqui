import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { EXAMPLE_AS_OF } from '@/lib/radar/landing-example'
import FoundersOfferPage, { revalidate } from './page'
import radarPreview from './radar-preview.png'

const out = renderToStaticMarkup(<FoundersOfferPage />)

/**
 * The hero shot's own `<img>` tag.
 *
 * Scoped to `<main>` and taken as the first image there. It is the only one on
 * the page today; the moment anything before it renders one — a logo, a fallback
 * — an unscoped `indexOf('<img')` would silently measure that instead, and two
 * of the assertions below (`no loading="lazy"`, `alt=""`) would still pass.
 */
function heroImage() {
  const main = out.slice(out.indexOf('<main'))
  const at = main.indexOf('<img')
  expect(at, 'the hero renders an <img>').toBeGreaterThan(-1)
  return main.slice(at, main.indexOf('>', at) + 1)
}

describe('/fundadores', () => {
  it('drops the "Prévia" banner the source page carried', () => {
    expect(out).not.toContain('Prévia')
    expect(out).not.toContain('O formulário ainda não envia dados')
  })

  it('has exactly one h1, and it is the approved headline', () => {
    expect(out.match(/<h1/g)).toHaveLength(1)
    expect(out).toContain(messages.foundersPage.hero.title)
  })

  it('keeps the landmarks a screen reader navigates by', () => {
    expect(out).toContain('<header')
    expect(out).toContain('<main id="topo"')
    expect(out).toContain('<footer')
  })

  it('quotes the prices of spec §10 and nothing else', () => {
    // The founder price and the price it becomes, on the page itself. The
    // form's own copy of them moved into the dialog with the form, and is
    // asserted in `signup-form.test.tsx`.
    expect(out).toContain('R$ 26')
    expect(out).toContain('R$ 57')
  })

  it('renders no form of its own: the ask is a dialog', () => {
    // The form is opened by the page's calls to action (`signup-sheet.tsx`)
    // and is not in the static HTML at all. What it must never grow — a bare
    // `action=`, which would serialise the e-mail and the WhatsApp number into
    // the URL — is asserted against the form itself in `signup-form.test.tsx`.
    expect(out).not.toContain('<form')
  })

  it('carries the company identification the legal brief prescribes', () => {
    expect(out).toContain('36.955.612/0001-85')
    expect(out).toContain('contato@licitaquiapp.com.br')
  })

  it('revalidates inside the 10–30 min window of spec §3.3', () => {
    expect(revalidate).toBeGreaterThanOrEqual(600)
    expect(revalidate).toBeLessThanOrEqual(1800)
  })

  it('renders no product copy that is not in the pt-BR catalogue', () => {
    // A spot check on the strings most likely to be hardcoded by accident.
    expect(out).toContain(messages.founders.offer.cta)
    expect(out).toContain(messages.brand.promise)
    expect(out).toContain(messages.legal.privacyLabel)
  })
})

describe('the refunds section', () => {
  /**
   * Until 2026-09-21 a sweep of the whole catalogue for
   * `devolv|reembols|garantia|arrepend|estorno` returned **nothing**, while both
   * refunds were already contractual under terms §8 and `faq-cobranca.md`'s own
   * placement table said the Offer must carry them. These assertions are what
   * keeps them from disappearing again.
   */
  it('states both refunds, verbatim from the billing FAQ', () => {
    const { refunds } = messages.foundersPage
    expect(out).toContain(refunds.title)
    // The distinguishing clause of each, so a paraphrase fails here.
    expect(out).toContain('direito de arrependimento do Código de Defesa do Consumidor')
    expect(out).toContain('uma vez por CNPJ')
    expect(out).toContain('Promocional e Essencial')
  })

  it('says the guarantee next to the price, not only in the small print', () => {
    // The line sits beside the price *in the form*, which is now a dialog —
    // so the requirement is asserted where the price is
    // (`signup-form.test.tsx`). What must stay on the page is the section
    // that states both refunds in full, which the tests above cover.
    expect(out).toContain(messages.foundersPage.refunds.title)
  })

  it('does not promise a proportional refund it never offered', () => {
    expect(out).toContain('não há devolução proporcional')
  })
})

describe('the competitor comparison', () => {
  it('records when its claims were last verified', () => {
    // Comparative advertising has to stay true without anyone touching the
    // code: a competitor can change terms and make this false on its own.
    const meta = messages.foundersPage.founderValue._meta
    expect(meta.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('brief §2.2 framing rules', () => {
  /**
   * Rules 1-3 of the product-framing section, which exists because there is no
   * budget for legal review before the first charge. Under CDC art. 30 the copy
   * *is* the obligation, so these are not style preferences — they are the
   * mitigation, and a regression here is a legal one.
   */
  it('never claims the reader can participate or is eligible (rule 2)', () => {
    expect(out).not.toContain('pode participar')
    expect(out).not.toMatch(/está habilitad|sua empresa está apta/i)
  })

  it('describes past winners, never a tendency about the next bid (rule 1)', () => {
    // "costuma vencer" puts the tendency on the reader's own bid; the winners
    // closing at a price is a fact about results that already happened.
    expect(out).not.toContain('costuma vencer')
  })

  it('never promises an outcome (rule 1)', () => {
    expect(out).not.toMatch(/\bvença\b|ganhe licitaç|aumente suas chances|\baprovado\b/i)
  })

  it('never leaves "preço-alvo" without saying what it is (rule 3)', () => {
    // A MEI reading "preço-alvo" beside an edital will assume it is the bid.
    const at = out.indexOf('preço-alvo')
    if (at !== -1) {
      expect(out.slice(at, at + 220)).toMatch(/máximo a pagar ao fornecedor/)
    }
  })

  it('gives the refund guarantees a section heading, not fine print', () => {
    // It was `text-lead font-semibold` — 15px IBM Plex Sans — while the other
    // eight h2s are 26px Archivo 700, so the 7-day CDC right of withdrawal and
    // the 30-day guarantee rendered *smaller than the body copy around them*,
    // directly above a FAQ with full display treatment.
    const heading = out.indexOf(messages.foundersPage.refunds.title)
    expect(heading).toBeGreaterThan(-1)
    // The display face and size the other sections get.
    const around = out.slice(Math.max(0, heading - 300), heading)
    expect(around).toContain('font-display')
    expect(around).not.toContain('text-lead font-semibold')
  })

  it('never lets a child force the brand panel past the viewport', () => {
    // The first fix for the compressed comparison table gave it
    // `min-w-[420px]`. A grid item is `min-width: auto`, so at 440px that
    // pushed the whole panel off-screen and carried the call to action with
    // it — visible in a screenshot before anything measured it.
    //
    // Two guards, because either alone would have let it happen: no fixed
    // minimum inside the panel, and `min-w-0` on the grid children so a
    // future wide child cannot do the same thing.
    expect(out).not.toContain('min-w-[420px]')
    // `&` and `>` are escaped in the rendered attribute.
    //
    // Scoped to the panel's own element. Unscoped, this passed with the guard
    // deleted from the panel: the page now carries the same utility on the
    // hero grid and on the price chain, and any one of the three satisfied a
    // document-wide match — so the test named an element it never checked.
    // `rounded-feature bg-brand-panel`, not just `bg-brand-panel`: the price
    // chain's last step is on the same colour and comes first in the
    // document, so the looser anchor grabs the wrong element.
    const at = out.indexOf('rounded-feature bg-brand-panel')
    expect(at).toBeGreaterThan(-1)
    const openingTag = out.slice(at, out.indexOf('>', at))
    expect(openingTag).toMatch(/\[&amp;&gt;\*\]:min-w-0/)
  })

  it('stacks the comparison table below 560px instead of scrolling it', () => {
    // This audience will not think to swipe a table, and three columns of
    // two-to-five words do not need to be three below 560px.
    expect(out).toContain('max-[559px]:block')
    // This used to also assert `max-[559px]:sr-only` on the `<thead>`, under
    // the heading "the headers stay for assistive technology, hidden only
    // visually". They did not: `display: block` strips the role off every
    // element of a table, so below 560px those headers were associated with
    // nothing and announced as two loose words. What the reader needs is
    // asserted in "the comparison table on a phone" instead — each value
    // announced with the name of its column.
  })

  it('inverts the panel\u2019s call to action so it is not its own background', () => {
    // Sci saw it before any measurement: a blue button on a blue panel
    // disappears. White ground, blue label — 11.49:1 for the button against
    // the panel, 6.16:1 for the label against the button.
    const cta = out.slice(out.indexOf(messages.foundersPage.founderValue.cta) - 400)
    expect(cta).toContain('bg-surface')
    expect(cta).toContain('text-blue')
  })

  it('puts the brand panel on the logo blue, with its own measured ramp', () => {
    // Sci: "this background black is not linked. Could change to Blue, like
    // the logo". The graphite ramp does not survive the move — `blue-on-ink`
    // measures 2.71:1 on blue — so the panel uses `on-brand*`, measured
    // against #14347f in `tokens.css`.
    expect(out).toContain('bg-brand-panel')
    expect(out).toContain('text-on-brand')
    // The graphite ramp is gone from this page entirely.
    expect(out).not.toMatch(/\btext-on-ink\b/)
    expect(out).not.toMatch(/\bblue-on-ink\b/)
    expect(out).not.toMatch(/\bborder-ink-line\b/)
  })

  it('keeps a way to act on screen through the long middle of the page', () => {
    // Between the form's submit and the next CTA there are ~5 499px.
    expect(out).toMatch(/<header class="[^"]*sticky/)
  })

  /**
   * `tokens.css` says it in its own words, above the public-page scale:
   *
   *   "The 11–15px scale above is the in-app scale, designed for a 390px
   *    frame full of data. A marketing page needs larger… **Body copy there
   *    is Tailwind's `text-base`**."
   *
   * The page did not follow the instruction written for it. Measured at a
   * true 390px viewport before the change: 31% of the page's characters were
   * at 13px or smaller and 44% at 15px, with only 10% at 16px — for readers
   * who are often in their fifties and sixties, on low-end Android, deciding
   * whether to trust an unknown company with a business subscription.
   *
   * This asserts the idiom rather than every element: the body-copy blocks
   * use `text-base`, and none of them is left on the in-app `text-lead`.
   */
  it('sets body copy at the size the token file specifies for public pages', () => {
    const bodyBlocks = out.match(/text-base leading-\[1\.6\]/g) ?? []
    expect(bodyBlocks.length).toBeGreaterThanOrEqual(8)
    // The in-app body idiom must not come back on a marketing page.
    expect(out).not.toContain('text-lead leading-[1.55]')
  })
})

describe('the price example, as a chain', () => {
  const { ruler } = messages.foundersPage
  /**
   * The price section: from its own eyebrow to the next section's heading.
   *
   * Searched *forward from* the price eyebrow. The end marker used to be
   * `pillars.label`, which the header anchors also render near the top of the
   * document; it is now the screening heading, because the pillars section
   * the chain used to precede is gone — its four claims are the band under
   * the hero.
   */
  const priceAt = out.indexOf(ruler.label)
  const section = out.slice(priceAt, out.indexOf(messages.foundersPage.screening.title, priceAt))

  /**
   * It used to be a bar with four marks over a green→red gradient, positioned
   * by percentage on a R$ 10 – R$ 40 scale. Measured at 390px, the green "you
   * can still profit" zone was **47px of 308** — a nub — so the gradient read
   * as one warm band and the colour semantics inverted on the phone this
   * audience uses. `R$ 14,60`, the number the product exists to produce, was
   * 16px while a competitor's price in the table below is 34px.
   */
  it('reads in the order of the argument, not in the order of a scale', () => {
    // What the tender estimated, what the winner actually bid, what retail
    // costs — therefore the most you can pay a supplier. On the ruler these
    // sat at 86.7%, 33.3%, 63.3% and 15.3%, so the eye met them backwards and
    // a screen reader met a single `role="img"` with a sentence for a label.
    const positions = [
      ruler.tenderValue,
      ruler.winnerValue,
      ruler.retailValue,
      ruler.maxPurchaseValue,
    ].map((value) => out.indexOf(value))

    for (const at of positions) expect(at).toBeGreaterThan(-1)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  /**
   * **Each figure must be announced by its own label.**
   *
   * The order test above maps only the four *values*, so swapping the `label:`
   * fields of two steps left the whole suite green — and that mutation makes
   * the page read "edital ≈ R$ 20" and "vencedor ofertou ≈ R$ 36", inverting
   * the argument of the section and publishing two false figures under a
   * source line that names eight real closed tenders. CDC art. 30 binds an
   * advertised figure, and this is the page taking money.
   *
   * The old ruler carried the pairing inside a single `role="img"` label
   * string. The chain carries it only in DOM adjacency, so adjacency is what
   * has to be asserted: each label's own list item holds its value and none of
   * the other three.
   */
  it('announces each figure with the label that belongs to it', () => {
    const steps = [
      [ruler.tender, ruler.tenderValue],
      [ruler.winner, ruler.winnerValue],
      [ruler.retail, ruler.retailValue],
      [ruler.maxPurchase, ruler.maxPurchaseValue],
    ] as const

    const values = steps.map(([, value]) => value)

    for (const [label, value] of steps) {
      const at = section.indexOf(label)
      expect(at).toBeGreaterThan(-1)

      // The label's own `<li>`, from the label forward to the end of that item.
      const end = section.indexOf('</li>', at)
      expect(end).toBeGreaterThan(at)
      const item = section.slice(at, end)

      expect(item).toContain(value)
      for (const other of values) {
        if (other !== value) expect(item).not.toContain(other)
      }
    }
  })

  it('sets the maximum purchase price at the size of a standalone figure', () => {
    // `--text-stat` is 34px: the size this page already gives a figure that
    // carries a section (`pain.facts`, the competitor's price). This one is
    // the product's whole insight and was two thirds smaller than both.
    const at = section.indexOf(ruler.maxPurchaseValue)
    expect(at).toBeGreaterThan(-1)
    expect(section.slice(at - 200, at)).toContain('text-stat')
  })

  it('does not spend the product’s green on "this price is safe"', () => {
    // Green is `success` here and nowhere else: the compatible badge, "Não
    // exige", "Oportunidade encontrada". A fourth meaning for it would strip
    // the meaning from every green badge in the app — so the emphasis is the
    // brand panel with the measured `on-brand` ramp, the page's own accent.
    expect(section).not.toContain('success')
    expect(section).toContain('bg-brand-panel')
    // And the gradient that inverted on a phone is gone. Scoped to this
    // section: document-wide it would also forbid a gradient in
    // `ExampleRadar` or a tender card, which is not this test's business.
    expect(section).not.toContain('linear-gradient')
  })

  it('keeps the red for the verdict, which is the one loss on the page', () => {
    // `error` still describes the verdict exactly — it is a warning that the
    // sum does not close. Removing the ruler must not take it with it.
    expect(section).toContain(ruler.verdictLead)
    const at = section.indexOf(ruler.verdictLead)
    expect(section.slice(at - 400, at)).toContain('bg-error-soft')
  })
})

/**
 * The hero, the image in it, and the form that left it.
 *
 * Every index below is taken against `messages.radar.landing.example.panelLabel`
 * — "Exemplo do Radar", the example panel's own `aria-label` — and never
 * against `example.label`, which is the four letters "Exemplo" and matches the
 * price chain's eyebrow ("Exemplo real · papel sulfite…") and the screening
 * card's label ("Exemplo de triagem por IA") as well. Two assertions here used
 * to be written against that substring, and what they measured was the price
 * chain's position, not the example's.
 */
describe('the hero, and the form that is now a dialog', () => {

  /** Every control that opens the signup dialog. */
  const triggers = () => out.match(/<button[^>]*>/g) ?? []

  it('offers a way to the form from the first screen', () => {
    // The risk in this change: the form is no longer on the page at all, so
    // the first screen must still reach it. The hero's own call to action is
    // a button that opens the dialog — asserted in a browser too
    // (`e2e/journeys/fundadores.spec.ts`), where it is clicked.
    const heroMarkup = out.slice(0, out.indexOf(messages.foundersPage.pillars.items[0].body))
    expect(heroMarkup).toContain(messages.founders.offer.cta)
    const cta = heroMarkup.indexOf(messages.founders.offer.cta)
    // …and it is a button, not a link to an anchor that no longer exists.
    expect(heroMarkup.slice(0, cta).lastIndexOf('<button')).toBeGreaterThan(
      heroMarkup.slice(0, cta).lastIndexOf('<a '),
    )
  })

  it('offers the Radar beside it, as a real link', () => {
    // The product is public and free to try. A visitor who would rather see it
    // working than hand over a WhatsApp number gets a link, not a dialog —
    // `account.screen.radar`, an approved string reused.
    expect(out).toContain(messages.account.screen.radar)
    const at = out.indexOf(messages.account.screen.radar)
    expect(out.slice(0, at).lastIndexOf('href="/radar"')).toBeGreaterThan(
      out.slice(0, at).lastIndexOf('<button'),
    )
  })

  it('leaves no link pointing at the anchor the form used to carry', () => {
    // `#vaga` is gone with the section. A CTA still pointing at it would
    // scroll nowhere — silently, on the page taking sign-ups.
    expect(out).not.toContain('href="#vaga"')
    expect(out).not.toContain('id="vaga"')
  })

  it('opens the dialog from all four calls to action', () => {
    // The header, the hero, the offer panel and the final band. Counted by
    // their labels, because that is what a reader presses.
    const labels = [
      messages.foundersPage.nav.cta, // header
      messages.founders.offer.cta, // hero and final band
      messages.foundersPage.founderValue.cta, // offer panel
    ]
    for (const label of labels) expect(out, label).toContain(label)
    expect(out.split(messages.founders.offer.cta).length - 1).toBe(2)
    // Every one of them is a <button>: the page renders no form and no anchor
    // for them to point at.
    expect(triggers().length).toBeGreaterThanOrEqual(4)
  })

  it('keeps the anchors that are still anchors', () => {
    // `#topo` and the three section ids stay — and keep the offset that was a
    // review blocker this morning, because they are still jumped to.
    expect(out).toContain('id="topo"')
    for (const id of ['tool', 'screening', 'faq']) {
      const at = out.indexOf(`id="${id}"`)
      expect(at, id).toBeGreaterThan(-1)
      expect(out.slice(out.lastIndexOf('<', at), out.indexOf('>', at)), id).toContain('scroll-mt-20')
    }
  })

  it('serves the hero shot through the image pipeline, not as 1.6MB of PNG', () => {
    // The source is 1600×1066 and 1.6MB. `next/image` with a static import
    // gives the optimised variants and the reserved box; a bare <img src=
    // "/radar-preview.png"> in a hero gives neither.
    const img = heroImage()
    // `srcSet` as React spells it on the server; the browser sees `srcset`.
    expect(img.toLowerCase()).toContain('srcset=')
    // Through the optimiser, and pointed at the hashed build asset — not at a
    // raw file in `public/`, which would ship the 1.6MB original as well.
    expect(img).toContain('/_next/image')
    expect(img).toContain(encodeURIComponent(radarPreview.src))
    expect(out).not.toContain('src="/radar-preview.png"')
  })

  it('reserves the shot’s box before it loads', () => {
    // Intrinsic width and height from the static import: no layout shift when
    // the bytes arrive, which is the whole reason for the static import.
    //
    // Read out of the imported module rather than typed in. `vitest.config.mts`
    // argues that hand-typing 1600×1066 into the component would copy a fact
    // the file already states and leave it wrong the day the shot is
    // regenerated — which is just as true one directory over, in the test.
    const img = heroImage()
    expect(radarPreview.width).toBeGreaterThan(0)
    expect(img).toContain(`width="${radarPreview.width}"`)
    expect(img).toContain(`height="${radarPreview.height}"`)
  })

  it('loads the shot eagerly, because it is the largest thing above the fold', () => {
    // `priority`. Next 16 expresses it as the absence of `loading="lazy"` plus
    // a preload; a lazily-loaded LCP element is a Core Web Vitals regression
    // that no string assertion about `<Image>`'s props would catch.
    const img = heroImage()
    expect(img).not.toContain('loading="lazy"')
  })

  it('leaves the shot out of the accessibility tree instead of narrating it', () => {
    // `alt=""` on purpose. The headline and the subtitle beside it already say
    // what the product does, and a description of the screenshot would be new
    // user-facing copy — which is Sci's, under the legal brief. An empty alt
    // is the correct answer for a decorative image, not an omission: `alt`
    // missing altogether is what a screen reader reads the file name for.
    expect(heroImage()).toContain('alt=""')
  })

  it('no longer carries the Radar example', () => {
    // Removed from this page on Sci's instruction. Nothing is orphaned:
    // `ExampleRadar` still renders on the Landing (`app/(public)/page.tsx`),
    // so the component and every string it uses keep a home — and card D11,
    // the frozen tenders that go stale on 30/09, moves with it to `/`.
    expect(out).not.toContain(messages.radar.landing.example.panelLabel)
    expect(out).not.toContain(EXAMPLE_AS_OF)
  })
})

/**
 * The sections the D7 layout pass restyled. Every assertion here is about what
 * the reader gets — an order, a size, a count, a surface — and not about the
 * utility that happens to produce it. `min-w-[420px]` was once asserted *by
 * name* in this file, which pinned a bug in place rather than a requirement.
 */
describe('the D7 layout pass', () => {
  const { pain, pillars, timeline, founderValue } = messages.foundersPage
  /** The founder price, from the catalogue: `signup.price` is "R$ 26". */
  const price = messages.foundersPage.signup.price

  /** Pain: from its heading to the next section's. */
  const painSection = out.slice(out.indexOf(pain.title), out.indexOf(messages.foundersPage.ruler.label))
  /**
   * The band of four promises, under the hero.
   *
   * It used to be a section of its own further down, sliced from
   * `pillars.title`; that heading is gone with the section (card **D14**), so
   * the band is bounded by the first thing it renders and the next section's
   * heading.
   */
  const bandSection = out.slice(out.indexOf('id="tool"'), out.indexOf(pain.title))
  const timelineSection = out.slice(out.indexOf(timeline.title), out.indexOf(messages.foundersPage.refunds.title))
  const founderSection = out.slice(out.indexOf(founderValue.label), out.indexOf(timeline.title))

  describe('the section heading gets its own column', () => {
    it('puts the standfirst beside the heading, not under the three problems', () => {
      // The section's supporting material belongs in the heading's second
      // column, not below the fold of the section on a phone.
      //
      // That column used to hold the two market figures; Sci replaced them
      // with `pain.standfirst` on 2026-09-24 and the figures now render
      // nowhere (card **D14** — they stay in the catalogue because deleting
      // copy is his). Asserted as an order, because that is what a reader
      // experiences: the standfirst comes between the heading and the first
      // problem. A revert to the single 720px stack puts it after the third.
      const heading = out.indexOf(pain.title)
      const firstProblem = out.indexOf(pain.items[0].body, heading)
      const standfirst = out.indexOf(pain.standfirst, heading)
      expect(standfirst).toBeGreaterThan(heading)
      expect(standfirst).toBeLessThan(firstProblem)
    })

    it('renders the three problems Sci wrote, in his order', () => {
      for (const [index, item] of pain.items.entries()) {
        const at = out.indexOf(item.body)
        expect(at, item.body).toBeGreaterThan(-1)
        expect(painSection, item.title).toContain(item.title)
        if (index > 0) expect(at).toBeGreaterThan(out.indexOf(pain.items[index - 1].body))
      }
    })

    it('leaves every other section on the single column it already had', () => {
      // The two-column head is opt-in. `Refunds` passes no `aside` and must
      // keep the 720px measure the rest of the page is set on.
      const refunds = out.indexOf(messages.foundersPage.refunds.title)
      expect(out.slice(Math.max(0, refunds - 300), refunds)).toContain('max-w-[720px]')
    })

    it('does not change the heading scale to get the heading bigger', () => {
      // `--text-section` is 26→38px and stays that. The headings look larger
      // in the draft because the column is ~500px, not because the token
      // moved; a size of this section's own here would make the page disagree
      // with every other one that renders an `<h2>`.
      const headings = [...out.matchAll(/<h2[^>]*class="([^"]*)"/g)].map((m) => m[1])
      expect(headings.length).toBeGreaterThan(0)
      for (const cls of headings) {
        expect(cls).toContain('text-section')
        expect(cls).not.toMatch(/text-\[/)
      }
    })
  })

  describe('the three problems', () => {
    it('is a list in the order the work happens, numbered', () => {
      // Encontrar → Entender → Não perder dinheiro is a sequence, not three
      // parallel complaints, so it is an `<ol>` and it is numbered.
      expect(painSection).toContain('<ol')
      const numerals = ['01', '02', '03'].map((n) => painSection.indexOf(`>${n}<`))
      for (const at of numerals) expect(at).toBeGreaterThan(-1)
      expect(numerals).toEqual([...numerals].sort((a, b) => a - b))
    })

    it('does not read the numerals out on top of the list itself', () => {
      // The `<ol>` already carries the sequence; a screen reader announcing
      // "zero um" before every heading says it twice.
      // Asserted on the numeral's own opening tag. A character window before
      // it passes on `Icon`'s own `aria-hidden` instead — which is how this
      // test used to work for 01 and 02, and failed for 03 only because
      // `money` has two long path strings. That is an accident of path length,
      // not a guard.
      for (const n of ['01', '02', '03']) {
        expect(painSection).toMatch(new RegExp(`<span aria-hidden="true"[^>]*>${n}</span>`))
      }
    })

    it('gives each problem an icon, and keeps all three intact', () => {
      // Three icons in the tinted square this page already uses for a
      // category — the same device as the trust row and the pillars.
      // Asserted against the catalogue's own length, not against 3: the icon
      // lists are indexed by position, so a fifth bullet added to `pt-BR.json`
      // would hand `Icon` an undefined name and throw. Here that is a red test
      // rather than a broken `next build` on a static route.
      expect(painSection.match(/rounded-swatch bg-blue-soft text-blue/g)).toHaveLength(
        pain.items.length,
      )
      for (const item of pain.items) {
        expect(painSection).toContain(item.title)
        expect(painSection).toContain(item.body)
      }
    })
  })

  describe('what you will use', () => {
    /** The band itself, so the next section's opening tag cannot be counted. */
    const band = bandSection.slice(bandSection.indexOf('<ul'), bandSection.indexOf('</ul>'))

    it('is one bordered surface, not four competing cards', () => {
      // Four separate cards make one claim — *da busca à proposta* — look like
      // four. `Card`'s surface is `rounded-card`; the band is a single panel.
      expect(bandSection).not.toContain('rounded-card')
      expect(bandSection.match(/<ul/g)).toHaveLength(1)
      expect(band.match(/<li/g)).toHaveLength(4)
    })

    it('keeps all four items and every plan attribution', () => {
      // The plan label is what tells a reader which of the two paid plans each
      // capability belongs to. Nothing here was the layout's to drop — the
      // first half of card D12 was exactly that: the trust row rendered these
      // bodies without their plan, so the AI reading lost "Básico com limite"
      // and the price band lost "Essencial".
      for (const [index, item] of pillars.items.entries()) {
        expect(bandSection).toContain(messages.foundersPage.hero.promises[index])
        expect(bandSection).toContain(item.body)
        expect(bandSection).toContain(item.plan)
      }
    })

    it('divides the items rather than boxing them', () => {
      // One rule between neighbours, never around each item: three of the four
      // carry a divider, the first carries none.
      expect(band.match(/border-t border-line/g)).toHaveLength(3)
    })
  })

  describe('the timeline', () => {
    it('stays an ordered list', () => {
      expect(timelineSection).toContain('<ol')
    })

    it('shows the sequence with an arrow between consecutive steps', () => {
      // Four steps, three gaps. A rule over each step said "four things"; it
      // never said they happen in this order, which is the whole section.
      const arrows = timelineSection.match(/M5 12h14M13 6l6 6-6 6/g) ?? []
      expect(arrows).toHaveLength(timeline.steps.length - 1)
    })

    it('keeps the arrows out of the accessibility tree', () => {
      // On the wrapper's own tag: `Icon` already sets `aria-hidden` on the
      // `<svg>` whenever no `title` is passed, so a character window before
      // the path data is satisfied by the component's default and says nothing
      // about this element at all.
      const wrappers = timelineSection.match(/<span aria-hidden="true" class="absolute[^"]*"/g) ?? []
      expect(wrappers).toHaveLength(timeline.steps.length - 1)
    })

    it('gives every step an icon, one per step in the catalogue', () => {
      // `TIMELINE_ICONS` is indexed by position; a fifth step in `pt-BR.json`
      // would hand `Icon` an undefined name and throw at build time.
      expect(timelineSection.match(/rounded-swatch bg-blue-soft text-blue/g)).toHaveLength(
        timeline.steps.length,
      )
    })

    it('announces the three lists it restyled as lists', () => {
      // Tailwind v4's preflight sets `list-style: none`, and Safari drops the
      // list role when it sees that — so the `<ol>` the numerals are
      // `aria-hidden` in deference to would carry nothing on an iPhone.
      for (const section of [painSection, bandSection, timelineSection]) {
        expect(section).toMatch(/<(ol|ul) role="list"/)
      }
    })

    it('keeps the four dates and the four steps', () => {
      for (const step of timeline.steps) {
        expect(timelineSection).toContain(step.when)
        expect(timelineSection).toContain(step.title)
        expect(timelineSection).toContain(step.body)
      }
    })
  })

  describe('the founder offer', () => {
    /**
     * **The price, not "whatever is first".**
     *
     * This asserted `benefits[0]` is rendered at `text-stat` — reading index 0
     * from the same array the component reads index 0 from, which is true by
     * construction and green in exactly the case the requirement is broken.
     * The four benefits are copy in an array Sci owns and may reorder; if he
     * does, "Aviso direto, sem precisar acompanhar redes" becomes the 34px
     * headline of the offer panel and the price drops into the list, with this
     * test still passing.
     *
     * So the assertion is on the figure the section exists to shout.
     */
    it('sets the price — the figure, not the first array element — at display size', () => {
      const raised = [...founderSection.matchAll(/<b class="[^"]*text-stat[^"]*"[^>]*>([^<]*)</g)].map(
        (m) => m[1],
      )
      expect(raised).toHaveLength(1)
      expect(raised[0]).toContain(price)
      // And it is one of the approved benefit strings, not something written
      // here: whichever of them names the price is the one that is raised.
      expect(founderValue.benefits.map((b) => b.title)).toContain(raised[0])
    })

    it('puts the price above the things it buys', () => {
      const at = founderSection.indexOf(price)
      expect(at).toBeGreaterThan(-1)
      for (const benefit of founderValue.benefits) {
        if (benefit.title.includes(price)) continue
        expect(founderSection.indexOf(benefit.title)).toBeGreaterThan(at)
      }
    })

    it('cuts none of the four benefits', () => {
      for (const benefit of founderValue.benefits) {
        expect(founderSection).toContain(benefit.title)
        expect(founderSection).toContain(benefit.body)
      }
    })

    it('marks the remaining benefits with a check', () => {
      // One idea — things the founder gets — so one glyph, not four different
      // pictograms that made the list look like four kinds of thing.
      const list = founderSection.slice(0, founderSection.indexOf(founderValue.cta))
      // One check per benefit that stayed in the list — every one but the
      // price, which is raised out of it.
      expect(list.match(/M5 12l5 5 9-10/g) ?? []).toHaveLength(founderValue.benefits.length - 1)
    })

    it('follows the offer with the call to action, full width', () => {
      // It used to hang under the comparison table in the other column: price,
      // what you get, then the thing to do about it.
      const cta = founderSection.indexOf(founderValue.cta)
      for (const benefit of founderValue.benefits) {
        expect(cta).toBeGreaterThan(founderSection.indexOf(benefit.title))
      }
      expect(cta).toBeLessThan(founderSection.indexOf(founderValue.comparisonRows[0].feature))
      expect(founderSection.slice(cta - 400, cta)).toContain('w-full')
    })
  })
})

/**
 * **A fix to something already on `main`, not part of the restyle.**
 *
 * Below 560px the comparison table is laid out with `display: block`, which
 * strips the implicit ARIA role from every table element in every major
 * browser: no table, no row, no cell, and therefore no `<th scope="col">`
 * association. The `<th>`s were `sr-only` — present and announced — and the
 * visible substitute labels inside each cell were `aria-hidden`, on a code
 * comment that asserted "the real `<th>` is still associated with the cell".
 *
 * On a phone every row therefore announced the feature name and then two bare
 * prices, with nothing saying which was the competitor's and which was ours —
 * on the one section whose entire job is that contrast, on a page taking money.
 */
describe('the comparison table on a phone', () => {
  const { founderValue } = messages.foundersPage

  it('announces each value with the name of its column', () => {
    // The substitute labels are the only thing left saying whose price this
    // is once the cell's role is gone, so they must be in the tree. Asserted
    // as: every rendering of either label is reachable by assistive tech.
    for (const label of [`${founderValue.comparisonOther}:`, `${messages.brand.name}:`]) {
      const occurrences = [...out.matchAll(new RegExp(`<span([^>]*)>\\s*${escapeForRegExp(label)}`, 'g'))]
      expect(occurrences.length).toBeGreaterThanOrEqual(messages.foundersPage.founderValue.comparisonRows.length)
      for (const [, attributes] of occurrences) expect(attributes).not.toContain('aria-hidden')
    }
  })

  it('does not leave the stripped headers announcing a second time', () => {
    // `sr-only` keeps an element in the tree. Below 560px the `<th>`s say
    // nothing useful — they are associated with nothing — and would be read
    // out before the rows as two loose words. `hidden` takes them out.
    const thead = out.slice(out.indexOf('<thead'), out.indexOf('</thead>'))
    expect(thead).toContain('max-[559px]:hidden')
    expect(thead).not.toContain('sr-only')
  })

  it('keeps the real table semantics from 560px up', () => {
    // The fix is for the phone. The desktop layout is a real table and must
    // stay one, headers included.
    const thead = out.slice(out.indexOf('<thead'), out.indexOf('</thead>'))
    expect(thead.match(/scope="col"/g)).toHaveLength(3)
    expect(out).toContain(founderValue.comparisonOther)
  })
})

/** `RegExp` needs the currency and punctuation in the labels escaped. */
function escapeForRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The finish pass: two more sections take the two-column head, the trust row
 * becomes a band, and the hero swaps the form for the product shot.
 *
 * What is *drawn* by those changes — a heading beside its content rather than
 * above it, a hairline between two cells — is not in this file's reach: it is
 * produced by media queries and by the cascade, and the string of HTML is
 * identical either way. Those assertions are in
 * `e2e/journeys/fundadores.spec.ts`, measured in a browser at the widths that
 * change shape. What belongs here is what the markup must carry whatever the
 * width: the copy, and the order it reads in.
 */
describe('the founders finish pass', () => {
  const { faq, ruler, pillars } = messages.foundersPage

  it('keeps every FAQ question and answer, in the catalogue’s order', () => {
    // The two catalogue columns became one list. Flattening is a layout
    // change, not an editorial one: nothing may be dropped or reordered.
    const questions = faq.columns.flat()
    expect(questions.length).toBeGreaterThan(0)

    let at = out.indexOf(faq.title)
    for (const item of questions) {
      const q = out.indexOf(item.q, at)
      expect(q, item.q).toBeGreaterThan(at)
      expect(out.indexOf(item.a, q), item.q).toBeGreaterThan(q)
      at = q
    }
  })

  it('keeps the verdict and the source after the chain, in that order', () => {
    // Order only — which column they land in is geometry, and is asserted in a
    // browser (`e2e/journeys/fundadores.spec.ts`). This one would pass with the
    // two-column head removed, and says so rather than claiming otherwise.
    // The verdict is the chain's conclusion — it names the sum that does not
    // close — and the source names where the four figures came from. Both read
    // as a footnote to a heading if they end up in the heading's column.
    const lastStep = out.indexOf(ruler.maxPurchaseValue)
    const verdict = out.indexOf(ruler.verdictLead)
    const source = out.indexOf(ruler.source)

    expect(lastStep).toBeGreaterThan(-1)
    expect(verdict).toBeGreaterThan(lastStep)
    expect(source).toBeGreaterThan(verdict)
    // …and all three still belong to this section, not the next one.
    expect(source).toBeLessThan(out.indexOf(messages.foundersPage.screening.title))
  })

  it('keeps the four promise titles and their bodies in one band', () => {
    // The band is the only place these four claims are made now. `role="list"`
    // with it: Tailwind v4's preflight sets `list-style: none`, and Safari
    // drops the list semantics along with the marker.
    const band = out.slice(out.indexOf('id="tool"'), out.indexOf(messages.foundersPage.pain.title))
    expect(band).toContain('role="list"')
    for (const [index, item] of pillars.items.entries()) {
      expect(band).toContain(messages.foundersPage.hero.promises[index])
      expect(band).toContain(item.body)
      expect(band).toContain(item.plan)
    }
  })
})

/**
 * The copy Sci wrote on 2026-09-24, and what it replaced.
 *
 * Every string here is his — none of it was written, shortened or
 * re-punctuated in this repository. What these assert is that the page renders
 * it, in his order, and that the sentences it replaced are gone rather than
 * left sitting beside it.
 */
describe('the copy Sci supplied for the problem and the screening', () => {
  const { pain, screening } = messages.foundersPage

  it('renders the standfirst he wrote for the heading’s second column', () => {
    expect(out).toContain(pain.standfirst)
  })

  it('renders the four checks of the screening, in his order, in that section', () => {
    // The left column of the screening section: from its heading to the card
    // it introduces, so a check rendered somewhere else does not count.
    const section = out.slice(out.indexOf(screening.title), out.indexOf(screening.cardLabel))
    expect(screening.checks).toHaveLength(4)

    let at = section.indexOf(screening.body)
    expect(at, 'the paragraph the checks sit under').toBeGreaterThan(-1)
    for (const check of screening.checks) {
      const found = section.indexOf(check, at)
      expect(found, check).toBeGreaterThan(at)
      at = found
    }
  })

  it('announces those checks as a list, which preflight would otherwise strip', () => {
    // Tailwind v4's preflight sets `list-style: none` and Safari drops the
    // list role with the marker. The same defect shipped this morning.
    const upToFirst = out.slice(0, out.indexOf(screening.checks[0]))
    expect(upToFirst.slice(upToFirst.lastIndexOf('<ul'))).toContain('role="list"')
  })

  it('replaced the old screening paragraph rather than keeping both', () => {
    // The sentence it replaced described the caching — "fica pronta para todos
    // que pedirem depois". The speed claim it also carried survives in
    // `screening.readIn`, which still renders inside the card.
    expect(out).not.toContain('fica pronta para todos que pedirem depois')
    expect(out).toContain(screening.readIn)
  })

  it('does not leave the old problem copy on the page beside the new', () => {
    expect(out).not.toContain('O governo compra todo dia')
    expect(out).not.toContain('São milhares de editais abertos')
  })

  it('spells the brand the way CLAUDE.md requires, everywhere it appears', () => {
    // "LicitaQui" — capital L, capital Q, no accent. Some renders of the draft
    // show it wrong, and these two sentences are the newest copy on the page.
    for (const text of [pain.standfirst, screening.body]) {
      if (/licitaqui/i.test(text)) expect(text).toContain(messages.brand.name)
      expect(text).not.toMatch(/Licitaqui|licitaQui|Licitaquí/)
    }
  })
})

describe('the header anchors', () => {
  const header = out.slice(out.indexOf('<header'), out.indexOf('</header>'))

  it('links nowhere that does not exist', () => {
    const targets = [...header.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])
    // The logo and the three section anchors. The call to action used to be a
    // fifth — `href="#vaga"` — and is a dialog trigger now, which is why the
    // count is four and not five.
    expect(targets.length).toBeGreaterThanOrEqual(4)
    for (const id of targets) expect(out).toContain(`id="${id}"`)
  })

  it('keeps the call to action it was added beside', () => {
    // The header is sticky because between the form's submit and the next CTA
    // there are ~5 499px. Anchors must not have cost the thing it carries.
    // It is a button now — the form is a dialog — but it is still there, and
    // still labelled with the same approved string.
    expect(header).toContain(messages.foundersPage.nav.cta)
    expect(header).toContain('<button')
  })

  it('labels them with the sections’ own approved eyebrows', () => {
    // Copy on this page is the founder's under a legal brief. The header
    // invents none: `nav` holds three strings and none of them names a
    // section, so the anchors borrow the labels the sections already carry.
    expect(header).toContain(messages.foundersPage.pillars.label)
    expect(header).toContain(messages.foundersPage.screening.label)
    expect(header).toContain(messages.foundersPage.faq.label)
  })

  it('lands the target clear of the bar instead of under it', () => {
    // The bar is 64px and sticky, so a bare `#id` jump parks the heading
    // beneath it and the reader arrives mid-paragraph.
    //
    // The ids are read out of the header rather than written here: this test
    // is about the offset, not about what the anchors are called, and
    // hardcoding them made renaming them to English (`CLAUDE.md`: identifiers
    // are English) fail a test that has nothing to do with naming.
    // **No exemptions.** This filter used to drop `topo` and `vaga`, and both
    // were in fact broken: `#vaga` is the page's own conversion target — three
    // of the eight in-page links point at it, including the header's CTA — and
    // it landed 65px under the bar, clipping the `R$ 26`. `#topo` is the skip
    // link's target, so the first thing a keyboard user revealed was the hero
    // badge, behind the bar. The suite passed by excluding by name exactly the
    // two anchors that did not work.
    const targets = [...out.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])

    expect(new Set(targets).size).toBeGreaterThanOrEqual(4)
    for (const id of new Set(targets)) {
      const at = out.indexOf(`id="${id}"`)
      expect(at).toBeGreaterThan(-1)
      // The value, not the prefix. `scroll-mt-2` is 8px against a 64px bar and
      // satisfied the old `/scroll-mt-/`, so the assertion held while the
      // heading still landed 57px underneath.
      expect(out.slice(at, at + 240)).toContain('scroll-mt-20')
    }
  })
})
