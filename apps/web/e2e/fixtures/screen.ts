import { expect, type Locator, type Page } from '@playwright/test'

/**
 * The few things a journey needs to say about a screen that a role and a name
 * cannot say on their own.
 *
 * Everything else in this suite is selected the way a person finds it — by the
 * words on it — because that is what survives a redesign. The three helpers
 * here are the exceptions, and each one states why it had to be one.
 */

/**
 * The tender cards on the Radar.
 *
 * Selected by where they lead rather than by what they say: a card's
 * accessible name is the whole card — badge, title, agency, value, tags and
 * deadline — so `getByRole('link', { name: … })` would be asserting on nine
 * facts at once, and counting sixty of them needs a stable handle. The href
 * prefix is the product's own routing, not a class name, so it moves only when
 * the address of a tender moves.
 */
export function cards(page: Page): Locator {
  return page.locator('a[href^="/radar/edital/"]')
}

/** The card for one process number, found the way a reader finds it. */
export function card(page: Page, processo: string): Locator {
  return cards(page).filter({ hasText: processo })
}

/**
 * The three group chips, scoped to the strip they live in.
 *
 * Needed because a chip and a card can carry the same word: every card in the
 * Verificar tab opens its accessible name with the badge "Verificar", so an
 * unscoped `getByRole('link', { name: /^Verificar/ })` matches thirteen
 * elements. The strip has a name of its own — "Editais encontrados" — and
 * that is the one a screen reader announces before the chips.
 */
export function groupTabs(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Editais encontrados' })
}

/**
 * Every address this tab has been at.
 *
 * Dona Marta's journey turns on a negative — she is *never* asked to create an
 * account — and a negative about navigation cannot be asserted by looking at
 * the final screen. So the trail is recorded as it happens.
 */
export function trail(page: Page): string[] {
  const seen: string[] = [page.url()]
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seen.push(frame.url())
  })
  return seen
}

/** Where the window is, for the journeys that come back to a list. */
export function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY)
}

/**
 * `R$ 0,00` must not exist anywhere on the page (#72, brief §2.2 rule 3).
 *
 * A whole-document text check rather than a per-element one, deliberately: the
 * zero came back on five different screens the first time, so the assertion
 * that is worth having is the one no new element can slip past.
 */
export async function noFabricatedZero(page: Page): Promise<void> {
  expect(await pageText(page), 'a zero is not a price — #72, brief §2.2 rule 3').not.toContain(
    'R$ 0,00',
  )
}

/**
 * Every character in the document, not only the visible ones.
 *
 * `innerText` would miss the half of the Itens table the CSS is hiding — the
 * board draws labelled rows below `md` and a real `<table>` above it, and both
 * are in the DOM. A fabricated price on the desktop half is still a fabricated
 * price, so the check reads `textContent`.
 */
function pageText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.textContent ?? '')
}

/**
 * None of the ways this product knows how to tell someone to hurry
 * (legal brief §2.2 rule 6).
 *
 * The list is the copy itself rather than a set of test ids, because the rule
 * is about the words: the defect of 2026-09-22 was a suspended tender printing
 * "último dia" and "Ainda dá tempo", and the next way to say it will also be
 * words.
 */
export const URGENCY_COPY = [
  'último dia',
  'Ainda dá tempo',
  'restantes',
  'Proposta até',
  'As propostas deste edital já encerraram',
] as const

export async function noUrgency(page: Page): Promise<void> {
  const text = await pageText(page)
  for (const phrase of URGENCY_COPY) {
    expect(text, `urgency copy on a stopped tender: "${phrase}"`).not.toContain(phrase)
  }
}
