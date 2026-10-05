/**
 * The Compras.gov.br purchase identifier a price sample came from (D37).
 *
 * ## What `id_compra` is
 *
 * Since B35 the price band and its evidence come from the Compras.gov.br
 * catalogue, not from our `awards` table, and {@link PriceSample.tenderId}
 * carries `catalog_prices.id_compra` — the price API's `idCompra`. It is **not**
 * a PNCP `numeroControlePNCP` and must never be handed to `pncpEditalUrl`:
 * that parser requires `{14 digits}-{digits}-{digits}/{4 digits}` and answers
 * `null` for bare digits, which is the behaviour a test in this module pins.
 *
 * It is a fixed-width **17-digit** SIASG purchase key:
 *
 *     codigoUasg(6) ‖ modalidade SIASG(2) ‖ numero(5, zero-padded) ‖ ano(4)
 *     92990906001072026  →  929909 · 06 · 00107 · 2026
 *
 * **[M] That decomposition is measured, not assumed — and the measurement is
 * reproducible.** 27 real purchase ids carry a `linkSistemaOrigem` of the form
 * `…?compra=<17 digits>` in cached PNCP payloads; each was decomposed against
 * the *sibling* fields of its own record — `unidadeOrgao.codigoUnidade`,
 * `numeroCompra`, `anoCompra` — and **all 27 fit, with no exceptions**. Every
 * one is exactly 17 characters.
 *
 * **6 of the 27 are in this repository** (`db/seed/fixtures/pncp/*.json`) and
 * the other 21 are in the read-only knowledge base (`~/Documents/POC
 * Licitacao/cache_pncp/`), which CI cannot see. So `compra.test.ts` re-derives
 * the rule from **the six, at test time**, reading the fixtures and comparing
 * each segment to its sibling field — a cross-check rather than a restatement
 * of the offsets this file already applies.
 *
 * The one real price-API row we hold agrees from the other direction:
 * `worker/tests/test_catalog_prices.py`'s `RAW_ROW` carries
 * `idCompra = 92990906001072026` beside its own `codigoUasg = "929909"` — the
 * first six digits, in the same dict.
 *
 * ## Why this pads instead of trusting the stored string
 *
 * **[M] The API sends `idCompra` as a JSON *number*, not a string.** `RAW_ROW`
 * records it as `92990906001072026` — an integer literal, measured against the
 * live API on 2026-10-03 — and `parse_rows` stores `str(id_compra)`. So for any
 * UASG whose code begins with a zero the leading zero is gone *before the
 * worker ever sees it*: JSON has no way to carry it. **[M] Such UASGs are real
 * and are in the measured set — `070018`, `092201` and `092301` all appear** —
 * so a 16-digit `id_compra` is reachable in storage, and printing it verbatim
 * would hand the reader an identifier that matches nothing.
 *
 * Left-padding restores the key, because the key is fixed-width: the four
 * segments have fixed lengths and sum to 17.
 *
 * **It repairs exactly one lost zero and refuses anything shorter**, which is
 * the bound the evidence supports. One dropped zero is the documented loss, and
 * for a 16-digit value `padStart` is the exact inverse of `str(int(...))` and
 * cannot be wrong. Below that it would be inventing: no UASG beginning `00`
 * appears in the measured set, and a 13-digit junk value like `1234567892026`
 * would otherwise pad into `00001234567892026`, clear every remaining guard and
 * be printed as a **confident 17-digit citation matching nothing** — the one
 * outcome this module exists to prevent, and indistinguishable on screen from a
 * correct one. A short value loses its citation instead, which is the safe
 * failure.
 *
 * **The real fix is upstream**, in the ingest, so that the primary key itself is
 * not split between two spellings of the same purchase. That is **D41**; this
 * module is the read-side repair that makes the citation correct meanwhile.
 *
 * ## Why there is no URL here
 *
 * There is a URL template, and it is not ours: PNCP publishes
 * `…/comprasnet-web/public/compras/acompanhamento-compra?compra=<17 digits>`
 * as `linkSistemaOrigem`, and we already render it on the opportunity screen
 * from `tenders.bidding_system_url` — **stored verbatim as PNCP gave it**,
 * never constructed. Constructing one here would add two unverified steps:
 * that a price-API `idCompra` lives in the same namespace as that parameter
 * [I, supported by the shape above but never observed on one record], and that
 * the page resolves. **[M] The second could not be checked at all: opening that
 * URL in a real browser on 2026-10-05 returned a bot-detection CAPTCHA, not a
 * purchase.** A link whose destination we cannot see, on the one screen whose
 * purpose is letting a doubting reader verify us, is the failure `pncp.ts`
 * refuses in its own words — *"a 404 on the portal with our name on it … is
 * worse than no link on a page whose whole purpose is trust."*
 *
 * So the screen prints the identifier and lets the reader carry it. **D42** is
 * the card for the link, and it is blocked on evidence, not on effort.
 */

/** `codigoUasg(6) + modalidade(2) + numero(5) + ano(4)`. */
const COMPRA_ID_LENGTH = 17

const DIGITS_ONLY = /^\d+$/

/** Loose on purpose: it rejects junk, not unusual years. The same bound `pncp.ts` uses. */
const FIRST_YEAR = 2000
const LAST_YEAR = 2100

export type CompraId = {
  /** The full 17-digit key, left-padded — what the reader copies. */
  id: string
  /** The buying unit's SIASG code, 6 digits. */
  uasg: string
  /** The legacy SIASG modality code, 2 digits — `05` pregão, `06` dispensa, `03` concorrência [M, 27 records]. */
  modality: string
  /** The purchase's own number within that unit and year, 5 digits. */
  number: string
  year: number
}

/**
 * `92990906001072026` → its four fields, or `null` when the value is not a
 * purchase key.
 *
 * `null` is the ordinary answer for anything unexpected, and the caller renders
 * nothing — the same contract, and for the same reason, as
 * {@link parsePncpId}: a screen's correct behaviour for an identifier it cannot
 * read is to show no identifier at all, never a half-repaired one.
 */
export function parseCompraId(value: string | null | undefined): CompraId | null {
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  if (!DIGITS_ONLY.test(trimmed)) return null
  // Longer than the key cannot be a short-by-leading-zeros key, so it is not
  // something padding can rescue — it is a different thing, and refused.
  //
  // Shorter than one lost zero is refused for the stronger reason given above:
  // padding it would **invent** digits and print a citation that matches
  // nothing, which is worse than printing none.
  if (trimmed.length > COMPRA_ID_LENGTH) return null
  if (trimmed.length < COMPRA_ID_LENGTH - 1) return null

  const id = trimmed.padStart(COMPRA_ID_LENGTH, '0')

  const uasg = id.slice(0, 6)
  const modality = id.slice(6, 8)
  const number = id.slice(8, 13)
  const year = Number(id.slice(13))

  // `000000…` is syntactically a key and identifies nothing — `pncp.ts`'s
  // `sequence <= 0` guard, in the two places this key can degenerate. An
  // all-zero UASG is what a `0` or an empty value pads up into, and an
  // all-zero purchase number is the same degeneracy one segment along: a short
  // stored value like `100000002026` pads into a well-formed-looking
  // `00000100000002026` that names nothing. Found by sweeping the boundaries
  // rather than by reading.
  //
  // **`modality` is deliberately not constrained.** Only `03`, `05` and `06`
  // were observed across 32 records, and pinning a set from three observations
  // is the §4d mistake — a real modality outside it would be refused and the
  // reader would lose a citation that was correct.
  if (uasg === '000000') return null
  if (number === '00000') return null
  if (year < FIRST_YEAR || year > LAST_YEAR) return null

  return { id, uasg, modality, number, year }
}

/**
 * Just the printable identifier, or `null`.
 *
 * The screen needs only this; the decomposition is exported because it is the
 * evidence for the padding and a test asserts it segment by segment.
 */
export function compraIdLabel(value: string | null | undefined): string | null {
  return parseCompraId(value)?.id ?? null
}
