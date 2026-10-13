/**
 * The 18+ rule, and the only reason a date of birth is collected — task
 * **F31**.
 *
 * `politica-de-privacidade.md` §4 states it (*"o serviço não é destinado a
 * menores de 18 anos"*) and §5, from v1.4 (13/10/2026), declares it as a
 * purpose with a legal basis. `0016_profile_identity.sql`'s own comment on the
 * column says the same thing: *"Collected only to apply the 18+ rule the
 * privacy policy states."* Used for anything else it would fail data
 * minimisation, which is why this module does one thing and returns a boolean.
 *
 * ## The clock
 *
 * CLAUDE.md, Clocks: a date a person reads is `America/Sao_Paulo`, the database
 * is UTC, and the laptop is in Portugal. Somebody turning 18 **today** in
 * Brasília is still 17 by a UTC clock for three hours of every night, so "is
 * this person 18" is asked in the product's timezone or it is wrong once a day
 * for every applicant born exactly eighteen years ago.
 *
 * §12: a birth date is personal data and is never logged.
 */

/** Nobody alive is older than this, and a typo in the year reads as one. */
const MAX_AGE = 120
const MIN_AGE = 18

/**
 * Today in `America/Sao_Paulo`, as `[year, month, day]`, or `null`.
 *
 * **Nullable because the first version failed *open*, which is the wrong
 * direction for the one validator whose job is refusing children.** It read
 * `new Intl.DateTimeFormat('en-CA', …).format(now)` and did
 * `.split('-').map(Number)`, trusting the locale to render `YYYY-MM-DD`. On a
 * runtime without `en-CA` data the fallback formats `10/13/2026`, the split
 * gives `[NaN, undefined, undefined]`, the age becomes `NaN` — and **both**
 * `NaN < 18` and `NaN > 120` are `false`, so every date was accepted,
 * including a five-year-old's. Not reachable on Vercel, which ships full ICU,
 * and found by review before it ever could be.
 *
 * `formatToParts` asks for the fields by name instead of parsing a string, and
 * every one is checked, so an unexpected runtime makes this return `null` and
 * the caller refuse — CLAUDE.md §4d: change the shape rather than trust the
 * happy string.
 */
function todayInSaoPaulo(now: Date): [number, number, number] | null {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)

  const field = (type: 'year' | 'month' | 'day'): number => {
    const found = parts.find((part) => part.type === type)
    return found ? Number(found.value) : Number.NaN
  }

  const [y, m, d] = [field('year'), field('month'), field('day')]
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  return [y, m, d]
}

export type BirthDate = { iso: string }

/**
 * `null` unless this is a real calendar date in the past and the person is
 * between 18 and 120.
 *
 * One rejection for every reason, like `parseMobile`: a form that says *which*
 * rule a date broke teaches somebody to type a date that passes.
 */
export function parseBirthDate(raw: string, now: Date = new Date()): BirthDate | null {
  const text = String(raw ?? '').trim()
  // `<input type="date">` posts `YYYY-MM-DD`, and that is the only shape taken
  // — a free-text date is ambiguous between `dd/mm` and `mm/dd`, which is the
  // same class of mistake as reading a `+1` number as Brazilian.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  // **Round-tripped, so 31/02 is refused rather than rolled into March.**
  // `new Date(2026, 1, 31)` is 3 March, and a validator that trusted it would
  // accept a date that does not exist and store a different one.
  const asDate = new Date(Date.UTC(year, month - 1, day))
  if (
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== month - 1 ||
    asDate.getUTCDate() !== day
  ) {
    return null
  }

  const today = todayInSaoPaulo(now)
  // No clock, no decision. Refusing is the safe direction: the alternative is
  // admitting a minor because a locale was missing.
  if (today === null) return null
  const [ty, tm, td] = today
  // Whole years elapsed, by calendar comparison rather than by dividing
  // milliseconds: leap years make the arithmetic wrong by a day roughly once
  // every four birthdays, and that day is somebody's eighteenth.
  let age = ty - year
  if (tm < month || (tm === month && td < day)) age -= 1

  if (age < MIN_AGE || age > MAX_AGE) return null
  return { iso: `${match[1]}-${match[2]}-${match[3]}` }
}
