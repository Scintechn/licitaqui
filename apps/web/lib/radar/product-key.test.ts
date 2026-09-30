import { describe, expect, it } from 'vitest'
import { productGrade, productHead, sameProduct } from './product-key'

/**
 * The fixtures here are descriptions read from production on 2026-09-30 — the
 * comparables the band query actually returned for
 * `96291141000180-1-006394/2026` items 37 and 13, the two items Sci found, and
 * for `01181184000104-1-000003/2026` item 54, the `Papel Kraft` the audit
 * turned up. They are the sets that produced R$ 9,35 for a R$ 168 hole punch
 * and R$ 207,99 for a R$ 130 generic toner.
 *
 * **Two caveats, because the first version of this comment claimed more than
 * it had.** The punch and toner strings are cut at ~100 characters, which is
 * how the query that pulled them was written; truncation shortens the
 * *candidate* side and so biases a `toBe(false)` toward passing. No assertion
 * here flips when the full strings are substituted — the missing word is
 * still `perfurador` — but the shortening is stated rather than implied. The
 * `Papel Kraft` block is whole, and it had to be: its fixtures were hand-typed
 * at first, and the real `Fita Adesiva … material: papel kraft` row found a
 * defect the invented ones could not.
 */

/** The subject: a cast-iron desk punch, 100 sheets. Edital estimate R$ 168,78. */
const PERFURADOR =
  'Perfurador Papel material: ferro fundido, tipo: mesa, capacidade perfuração: 100, funcionamento: manual, carac'

/** The subject: a **compatible** Lexmark toner. Edital estimate R$ 129,85. */
const TONER_COMPATIVEL =
  'Cartucho Toner Impressora Lexmark tipo cartucho: compatível, cor tinta: preta, referência cartucho 3: 50f0z00'

describe('productHead', () => {
  it('reads the product and drops the attribute scaffolding', () => {
    expect(productHead(PERFURADOR)).toEqual(['perfurador', 'papel'])
  })

  it('drops a two-word attribute key, not only the word before the colon', () => {
    // "…Lexmark tipo cartucho: compatível" — `tipo` belongs to the key too.
    expect(productHead(TONER_COMPATIVEL)).toEqual([
      'cartucho',
      'toner',
      'impressora',
      'lexmark',
    ])
  })

  it('keeps the brand on a line an órgão typed with no attributes', () => {
    // Free text, no scaffolding to strip — and the fourth word is the one that
    // refuses every HP cartridge. A three-word cap stopped at `impressora`,
    // which is why the cap is four for both shapes.
    expect(productHead('Cartucho toner impressora lexmark')).toEqual([
      'cartucho',
      'toner',
      'impressora',
      'lexmark',
    ])
  })

  it('ignores the words that carry no product, and stops at four', () => {
    // `de` twice, and then the cap: requiring all six would be string identity
    // against a corpus whose median head is seven words.
    expect(productHead('PERFURADOR DE PAPEL 02 FUROS DE AÇO FUNDIDO')).toEqual([
      'perfurador',
      'papel',
      '02',
      'furos',
    ])
  })

  it('strips an attribute key the órgão wrote in capitals', () => {
    // 8.5% of the corpus has an ALL-CAPS front and another 7.1% a Capitalised
    // key. The first version only popped lower-case tails, so this head kept
    // `cor` and demanded the literal word of every comparable.
    expect(productHead('PAPEL A4 COR: BRANCA, GRAMATURA: 75')).toEqual(['papel', 'a4'])
  })

  it('does not count the product name an órgão wrote twice', () => {
    expect(
      productHead('Cadeira Escritório Cadeira Escritório, Material Estrutura:Tubo Aço'),
    ).toEqual(['cadeira', 'escritorio'])
  })

  it('has no head for a description it cannot read', () => {
    expect(productHead(null)).toEqual([])
    expect(productHead('')).toEqual([])
  })
})

describe('productGrade', () => {
  it('reads the grade that doubles the price', () => {
    expect(productGrade(TONER_COMPATIVEL)).toBe('compativel')
    expect(productGrade('Cartucho Toner Impressora Lexmark tipo cartucho: original')).toBe(
      'original',
    )
  })

  it('folds the accent and the synonym', () => {
    expect(productGrade('tipo cartucho: compativel')).toBe('compativel')
    expect(productGrade('cartucho generico')).toBe('compativel')
  })

  it('says nothing when the description does not', () => {
    expect(productGrade(PERFURADOR)).toBeNull()
    // Not a substring match: "originalidade" is not a grade.
    expect(productGrade('Selo de originalidade')).toBeNull()
  })
})

describe('sameProduct · the eleven comparables that priced a hole punch', () => {
  /** The nine that are not punches at all, verbatim from production. */
  const NOT_A_PUNCH = [
    'Papel Higiênico material: celulose virgem, comprimento: 30, largura: 10, tipo: picotado, quantidade',
    'Caderno características adicionais: brochura, capa dura, costurado, comprimento: 200, gramatura folh',
    'Caderno tipo: 1/4, material: papel off-set, gramatura folhas: 56, material capa: papelão revestida c',
    'Caderno características adicionais: lombada em espiral, personalizado, 4x0 cores, acab, comprimento:',
    'Caderno características adicionais: personalizado, impressão 4x1, acabamento wire-o, comprimento: 24',
    'Bobina Papel Senha material: papel acetinado, largura: 4, comprimento: 96, gramatura: 58, capacidade',
    'Caderno material: papel off-set 56g/m2, branco, material capa: papelão revestido papel couchê, 750g/',
    'Caderno tipo: horizontal sem pauta, material: celulose vegetal, gramatura folhas: 56, gramatura capa',
  ]

  it('refuses every caderno, and the toilet paper', () => {
    // Each of these carries `papel` somewhere — that is exactly how they were
    // scored as similar — and none of them carries `perfurador`.
    for (const other of NOT_A_PUNCH) {
      expect(sameProduct(PERFURADOR, other), other.slice(0, 40)).toBe(false)
    }
  })

  it('keeps the punch an órgão typed in capitals with no attributes', () => {
    // R$ 204,00, and the *lowest* similarity of the eleven — the one genuinely
    // equivalent product, outvoted by the cadernos under the old rule.
    expect(
      sameProduct(
        PERFURADOR,
        'PERFURADOR DE PAPEL 02 FUROS DE AÇO FUNDIDO RESISTENTE COM CAPACIDADE PARA 100 FOLHAS',
      ),
    ).toBe(true)
  })

  it('keeps a smaller punch, because it is still a punch', () => {
    // R$ 10,35. A different size is a judgement about the band's width, which
    // is `price-band.ts`'s job; this module only answers "same product".
    expect(
      sameProduct(
        PERFURADOR,
        'Perfurador Papel material: metal, tipo: pequeno, tratamento superficial: pintado, capacidade perfura',
      ),
    ).toBe(true)
  })

  it('leaves too few to price, which is the point', () => {
    // 2 of 11 survive, from 2 editais — under `MIN_SAMPLE`, so the screen
    // shows "ainda sem dados de vencedores" instead of R$ 9,35.
    const survivors = [
      'PERFURADOR DE PAPEL 02 FUROS DE AÇO FUNDIDO RESISTENTE COM CAPACIDADE PARA 100 FOLHAS',
      'Perfurador Papel material: metal, tipo: pequeno, tratamento superficial: pintado, capacidade perfura',
      ...NOT_A_PUNCH,
    ].filter((other) => sameProduct(PERFURADOR, other))
    expect(survivors).toHaveLength(2)
  })
})

describe('sameProduct · the toner that was priced as an original', () => {
  it('refuses the same reference in the other grade', () => {
    // R$ 525,80 — same Lexmark, same 50f0z00, `original` instead of
    // `compatível`. The word `similarity()` cannot weigh is the whole price.
    expect(
      sameProduct(
        TONER_COMPATIVEL,
        'Cartucho Toner Impressora Lexmark tipo cartucho: original, cor tinta: preta, referência cartucho 3: ',
      ),
    ).toBe(false)
  })

  it('refuses another maker’s cartridge', () => {
    for (const hp of [
      'Cartucho Toner Impressora Hp tipo cartucho: compatível, cor: ciano, referência cartucho 2: cf381a',
      'Cartucho Toner Impressora Hp tipo cartucho: original, cor: preta, referência cartucho 3: w1030xz',
      'Cartucho Tinta Impressora Hp referência cartucho 6: 938, tipo cartucho: original, cor tinta: preto',
      'Cartucho toner impressora hp',
    ]) {
      expect(sameProduct(TONER_COMPATIVEL, hp), hp.slice(0, 40)).toBe(false)
    }
  })

  it('refuses the drum that merely mentions the same printer', () => {
    // "Unidade Imagem … referência: 50f0z00, tipo uso: impressora lexmark" is
    // a photoconductor, not a cartridge, and it carried the same part number.
    expect(
      sameProduct(
        TONER_COMPATIVEL,
        'Unidade Imagem tipo: original, referência: 50f0z00, tipo uso: impressora lexmark',
      ),
    ).toBe(false)
  })

  it('keeps the two Lexmark toners that declare no grade', () => {
    // R$ 290,00 and R$ 300,00. Two editais is still under `MIN_SAMPLE`, so
    // this item also stops showing a band — correctly, on this evidence.
    for (const same of ['Cartucho toner impressora lexmark', 'Cartucho Toner Impressora Lexmark']) {
      expect(sameProduct(TONER_COMPATIVEL, same)).toBe(true)
    }
  })
})

describe('sameProduct · the Papel Kraft the audit found', () => {
  // `01181184000104-1-000003/2026` item 54 — a band of R$ 4,90 built from
  // nothing that was kraft paper at all. Every string below is the **whole**
  // description as the database holds it.
  const KRAFT =
    'Papel Kraft material: celulose vegetal, gramatura: 120, comprimento: 96, largura: 66, cor: parda'

  it('refuses every product that shared only the word “papel”', () => {
    for (const other of [
      'Caderno apresentação: brochura, comprimento: 150, largura: 210, material: celulose vegetal, material capa: papelão, quantidade folhas: 40, tipo: pedagógico, caligrafia',
      'Caixa material: papelão ondulado duplex, comprimento: 400, largura: 300, altura: 300, gramatura: 445',
      'Guardanapo De Papel material: celulose, largura: 30, comprimento: 30, cor: branca, tipo folhas: dupla',
      'Papel Crepom material: celulose vegetal, gramatura: 18, comprimento: 2, largura: 48, cor: azul turquesa',
      'Papel Seda material: celulose vegetal, comprimento: 60, largura: 48, cor: lilás, gramatura: 18',
    ]) {
      expect(sameProduct(KRAFT, other), other.slice(0, 32)).toBe(false)
    }
  })

  /**
   * **The one that caught a defect in the first version of this module.**
   *
   * Adhesive tape whose *material* is kraft paper carries both of the
   * subject's head words — inside an attribute value. The rule then compared
   * the subject's head against the candidate's whole description and accepted
   * it, so a roll of tape priced a sheet of paper. It was invisible because
   * the fixture here had been written by hand from the audit's summary rather
   * than read out of the database; the real string is what found it.
   */
  it('refuses tape that is merely made of kraft paper', () => {
    expect(
      sameProduct(
        KRAFT,
        'Fita Adesiva Embalagem material: papel kraft, comprimento: 45, largura: 45, aplicação: acondicionamento e embalagem, tipo: gomada',
      ),
    ).toBe(false)
  })

  it('keeps paper kraft, written either way round', () => {
    expect(sameProduct(KRAFT, 'PAPEL KRAFT 80G NATURAL LARGURA 60CM')).toBe(true)
  })
})

describe('sameProduct · the refusals that keep it safe', () => {
  it('refuses everything when the subject cannot be read', () => {
    // Falling through to "comparable with anything" is the behaviour this
    // module exists to stop, so an unreadable subject prices nothing.
    expect(sameProduct(null, 'Perfurador Papel material: ferro fundido')).toBe(false)
    expect(sameProduct('', 'Perfurador Papel material: ferro fundido')).toBe(false)
  })

  it('refuses a candidate with no description', () => {
    expect(sameProduct(PERFURADOR, null)).toBe(false)
  })

  it('is directional: the candidate may be more specific, never less', () => {
    expect(sameProduct('Caneta Esferográfica material: plástico', 'Caneta Esferográfica azul')).toBe(
      true,
    )
    expect(sameProduct('Caneta Esferográfica azul', 'Caneta material: plástico')).toBe(false)
  })
})
