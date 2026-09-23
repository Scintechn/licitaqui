/**
 * How the Radar writes a date, a deadline and an amount of money.
 *
 * Pure functions over the wire types of `contract.ts`. No React, no `node:`
 * imports and no database — the browser loads this file, and the same call has
 * to produce the same string on the server and on the phone that hydrates it.
 *
 * ## Everything is Brasília time
 *
 * PNCP publishes naive Brasília local time and `db/seed.py` stores it as a real
 * instant (`::timestamp at time zone 'America/Sao_Paulo'`). A deadline rendered
 * in the *viewer's* zone would therefore read "30/09 · 05:30" for a user in
 * Portugal and "30/09 · 08:30" for the agency that published it — on a product
 * whose promise is "before the deadline". Every formatter below pins the zone,
 * which also makes these functions testable without freezing the machine clock.
 *
 * ## Why "13 dias" is a calendar difference and not a division
 *
 * The board's card counts down in whole days, and a person counting days to a
 * deadline counts dates, not 24-hour blocks: at 06:00 on the 17th, the 30th is
 * still "13 dias" away, and `Math.ceil(ms / 86_400_000)` would say 14. So the
 * count is the difference between two Brasília calendar dates.
 */

export const TIME_ZONE = 'America/Sao_Paulo'

const DAY_MS = 86_400_000

/** `2026-09-30` — the Brasília calendar date of an instant. */
const ISO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** `30/09` — the board's card line. */
const SHORT_DATE = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
})

/** `30/09/2026` — an operation row, where the year matters. */
const FULL_DATE = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

/** `30 set` — the tall "Proposta até" figure on the Opportunity screen. */
const TALL_DATE = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: 'short',
})

const TIME = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const INTEGER = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
const SCALED = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 })

function instant(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** `30/09`, or `null` when the tender carries no date. */
export function shortDate(iso: string | null | undefined): string | null {
  const date = instant(iso)
  return date ? SHORT_DATE.format(date) : null
}

/** `30/09/2026`. */
export function fullDate(iso: string | null | undefined): string | null {
  const date = instant(iso)
  return date ? FULL_DATE.format(date) : null
}

/** `08:30`, in Brasília. */
export function clockTime(iso: string | null | undefined): string | null {
  const date = instant(iso)
  return date ? TIME.format(date) : null
}

/** `30/09 · 08:30` — the deadline line on a Radar card. */
export function deadlineShort(iso: string | null | undefined): string | null {
  const date = instant(iso)
  if (!date) return null
  return `${SHORT_DATE.format(date)} · ${TIME.format(date)}`
}

/** `30/09/2026 · 08:30` — the same, with the year, for an operation row. */
export function deadlineFull(iso: string | null | undefined): string | null {
  const date = instant(iso)
  if (!date) return null
  return `${FULL_DATE.format(date)} · ${TIME.format(date)}`
}

/**
 * `30 SET · 08:30` — the board's big "Proposta até" figure, set in Archivo.
 *
 * Built from `formatToParts` rather than from the formatted string, because
 * pt-BR writes a short date as "30 de set." — the connective and the full stop
 * are both locale data, and stripping them with a regular expression would be
 * guessing at ICU's output. The capitals are applied here rather than with a
 * `uppercase` utility so the accessibility tree does not get a shouted date.
 */
export function deadlineTall(iso: string | null | undefined): string | null {
  const date = instant(iso)
  if (!date) return null
  const parts = TALL_DATE.formatToParts(date)
  const day = parts.find((part) => part.type === 'day')?.value ?? ''
  const month = (parts.find((part) => part.type === 'month')?.value ?? '')
    .replace(/\./g, '')
    .toLocaleUpperCase('pt-BR')
  return `${day} ${month} · ${TIME.format(date)}`
}

/** The Brasília calendar date of an instant, as `Date.UTC` milliseconds. */
function calendarDay(date: Date): number {
  const [year, month, day] = ISO_DATE.format(date).split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

/**
 * Whole Brasília days from `now` to the deadline. `0` is "today, still open",
 * a negative number means it has closed, and `null` means there is no date.
 */
export function daysUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  const date = instant(iso)
  if (!date) return null
  return Math.round((calendarDay(date) - calendarDay(now)) / DAY_MS)
}

/**
 * Zero is not a price, and PNCP publishes a great deal of it.
 *
 * 108 tenders in our table carry `estimated_value = 0`, and the two Sci found
 * on production — `94703980000132-1-000080/2026` and
 * `13112669000117-1-000010/2026` — carry item rows whose unit and total values
 * are all zero. That zero is not what the órgão will pay. It is what PNCP puts
 * in the value field when the budget is withheld: asked directly, the second
 * of those returns `valorTotalEstimado: 0.0` and `orcamentoSigilosoCodigo: 3`
 * ("Compra totalmente sigilosa") in the same payload. No edital buys anything
 * for nothing.
 *
 * So `R$ 0,00` on our screen is a figure the edital does not support, which
 * legal brief §2.2 rule 3 forbids: a price is an estimate with its arithmetic
 * visible, and a fabricated price is worse than no price at all.
 *
 * ## Why the guard is here and not at the call sites
 *
 * Because the two failure modes are not symmetric. A call site that forgets
 * the guard prints a false price **silently** — that is the production bug
 * being fixed here, and it recurs the day someone adds a fifth slot that shows
 * a value. A formatter that refuses a zero some future caller meant fails
 * **loudly and at once**: the number is simply missing from the screen in
 * front of the developer who put it there.
 *
 * That trade has a price, and it is worth naming. Somewhere there is a caller
 * for whom zero is a fact — "você pagou R$ 0,00 este mês" on a billing screen
 * is true and must print. That caller must not reach for these two functions.
 * They are the Radar's, over figures PNCP declares about an edital, and the
 * domain rule "a purchase has no price of zero" is part of what they mean.
 * A billing screen gets a billing formatter, with its own tests. This is not a
 * general-purpose currency library and should not become one.
 *
 * Deliberately **not** guarded: a value under R$ 1 that `money()` rounds to
 * "R$ 0". It is the same untruth in principle, but no such row exists in the
 * corpus, and the honest repair there is a different format — not a `null`
 * that would hide a figure we really do hold.
 */
function notAPrice(amount: number): boolean {
  return !Number.isFinite(amount) || amount === 0
}

/**
 * `R$ 48.196`, `R$ 1,25 mi`, `R$ 272,6 bi` — and `null` for a zero, which is
 * an absence dressed as a figure rather than a figure (see `notAPrice`).
 *
 * The board never shows centavos on a card: a tender's estimated value is an
 * order of magnitude, and `R$ 4.330.000,00` in Archivo at 22px does not fit a
 * 390px card next to the item count. Values come off the wire as decimal
 * strings — money is never a float — and are only turned into a number here,
 * for display.
 */
export function money(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  const amount = Number(value)
  if (notAPrice(amount)) return null
  if (Math.abs(amount) >= 1e9) return `R$ ${SCALED.format(amount / 1e9)} bi`
  if (Math.abs(amount) >= 1e6) return `R$ ${SCALED.format(amount / 1e6)} mi`
  return `R$ ${INTEGER.format(amount)}`
}

/**
 * `R$ 326.668,00`, `R$ 816,67` — the items table, to the centavo.
 *
 * `money()` above scales and drops the centavos, which is right for a card
 * whose 22px slot holds an order of magnitude and wrong here: the Itens tab
 * exists so a reader can check our rows against PNCP's table line by line, and
 * `R$ 2,99 mi` cannot be checked against anything. PNCP prints two decimals,
 * so we print two decimals.
 *
 * Unit values carry four decimals in the database (`816.6700`); the currency
 * format rounds them to two the way PNCP's own table does, which is also what
 * makes `quantidade × unitário` come out to the total the agency published.
 *
 * A zero returns `null` here for the same reason it does in `money()`: on the
 * tenders Sci found, every unit value and every total on the Itens tab is
 * zero, and `R$ 0,00` printed twenty rows deep is twenty fabricated prices.
 */
const CURRENCY = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function moneyExact(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  const amount = Number(value)
  if (notAPrice(amount)) return null
  // Intl uses a non-breaking space after "R$"; the tests and the DOM both read
  // better with an ordinary one, and the figure is `tabular-nums` either way.
  return CURRENCY.format(amount).replace(/ /g, ' ')
}

/**
 * `400`, `1,5`, `12.000` — a quantity as the agency declared it.
 *
 * `numeric(…)` comes off the wire as `400.0`, and "400,0 Hora" is noise. Up to
 * four decimals are kept because agencies really do publish fractional
 * quantities (metres, tonnes); trailing zeros are not.
 */
const QUANTITY = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 })

export function quantity(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  const amount = Number(value)
  if (!Number.isFinite(amount)) return null
  return QUANTITY.format(amount)
}

export type AgeParts =
  | { unit: 'now'; count: 0 }
  | { unit: 'minutes' | 'hours' | 'days'; count: number }

/**
 * "atualizado há X" (§3.1), as a unit and a count rather than a sentence, so
 * the plural is chosen by the pt-BR catalogue and not by this file.
 *
 * Under a minute is "agora mesmo": a freshness line that ticks 1, 2, 3 seconds
 * is noise, and the sweep it describes runs every thirty minutes.
 */
export function ageParts(seconds: number | null | undefined): AgeParts | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null
  const value = Math.max(0, Math.floor(seconds))
  if (value < 60) return { unit: 'now', count: 0 }
  if (value < 3600) return { unit: 'minutes', count: Math.floor(value / 60) }
  if (value < 86_400) return { unit: 'hours', count: Math.floor(value / 3600) }
  return { unit: 'days', count: Math.floor(value / 86_400) }
}

/** The four values `tenders.me_epp_summary` can hold (§6.1). */
export const ME_EPP_SUMMARIES = ['exclusive', 'quota', 'mixed', 'none'] as const
export type MeEppSummary = (typeof ME_EPP_SUMMARIES)[number]

/** Narrows the wire's `string | null` to a key the catalogue has a tag for. */
export function meEppSummary(value: string | null | undefined): MeEppSummary | null {
  return ME_EPP_SUMMARIES.includes(value as MeEppSummary) ? (value as MeEppSummary) : null
}

/** `Prefeitura de Campinas/SP · Pregão eletrônico`, skipping what is missing. */
export function agencyLine(parts: {
  agencyName?: string | null
  city?: string | null
  state?: string | null
  modalityName?: string | null
}): string {
  const place = [parts.city, parts.state].filter(Boolean).join('/')
  const who = [parts.agencyName, place || null].filter(Boolean).join(' · ')
  return [who || null, parts.modalityName].filter(Boolean).join(' · ')
}

/**
 * PNCP objects are one long shouted paragraph — the seed holds a 340-character
 * one in block capitals. The card gives the title two lines, so it is trimmed
 * here rather than clipped with `line-clamp`, which would hide the fact that
 * there is more and leave the full string in the accessibility tree anyway.
 */
export function trimObject(object: string, max = 120): string {
  const clean = object.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[.,;:·-]+$/, '')}…`
}

/* ------------------------------------------------------------------ titles */

/**
 * PNCP objects arrive with the sourcing portal bolted on the front, in block
 * capitals, and with a full stop at the end:
 *
 *   `[Portal de Compras Públicas] - Aquisição de drones.`
 *   `AQUISIÇÃO DE EQUIPAMENTOS DESTINADOS À SECRETARIA DE SAÚDE.`
 *
 * Next to the Landing's clean example the real list reads like a different
 * product. This is **presentation only**: the database keeps what PNCP
 * published, because it is the string the edital itself carries and the one a
 * screening cites. Nothing here writes, and nothing here is fed back to the
 * API — `tenderTitle()` is called at the point of render and nowhere else.
 */

/** `[Portal de Compras Públicas] - ` and any separator behind it. */
const PORTAL_PREFIX = /^\s*\[[^\]]*\]\s*[-–—:·]*\s*/

/** A full stop the agency typed at the end of a title that is not a sentence. */
const TRAILING_STOP = /[.\s]+$/

/**
 * Words that stay lowercase when a shouted title is brought back to sentence
 * case. Portuguese connectives only — they are the short tokens that would
 * otherwise be mistaken for acronyms by the length rule below.
 */
const LOWERCASE_WORDS = new Set([
  'a', 'ao', 'aos', 'as', 'às', 'à', 'com', 'como', 'da', 'das', 'de', 'do',
  'dos', 'e', 'em', 'entre', 'na', 'nas', 'no', 'nos', 'o', 'os', 'ou', 'para',
  'pela', 'pelas', 'pelo', 'pelos', 'por', 'sem', 'sob', 'sobre', 'um', 'uma',
])

/**
 * Acronyms that must survive the lowercasing, because they are read as letters
 * and not as words. Deliberately short and domain-specific: this list only has
 * to cover what turns up in a tender object, and a missed one costs a lowercase
 * word, not a wrong fact.
 */
const ACRONYMS = new Set([
  'ABNT', 'ANVISA', 'CNPJ', 'CNAE', 'CRAS', 'CREAS', 'EIRELI', 'EPI', 'EPIS',
  'EPP', 'INMETRO', 'LED', 'LTDA', 'ME', 'MEI', 'PNAE', 'PNCP', 'SAMU', 'SEBRAE',
  'SENAC', 'SENAI', 'SESC', 'SESI', 'SIASG', 'SRP', 'SUS', 'TI', 'UASG', 'UBS',
  'UPA', 'UTI',
])

/**
 * De-shouting is decided **per word**, not for the title as a whole.
 *
 * The obvious rule — "if the string has no lowercase letter, lowercase it" —
 * fails on the commonest real shape. Agencies shout the object and then paste
 * the legal basis in prose after it:
 *
 *   `AQUISICAO DE MATERIAIS TERAPEUTICOS PARA AS UNIDADES DO NUCLEO … por meio
 *    de Dispensa Eletronica de Licitacao com fundamento no art. 75 …`
 *
 * One lowercase letter three hundred characters in made the whole title "not
 * shouting", so nothing was cased — and the card, which shows the first 120
 * characters, displayed the shouted half untouched. Judging each word instead
 * fixes that and leaves the prose half alone, because its words are not in
 * block capitals to begin with.
 *
 * ## What this cannot do
 *
 * Nothing distinguishes `NUCLEO` (a shouted word) from `NIDI` (an acronym)
 * without a dictionary, so a four-letter acronym outside `ACRONYMS` below is
 * lowercased. That is the accepted cost: these sources are unaccented anyway
 * (`AQUISICAO`, `ATENCAO`), so this was never restoration — it is stopping the
 * list from shouting. Add to `ACRONYMS` when a real one turns up.
 */
function isShoutedWord(letters: string): boolean {
  return letters.length > 0 && letters === letters.toLocaleUpperCase('pt-BR')
}

function deShout(text: string): string {
  return (
    text
      // Split on the slash as well as on whitespace, so "ME/EPP" is judged as
      // "ME" and "EPP" — two acronyms — and not as the 5-letter word "MEEPP".
      .split(/([\s/]+)/)
      .map((token) => {
        if (!token.trim()) return token
        const letters = token.replace(/[^\p{L}]/gu, '')
        if (!letters) return token
        // A code, not a word: "01/2026", "RSD-02011", "N°3".
        if (/\d/.test(token)) return token
        // Already prose — only block capitals are being undone here.
        if (!isShoutedWord(letters)) return token
        const lower = letters.toLocaleLowerCase('pt-BR')
        if (LOWERCASE_WORDS.has(lower)) return token.toLocaleLowerCase('pt-BR')
        if (ACRONYMS.has(letters)) return token
        // SUS, EPI, TI: too short to be a shouted Portuguese word worth fixing.
        if (letters.length <= 3) return token
        return token.toLocaleLowerCase('pt-BR')
      })
      .join('')
  )
}

/** The portal prefix, the shouting and the trailing full stop, all removed. */
export function cleanTitle(object: string): string {
  const clean = object.replace(/\s+/g, ' ').trim().replace(PORTAL_PREFIX, '')
  const stopped = clean.replace(TRAILING_STOP, '')
  const body = stopped || clean
  const cased = deShout(body)

  // Restore the opening capital only if the source had one — a title that
  // deliberately starts lowercase ("iPhone…") is left exactly as it came.
  if (!/^[^\p{L}]*\p{Lu}/u.test(body)) return cased
  return cased.replace(/\p{L}/u, (first) => first.toLocaleUpperCase('pt-BR'))
}

/** What a screen prints as a tender's title: cleaned, then trimmed to fit. */
export function tenderTitle(object: string, max = 120): string {
  return trimObject(cleanTitle(object), max)
}
