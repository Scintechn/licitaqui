import { z } from 'zod'
import { parseBrazilianMobile } from '@/lib/profile/phone'
import { normaliseCnpj } from '@/lib/cnpj'

export { normaliseCnpj }

/**
 * What `POST /api/founders` accepts (spec §8: "Validates (Zod)").
 *
 * Two shaping rules the rest of the flow depends on:
 *
 *  - every value is trimmed and normalised **here**, so the database never sees
 *    `"  Maria "` or `"(11) 9 9999-9999"` in one row and `"+5511999999999"` in
 *    the next, and E2's WhatsApp client has one format to dial;
 *  - error codes are catalogue keys (`founders.errors.*`), not sentences. The
 *    route returns codes and the browser renders the pt-BR string, so the API
 *    never hardcodes copy.
 *
 * On CNPJ vs "o que você vende" (the open question on the card): **both**, with
 * the CNPJ required — Sci's decision. The CNPJ is what says which licitações a
 * business can actually enter, so it is product data, not a nice-to-have: on
 * opening day a founder's Radar is ready instead of empty. "O que você vende"
 * stays exactly as the approved page words it, and stays optional. This is the
 * one place where the rendered form departs from the approved HTML.
 */

export const ERROR_CODES = {
  name: 'nameRequired',
  email: 'emailInvalid',
  whatsapp: 'whatsappInvalid',
  cnpj: 'cnpjInvalid',
} as const

/**
 * Brazilian mobile in E.164 — now a thin wrapper, and the rewrite closed a
 * live defect rather than tidying one.
 *
 * It used to strip every non-digit **first**, which threw away the one
 * character that says the country code was stated. Measured 2026-10-13 against
 * the shipped function: `normaliseWhatsapp('+1 299 555 0000')` returned
 * **`+5512995550000`** — area code 12 is Sao Jose dos Campos and
 * `99555-0000` is a well-formed mobile there, so a US number became a real
 * stranger's Brazilian one, in the form whose numbers the opening broadcast
 * dials. `evolution.py`'s `normalise_number` had already been written against
 * exactly this and carried the comment; this side had not.
 *
 * The rules are unchanged and the surface is unchanged: this form takes
 * Brazilian numbers only, because the message it promises is a WhatsApp one
 * and `normalise_number` refuses to dial anything else. `parseMobile` in
 * `lib/profile/phone.ts` is where they live now, and F31's profile form uses
 * the same parser to *accept* a stated foreign code.
 */
export function normaliseWhatsapp(raw: string): string | null {
  return parseBrazilianMobile(raw)
}

/**
 * 14 digits, as the catalogue promises ("são 14 números"), plus the check
 * digits. The implementation moved to `lib/cnpj.ts` when the Radar started
 * needing the same one (task R1); it is re-exported above, so this module's
 * surface is unchanged.
 */

const optionalText = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length <= max, { message: 'tooLong' })
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional()

export const signupInput = z.object({
  name: z
    .string({ error: ERROR_CODES.name })
    .transform((value) => value.trim().replace(/\s+/g, ' '))
    .refine((value) => value.length >= 2 && value.length <= 120, {
      message: ERROR_CODES.name,
    }),

  email: z
    .string({ error: ERROR_CODES.email })
    .transform((value) => value.trim().toLowerCase())
    .refine((value) => value.length <= 254 && z.email().safeParse(value).success, {
      message: ERROR_CODES.email,
    }),

  whatsapp: z
    .string({ error: ERROR_CODES.whatsapp })
    .transform((value) => normaliseWhatsapp(value))
    .refine((value): value is string => value !== null, {
      message: ERROR_CODES.whatsapp,
    }),

  sells: optionalText(200),

  /**
   * Optional since 2026-09-24 — but **still validated when given**.
   *
   * Blank is a signup without a CNPJ, which is now allowed. Fourteen digits
   * that are not a CNPJ are still a mistake, and telling somebody at the form
   * costs them a correction while storing it costs a lead on opening day.
   * `normaliseCnpj` returning null on a non-empty value is therefore an error,
   * not an absence — those two cases are the whole of this field.
   */
  cnpj: z
    .string()
    .transform((value) => value.trim())
    // Blank becomes `undefined` before the refine, so an absent CNPJ passes
    // it; anything non-blank goes through `normaliseCnpj`, whose `null` is
    // the only thing the refine rejects. Those two cases are the whole field:
    // **not given** is allowed, **given and wrong** is still a mistake worth
    // telling somebody about at the form rather than storing.
    .transform((value) => (value.length === 0 ? undefined : normaliseCnpj(value)))
    .refine((value) => value !== null, { message: ERROR_CODES.cnpj })
    .transform((value) => value ?? undefined)
    .optional(),

  /** utm_source / influencer / coupon (§6.3). Never anything that identifies a person. */
  source: z
    .string()
    .transform((value) => value.trim().slice(0, 60))
    .refine((value) => /^[\w.-]*$/.test(value), { message: 'invalid' })
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional(),

  /**
   * LGPD art. 8 §4 (terms Annex B): one checkbox per purpose, never pre-ticked.
   * `false` is a refusal, and a refusal is not a signup — the request fails
   * rather than storing `contact_consent = false`.
   */
  contactConsent: z.literal(true, { error: 'foundersRequired' }),
  acceptedTerms: z.literal(true, { error: 'termsRequired' }),
})

export type SignupInput = z.infer<typeof signupInput>

export type FieldErrors = Record<string, string>

/** Flattens a Zod failure into `{ field: catalogueKey }` for the browser. */
export function fieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {}
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? 'form')
    if (!(field in out)) out[field] = issue.message
  }
  return out
}
