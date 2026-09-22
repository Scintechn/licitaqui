/**
 * PNCP's own address for a tender, derived from the id we already store.
 *
 * ## Our id *is* PNCP's id
 *
 * `tenders.id` is the `numeroControlePNCP` verbatim — the string PNCP prints
 * on the edital page as **"Id contratação PNCP"**. Nothing is transformed on
 * the way in (`worker/licitaqui/tenders.py`, `from_consulta`), so the value the
 * detail screen shows is byte-for-byte the value a user will find on the
 * portal. That is the whole point: a person can read one screen and check it
 * against the other without translating anything.
 *
 * ## …but the URL is not the id
 *
 * The id is `{cnpj}-{instrumento}-{sequencial}/{ano}`; the portal's address is
 *
 *     https://pncp.gov.br/app/editais/{cnpj}/{ano}/{sequencial}
 *
 * — the three fields **reordered**, the instrument code dropped, and the
 * sequence's **leading zeros stripped**:
 *
 *     87612826000190-1-000958/2026  →  .../87612826000190/2026/958
 *
 * The zero-stripping is not a guess. PNCP writes the same triple into the file
 * URLs it hands us, and those are stored verbatim in `tender_files.url`:
 * `https://pncp.gov.br/pncp-api/v1/orgaos/09034960000147/compras/2026/102/arquivos/1`
 * for a tender whose id is `09034960000147-1-000102/2026`. Every file URL in
 * production agrees, across all three modalities we hold.
 *
 * ## Why this parses instead of formatting
 *
 * The worker has `split_control_number`; the web app had nothing, so this is
 * the web's one parser and every caller goes through it. It answers `null`
 * rather than throwing or guessing, because the only caller is a screen and a
 * screen's correct behaviour for an id it cannot read is to show no link at
 * all. A half-parsed id would ship a 404 on the portal with our name on it,
 * which is worse than no link on a page whose whole purpose is trust.
 */

/** `{14 digits}-{digits}-{digits}/{4 digits}`, anchored, nothing else allowed. */
const CONTROL_NUMBER = /^(\d{14})-(\d+)-(\d+)\/(\d{4})$/

/** PNCP publishes from 2021; the bound is loose on purpose, it only rejects junk. */
const FIRST_YEAR = 2000
const LAST_YEAR = 2100

export type PncpTenderId = {
  /** The agency's CNPJ, 14 digits, unpunctuated — as the id and the URL carry it. */
  cnpj: string
  /** The instrument code (`1` for a contratação). Parsed, then unused by the URL. */
  instrument: number
  /** Leading zeros gone: PNCP's URLs say `958`, never `000958`. */
  sequence: number
  year: number
}

/**
 * `87612826000190-1-000958/2026` → its four fields, or `null` when the string
 * is not a `numeroControlePNCP`.
 */
export function parsePncpId(id: string | null | undefined): PncpTenderId | null {
  if (typeof id !== 'string') return null
  const match = CONTROL_NUMBER.exec(id.trim())
  if (!match) return null

  const [, cnpj, instrument, sequence, year] = match
  const parsed = {
    cnpj,
    instrument: Number(instrument),
    sequence: Number(sequence),
    year: Number(year),
  }

  // `\d+` will happily match forty digits; past 2^53 the arithmetic stops being
  // exact and the URL would name a different tender than the id does.
  if (!Number.isSafeInteger(parsed.sequence) || !Number.isSafeInteger(parsed.instrument)) {
    return null
  }
  // `000000/2026` and `…/0000` are syntactically fine and identify nothing.
  if (parsed.sequence <= 0) return null
  if (parsed.year < FIRST_YEAR || parsed.year > LAST_YEAR) return null

  return parsed
}

export const PNCP_EDITAL_BASE = 'https://pncp.gov.br/app/editais'

/**
 * The official PNCP page for a tender, or `null` when the id cannot be read —
 * the caller renders nothing rather than a link that would 404.
 */
export function pncpEditalUrl(id: string | null | undefined): string | null {
  const parsed = parsePncpId(id)
  if (!parsed) return null
  return `${PNCP_EDITAL_BASE}/${parsed.cnpj}/${parsed.year}/${parsed.sequence}`
}
