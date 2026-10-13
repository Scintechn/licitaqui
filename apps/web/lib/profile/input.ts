import { z } from 'zod'
import { normaliseCnpj } from '@/lib/cnpj'
import { parseMobile } from './phone'

/**
 * The profile a subscriber must complete before paying — task **F31**.
 *
 * Sci, 2026-10-12: *"all user needs to inform their name, birth date, mobile
 * number (BR or other country), Company/Business name (optional), a very
 * simplify form"*, and the gate goes **before subscribing** rather than across
 * the app, so the free Radar stays frictionless.
 *
 * ## Two of the fields Sci asked for are not here
 *
 * **`birth_date` and `cpf` are deliberately absent.** The columns exist
 * (`0016_profile_identity.sql`, applied) and nothing writes them, because
 * `docs/legal/politica-de-privacidade.md` does not say we collect either one.
 * Collecting an undisclosed personal datum is an LGPD problem and the wording
 * is Sci's (legal brief §5) — `docs/TO_VALIDATE.md` **I** is the request. This
 * schema is the half that the policy as it stands already covers, so the form
 * ships and gains two fields later rather than waiting on a sentence.
 *
 * ## Why the CNPJ is required and the CPF is not the alternative
 *
 * Asaas needs a `cpfCnpj` on a customer, so *some* document is required to
 * charge anybody. Sci's ruling on **F32** was option **B**: the CNPJ is what
 * the Radar is built on, so it is the one the product asks for, and a CPF
 * would satisfy Asaas only. `checkout.ts` has always read `users.cnpj`; this
 * form is the first screen that asks for it as part of becoming a subscriber
 * rather than as part of searching.
 *
 * ## The mobile is required, and that makes one policy sentence stale
 *
 * §4(b) reads *"Nome, e-mail e, **se informar**, WhatsApp"* — which describes
 * the field as optional. Required, it is not. **This is not the same kind of
 * problem as `birth_date`**: the datum *is* disclosed, so nothing undisclosed
 * is collected; what is wrong is one clause describing it as a choice. That is
 * a copy correction, so it is a `docs/CLAIMS.md` row against this card rather
 * than a second blocker — Sci's ruling was that every user informs a mobile.
 */
export const PROFILE_ERRORS = {
  name: 'nameRequired',
  mobile: 'mobileInvalid',
  cnpj: 'cnpjInvalid',
} as const

export type ProfileError = (typeof PROFILE_ERRORS)[keyof typeof PROFILE_ERRORS]

/** Long enough for a real name, short enough that Asaas will take it. */
const NAME_MAX = 120

export const profileInput = z.object({
  /**
   * **What closes F29.** `users.name` is nullable and a magic-link signup
   * supplies none, so `checkout.ts` fell back to the company's `legal_name`
   * and a paying subscriber could have no name of their own — which is
   * precisely what F24's charge notice needs, since `billing.py` greets
   * `{{nome}}` and `templates.py` refuses a blank as hard as a missing value.
   *
   * A single character is not a name, and two is (`Bo`, `Li`). The lower bound
   * is there to refuse `.` and `-`, not to adjudicate names.
   */
  name: z
    .string({ error: PROFILE_ERRORS.name })
    .transform((value) => value.trim().replace(/\s+/g, ' '))
    .refine((value) => value.length >= 2 && value.length <= NAME_MAX, {
      message: PROFILE_ERRORS.name,
    })
    // A name of punctuation passes a length check. At least one letter —
    // Unicode, because `José` and `Ngô` are names and `\w` is not enough.
    .refine((value) => /\p{L}/u.test(value), { message: PROFILE_ERRORS.name }),

  /** E.164. See `./phone.ts` for why the `+` is read before anything else. */
  mobile: z
    .string({ error: PROFILE_ERRORS.mobile })
    .transform((value) => parseMobile(value))
    .refine((value): value is NonNullable<typeof value> => value !== null, {
      message: PROFILE_ERRORS.mobile,
    })
    .transform((value) => value.e164),

  /**
   * Required here, unlike the founders form, where it is the top of the funnel
   * and a missing CNPJ costs a lead. This form is the last step before money,
   * where a missing CNPJ costs a failed charge at Asaas.
   */
  cnpj: z
    .string({ error: PROFILE_ERRORS.cnpj })
    .transform((value) => normaliseCnpj(value.trim()))
    .refine((value): value is string => value !== null, { message: PROFILE_ERRORS.cnpj }),

})

/**
 * **The optional business name Sci asked for is not here, and not rendered.**
 * `companies` already holds what the Receita returns for the CNPJ, which is
 * the name Asaas and an edital use; a trade name somebody types when those
 * differ has **no column**. Validating it and throwing it away, or rendering a
 * field whose answer is discarded, is the defect CLAUDE.md lists five
 * instances of — so it is a card, **F38**, and the field arrives with the
 * column it needs.
 */
export type ProfileInput = z.infer<typeof profileInput>

/**
 * First error per field, by field name. Mirrors `lib/founders/input.ts`'s
 * `fieldErrors` — one shape for both forms, so a screen reads them the same
 * way.
 */
export function profileErrors(error: z.ZodError): Partial<Record<string, ProfileError>> {
  const out: Partial<Record<string, ProfileError>> = {}
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? '')
    if (field && !(field in out)) out[field] = issue.message as ProfileError
  }
  return out
}
