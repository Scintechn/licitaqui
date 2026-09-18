/**
 * CSV for the `/admin` exports.
 *
 * ## Why every field is quoted
 *
 * The founders list is free text typed by strangers: a company called
 * `Silva, Souza & Cia`, a "what do you sell" of `cadeiras 12" e 14"`, a name
 * with a line break pasted out of a form. Deciding per value whether it needs
 * quoting is where CSV writers go wrong, so this one quotes everything and
 * doubles every `"` (RFC 4180). A comma, a semicolon, a quote or a newline in a
 * value can then only ever be data.
 *
 * ## Why `;` and not `,`
 *
 * The one reader is Sci, on Excel in pt-BR, where the list separator is `;` —
 * a comma-separated file lands in a single column there. Google Sheets detects
 * the separator, so `;` works in both. Values are fully quoted either way, so
 * the choice is about which program opens it, never about correctness.
 *
 * ## Spreadsheet formula injection
 *
 * A value starting with `=`, `@`, a tab or a carriage return is a formula to
 * Excel and to Sheets, and `=HYPERLINK(…)` in a "what do you sell" field is a
 * real way to attack the person who opens the export. Those get a leading
 * apostrophe, which spreadsheets eat on display.
 *
 * `+` and `-` are on the usual OWASP list too, and are deliberately **not**
 * treated the same: every WhatsApp number in this database starts `+55`
 * (`lib/founders/input.ts` stores E.164), so blanket-prefixing would corrupt a
 * whole column to defend against a formula that cannot start with a digit. A
 * value starting with `+` or `-` is only escaped when what follows is not a
 * plain number — i.e. when it contains a letter or an opening parenthesis.
 */

/** The delimiter, in one place. See the note above before changing it. */
export const DELIMITER = ';'

/** CRLF: RFC 4180, and the only line ending Excel never argues with. */
export const LINE_ENDING = '\r\n'

/**
 * Byte-order mark. Without it Excel reads a UTF-8 export as Latin-1 and every
 * "licitação" becomes "licitaÃ§Ã£o".
 */
export const BOM = '﻿'

export type CsvColumn<Row> = {
  /** The header cell. */
  header: string
  /** The value for one row. `null`/`undefined` become an empty cell. */
  value: (row: Row) => string | number | null | undefined
}

const FORMULA_START = /^[=@\t\r]/
const SIGNED = /^[+-]/
const LOOKS_LIKE_A_FORMULA = /[A-Za-z(]/

function neutralise(value: string): string {
  if (FORMULA_START.test(value)) return `'${value}`
  if (SIGNED.test(value) && LOOKS_LIKE_A_FORMULA.test(value)) return `'${value}`
  return value
}

/** One field: neutralised, quoted, inner quotes doubled. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""'
  const text = neutralise(String(value))
  return `"${text.replaceAll('"', '""')}"`
}

/** A complete file: BOM, header row, one row per record, trailing CRLF. */
export function toCsv<Row>(columns: readonly CsvColumn<Row>[], rows: readonly Row[]): string {
  const lines = [columns.map((column) => csvField(column.header)).join(DELIMITER)]
  for (const row of rows) {
    lines.push(columns.map((column) => csvField(column.value(row))).join(DELIMITER))
  }
  return BOM + lines.join(LINE_ENDING) + LINE_ENDING
}

/**
 * `licitaqui-fundadores-2026-09-18.csv`. Date only — the file is downloaded by
 * hand, so a minute-precise name would just make two exports look different.
 */
export function csvFilename(prefix: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  return `licitaqui-${prefix}-${date}.csv`
}

/** `Content-Type` for a downloaded CSV, with the charset the BOM promises. */
export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8'
