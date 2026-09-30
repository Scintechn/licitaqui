/**
 * Whether two PNCP item descriptions are the **same product**.
 *
 * ## Why this exists
 *
 * `comparables.ts` selects awarded items by segment, canonical unit and
 * trigram similarity, and `price-band.ts` then refuses a set whose prices are
 * incoherent. Measured on production, 2026-09-30, that is not enough, and the
 * reason is structural rather than a threshold being loose.
 *
 * PNCP writes a description as `<Produto> atributo: valor, atributo: valor…`.
 * Inside one segment and one unit, **the attribute scaffolding is most of the
 * string** — "material:", "comprimento:", "tipo:", "características…" — so
 * two entirely unrelated products score well against each other. The tender
 * `96291141000180-1-006394/2026`, item 37, is the case that found it:
 *
 *     subject   Perfurador Papel material: ferro fundido, tipo: mesa,
 *               capacidade perfuração: 100          (edital estimate R$ 168,78)
 *
 *     matched   9 × Caderno / Papel Higiênico / Bobina Papel Senha, R$ 4,85–16,80
 *               1 × Perfurador Papel tipo: pequeno,               R$ 10,35
 *               1 × PERFURADOR DE PAPEL … 100 FOLHAS,             R$ 204,00
 *
 * Nine of eleven were notebooks and toilet paper. The one genuinely equivalent
 * punch, at R$ 204,00, had the *lowest* similarity of the set and was outvoted.
 * The screen concluded: pay at most **R$ 9,35**.
 *
 * **The coherence gate cannot catch this, and no threshold on it can.**
 * Cadernos all cost R$ 9–15, so that sample's inter-quartile spread is tiny and
 * it passes `MAX_SPREAD` comfortably. The gate measures *precision*, not
 * accuracy: a tight cluster of the wrong product is exactly what it is built
 * to accept.
 *
 * Across 103 open items in `Gráfico / Escritório` and `Informática / TI` that
 * returned any comparables at all, the **median share of comparables that were
 * even the same product was 0%**, and 65 of 103 were under half.
 *
 * ## The rule
 *
 * Every significant word of the subject's **product head** — the words before
 * its first `atributo:` — must appear in the candidate's description. It is
 * deliberately directional: the candidate may be *more* specific than the
 * subject ("PERFURADOR DE PAPEL 02 FUROS … 100 FOLHAS" contains both words of
 * "Perfurador Papel"), never less. "Caderno … material: papel off-set" carries
 * `papel` and not `perfurador`, so it is refused.
 *
 * Plus a **grade** check, which is the second failure mode and costs as much.
 * Item 13 of the same tender is a *compatível* Lexmark toner whose comparables
 * were mostly *original* cartridges — including the identical reference at
 * R$ 525,80 — giving a band of R$ 256,95–294,49 against an estimate of
 * R$ 129,85. Same product, different grade, roughly double the price. When
 * both descriptions declare a grade and the grades differ, they are not
 * comparable.
 *
 * ## What this costs, said plainly
 *
 * Coverage, and most of what is left of it. Measured through the real query
 * over one sample of 400 open items across every segment: the items keeping
 * **any** comparable fall **62 → 14**, and the items showing a band are
 * **0 → 0** — bands are already rare enough that 400 items find none either
 * way, which is itself the finding. A 250-item sample of the two busiest
 * segments found 4 before and 0 after.
 *
 * Both items Sci found keep 2 comparables and show nothing; the audit's
 * `Papel Kraft` keeps none.
 *
 * That is the intended outcome — `radar.price.noData` ("Ainda sem dados de
 * vencedores para este item") is an honest answer and a wrong price on the
 * screen whose purpose is the bid is not — but it should be read as what it
 * is: **the band now almost never renders**, and **C3, a canonical product
 * key, is what this feature needs to exist at all** rather than to be good.
 */

/**
 * Words that carry no product identity and must not be required of a match.
 *
 * Requiring `de` would refuse "Perfurador Papel" against "PERFURADOR DE PAPEL"
 * in the one direction, and requiring it of everything would refuse nothing in
 * the other — either way it is noise in a rule that is about the noun.
 */
const STOPWORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'com', 'para', 'a', 'o', 'as', 'os', 'no', 'na',
])

/**
 * The last word of a PNCP attribute key, so it can be told from the product.
 *
 * **Measured, not guessed**: these are the tokens that most often sit
 * immediately before the first colon, over 60 000 random `tender_items` on
 * 2026-09-30. `material` alone is 5.4% of the corpus and `tipo` 3.8%.
 *
 * It is a long tail and this list does not close it — it does not need to.
 * Failing to strip a key costs a match (the head keeps one extra word and
 * refuses candidates that do not repeat it); it never admits a wrong product.
 * The first version relied on the key being lower-case, which is true of only
 * ~18% of the corpus: `PAPEL A4 COR: BRANCA` kept `cor` in the head and so
 * demanded the literal word "cor" of every comparable.
 */
const ATTRIBUTE_KEYS = new Set([
  'material', 'tipo', 'aplicacao', 'dosagem', 'concentracao', 'especificacao', 'especificacoes',
  'composicao', 'apresentacao', 'adicionais', 'adicional', 'modelo', 'fisico', 'minimas', 'minima',
  'referencia', 'altura', 'embalagem', 'capacidade', 'cor', 'tamanho', 'dimensoes', 'uso', 'corpo',
  'caracteristicas', 'estrutura', 'descricao', 'aproximadas', 'ativo', 'componentes', 'prima',
  'grau', 'ingredientes', 'comprimento', 'basica', 'catmat', 'cabo', 'fio', 'produto', 'largura',
  'gramatura', 'formato', 'quantidade', 'funcionamento', 'acabamento', 'espessura', 'peso',
  'volume', 'tensao', 'potencia', 'unidade', 'finalidade', 'conteudo', 'validade', 'classe',
])

/**
 * How many product words the head may carry.
 *
 * **This is the number that decides coverage, and the first version had no
 * such number.** It required *every* word before the first attribute key, and
 * measured over 60 000 items the median head is **7 words** and 60.3% are six
 * or more — because **65.7% of descriptions carry no `atributo:` at all** and
 * are free text an órgão typed. Requiring seven exact tokens is string
 * identity, so the gate refused almost everything for a reason that has
 * nothing to do with product identity.
 *
 * **Four, and the same four for free text.** A first draft gave free text
 * three, on the theory that its opening words are the product and the rest is
 * specification. Its own test said otherwise: `Cartucho toner impressora
 * lexmark` is free text, and three words stop at `impressora` — which is
 * exactly the HP cartridges back in. The brand is routinely the fourth word,
 * and the brand is what carries the identity here, so both shapes get four.
 */
const HEAD_WORDS = 4

/**
 * How many words of the **candidate's** name are read, which is more.
 *
 * Directional, and measurably worth it: a structured candidate's name ends at
 * its first `atributo:` whatever this number is, so the extra length only
 * reaches free text — where the órgão may have written "SUPRIMENTOS DE
 * INFORMÁTICA CARTUCHO TONER IMPRESSORA LEXMARK" and the product is not in the
 * first four words. Measured over 600 open items, raising it from 4 to 12 took
 * the items keeping any comparable from **18 to 24** and changed none of the
 * three known-bad cases, which still keep too few to price.
 */
const CANDIDATE_WORDS = 12

/**
 * Grades that change the price of the same product.
 *
 * Only spellings seen in the corpus, and only ones that are price-determining:
 * a compatible cartridge and an original cartridge are the same object to
 * `similarity()` and a factor of two to a bidder.
 */
const GRADES: readonly (readonly [string, string])[] = [
  ['original', 'original'],
  ['compativel', 'compativel'],
  ['remanufaturado', 'remanufaturado'],
  ['recondicionado', 'recondicionado'],
  ['generico', 'compativel'],
]

/**
 * The phrases where a grade word is **not** a grade.
 *
 * Measured over 60 000 items: the first version read a grade out of 1 492 of
 * them and was wrong in about two thirds.
 *
 *   **842** said `compatível` only as *"compatível com &lt;modelo&gt;"* — a
 *   photoelectric relay "compatible with mains", a TV bracket "compatible with
 *   23–75 inch televisions", a patch panel. Corpus-wide, **8 576** items
 *   contain "compatível com".
 *
 *   **116** said `original` inside *"embalagem original"* (1 130 items),
 *   *"original de fábrica"* (398) or *"caixa original"* (18) — a statement
 *   about the packaging, not the part.
 *
 * None of this can refuse a correct match **today**: the 0.3 trigram floor
 * already keeps only near-identical spellings, and over 570 trigram-passing
 * pairs from 400 open items, none was refused by the grade alone. It becomes
 * live exactly when C3 raises coverage, which is what C3 is now for.
 */
const NOT_A_GRADE = [
  /\bcompativel\s+com\b/,
  /\bembalagem\s+original\b/,
  /\bcaixa\s+original\b/,
  /\boriginal\s+de\s+fabrica\b/,
  /\bde\s+fabrica\s+original\b/,
]

/**
 * Lower-case, accent-fold, collapse whitespace, drop punctuation.
 *
 * Accent-folding here and **not** in `unit.ts`, which says it avoids folding
 * because "stripping accents across the whole corpus would also merge
 * spellings this module has not looked at". That risk is about *units*, where
 * a wrong merge silently makes a price per litre comparable with a price per
 * unit. Here folding is the opposite: `higiênico` and `higienico` are one word
 * written twice, and refusing to see that only loses matches — the failure
 * mode is a missing band, not a wrong one.
 */
function fold(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The product words at the front of a description: everything before the first
 * `atributo:`, minus the attribute key's own leading words.
 *
 * PNCP's attribute keys are sometimes two words — "tipo cartucho: compatível"
 * — so the token before the colon is not the only one to drop. The rule is to
 * stop at the colon and then discard trailing tokens that are part of the key,
 * which are the lower-case ones when the string is mixed case. A description
 * with no colon at all (`Cartucho toner impressora lexmark`, and every
 * all-caps line an órgão typed by hand) has no scaffolding to strip, so the
 * whole of it is the head.
 */
export function productHead(description: string | null | undefined, cap = HEAD_WORDS): string[] {
  if (description == null) return []
  const colon = description.indexOf(':')
  const structured = colon !== -1
  const front = structured ? description.slice(0, colon) : description

  let words = fold(front)
    .split(' ')
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))

  // Drop the attribute key from the tail. Case-insensitive, because the key is
  // upper-case in 8.5% of the corpus and Capitalised in another 7.1%.
  if (structured) {
    while (words.length > 1 && ATTRIBUTE_KEYS.has(words[words.length - 1])) words.pop()
  }

  // `Cadeira Escritório Cadeira Escritório, Material Estrutura:` — the product
  // name written twice is a real and common shape, and the repeat carries no
  // extra identity.
  words = [...new Set(words)]

  return words.slice(0, cap)
}

/**
 * The declared grade, or `null` when the description does not say — **or says
 * both**.
 *
 * `null` for ambiguity rather than a first match. The corpus contains
 * *"GARRAFA DE TINTA … PRODUTO ORIGINAL OU COMPATÍVEL"*, and 63 items like it,
 * where an órgão is explicitly accepting either; the first version returned
 * `original` because that is the order the table happens to be written in, and
 * would then have refused every compatible cartridge for an item that welcomed
 * them.
 */
export function productGrade(description: string | null | undefined): string | null {
  if (description == null) return null
  let text = ` ${fold(description)} `
  // Remove the phrases where the word is about something else, before looking
  // for the word at all.
  for (const phrase of NOT_A_GRADE) text = text.replace(new RegExp(phrase, 'g'), ' ')

  const found = new Set<string>()
  for (const [spelling, grade] of GRADES) if (text.includes(` ${spelling} `)) found.add(grade)
  return found.size === 1 ? [...found][0] : null
}

/**
 * Whether an awarded item may price this one.
 *
 * Both sides are read as a **product name**, and the subject's words must all
 * appear in the candidate's. Comparing the subject's head against the whole of
 * the candidate's description looks equivalent and is not: the real
 * comparables for `Papel Kraft material: celulose vegetal…` include
 *
 *     Fita Adesiva Embalagem material: **papel kraft**, comprimento: 45…
 *
 * which carries both head words inside an *attribute value*. It is adhesive
 * tape made of kraft paper, and under the looser rule it priced kraft paper.
 * A product name is the only part of the string that names the product.
 *
 * `false` whenever the subject has no usable head: a description we cannot
 * read the product out of must not fall through to "compare with everything",
 * which is the behaviour this module exists to stop.
 */
export function sameProduct(
  subject: string | null | undefined,
  candidate: string | null | undefined,
): boolean {
  const head = productHead(subject)
  if (head.length === 0) return false

  const theirs = new Set(productHead(candidate, CANDIDATE_WORDS))
  if (theirs.size === 0) return false
  if (!head.every((word) => theirs.has(word))) return false

  const a = productGrade(subject)
  const b = productGrade(candidate)
  // A grade only decides when both sides declare one; most descriptions say
  // nothing, and refusing those would cost coverage for no gain in accuracy.
  return a === null || b === null || a === b
}
