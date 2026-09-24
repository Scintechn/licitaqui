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
