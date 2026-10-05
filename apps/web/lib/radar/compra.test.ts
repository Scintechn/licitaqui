import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compraIdLabel, parseCompraId } from './compra'
import { pncpEditalUrl, parsePncpId } from './pncp'

/** `db/seed/fixtures/pncp` relative to this file, which sits in `apps/web/lib/radar`. */
const FIXTURE_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'db', 'seed', 'fixtures', 'pncp')

type FixturePurchase = { compra: string; uasg: string; numero: string; ano: number }

/**
 * Every PNCP fixture whose `det.linkSistemaOrigem` names a Compras.gov.br
 * purchase, paired with the sibling fields that identify the same purchase
 * independently of the id.
 */
function fixturePurchases(): FixturePurchase[] {
  const found: FixturePurchase[] = []
  for (const name of readdirSync(FIXTURE_DIR)) {
    if (!name.endsWith('.json')) continue
    const det = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))?.det
    const link: unknown = det?.linkSistemaOrigem
    if (typeof link !== 'string') continue
    const compra = /acompanhamento-compra\?compra=(\d+)/.exec(link)?.[1]
    if (compra === undefined) continue
    found.push({
      compra,
      uasg: String(det.unidadeOrgao.codigoUnidade),
      numero: String(det.numeroCompra),
      ano: Number(det.anoCompra),
    })
  }
  return found.sort((a, b) => a.compra.localeCompare(b.compra))
}

/**
 * D37 — the purchase identifier a price sample cites.
 *
 * **What this file can and cannot prove** (§4c). `environment: 'node'` runs
 * no effects and measures no boxes, so everything here is arithmetic over
 * strings: the decomposition, the zero-padding, and the refusals. That the
 * identifier *reaches a reader*, that the copy control *copies*, and that the
 * row is drawn correctly at a narrow container are all in
 * `e2e/journeys/price-evidence-ladder.spec.ts`.
 *
 * The real values below are measured, not invented, and each one's provenance
 * is named beside it — because the whole point of this card was refusing to
 * infer an identifier's shape from memory (§4d).
 */

/**
 * `worker/tests/test_catalog_prices.py`'s `RAW_ROW`, whose docstring records it
 * as the real shape measured against the live price API on 2026-10-03. It is
 * self-confirming: the same dict carries `codigoUasg = "929909"`, which is
 * exactly the first six digits.
 */
const REAL_PRICE_ROW_ID = '92990906001072026'

/**
 * Measured against the live API on 2026-10-03 and quoted in three places
 * (`worker/licitaqui/compras.py`, `test_catalog_prices.py`, `docs/STATUS.md`):
 * code 8751 page 1, purchase `92930605900002025` item 59, two suppliers, the
 * cadastro de reserva.
 */
const REAL_PRICE_ROW_ID_2 = '92930605900002025'

describe('parseCompraId · the measured decomposition', () => {
  it('splits the real price-API row into UASG, modalidade, número and ano', () => {
    expect(parseCompraId(REAL_PRICE_ROW_ID)).toEqual({
      id: '92990906001072026',
      uasg: '929909',
      modality: '06',
      number: '00107',
      year: 2026,
    })
  })

  it('splits the second real row the same way', () => {
    expect(parseCompraId(REAL_PRICE_ROW_ID_2)).toEqual({
      id: '92930605900002025',
      uasg: '929306',
      modality: '05',
      number: '90000',
      year: 2025,
    })
  })

  /**
   * **The real cross-check, and the reason it reads the fixtures instead of a
   * literal table.**
   *
   * A table of `['12001605008432026', '120016', '05', '00843', 2026]` is a
   * **tautology**: the expected segments are what you get by applying the same
   * 6/2/5/4 offsets the implementation applies, so both sides share the rule
   * under test and the assertion holds even if the rule is wrong — or if the id
   * was never real. That is not a hypothetical. The first version of this file
   * pinned four ids as measured and **one of them, `98621905983652025`, existed
   * in no file anywhere**; it was invented, and a review caught it. §4d, from
   * the inside.
   *
   * So this reads `db/seed/fixtures/pncp/*.json`, takes the `compra=` parameter
   * out of PNCP's own `linkSistemaOrigem`, and compares each segment to a
   * **sibling field of the same record** — `unidadeOrgao.codigoUnidade`,
   * `numeroCompra`, `anoCompra`. Those fields are not derived from the id, so
   * agreement is evidence.
   *
   * Six records are in this repository and CI can see them. The full measured
   * set is **27** — the other 21 live in the read-only knowledge base
   * (`~/Documents/POC Licitacao/cache_pncp/`), and all 27 fit. That number is
   * stated in `compra.ts` and cannot be re-derived here, which is exactly why
   * the six that *can* be are asserted rather than described.
   */
  const fixtures = fixturePurchases()

  it('finds the PNCP fixtures it is supposed to cross-check', () => {
    // Without this the loop below is vacuous on an empty array — a green test
    // that proves nothing, which is the shape this file already shipped once.
    expect(fixtures.length).toBeGreaterThanOrEqual(6)
  })

  it.each(fixtures)(
    'decomposes $compra to match its own record (uasg $uasg, nº $numero, ano $ano)',
    ({ compra, uasg, numero, ano }) => {
      const parsed = parseCompraId(compra)
      expect(parsed, `${compra} did not parse at all`).not.toBeNull()
      expect(parsed!.id).toBe(compra)
      expect(parsed!.uasg, 'UASG segment vs unidadeOrgao.codigoUnidade').toBe(uasg)
      expect(Number(parsed!.number), 'número segment vs numeroCompra').toBe(Number(numero))
      expect(parsed!.year, 'ano segment vs anoCompra').toBe(ano)
    },
  )
})

describe('parseCompraId · the leading zero JSON already lost', () => {
  /**
   * **The defect this padding exists for.** The API sends `idCompra` as a JSON
   * *number* — `RAW_ROW` records it as the integer `92990906001072026` — so a
   * UASG beginning with a zero arrives already short, and `str()` in the worker
   * cannot put back what JSON dropped. **`070018`, `092201` and `092301` are
   * real leading-zero UASGs in the 27 measured records**, so this is reachable
   * rather than hypothetical.
   */
  it('restores a UASG whose code begins with a zero', () => {
    const short = '7001805001072026' // 16 digits: 070018 · 05 · 00107 · 2026
    expect(short).toHaveLength(16)
    expect(parseCompraId(short)).toEqual({
      id: '07001805001072026',
      uasg: '070018',
      modality: '05',
      number: '00107',
      year: 2026,
    })
  })

  /**
   * **It repairs one lost zero and refuses to invent a second.** The earlier
   * version of this test asserted the opposite — that 15 digits pad up just as
   * readily — and that was the module's one way to produce a *wrong*
   * identifier rather than a refusal: `1234567892026` becomes
   * `00001234567892026`, clears the UASG, number and year guards, and prints as
   * a confident citation matching nothing. One dropped zero is the documented
   * loss and `padStart` is its exact inverse; below that there is no evidence,
   * and no UASG beginning `00` appears in the measured set.
   */
  it('refuses to invent a second zero', () => {
    expect(parseCompraId('110203901202026')).toBeNull() // 15 digits
    expect(parseCompraId('1234567892026')).toBeNull() // 13 digits of junk
  })

  it('leaves a full-width id untouched', () => {
    expect(compraIdLabel(REAL_PRICE_ROW_ID)).toBe(REAL_PRICE_ROW_ID)
  })
})

describe('parseCompraId · what it refuses', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['letters', '9299090600107202X'],
    ['punctuated', '929909-06-00107/2026'],
    ['a decimal', '92990906001072026.0'],
    ['longer than the key', '929909060010720261'],
    // **The worker hit this exact class and it cost a refusal path.**
    // `is_usable_price` once raised on `'²'`, where Python's `str.isdigit()` is
    // True and `int()` is not, and the fix was `isdecimal()`. JavaScript's `\d`
    // is ASCII-only without the `u` flag, so these are already refused — pinned
    // rather than assumed, because the day someone adds `u` for an unrelated
    // reason is the day that stops being true.
    ['Arabic-Indic digits', '٩٢٩٩٠٩٠٦٠٠١٠٧٢٠٢٦'],
    ['fullwidth digits', '０１２３４５６７８９０１２３４５６'],
    ['a superscript', '9299090600107202²'],
    ['exponential notation', '9.299090600107e16'],
  ])('refuses %s rather than repairing it', (_name, value) => {
    expect(parseCompraId(value)).toBeNull()
  })

  /**
   * **Found by mutation, not by reading.** Loosening `DIGITS_ONLY` to admit
   * `-` and `/` left the whole suite green, because the only punctuated case
   * here was a 20-character PNCP control number and the *length* check was
   * refusing it — so the character guard was protecting nothing any test could
   * see. A **short** punctuated string is where it earns its place:
   * `'12345-6/2026'` is 12 characters, pads to `0000012345-6/2026`, clears the
   * UASG and year checks, and would be handed to the reader as a purchase id
   * with a modality of `23` and a number of `45-6/`. That is the one outcome
   * this module must never have — not a refusal, a **wrong identifier**.
   */
  it.each(['12345-6/2026', '1-2/2026', '929909/06', '92990906-01072026'])(
    'refuses %s, which is short enough to survive the length check',
    (value) => {
      expect(parseCompraId(value)).toBeNull()
    },
  )

  it('never returns an id that is not exactly 17 digits', () => {
    // The invariant behind every caller: whatever comes back is printable and
    // pasteable. Asserted over everything above that parses at all.
    const candidates = [
      REAL_PRICE_ROW_ID,
      REAL_PRICE_ROW_ID_2,
      '8110203901202026',
      '110203901202026',
      '12345-6/2026',
      'not-an-id',
      '',
      '929909060010720261',
    ]
    for (const value of candidates) {
      const parsed = parseCompraId(value)
      if (parsed === null) continue
      expect(parsed.id, `${value} parsed to a malformed id`).toMatch(/^\d{17}$/)
      expect(parsed.uasg + parsed.modality + parsed.number + String(parsed.year)).toBe(parsed.id)
    }
  })

  it('refuses an all-zero UASG, which is what a 0 pads up into', () => {
    expect(parseCompraId('0')).toBeNull()
    expect(parseCompraId('00000006001072026')).toBeNull()
  })

  it('refuses an all-zero purchase number, the same degeneracy one segment along', () => {
    // Found by sweeping boundaries, not by reading: a short stored value like
    // `100000002026` pads into `00000100000002026`, which clears the UASG and
    // year checks and names nothing. `pncp.ts` refuses `sequence <= 0` for the
    // identical reason.
    expect(parseCompraId('00000100000002026')).toBeNull()
    expect(parseCompraId('100000002026')).toBeNull()
    // …but a high number is ordinary and must survive: `90000` and `98365` are
    // both real (`92930605900002025`, `98621905983652025`).
    expect(parseCompraId('92930605900002025')?.number).toBe('90000')
  })

  it.each(['92990906001071026', '92990906001079026'])(
    'refuses the implausible year in %s',
    (id) => {
      expect(parseCompraId(id)).toBeNull()
    },
  )

  it('trims, because a stored value may carry whitespace', () => {
    expect(compraIdLabel(`  ${REAL_PRICE_ROW_ID}  `)).toBe(REAL_PRICE_ROW_ID)
  })
})

describe('the two id spaces cannot be crossed silently', () => {
  /**
   * **The guard that matters most.** `PriceSample.tenderId` still carries the
   * *name* of a PNCP tender id while carrying a Compras.gov.br purchase key
   * (D44 is the rename), so the one thing that must never happen is a caller
   * handing this value to the PNCP URL builder and shipping a link to a tender
   * that does not exist. Asserted in both directions.
   */
  it('a purchase id is not a PNCP id, and builds no PNCP URL', () => {
    expect(parsePncpId(REAL_PRICE_ROW_ID)).toBeNull()
    expect(pncpEditalUrl(REAL_PRICE_ROW_ID)).toBeNull()
  })

  it('a PNCP control number is not a purchase id', () => {
    expect(parseCompraId('87612826000190-1-000958/2026')).toBeNull()
  })
})
