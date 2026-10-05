import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compraIdLabel, parseCompraId } from './compra'
import { pncpEditalUrl, parsePncpId } from './pncp'

/** `db/seed/fixtures/pncp` relative to this file, which sits in `apps/web/lib/radar`. */
const FIXTURE_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'db', 'seed', 'fixtures', 'pncp')

/**
 * The purchase id out of a `linkSistemaOrigem`, in **either** spelling PNCP
 * publishes it in, or `undefined`.
 *
 * Extracted so the pattern can be tested directly. It has to be: no repo
 * fixture uses the `&compra=` form today, so a regression here would leave
 * `fixturePurchases()` silently returning fewer records while
 * `fixtures.length >= 6` stayed green — which is precisely how the single
 * spelling went unnoticed long enough to put three wrong claims into the docs.
 */
export function compraFromLink(link: string): string | undefined {
  return /acompanhamento-compra[?&]compra=(\d+)/.exec(link)?.[1]
}

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
    // **`[?&]`, not `?`.** PNCP publishes this link in two spellings —
    // `…/public/compras/acompanhamento-compra?compra=<id>` and
    // `…/public/landing?destino=acompanhamento-compra&compra=<id>` — and an
    // earlier pass of this card matched only the first. That found 27 of 31
    // records, declared two real ids fabricated and deleted a true example.
    // No repo fixture uses the second form today, so this costs nothing now and
    // is the whole point: `fixtures.length >= 6` would stay green while an
    // `&compra=` fixture was silently skipped.
    const compra = compraFromLink(link)
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
   * under test and the assertion holds even if the rule is wrong. A literal
   * table also cannot tell you whether the id it pins was ever real.
   *
   * **This card proved both halves the hard way.** A first pass pinned four
   * literal ids as measured; a review could not find `98621905983652025` and
   * reported it fabricated; the "correction" then deleted it, deleted a true
   * leading-zero example (`081102`), and wrote the wrong population into four
   * documents. All of it came from one grep for `acompanhamento-compra?compra=`
   * — **PNCP publishes a second spelling, `…&compra=`, and those four records
   * were invisible to it.** Both ids are real. The population is 31.
   * `memory: empty-result-is-not-absence`, twice, in the card about §4d.
   *
   * So this reads `db/seed/fixtures/pncp/*.json`, takes the `compra=` parameter
   * out of PNCP's own `linkSistemaOrigem`, and compares each segment to a
   * **sibling field of the same record** — `unidadeOrgao.codigoUnidade`,
   * `numeroCompra`, `anoCompra`. Those fields are not derived from the id, so
   * agreement is evidence.
   *
   * Six records are in this repository and CI can see them. The full measured
   * set is **31** — all 31 live in the read-only knowledge base
   * (`~/Documents/POC Licitacao/cache_pncp/`), of which the repo's six are a
   * strict subset, and all 31 fit. That number is stated in `compra.ts` and
   * cannot be re-derived here, which is exactly why the six that *can* be are
   * asserted rather than described.
   */
  /**
   * **The blind spot that cost three documents their accuracy**, pinned.
   * Measured across the 31 records: 27 use `?compra=`, 4 use the `landing`
   * route with `&compra=`. A pattern matching only the first finds 27.
   */
  it.each([
    [
      'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=12001605008432026',
      '12001605008432026',
    ],
    [
      'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=acompanhamento-compra&compra=98621905983652025',
      '98621905983652025',
    ],
  ])('reads the purchase id out of both spellings PNCP publishes', (link, expected) => {
    expect(compraFromLink(link)).toBe(expected)
  })

  it('reads nothing out of a link that names no purchase', () => {
    expect(compraFromLink('https://previjop.mg.gov.br/')).toBeUndefined()
  })

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
   * cannot put back what JSON dropped. **`070018`, `081102`, `092201` and
   * `092301` are real leading-zero UASGs in the 31 measured records**, so this
   * is reachable rather than hypothetical.
   *
   * `08110203901202026` is a real purchase id (`60509015000101_2026_162.json`).
   * It was briefly deleted from this file as unmeasured, which it never was —
   * it is one of the four records the single-spelling grep could not see.
   */
  it.each([
    ['8110203901202026', '08110203901202026', '081102', '03', '90120', 2026],
    ['7001805001072026', '07001805001072026', '070018', '05', '00107', 2026],
  ])('restores %s, a UASG whose code begins with a zero', (short, id, uasg, modality, number, year) => {
    expect(short).toHaveLength(16)
    expect(parseCompraId(short)).toEqual({ id, uasg, modality, number, year })
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
      // **Idempotence, which can actually fail** — unlike concatenating the
      // four segments back together, which holds for any implementation that
      // slices contiguous ranges of `id` and is therefore no assertion at all.
      // Re-parsing the normalised id must give the same answer: that is the
      // property every caller relies on, since the screen prints `parsed.id`
      // and the reader may well paste it back to us in a support thread.
      expect(parseCompraId(parsed.id), `${value} is not a fixed point`).toEqual(parsed)
    }
  })

  it('refuses an all-zero UASG, which is what a 0 pads up into', () => {
    expect(parseCompraId('0')).toBeNull()
    expect(parseCompraId('00000006001072026')).toBeNull()
  })

  /**
   * **The guard that was here is gone, and the measurement is why.**
   *
   * A `number === '00000'` refusal sat here for one commit, justified by
   * `'100000002026'` padding up into `00000100000002026`. That case is
   * **unreachable** — 12 digits are refused by the length floor — and **0 of
   * the 31 real ids have an all-zero number**, so the constraint had no
   * evidence in either direction and could only cost a reader a citation that
   * was correct. §4d: check a threshold is one before pinning it. It is also
   * what forced this file's sibling fixture helper to start counting at 1.
   *
   * What remains is the measured fact it was confused with: a *high* number is
   * ordinary. `90000` is real — `92930605900002025`, measured 2026-10-03
   * against the live API: purchase, item 59, two suppliers at R$ 5,10 and
   * R$ 5,00, a cadastro de reserva (which is why `(idCompra, numeroItemCompra)`
   * is not unique upstream).
   */
  it('accepts the full range of real purchase numbers, high and low', () => {
    expect(parseCompraId('92930605900002025')?.number).toBe('90000')
    expect(parseCompraId('92990906001072026')?.number).toBe('00107')
    // Short enough to have been padded, and still a real-shaped number.
    expect(parseCompraId('7001805001072026')?.number).toBe('00107')
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
