'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { setUserCnpj, setUserProfile } from '@/lib/auth/session'
import { db } from '@/lib/db'
import {
  DRAFT_COOKIE,
  DRAFT_MAX_AGE,
  DRAFT_PATH,
  encodeDraft,
} from '@/lib/profile/draft'
import { profileErrors, profileInput } from '@/lib/profile/input'
import { companyOrLookup } from '@/lib/radar/company'
import { ACCOUNT_CREATE_PATH, PLAN_PATH, PROFILE_PATH } from '@/lib/routes'
import { withQuery } from '@/lib/url'

/**
 * `saveProfile` — the one thing `/conta/perfil` does (task **F31**).
 *
 * ## Why it re-reads the session
 *
 * A Server Function is a POST endpoint with a generated name, so the form that
 * calls it is not the only thing that can. It takes no user id from its
 * caller: it reads the session and writes to **that** account. The same rule
 * `app/conta/plano/actions.ts` states at length, and the reason **F33** exists.
 *
 * ## Why it is not rate limited while `goToCheckout` is
 *
 * Writing a name twice is harmless, like `saveCompany` beside it; neither
 * creates nor destroys a charge. What it *can* do is enqueue a
 * `company_lookup`, and `companyOrLookup` dedupes that itself.
 *
 * ## §12
 *
 * Nothing here logs the name, the mobile or the CNPJ. The error path puts
 * **field names** in the query string and never values, so a shared screenshot
 * of the address bar cannot leak a number.
 */
export async function saveProfile(formData: FormData): Promise<void> {
  const session = await auth()
  const id = session?.user?.id
  if (!id) redirect(ACCOUNT_CREATE_PATH)

  const typed = {
    name: String(formData.get('nome') ?? ''),
    mobile: String(formData.get('celular') ?? ''),
    cnpj: String(formData.get('cnpj') ?? ''),
  }
  const parsed = profileInput.safeParse(typed)

  if (!parsed.success) {
    /*
     * **The schema's field names are not the form's**, and the two have to be
     * translated here or the error never renders. `profileInput` is keyed
     * `name`/`mobile`/`cnpj` (English, like every identifier in this repo);
     * the inputs are `nome`/`celular`/`cnpj`, because a form field's name is
     * what a person's browser remembers and autofills. Emitting the schema's
     * keys would hand the page `?erro=name,mobile`, which its allow-list
     * filters out entirely — a form that rejects an entry and then re-renders
     * with no error on it at all. Caught by `actions.test.ts`, which asserts
     * the query string this produces against the names the page accepts.
     */
    const FIELD_NAMES: Record<string, string> = { name: 'nome', mobile: 'celular', cnpj: 'cnpj' }
    const fields = Object.keys(profileErrors(parsed.error))
      .map((field) => FIELD_NAMES[field] ?? field)
      .join(',')

    /*
     * **Carry back what was typed.** The redirect below is a 303 to a fresh
     * GET, so the post body is gone — and the first version of this screen
     * then re-filled the fields from the database, which for the account this
     * form exists for (a magic-link signup with all three columns null) meant
     * **one wrong digit emptied all three fields**. Found by review. The
     * values are a name and a mobile, so they travel in an `httpOnly`
     * path-scoped cookie and never in the URL (§12) — see
     * `lib/profile/draft.ts`, and `HANDOFF_COOKIE` for the same pattern.
     */
    ;(await cookies()).set(DRAFT_COOKIE, encodeDraft(typed), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: DRAFT_PATH,
      maxAge: DRAFT_MAX_AGE,
    })

    return redirect(withQuery(PROFILE_PATH, `erro=${encodeURIComponent(fields)}`))
  }

  const { name, mobile, cnpj } = parsed.data

  try {
    await companyOrLookup(cnpj)
  } catch (error) {
    // The CNPJ is worth more than the company's name: a failed lookup must not
    // stop somebody subscribing. A code, never the CNPJ (§12) — the same trade
    // `saveCompany` makes, in the same words.
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`company_lookup could not be enqueued (${code})`)
  }

  /*
   * **One transaction, because a half-saved profile is this gate's worst
   * case.** `canBill` asks for a name *and* a CNPJ. Written separately, a
   * failure between them leaves an account that passes one check and not the
   * other, and returns somebody to a form that looks half filled with no
   * explanation. Either both land or neither does.
   */
  await db().transaction(async (tx) => {
    await setUserProfile(Number(id), { name, mobile }, tx)
    await setUserCnpj(Number(id), cnpj, tx)
  })

  // **The draft's other half.** A Server Component may read cookies and not
  // write them, so the page cannot clear this after rendering — the action
  // owns the whole lifecycle, and this is the success end of it. `DRAFT_MAX_AGE`
  // is only the backstop for somebody who abandons the form.
  ;(await cookies()).delete({ name: DRAFT_COOKIE, path: DRAFT_PATH })

  // Straight to the plan screen: this form exists because somebody tried to
  // subscribe, so finishing it returns them to where they were going.
  redirect(withQuery(PLAN_PATH, 'estado=cadastro-salvo'))
}
