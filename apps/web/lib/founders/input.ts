import { z } from 'zod'
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

/** Digits only, so "(11) 99999-9999" and "11999999999" are the same number. */
function digits(value: string): string {
  return value.replace(/\D+/g, '')
}

/**
 * Brazilian mobile in E.164: country code 55, a two-digit area code (11..99)
 * and an 8- or 9-digit subscriber number. A leading 55 or +55 is accepted and
 * not doubled; a 9-digit mobile must start with 9, which is how ANATEL numbers
 * mobiles and the only cheap way to reject a landline typed by mistake.
 */
export function normaliseWhatsapp(raw: string): string | null {
  let value = digits(raw)
  if (value.length > 11 && value.startsWith('55')) value = value.slice(2)
  if (value.length !== 10 && value.length !== 11) return null

  const area = Number(value.slice(0, 2))
  if (!Number.isInteger(area) || area < 11 || area > 99) return null

  const subscriber = value.slice(2)
  if (subscriber.length === 9 && !subscriber.startsWith('9')) return null
  if (subscriber.length === 8 && !/^[2-9]/.test(subscriber)) return null

  return `+55${value}`
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
