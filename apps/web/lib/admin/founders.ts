import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import { toCsv, type CsvColumn } from './csv'

/**
 * The founders list, for the one person allowed to read it.
 *
 * `founders_list` holds names, e-mail addresses, WhatsApp numbers and CNPJs
 * (spec §6.3) — personal data under the LGPD (§12). The rules this module
 * follows, and the reason each function looks the way it does:
 *
 *  - **never logged.** Nothing here prints a row, a column or a count of a
 *    filtered query. A failure is handled by the caller, which logs a code.
 *  - **never in a URL.** The export is a `POST`, so no e-mail address can end
 *    up in a browser history, a proxy log or a Vercel access log. That is also
 *    why the table is not filterable by e-mail from the query string.
 *  - **never cached.** The page and the export send `private, no-store`
 *    (§3.3, `ADMIN_HEADERS`).
 *  - **read-only.** `/admin` cannot edit or delete a founder; an LGPD erasure
 *    request is handled by hand (§12), against the database.
 */

export type FounderRow = {
  id: number
  name: string
  email: string
  whatsapp: string | null
  cnpj: string | null
  sells: string | null
  source: string | null
  seat: number | null
  contactConsent: boolean
  createdAt: Date
}

/**
 * The newest first, because the page's job is "did the signups arrive?".
 *
 * 500 is not pagination; it is a ceiling that keeps one accidental `/admin`
 * load from streaming the whole list into a phone. The Phase 0 gate is 150
 * founders and the page says so when it is capped.
 */
export const FOUNDERS_PAGE_LIMIT = 500

type Raw = {
  id: string | number
  name: string
  email: string
  whatsapp: string | null
  cnpj: string | null
  sells: string | null
  source: string | null
  seat: number | null
  contact_consent: boolean
  created_at: Date | string
}

function toRow(raw: Raw): FounderRow {
  return {
    id: Number(raw.id),
    name: raw.name,
    email: raw.email,
    whatsapp: raw.whatsapp,
    cnpj: raw.cnpj,
    sells: raw.sells,
    source: raw.source,
    seat: raw.seat === null ? null : Number(raw.seat),
    contactConsent: raw.contact_consent,
    createdAt: raw.created_at instanceof Date ? raw.created_at : new Date(raw.created_at),
  }
}

export async function listFounders(
  limit = FOUNDERS_PAGE_LIMIT,
  database: Executor = db(),
): Promise<FounderRow[]> {
  const { rows } = await database.execute<Raw>(sql`
    select id, name, email, whatsapp, cnpj, sells, source, seat, contact_consent, created_at
      from founders_list
     order by created_at desc, id desc
     limit ${limit}
  `)
  return rows.map(toRow)
}

/** Every founder, for the export. The CSV is the one place that gets the lot. */
export async function listAllFounders(database: Executor = db()): Promise<FounderRow[]> {
  const { rows } = await database.execute<Raw>(sql`
    select id, name, email, whatsapp, cnpj, sells, source, seat, contact_consent, created_at
      from founders_list
     order by seat asc nulls last, created_at asc, id asc
  `)
  return rows.map(toRow)
}

export async function countFounders(database: Executor = db()): Promise<number> {
  const { rows } = await database.execute<{ count: string }>(
    sql`select count(*)::text as count from founders_list`,
  )
  return Number(rows[0]?.count ?? 0)
}

/** `12345678000190` → `12.345.678/0001-90`. Returns the input if it is not 14 digits. */
export function formatCnpj(cnpj: string | null): string | null {
  if (!cnpj) return null
  const digits = cnpj.replace(/\D+/g, '')
  if (digits.length !== 14) return cnpj
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`
}

/** `+5511999998888` → `+55 (11) 99999-8888`. Returns the input if it is not E.164 BR. */
export function formatWhatsapp(whatsapp: string | null): string | null {
  if (!whatsapp) return null
  const digits = whatsapp.replace(/\D+/g, '')
  if (!digits.startsWith('55') || (digits.length !== 12 && digits.length !== 13)) return whatsapp
  const area = digits.slice(2, 4)
  const subscriber = digits.slice(4)
  const half = subscriber.length - 4
  return `+55 (${area}) ${subscriber.slice(0, half)}-${subscriber.slice(half)}`
}

/** ISO 8601 with the offset, so a spreadsheet cannot silently reinterpret it. */
function isoDate(value: Date): string {
  return value.toISOString()
}

/**
 * The export's columns.
 *
 * Numbers and CNPJs go out **unformatted** — digits only, as stored — because
 * this file is read by a program as often as by a person, and `formatCnpj()`'s
 * dots are the sort of thing a mail-merge chokes on. The screen is where the
 * formatting lives.
 */
export const FOUNDER_CSV_COLUMNS: readonly CsvColumn<FounderRow>[] = [
  { header: 'id', value: (row) => row.id },
  { header: 'vaga', value: (row) => row.seat },
  { header: 'nome', value: (row) => row.name },
  { header: 'email', value: (row) => row.email },
  { header: 'whatsapp', value: (row) => row.whatsapp },
  { header: 'cnpj', value: (row) => row.cnpj },
  { header: 'o_que_vende', value: (row) => row.sells },
  { header: 'origem', value: (row) => row.source },
  { header: 'consentimento_contato', value: (row) => (row.contactConsent ? 'sim' : 'nao') },
  { header: 'criado_em', value: (row) => isoDate(row.createdAt) },
]

export function foundersCsv(rows: readonly FounderRow[]): string {
  return toCsv(FOUNDER_CSV_COLUMNS, rows)
}
