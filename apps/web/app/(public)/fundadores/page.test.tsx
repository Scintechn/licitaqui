import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { EXAMPLE_AS_OF, EXAMPLE_TENDERS } from '@/lib/radar/landing-example'
import FoundersOfferPage, { revalidate } from './page'

const out = renderToStaticMarkup(<FoundersOfferPage />)

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
    expect(out).toContain('R$ 26')
    expect(out).toContain('R$ 57')
    expect(out).toContain('por mês nos 6 primeiros meses')
  })

  it('draws no seat grid until a seat is actually taken', () => {
    // The page is statically rendered, so the live count is never in this
    // HTML — which is exactly why the grid used to be forty-eight visibly
    // empty boxes under "Restam 48 vagas", for every visitor, on the page
    // founders week points at. Scarcity framing only works above zero.
    expect(out).not.toContain('aspect-square')
    // The claim itself stays: it is true at 0 and at 48.
    expect(out).toContain(messages.foundersPage.signup.seatsLabel)
  })

  it('labels every form control', () => {
    for (const id of ['nome', 'email', 'whatsapp', 'cnpj', 'vende', 'aceite-contato', 'aceite-termos']) {
      expect(out).toContain(`for="${id}"`)
      expect(out).toContain(`id="${id}"`)
    }
  })

  it('submits through fetch, never a browser form navigation (F1)', () => {
    // The endpoint is called from the submit handler, so nothing about it is in
    // the static HTML: a bare `action=` would serialise the e-mail and the
    // WhatsApp number into the URL.
    expect(out).not.toMatch(/<form[^>]*\saction=/)
  })

  it('never pre-ticks a consent box (LGPD art. 8 §4, terms Annex B)', () => {
    for (const box of out.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []) {
      expect(box).not.toContain('checked')
    }
    expect(out.match(/type="checkbox"/g)).toHaveLength(2)
    expect(out).toContain(messages.consent.founders)
    expect(out).toContain(messages.consent.termsBefore)
    expect(out).toContain(messages.consent.termsBetween)
  })

  it('lets the reader actually open what they are accepting', () => {
    // Until the legal lane the two documents were named in plain text and had
    // nowhere to go, so the box recorded an acceptance nobody could have given.
    expect(out).toContain(`href="${messages.legal.termsUrl}"`)
    expect(out).toContain(`href="${messages.legal.privacyUrl}"`)
    // A new tab, so a half-filled form survives the detour.
    expect(out).toContain('rel="noopener noreferrer"')
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
    expect(out).toContain(messages.foundersPage.refunds.ctaLine)
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
    // The headers stay for assistive technology, hidden only visually.
    expect(out).toContain('max-[559px]:sr-only')
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
   * The price section: from its own eyebrow to the next section's.
   *
   * Searched *forward from* the price eyebrow, because the header anchors now
   * render `pillars.label` near the top of the document as well.
   */
  const priceAt = out.indexOf(ruler.label)
  const section = out.slice(priceAt, out.indexOf(messages.foundersPage.pillars.label, priceAt))

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

describe('the product in the hero', () => {
  it('shows a real screen before asking for a name and a WhatsApp number', () => {
    // The first product on this page was the screening card in section five.
    // A visitor was asked for three contact details having seen none of it.
    const example = out.indexOf(messages.radar.landing.example.label)
    expect(example).toBeGreaterThan(-1)
    expect(example).toBeLessThan(out.indexOf(messages.foundersPage.pain.title))
  })

  it('shows the Radar’s own card, not a drawing of one', () => {
    // `ExampleRadar` renders `TenderCardView` over three real frozen PNCP
    // tenders. A mock-up built for marketing drifts from the product within a
    // sprint and starts advertising screens we do not draw — on a page taking
    // money, that is CDC art. 30.
    for (const tender of EXAMPLE_TENDERS) expect(out).toContain(tender.object)
  })

  it('keeps the caption that says the three are frozen, not a live search', () => {
    expect(out).toContain(EXAMPLE_AS_OF)
    expect(out).toContain(messages.radar.landing.example.caption.split('{')[0].trim())
  })

  it('keeps the form above the example on one column', () => {
    // Below 900px the hero falls in DOM order. The example is ~600px tall and
    // this page is taking sign-ups: the ask must not be under it.
    expect(out.indexOf(messages.foundersPage.signup.priceUnit)).toBeLessThan(
      out.indexOf(messages.radar.landing.example.label),
    )
  })
})

describe('the trust row under the hero', () => {
  it('states the three facts in the catalogue’s own words', () => {
    // CNAE compatibility, the AI reading with the page, the maximum purchase
    // price — `pillars.items[0..2]`, reused rather than rewritten.
    const pain = out.indexOf(messages.foundersPage.pain.title)
    for (const item of messages.foundersPage.pillars.items.slice(0, 3)) {
      const at = out.indexOf(item.title)
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(pain)
      expect(out.indexOf(item.body)).toBeLessThan(pain)
    }
  })

  it('introduces no heading structure of its own', () => {
    // It was three `<h3>`s for one run, and that broke the outline twice
    // over: the row sits above the page's first `<h2>`, so the document went
    // h1 → h3 with nothing between; and the same three strings head the
    // `Pillars` section further down, so a reader navigating by heading met
    // "Encontrar / Entender / Ofertar com lucro" twice with no way to tell
    // the summary from the section.
    const headings = [...out.matchAll(/<(h[1-6])[^>]*>(.*?)<\/\1>/g)].map((m) => ({
      level: Number(m[1][1]),
      text: m[2].replace(/<[^>]*>/g, ''),
    }))

    // No level is skipped anywhere on the page.
    for (const [i, heading] of headings.entries()) {
      if (i === 0) continue
      expect(heading.level).toBeLessThanOrEqual(headings[i - 1].level + 1)
    }

    // And each of the three appears as a heading exactly once — in `Pillars`,
    // which is a section and has an h2 above it.
    for (const item of messages.foundersPage.pillars.items.slice(0, 3)) {
      expect(headings.filter((h) => h.text === item.title)).toHaveLength(1)
    }
  })
})

describe('the header anchors', () => {
  const header = out.slice(out.indexOf('<header'), out.indexOf('</header>'))

  it('links nowhere that does not exist', () => {
    const targets = [...header.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])
    // The logo, the three anchors and the call to action.
    expect(targets.length).toBeGreaterThanOrEqual(5)
    for (const id of targets) expect(out).toContain(`id="${id}"`)
  })

  it('keeps the call to action it was added beside', () => {
    // The header is sticky because between the form's submit and the next CTA
    // there are ~5 499px. Anchors must not have cost the thing it carries.
    expect(header).toContain('href="#vaga"')
    expect(header).toContain(messages.foundersPage.nav.cta)
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

    expect(new Set(targets).size).toBeGreaterThanOrEqual(5)
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
