/**
 * One canonical form per unit of measure, so two items that are priced the
 * same way compare as the same way.
 *
 * ## Why this exists
 *
 * PNCP lets each órgão type its own unit. Measured 2026-09-28 across 430 978
 * items: **4 405 distinct spellings**, and the *unidade* family alone —
 * `Unidade`, `UNIDADE`, `UN`, `UND`, `unidade`, `UNID`, `Un`, `un`, `UNI`,
 * `UNIDADE (UN)`, `UN - UNIDADE` — is ~245 000 items, **57% of the corpus**,
 * matching none of each other on equality.
 *
 * E9's price band needs comparable awarded items, and comparing on the raw
 * string discards 93% of the candidates it could have had: segment-only gives
 * ~574 comparable pairs per item, segment + raw unit gives ~41. That is a
 * spelling problem being mistaken for a data-volume problem.
 *
 * ## The rule this follows, and the one it refuses
 *
 * **Only merge spellings that unambiguously name the same unit.** A band is a
 * price claim; merging `PC` into `PCT` because they look similar would quietly
 * compare the price of a *pacote* with the price of a *peça* and produce a
 * number that is wrong rather than absent — the one outcome E9's gate exists to
 * prevent. Ambiguous spellings are left alone: they simply fail to match, which
 * costs coverage and never costs correctness.
 *
 * So `PC` is **not** in the table below. It appears 1 779 times and means
 * *peça* in some órgãos and *pacote* in others, and nothing in the payload
 * says which.
 */

/**
 * Canonical code → every spelling that certainly means it.
 *
 * Derived from the measured frequency table, not invented: each entry below
 * was read off the corpus. Values are compared after upper-casing, trimming
 * and collapsing internal whitespace, so `un - unidade` and `UN - UNIDADE`
 * need only one entry.
 */
const SPELLINGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  UN: [
    'UNIDADE',
    'UN',
    'UND',
    'UNID',
    'UNI',
    'UNIDADE (UN)',
    'UN - UNIDADE',
    'UNIDADES',
    'UNIT',
  ],
  KG: ['QUILOGRAMA', 'KG', 'QUILO', 'QUILOS', 'KILOGRAMA'],
  G: ['GRAMA', 'GRAMAS', 'G'],
  L: ['LITRO', 'LITROS', 'L', 'LT'],
  ML: ['MILILITRO', 'MILILITROS', 'ML'],
  M: ['METRO', 'METROS', 'M'],
  M2: ['METRO QUADRADO', 'METROS QUADRADOS', 'M2', 'M²'],
  M3: ['METRO CUBICO', 'METRO CÚBICO', 'M3', 'M³'],
  CX: ['CAIXA', 'CAIXAS', 'CX'],
  PCT: ['PACOTE', 'PACOTES', 'PCT'],
  FRASCO: ['FRASCO', 'FRASCOS', 'FR'],
  COMPRIMIDO: ['COMPRIMIDO', 'COMPRIMIDOS', 'CP', 'COMP'],
  SERVICO: ['SERVICO', 'SERVIÇO', 'SERVICOS', 'SERVIÇOS', 'SERV'],
  PAR: ['PAR', 'PARES'],
  ROLO: ['ROLO', 'ROLOS', 'RL'],
  LATA: ['LATA', 'LATAS'],
  TUBO: ['TUBO', 'TUBOS'],
  GALAO: ['GALAO', 'GALÃO', 'GALOES', 'GALÕES', 'GL'],
})

/** Spelling (already normalised for case and space) → canonical code. */
const CANONICAL: ReadonlyMap<string, string> = new Map(
  Object.entries(SPELLINGS).flatMap(([code, spellings]) =>
    spellings.map((spelling) => [spelling, code] as const),
  ),
)

/**
 * Upper-case, trim, collapse runs of whitespace.
 *
 * Deliberately **not** accent-stripping: `SERVIÇO` and `SERVICO` are both
 * listed above by hand, because stripping accents across the whole corpus
 * would also merge spellings this module has not looked at.
 */
function squash(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, ' ')
}

/**
 * The canonical unit code, or the squashed spelling when it is not recognised.
 *
 * Falling back to the squashed spelling rather than `null` is what makes this
 * safe to use as a join key: an unrecognised unit still matches *itself* across
 * two items, so `KIT` compares with `kit` and simply never compares with
 * anything this table knows about. Returning `null` would silently make every
 * unrecognised item comparable with every other one.
 */
export function canonicalUnit(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const squashed = squash(raw)
  if (!squashed) return null
  return CANONICAL.get(squashed) ?? squashed
}

/** Every canonical code, for tests and for the SQL expression below. */
export const CANONICAL_UNITS: readonly string[] = Object.freeze(Object.keys(SPELLINGS))

/**
 * The same mapping as SQL, for the comparable-items query.
 *
 * Generated from the table above rather than written out, so the two cannot
 * disagree — the defect `search_vector` was created to stop, applied before it
 * happens rather than after.
 */
export function canonicalUnitSql(column: string): string {
  const squashed = `regexp_replace(upper(btrim(${column})), '\\s+', ' ', 'g')`
  const whens = [...CANONICAL.entries()]
    .map(([spelling, code]) => `when ${squashed} = ${quote(spelling)} then ${quote(code)}`)
    .join('\n       ')
  return `case\n       ${whens}\n       else ${squashed} end`
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
