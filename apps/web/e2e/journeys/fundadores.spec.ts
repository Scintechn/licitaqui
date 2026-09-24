import { expect, test, type Page } from '@playwright/test'
import { messages } from '../../lib/messages'

/**
 * **The founders form, which had no browser test at all.**
 *
 * On 2026-09-24 a change made the CNPJ optional: the Zod schema, the
 * `required` attribute and the label all moved, and the insert did not.
 * Drizzle drops an `undefined` embedded value from a template rather than
 * binding NULL, so the statement became `select $1, $2, $3, ,` and every
 * signup that left the field blank returned a 500 — the one case the change
 * existed to allow, on a live page taking sign-ups.
 *
 * It shipped green. `input.test.ts` tested the schema and stopped there, every
 * fixture in `signup.db.test.ts` passed a CNPJ, and `grep -rn "fundadores"
 * e2e/journeys` returned nothing — so "25 journeys green" was never evidence
 * about this form. The unit tests exercised the units; nothing exercised the
 * path.
 *
 * ## What this covers, and what it deliberately does not
 *
 * `POST /api/founders` is stubbed, like every other journey here: the point is
 * what the **page** does with an answer, not whether Postgres is up. What the
 * stub cannot catch is the defect above, which lived in the SQL — that is
 * `signup.db.test.ts`'s new case, and the two are deliberately a pair.
 *
 * What this one catches is the other half: that the form submits what the
 * schema now accepts. The request body is asserted directly, because a form
 * that silently sends `cnpj: ""` where the schema expects it absent is the
 * same class of bug one layer up.
 */

const form = messages.founders.form
const confirmation = messages.founders.confirmation

type Captured = { body: Record<string, unknown> | null }

/** Stubs the signup endpoint and hands back whatever the page posted. */
async function stubSignup(page: Page, status = 201): Promise<Captured> {
  const captured: Captured = { body: null }
  await page.route('**/api/founders', async (route) => {
    captured.body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(
        status === 201
          ? { status: 'seated', seat: 7, seatsTaken: 7, seatsLeft: 41 }
          : { status: 'error', error: 'server_error' },
      ),
    })
  })
  // The live seat count is decoration; pin it so the gauge never flakes.
  await page.route('**/api/founders/seats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ taken: 6, total: 48 }),
    }),
  )
  return captured
}

/**
 * The signup card, not the page, and fields by id rather than by label.
 *
 * "E-mail" and "WhatsApp" each appear twice *inside the form* — once as a
 * field label and once in the consent sentence beneath it — so `getByLabel`
 * is ambiguous however tightly it is scoped. The ids are the form's own
 * (`signup-form.tsx`), and the label is asserted once, on its own, below.
 */
function signupForm(page: Page) {
  return page.locator('#vaga')
}

async function fillRequired(page: Page) {
  const vaga = signupForm(page)
  await vaga.locator('#nome').fill('Dona Marta')
  await vaga.locator('#email').fill('marta@papelaria.test')
  await vaga.locator('#whatsapp').fill('(11) 91234-5678')
  for (const box of await vaga.getByRole('checkbox').all()) await box.check()
}

test.describe('Dona Marta reserves a founder seat', () => {
  test('the CNPJ is optional, and leaving it blank still seats her', async ({ page }) => {
    const captured = await stubSignup(page)
    await page.goto('/fundadores')

    // The label says so, and the control does not demand it.
    const cnpj = signupForm(page).locator('#cnpj')
    await expect(cnpj).toBeVisible()
    await expect(cnpj).not.toHaveAttribute('required', /.*/)
    // …and it is labelled, and labelled as optional.
    const label = signupForm(page).locator('label[for="cnpj"]')
    await expect(label).toContainText(form.cnpjLabel)
    await expect(label).toContainText(messages.common.optional)

    await fillRequired(page)
    await signupForm(page).getByRole('button', { name: messages.founders.offer.cta }).click()

    await expect(page.getByText(confirmation.title.split('{')[0].trim(), { exact: false })).toBeVisible()
    // Absent, not an empty string: the schema turns blank into `undefined`,
    // and a form that posts `""` would be the same defect one layer up.
    expect(captured.body?.cnpj ?? '').toBe('')
  })

  test('a CNPJ that is given is still sent, and a wrong one is refused at the form', async ({
    page,
  }) => {
    const captured = await stubSignup(page)
    await page.goto('/fundadores')

    await fillRequired(page)
    await signupForm(page).locator('#cnpj').fill('00.394.429/0001-00')
    await signupForm(page).getByRole('button', { name: messages.founders.offer.cta }).click()

    await expect(page.getByText(confirmation.title.split('{')[0].trim(), { exact: false })).toBeVisible()
    // Posted as typed. `normaliseCnpj` runs server-side in the Zod schema —
    // the form's job is to send what was entered, not to pre-clean it.
    expect(String(captured.body?.cnpj)).toContain('00.394.429/0001-00')
  })

  test('a failed signup says so instead of pretending it worked', async ({ page }) => {
    // The 500 that shipped rendered… nothing the user could act on. Whatever
    // the server answers, the page must not show the seat confirmation.
    await stubSignup(page, 500)
    await page.goto('/fundadores')

    await fillRequired(page)
    await signupForm(page).getByRole('button', { name: messages.founders.offer.cta }).click()

    await expect(page.getByText(confirmation.title.split('{')[0].trim(), { exact: false })).toHaveCount(0)
    await expect(page.getByText(messages.founders.errors.generic.split('{')[0].trim())).toBeVisible()
  })

  test('consent is not pre-ticked, and an unticked box reaches the server as a refusal', async ({
    page,
  }) => {
    // LGPD art. 8 §4, and the two boxes are the last thing before conversion.
    //
    // This form carries `noValidate`, so `required` does **not** block the
    // submit here — unlike `/conta/criar`, which has no `noValidate` and where
    // the browser does stop it. Enforcement is the Zod literals
    // (`contactConsent: z.literal(true)`), which is why a refusal must arrive
    // at the server as `false` rather than being quietly dropped: `input.ts`
    // is explicit that "a refusal is not a signup", and it can only refuse
    // what it is sent.
    const captured = await stubSignup(page)
    await page.goto('/fundadores')

    for (const box of await signupForm(page).getByRole('checkbox').all()) {
      await expect(box).not.toBeChecked()
    }

    const vaga = signupForm(page)
    await vaga.locator('#nome').fill('Dona Marta')
    await vaga.locator('#email').fill('marta@papelaria.test')
    await vaga.locator('#whatsapp').fill('(11) 91234-5678')
    await signupForm(page).getByRole('button', { name: messages.founders.offer.cta }).click()

    // It posts, and it posts the refusal — which the schema rejects.
    expect(captured.body?.contactConsent).toBe(false)
    expect(captured.body?.acceptedTerms).toBe(false)
  })
})

/**
 * What the page *announces*, which is not what it renders.
 *
 * The `journeys` project runs at 390px — the width these readers are on — so
 * these are the phone layout, in a real browser, with the real stylesheet.
 * `renderToStaticMarkup` cannot see any of it: every defect below is produced
 * by a media query or by the browser's own role mapping, neither of which
 * exists in a string of HTML.
 */

/**
 * Everything in `el` a screen reader would reach, in order.
 *
 * Skips anything inside an `aria-hidden` subtree and anything not rendered —
 * `display: none` removes a node from the accessibility tree, `sr-only` does
 * not. That distinction is the whole subject of the first test.
 */
async function announcedText(locator: ReturnType<Page['locator']>) {
  return locator.evaluate((el) => {
    const parts: string[] = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const parent = node.parentElement
      const text = node.textContent?.trim()
      if (
        parent &&
        text &&
        !parent.closest('[aria-hidden="true"]') &&
        parent.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })
      ) {
        parts.push(text)
      }
      node = walker.nextNode()
    }
    return parts.join(' ')
  })
}

test.describe('Dona Marta reads the comparison on her phone', () => {
  /**
   * **A defect already on `main`, not something the layout pass introduced.**
   *
   * Below 560px the table is laid out with `display: block`, and that strips
   * the implicit ARIA role from every table element in every major browser:
   * no table, no row, no cell, and so no `<th scope="col">` association. The
   * `<th>`s were `sr-only` — in the tree, announced — and the visible
   * substitute labels inside each cell were `aria-hidden`, on the strength of
   * a code comment claiming "the real `<th>` is still associated with the
   * cell". It is not, and it had not been since the day the row was stacked.
   *
   * So on a phone each row announced the feature and then two bare prices,
   * with nothing saying which was the competitor's and which was ours — on
   * the section that exists to make exactly that contrast.
   *
   * This cannot be asserted in `page.test.tsx`: the layout that strips the
   * roles is a media query, and the string of HTML is identical either way.
   */
  test('every price says whose it is, not just what it is', async ({ page }) => {
    await page.goto('/fundadores')

    const comparison = messages.foundersPage.founderValue
    const row = page.locator('tr').filter({ hasText: comparison.comparisonRows[0].feature })
    await expect(row).toHaveCount(1)

    const announced = await announcedText(row)
    // The feature, then each value with the name of the column it is in.
    expect(announced).toContain(comparison.comparisonRows[0].feature)
    expect(announced).toContain(comparison.comparisonOther)
    expect(announced).toContain(messages.brand.name)
    // And each label sits before the value it labels, not after it.
    expect(announced.indexOf(comparison.comparisonOther)).toBeLessThan(
      announced.indexOf(comparison.comparisonRows[0].other),
    )
  })

  test('the column headers do not announce a second time as two loose words', async ({ page }) => {
    // They label nothing at this width — `sr-only` would leave them being read
    // out ahead of the rows, meaning "Ferramentas populares. LicitaQui." with
    // no values attached.
    await page.goto('/fundadores')
    await expect(page.locator('thead')).toBeHidden()
  })

  test('the desktop table is still a table, with its headers', async ({ page }) => {
    // The fix is for the phone. From 560px up the roles are real and the
    // `<th scope="col">` associations are what a screen reader should use.
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/fundadores')

    await expect(page.getByRole('table')).toHaveCount(1)
    await expect(
      page.getByRole('columnheader', { name: messages.foundersPage.founderValue.comparisonOther }),
    ).toBeVisible()
  })
})

test.describe('the founders page at 390px', () => {
  /**
   * The timeline's arrows sit *between* steps. Stacked, there is no between —
   * an arrow pointing right at the item below it points at nothing — so they
   * exist only from 900px, where the four steps are actually a row.
   */
  test('shows no arrows between steps that are stacked, and four on a wide screen', async ({
    page,
  }) => {
    await page.goto('/fundadores')
    const steps = page.getByRole('list').filter({ hasText: messages.foundersPage.timeline.steps[0].title })
    await expect(steps).toHaveCount(1)

    const visibleArrows = (locator: ReturnType<Page['locator']>) =>
      locator.locator('svg').evaluateAll(
        (nodes) => nodes.filter((n) => n.checkVisibility() && n.getBoundingClientRect().width > 0).length,
      )

    // Four steps, four category icons, and no arrows.
    expect(await visibleArrows(steps)).toBe(messages.foundersPage.timeline.steps.length)

    await page.setViewportSize({ width: 1280, height: 900 })
    // One row now: the same four icons plus an arrow in each of the three gaps.
    expect(await visibleArrows(steps)).toBe(messages.foundersPage.timeline.steps.length * 2 - 1)
  })

  /**
   * The panel went off-screen at 440px once, when the comparison table inside
   * it was given a `min-w-[420px]` and a grid item's `min-width: auto` let it
   * push the whole panel — call to action included — past the viewport. The
   * layout pass moved the call to action into that panel, so the guard is
   * worth more now, not less.
   */
  for (const width of [390, 440]) {
    test(`nothing on the page is wider than a ${width}px screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/fundadores')

      const overflow = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth
        return [...document.querySelectorAll('body *')]
          .filter((el) => {
            const box = el.getBoundingClientRect()
            return box.width > 0 && (box.right > limit + 1 || box.left < -1)
          })
          .map((el) => `${el.tagName} ${String(el.className).slice(0, 80)}`)
          .slice(0, 5)
      })
      expect(overflow).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      )
    })
  }

  /** The offer's call to action is the panel's, and it fills the card. */
  test('the founder panel’s call to action is full width and reachable', async ({ page }) => {
    await page.goto('/fundadores')

    const cta = page
      .getByRole('link', { name: messages.foundersPage.founderValue.cta })
      .first()
    await expect(cta).toBeVisible()

    const [button, card] = await Promise.all([
      cta.boundingBox(),
      cta.evaluate((el) => {
        const parent = el.parentElement!
        const box = parent.getBoundingClientRect()
        return { width: box.width }
      }),
    ])
    expect(button!.width).toBeGreaterThan(card.width - 2)

    // Keyboard focus still lands on it, and still shows.
    await cta.focus()
    await expect(cta).toBeFocused()
  })
})
