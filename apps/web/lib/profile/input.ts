import { z } from 'zod'
import { normaliseCnpj } from '@/lib/cnpj'
import { parseBirthDate } from './age'
import { parseMobile } from './phone'

/**
 * The profile a subscriber must complete before paying — task **F31**.
 *
 * Sci, 2026-10-12: *"all user needs to inform their name, birth date, mobile
 * number (BR or other country), Company/Business name (optional), a very
 * simplify form"*, and the gate goes **before subscribing** rather than across
 * the app, so the free Radar stays frictionless.
 *
 * ## One of the fields Sci asked for is not here
 *
 * **`cpf` is absent, and `birth_date` is not** — this docblock said both were
 * absent until 2026-10-13, which review caught as one file stating the
 * opposite of the schema sixty lines below it.
 *
 * The date of birth arrived with the policy: Sci approved the amendment and
 * `politica-de-privacidade.md` **v1.4** names it in §2 and §4(c) and declares
 * the 18+ purpose in §5. Disclose, then collect. `./age.ts` applies that one
 * rule and nothing else, which is what data minimisation requires of it.
 *
 * The **CPF** is still not collected, and no longer for a legal reason — v1.4
 * names it too. What stops it is **F32**, Sci's own ruling that a CNPJ stays
 * required to use the Radar, which leaves a CPF satisfying only Asaas.
 * `users.cpf` exists and stays empty, and this schema drops a posted `cpf`
 * (asserted), so F32 and not a stray caller is what starts writing it.
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
  birthDate: 'birthDateInvalid',
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

  /**
   * **Collected only to apply the 18+ rule**, which `politica-de-privacidade.md`
   * §4 states and §5 declares as a purpose with a legal basis from v1.4
   * (13/10/2026). That amendment is what unblocked this field: before it, the
   * policy named no date of birth anywhere, so collecting one was an
   * undisclosed personal datum. See `./age.ts`, including why the age is
   * computed in the product's timezone.
   */
  birthDate: z
    .string({ error: PROFILE_ERRORS.birthDate })
    .transform((value) => parseBirthDate(value))
    .refine((value): value is NonNullable<typeof value> => value !== null, {
      message: PROFILE_ERRORS.birthDate,
    })
    .transform((value) => value.iso),

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
