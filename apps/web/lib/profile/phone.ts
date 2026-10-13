/**
 * A mobile number, parsed once and classified by country — task **F31**.
 *
 * Sci, 2026-10-12: the profile form asks for a *"mobile number (**BR or other
 * country**)"*. That parenthesis is the whole of this module, because the
 * obvious way to honour it is a defect the worker already carries a warning
 * about — `evolution.py`'s `normalise_number`:
 *
 * > `+1 415 555 0000` is eleven digits whose first two are a valid Brazilian
 * > area code, so stripping the `+` silently turns a US number into a
 * > plausible São Paulo one and messages a stranger.
 *
 * **A leading `+` is the only signal that the country code was stated**, so it
 * is read before anything is stripped. That one ordering is the difference
 * between accepting an international number and inventing a Brazilian one.
 *
 * `lib/founders/input.ts`'s `normaliseWhatsapp` had the hole: it called
 * `digits()` first, so `+12995550000` — a `+1` number whose third digit is a
 * `9` — became `+5512995550000`, a real mobile in São José dos Campos. It now
 * goes through here and refuses anything that is not Brazilian, which is the
 * founders form's own rule and not a widening of it.
 *
 * ## Why this is not `libphonenumber`
 *
 * Google's library is ~250 kB for a form with one phone field, and it would be
 * shipped to every visitor of a landing page that does not have one. What we
 * need is narrower than it: Brazilian numbers validated properly, because they
 * are the ones WhatsApp will dial, and everything else accepted as E.164
 * digits because **nothing in the product dials a foreign number** —
 * `normalise_number` raises on one by design. If that changes, this is the one
 * place to widen.
 *
 * ## §12
 *
 * A number is personal data. Nothing here logs, and the caller's error is a
 * code, never the value.
 */

/** ITU-T E.164: at most 15 digits including the country code. */
const MAX_E164_DIGITS = 15
/**
 * The shortest plausible international number. E.164 sets no floor; 8 is the
 * shortest national number in use (Denmark, Norway) plus a 1-digit code, and
 * it is low enough to accept a real number and high enough to reject a
 * mistyped fragment.
 */
const MIN_E164_DIGITS = 8

export type Mobile = {
  /**
   * `'BR'` is the only value anything can *dial* today — see the module note.
   * Carried so a caller that must refuse a foreign number says so explicitly
   * rather than re-deriving it from the prefix.
   */
  country: 'BR' | 'other'
  /** E.164, `+` included. What goes in `users.whatsapp`. */
  e164: string
}

const digitsOf = (value: string): string => value.replace(/\D+/g, '')

/**
 * The national part of a Brazilian number: a 2-digit area code (11..99) and 8
 * or 9 subscriber digits, with an optional country code in front.
 *
 * **The `length > 11` guard on the country code is load-bearing**, and the
 * reason is that **55 is also an area code** — Santa Maria, RS. Stripping a
 * leading `55` unconditionally would turn `55 99999-9999`, a valid number
 * there, into the four digits `99999999` and reject it; worse, it would turn
 * the 11-digit `55 9 9999-9999` into a different subscriber's number. A real
 * Brazilian number is 10 or 11 digits *without* the country code, so only a
 * longer string can have one.
 */
function brazilianNational(digits: string, stated: boolean): string | null {
  // **A stated country code is a fact; an unstated one is a guess.** With a
  // `+` the leading 55 can only be the country code, so it comes off
  // unconditionally. Without one, length decides — see above.
  //
  // The first version of this function took the length path in both cases and
  // produced a **stranger's number**: `+55 99999-9999`, a country code and a
  // subscriber number with the DDD forgotten, is 11 digits, so the guard did
  // not fire, `55` was read as Santa Maria and the result was
  // `+5555999999999` — a real mobile belonging to somebody else. It had
  // `stated` in hand and threw it away, which is the exact failure this
  // module's docstring is about, committed by the module itself.
  const value =
    (stated || digits.length > 11) && digits.startsWith('55') ? digits.slice(2) : digits
  if (value.length !== 10 && value.length !== 11) return null

  const area = Number(value.slice(0, 2))
  if (!Number.isInteger(area) || area < 11 || area > 99) return null

  const subscriber = value.slice(2)
  // ANATEL numbers mobiles with a leading 9, so a 9-digit subscriber that does
  // not start with 9 is refused.
  //
  // **The 8-digit branch below accepts landlines, and saying otherwise would
  // overstate it.** Brazil finished adding the mandatory 9th digit to mobiles
  // in 2016, so an 8-digit number beginning 2-5 is a landline with certainty —
  // and it is accepted, because this rule is inherited from
  // `lib/founders/input.ts` and tightening it would start refusing numbers
  // that form has taken for weeks. What it costs is bounded: an 8-digit
  // landline reaches Asaas as a `mobilePhone` and WhatsApp cannot dial it, so
  // it degrades to the e-mail notice. Narrowing it is a product decision, not
  // a bug fix.
  if (subscriber.length === 9 && !subscriber.startsWith('9')) return null
  if (subscriber.length === 8 && !/^[2-9]/.test(subscriber)) return null

  return value
}

/**
 * `null` for anything we will not store. One return for every rejection: the
 * caller turns it into one error code, because a form that explains *which*
 * rule a number broke is a form that teaches somebody to type a number that
 * passes validation and does not exist.
 */
export function parseMobile(raw: string): Mobile | null {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return null
  // A `+` anywhere but the front is not a country code, it is a typo. Checked
  // before `digitsOf` throws the character away.
  if (text.lastIndexOf('+') > 0) return null

  const stated = text.startsWith('+')
  const digits = digitsOf(text)
  if (digits.length === 0) return null

  // **Stated and foreign: accepted as given, never reinterpreted.** This is
  // the branch `normalise_number`'s comment is about, and reaching it requires
  // the `+` — bare digits can never land here, so no unprefixed string is ever
  // read as international.
  if (stated && !digits.startsWith('55')) {
    if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null
    // No E.164 country code begins with 0, and `+00…` is the international
    // prefix typed where the `+` already is — a mistake, not a number.
    if (digits.startsWith('0')) return null
    return { country: 'other', e164: `+${digits}` }
  }

  const national = brazilianNational(digits, stated)
  return national === null ? null : { country: 'BR', e164: `+55${national}` }
}

/** The Brazilian-only gate the founders form needs. `null` if it is not one. */
export function parseBrazilianMobile(raw: string): string | null {
  const mobile = parseMobile(raw)
  return mobile !== null && mobile.country === 'BR' ? mobile.e164 : null
}
