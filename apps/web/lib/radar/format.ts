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
 * `R$ 48.196`, `R$ 1,25 mi`, `R$ 272,6 bi`.
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
  if (!Number.isFinite(amount)) return null
  if (Math.abs(amount) >= 1e9) return `R$ ${SCALED.format(amount / 1e9)} bi`
  if (Math.abs(amount) >= 1e6) return `R$ ${SCALED.format(amount / 1e6)} mi`
  return `R$ ${INTEGER.format(amount)}`
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
