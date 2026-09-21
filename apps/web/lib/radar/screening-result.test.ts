import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { parseScreening, verdictFor, type Finding } from './screening-result'

/**
 * The parser, against a **real** analysis.
 *
 * `REAL` below is `ai_analyses.result` / `citation_check` / `rules` exactly as
 * the worker wrote them on 2026-09-21 for PNCP tender
 * `00394544000185-1-002027/2026` — an água-supply works contract in Jacareacanga/PA,
 * 50 pages, read by `qwen/qwen3.7-flash` under prompt `triagem-edital-v2`. It is
 * pasted verbatim rather than invented, because the shape this file has to
 * survive is the shape a language model actually produces: strings where the
 * schema says numbers (`"10%"`, `"12"`), `null` where the document was silent,
 * and an empty array where it found nothing.
 *
 * It is the case that exercises everything the screen promises: eight cited
 * pages, all eight verified, a minimum capital the *worker* calculated, and
 * three blockers that each name a page.
 */
const REAL = {
  "result": {
    "orgao": "DISTRITO SANIT.ESP.INDIGENA - TAPAJOS - PA",
    "motivo": "Obra complexa de engenharia sem benefício para ME/EPP, exigindo atestados técnicos específicos e difíceis de obter para pequenas empresas.",
    "objeto": "Implantação de sistema de abastecimento de água (SAA) com perfuração de poço, reservatório, bombeamento fotovoltaico, tratamento e rede de distribuição na Aldeia São João.",
    "entrega": {
      "local": "Aldeia São João, Terra Indígena Munduruku, coordenadas Latitude: 6°22'13.18\" S°, Longitude: 57°28'32.96\" O",
      "pagina": 5,
      "parcelada": null,
      "validade_minima_produto": null
    },
    "consorcio": "permitido",
    "modalidade": "Concorrência Eletrônica",
    "tipo_objeto": "obra",
    "municipio_uf": "Jacareacanga/PA",
    "vale_deep_dive": false,
    "vigencia_meses": "12",
    "visita_tecnica": "obrigatoria",
    "beneficio_me_epp": {
      "pagina": 35,
      "situacao": "sem_beneficio",
      "observacao": "Edital declara expressamente que não será concedido tratamento favorecido para ME/EPP em razão do art. 4º, § 1º da Lei nº 14.133/2021.",
      "itens_exclusivos": [],
      "itens_cota_reservada": []
    },
    "exigencias_produto": {
      "pagina": null,
      "inmetro": null,
      "afe_anvisa": null,
      "registro_anvisa": null,
      "catalogo_ou_ficha_tecnica": null,
      "licenca_ou_alvara_sanitario": null,
      "aceita_distribuidor_revendedor": "nao_informado"
    },
    "orcamento_sigiloso": false,
    "plataforma_disputa": null,
    "registro_de_precos": false,
    "criterio_julgamento": "menor preço por item",
    "data_sessao_disputa": "2026-10-29 09:00",
    "garantia_contratual": {
      "pagina": 4,
      "situacao": "exigida",
      "percentual": "5%"
    },
    "nota_triagem_0_a_10": 2,
    "observacao_pagamento": null,
    "prazo_envio_proposta": null,
    "prazo_pagamento_dias": null,
    "valor_estimado_total": 1693346.78,
    "vigencia_meses_normalizada": 12.0,
    "atestado_capacidade_tecnica": {
      "exige": true,
      "pagina": 18,
      "resumo": "Comprovação de aptidão para execução de serviço similar envolvendo: perfuração de poço tubular em rocha cristalina (diâmetro mín. 6\", profundidade mín. 100m); execução de rede de distribuição de água (diâmetro 50mm, mín. 131m); estrutura concreto armado (mín. 3,22 m³); alvenaria de vedação (mín. 19,00 m²). Não admite somatório de atestados para a perfuração."
    },
    "amostra_ou_prova_de_conceito": {
      "tipo": "nenhuma",
      "pagina": null,
      "resumo": null
    },
    "bloqueadores_pequena_empresa": [
      {
        "ponto": "Não há tratamento favorecido (Lei 14.133, art. 4º, § 1º), impedindo uso de margem de preferência ou cota exclusiva.",
        "pagina": 35
      },
      {
        "ponto": "Exigência de atestado específico de perfuração de poço tubular em rocha cristalina (100m de profundidade, diâmetro 6\") sem possibilidade de somatório com outros atestados.",
        "pagina": 18
      },
      {
        "ponto": "Exigência de profissionais específicos (Engenheiro Civil e Geólogo) vinculados permanentemente à empresa, com comprovação de acervo técnico individual.",
        "pagina": 19
      }
    ],
    "capital_ou_patrimonio_minimo": {
      "base": "valor_total",
      "exige": true,
      "pagina": 17,
      "resumo": "Patrimônio líquido mínimo de 10% do valor total estimado da contratação, aplicável caso os índices de Liquidez Geral, Corrente e Solvência sejam inferiores ou iguais a 1.",
      "calculo": "10% de R$ 1,693,346.78",
      "percentual": "10%",
      "valor_minimo_calculado": 169334.68
    },
    "prazo_execucao_ou_entrega_dias": null
  },
  "citationCheck": {
    "mode": "lite",
    "rate": 1.0,
    "findings": {
      "entrega": "confere",
      "beneficio_me_epp": "confere",
      "garantia_contratual": "confere",
      "atestado_capacidade_tecnica": "confere",
      "capital_ou_patrimonio_minimo": "confere",
      "bloqueadores_pequena_empresa[0]": "confere",
      "bloqueadores_pequena_empresa[1]": "confere",
      "bloqueadores_pequena_empresa[2]": "confere"
    },
    "verified": 8,
    "citations": 8
  },
  "rules": {
    "term_months": 12.0,
    "minimum_capital_brl": 169334.68,
    "minimum_capital_calculation": "10% de R$ 1,693,346.78"
  }
} as const

const fields = messages.radar.fields
const values = messages.radar.values

function find(findings: Finding[], id: string): Finding {
  const found = findings.find((finding) => finding.id === id)
  if (!found) throw new Error(`no finding "${id}" in [${findings.map((f) => f.id).join(', ')}]`)
  return found
}

describe('parseScreening · a real analysis', () => {
  const model = parseScreening(REAL.result, REAL.citationCheck, REAL.rules)!

  it('reads the score and the verdict band', () => {
    expect(model.score).toBe(2)
    expect(model.verdict).toBe(messages.radar.screening.verdict.hard)
    expect(model.reason).toContain('Obra complexa de engenharia')
  })

  it('carries the page of every claim that cited one — the acceptance criterion', () => {
    expect(find(model.qualification, 'meEpp').page).toBe(35)
    expect(find(model.qualification, 'technicalCertificate').page).toBe(18)
    expect(find(model.qualification, 'minimumCapital').page).toBe(17)
    expect(find(model.qualification, 'guarantee').page).toBe(4)
    expect(find(model.requirements, 'deliveryPlace').page).toBe(5)
  })

  it('cites no page where the model cited none, instead of inventing one', () => {
    expect(find(model.qualification, 'sample').page).toBeNull()
  })

  it('marks nothing as unverified when the worker verified every citation', () => {
    expect(model.citations).toEqual({ citations: 8, verified: 8, rate: 1 })
    expect(model.qualification.every((finding) => !finding.pageUnverified)).toBe(true)
    expect(model.blockers.every((blocker) => !blocker.pageUnverified)).toBe(true)
  })

  it('prints the minimum capital the worker calculated, not the model’s percentage', () => {
    const capital = find(model.qualification, 'minimumCapital')
    // `rules.minimum_capital_brl` = 169334.68, from 10% of R$ 1.693.346,78.
    expect(capital.value).toBe('R$ 169.334,68')
    expect(capital.tone).toBe('attention')
    expect(capital.note).toContain('Patrimônio líquido mínimo de 10%')
  })

  it('reads the contract term out of `rules`, where the arithmetic was done', () => {
    // The model answered the string "12"; `compute_rules` normalised it.
    expect(find(model.requirements, 'term').value).toBe('12 meses')
  })

  it('tones "sem benefício" and "obrigatória" the way a small company reads them', () => {
    expect(find(model.qualification, 'meEpp').value).toBe(values.meEppNone)
    expect(find(model.qualification, 'siteVisit').value).toBe(values.visitRequired)
    expect(find(model.qualification, 'siteVisit').tone).toBe('attention')
    expect(find(model.qualification, 'technicalCertificate').tone).toBe('attention')
  })

  it('keeps each blocker with its page', () => {
    expect(model.blockers.map((blocker) => blocker.page)).toEqual([35, 18, 19])
    expect(model.blockers[1].text).toContain('rocha cristalina')
  })

  it('drops the rows the document was silent about rather than printing null', () => {
    const ids = model.requirements.map((finding) => finding.id)
    expect(ids).not.toContain('anvisa')
    expect(ids).not.toContain('inmetro')
    expect(ids).not.toContain('reseller')
    expect(ids).not.toContain('paymentDays')
  })

  it('labels every row from the pt-BR catalogue', () => {
    expect(find(model.qualification, 'minimumCapital').label).toBe(fields.minimumCapital)
    expect(find(model.requirements, 'deliveryPlace').label).toBe(fields.deliveryPlace)
  })
})

describe('parseScreening · what a model can get wrong', () => {
  it('flags a page the citation check could not confirm, and still shows it', () => {
    const model = parseScreening(
      { beneficio_me_epp: { situacao: 'exclusivo', pagina: 3 }, nota_triagem_0_a_10: 9 },
      { mode: 'lite', citations: 1, verified: 0, rate: 0, findings: { beneficio_me_epp: 'pagina errada' } },
      {},
    )!
    const meEpp = find(model.qualification, 'meEpp')
    expect(meEpp.page).toBe(3)
    expect(meEpp.pageUnverified).toBe(true)
  })

  it('does not flag a field the check never looked at', () => {
    const model = parseScreening(
      { garantia_contratual: { situacao: 'exigida', pagina: 8 } },
      { mode: 'lite', citations: 0, verified: 0, rate: null, findings: {} },
      {},
    )!
    expect(find(model.qualification, 'guarantee').pageUnverified).toBe(false)
  })

  it('reads a percentage written as a string and a page written as a float', () => {
    const model = parseScreening(
      { garantia_contratual: { situacao: 'exigida', percentual: '5%', pagina: 4.0 } },
      null,
      null,
    )!
    const guarantee = find(model.qualification, 'guarantee')
    expect(guarantee.page).toBe(4)
    expect(guarantee.note).toBe('5%')
  })

  it('ignores a page number that is not one', () => {
    const model = parseScreening({ entrega: { local: 'Almoxarifado', pagina: 'não informado' } }, null, null)!
    expect(find(model.requirements, 'deliveryPlace').page).toBeNull()
  })

  it('clamps a score outside the prompt’s 0–10 scale', () => {
    expect(parseScreening({ nota_triagem_0_a_10: 42 }, null, null)!.score).toBe(10)
    expect(parseScreening({ nota_triagem_0_a_10: -3 }, null, null)!.score).toBe(0)
  })

  it('survives an answer that is not the schema at all', () => {
    const model = parseScreening({ desculpe: 'não consegui ler o documento' }, null, null)!
    expect(model.score).toBeNull()
    expect(model.verdict).toBe(messages.radar.screening.verdict.unknown)
    // Three rows always have an answer, even when it is "não informado".
    expect(model.qualification.map((finding) => finding.value)).toEqual([
      values.unknown,
      values.unknown,
      values.unknown,
      values.unknown,
      values.unknown,
    ])
    expect(model.requirements).toEqual([])
    expect(model.blockers).toEqual([])
  })

  it('returns null when the row holds no object to read', () => {
    expect(parseScreening(null, null, null)).toBeNull()
    expect(parseScreening('{"objeto":"x"}', null, null)).toBeNull()
  })
})

describe('verdictFor', () => {
  it('bands the score the way the board colours the card', () => {
    expect(verdictFor(10)).toBe(messages.radar.screening.verdict.good)
    expect(verdictFor(8)).toBe(messages.radar.screening.verdict.good)
    expect(verdictFor(7)).toBe(messages.radar.screening.verdict.medium)
    expect(verdictFor(5)).toBe(messages.radar.screening.verdict.medium)
    expect(verdictFor(4)).toBe(messages.radar.screening.verdict.hard)
    expect(verdictFor(null)).toBe(messages.radar.screening.verdict.unknown)
  })
})
