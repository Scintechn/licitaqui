import { describe, expect, it } from 'vitest'
import {
  ageParts,
  agencyLine,
  cleanTitle,
  clockTime,
  daysUntil,
  deadlineFull,
  deadlineShort,
  deadlineTall,
  displayTitle,
  meEppSummary,
  money,
  moneyExact,
  shortDate,
  tenderTitle,
  trimObject,
} from './format'

/**
 * The instants below are the board's own example: a Campinas tender whose
 * proposals close on 30/09 at 08:30 Brasília, read on 17/09, where the card
 * says "13 dias". `08:30-03:00` is `11:30Z`.
 */
const DEADLINE = '2026-09-30T11:30:00.000Z'
const READING_IT = new Date('2026-09-17T15:00:00.000Z') // 12:00 in Brasília

describe('money', () => {
  it('writes the board figures exactly as the board writes them', () => {
    expect(money('48196.00')).toBe('R$ 48.196')
    expect(money('1250000')).toBe('R$ 1,25 mi')
    expect(money('4330000')).toBe('R$ 4,33 mi')
  })

  it('scales to bilhões rather than printing ten digits', () => {
    expect(money('2726000000')).toBe('R$ 2,73 bi')
  })

  it('rounds the centavos away on a card', () => {
    expect(money('101597.40')).toBe('R$ 101.597')
  })

  it('has nothing to say about a missing or unparseable value', () => {
    expect(money(null)).toBeNull()
    expect(money('')).toBeNull()
    expect(money('sigiloso')).toBeNull()
  })

  /**
   * The production bug, at its root. This suite used to assert
   * `money('0') === 'R$ 0'` under the heading "keeps zero as a number", and
   * that assertion is what shipped `R$ 0,00` to Sci's screen: 108 tenders hold
   * `estimated_value = 0`, which is what PNCP publishes in the value field when
   * the budget is withheld, not what the órgão intends to pay. Legal brief
   * §2.2 rule 3 — a price is an estimate with its arithmetic visible — makes
   * printing it a defect, so the formatter refuses it.
   */
  it('refuses a zero, which is an absence and not a price', () => {
    expect(money('0')).toBeNull()
    expect(money('0.00')).toBeNull()
    expect(money('0.0000')).toBeNull()
    expect(money('-0')).toBeNull()
  })

  it('still prints the smallest figure that is genuinely a price', () => {
    expect(money('1')).toBe('R$ 1')
    expect(moneyExact('0.01')).toBe('R$ 0,01')
  })
})

describe('moneyExact', () => {
  it('prints the Itens tab to the centavo, against PNCP’s own table', () => {
    expect(moneyExact('816.6700')).toBe('R$ 816,67')
    expect(moneyExact('326668.00')).toBe('R$ 326.668,00')
    expect(moneyExact('2988571.02')).toBe('R$ 2.988.571,02')
  })

  it('refuses a zero too — twenty item rows is twenty invented prices', () => {
    expect(moneyExact('0')).toBeNull()
    expect(moneyExact('0.00')).toBeNull()
    expect(moneyExact('0.0000')).toBeNull()
  })

  it('has nothing to say about a missing or unparseable value', () => {
    expect(moneyExact(null)).toBeNull()
    expect(moneyExact(undefined)).toBeNull()
    expect(moneyExact('')).toBeNull()
    expect(moneyExact('sigiloso')).toBeNull()
  })
})

describe('dates, always in Brasília', () => {
  it('formats the deadline the three ways the two screens need', () => {
    expect(shortDate(DEADLINE)).toBe('30/09')
    expect(clockTime(DEADLINE)).toBe('08:30')
    expect(deadlineShort(DEADLINE)).toBe('30/09 · 08:30')
    expect(deadlineFull(DEADLINE)).toBe('30/09/2026 · 08:30')
    expect(deadlineTall(DEADLINE)).toBe('30 SET · 08:30')
  })

  it('counts the board’s 13 days, whatever time of day it is asked', () => {
    expect(daysUntil(DEADLINE, READING_IT)).toBe(13)
    // 06:00 in Brasília. A plain ms division would round this up to 14.
    expect(daysUntil(DEADLINE, new Date('2026-09-17T09:00:00.000Z'))).toBe(13)
    // 23:30 in Brasília, still the 17th.
    expect(daysUntil(DEADLINE, new Date('2026-09-18T02:30:00.000Z'))).toBe(13)
  })

  it('counts calendar days in Brasília, not in UTC', () => {
    // 2026-09-30T02:00Z is 29/09 at 23:00 in Brasília: twelve days, not thirteen.
    expect(daysUntil('2026-09-30T02:00:00.000Z', READING_IT)).toBe(12)
  })

  it('says 0 on the last day and goes negative once it has closed', () => {
    expect(daysUntil(DEADLINE, new Date('2026-09-30T03:00:00.000Z'))).toBe(0)
    expect(daysUntil(DEADLINE, new Date('2026-10-02T15:00:00.000Z'))).toBe(-2)
  })

  it('returns null rather than a fake date when there is none', () => {
    expect(daysUntil(null, READING_IT)).toBeNull()
    expect(deadlineShort(null)).toBeNull()
    expect(deadlineTall('not a date')).toBeNull()
  })
})

describe('ageParts', () => {
  it('calls anything under a minute "now"', () => {
    expect(ageParts(0)).toEqual({ unit: 'now', count: 0 })
    expect(ageParts(59)).toEqual({ unit: 'now', count: 0 })
  })

  it('steps up through minutes, hours and days', () => {
    expect(ageParts(60)).toEqual({ unit: 'minutes', count: 1 })
    expect(ageParts(3599)).toEqual({ unit: 'minutes', count: 59 })
    expect(ageParts(3600)).toEqual({ unit: 'hours', count: 1 })
    expect(ageParts(86_400)).toEqual({ unit: 'days', count: 1 })
  })

  it('has no opinion when the route did not report an age', () => {
    expect(ageParts(null)).toBeNull()
    expect(ageParts(undefined)).toBeNull()
  })
})

describe('meEppSummary', () => {
  it('accepts only the four values the column can hold', () => {
    for (const value of ['exclusive', 'quota', 'mixed', 'none']) {
      expect(meEppSummary(value)).toBe(value)
    }
    expect(meEppSummary('EXCLUSIVO')).toBeNull()
    expect(meEppSummary(null)).toBeNull()
  })
})

describe('agencyLine', () => {
  it('writes the board line', () => {
    expect(
      agencyLine({
        agencyName: 'Prefeitura de Campinas',
        city: 'Campinas',
        state: 'SP',
        modalityName: 'Pregão eletrônico',
      }),
    ).toBe('Prefeitura de Campinas · Campinas/SP · Pregão eletrônico')
  })

  it('leaves out what PNCP did not send, with no stray separators', () => {
    expect(agencyLine({ agencyName: 'Rede Mário Gatti', city: null, state: null })).toBe(
      'Rede Mário Gatti',
    )
    expect(agencyLine({ agencyName: null, city: 'Campinas', state: 'SP' })).toBe('Campinas/SP')
    expect(agencyLine({})).toBe('')
  })
})

describe('trimObject', () => {
  const shouted =
    '[Portal de Compras Públicas] - REGISTRO DE PREÇO VISANDO FUTURA E EVENTUAL SELEÇÃO DAS ' +
    'MELHORES PROPOSTAS PARA CONTRATAÇÃO DE EMPRESA ESPECIALIZADA NA CONFECÇÃO DE MATERIAL ' +
    'GRÁFICO, PARA ATENDER A DEMANDA DO FUNDO MUNICIPAL DE SAÚDE.'

  it('keeps a short object exactly as it came', () => {
    expect(trimObject('Baterias e pilhas')).toBe('Baterias e pilhas')
  })

  it('cuts a PNCP paragraph at a word boundary and says it cut it', () => {
    const out = trimObject(shouted)
    expect(out.length).toBeLessThanOrEqual(121)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toContain(' …')
    expect(shouted.startsWith(out.slice(0, 40))).toBe(true)
  })

  it('collapses the whitespace PNCP leaves in the middle of an object', () => {
    expect(trimObject('Aquisição   de\n  material')).toBe('Aquisição de material')
  })
})

describe('cleanTitle', () => {
  it('strips the sourcing portal PNCP bolts onto the front of a title', () => {
    expect(cleanTitle('[Portal de Compras Públicas] - Aquisição de drones.')).toBe(
      'Aquisição de drones',
    )
    expect(cleanTitle('[Compras.gov.br] Aquisição de drones')).toBe('Aquisição de drones')
    // An em dash, an en dash, a colon: agencies use all of them as the joint.
    expect(cleanTitle('[BLL] — Aquisição de drones')).toBe('Aquisição de drones')
  })

  it('brings a shouted title back to sentence case', () => {
    expect(cleanTitle('AQUISIÇÃO DE EQUIPAMENTOS DESTINADOS À SECRETARIA DE SAÚDE.')).toBe(
      'Aquisição de equipamentos destinados à secretaria de saúde',
    )
  })

  it('drops the full stop an agency typed at the end of a title', () => {
    expect(cleanTitle('Baterias e pilhas.')).toBe('Baterias e pilhas')
    expect(cleanTitle('Baterias e pilhas...')).toBe('Baterias e pilhas')
  })

  it('de-shouts the shouted half of a title that turns to prose halfway', () => {
    // The commonest real shape, and the one a whole-string "is it shouting?"
    // check gets wrong: the card shows the first 120 characters, so a single
    // lowercase letter 300 characters in used to leave the visible half
    // shouting.
    expect(
      cleanTitle(
        'AQUISICAO DE MATERIAIS TERAPEUTICOS PARA AS UNIDADES DO NUCLEO ' +
          'por meio de Dispensa Eletronica de Licitacao',
      ),
    ).toBe(
      'Aquisicao de materiais terapeuticos para as unidades do nucleo ' +
        'por meio de Dispensa Eletronica de Licitacao',
    )
  })

  it('leaves a title that deliberately starts lowercase alone', () => {
    expect(cleanTitle('iPhone e acessórios')).toBe('iPhone e acessórios')
  })

  it('leaves a title that was already written like prose alone', () => {
    expect(cleanTitle('Registro de preços de baterias e pilhas')).toBe(
      'Registro de preços de baterias e pilhas',
    )
    // Mixed case is not shouting, so nothing is lowercased.
    expect(cleanTitle('Aquisição de EPIs para a Defesa Civil')).toBe(
      'Aquisição de EPIs para a Defesa Civil',
    )
  })

  it('keeps acronyms and codes capitals while lowercasing the words', () => {
    expect(cleanTitle('AQUISIÇÃO DE INSUMOS PARA O SUS')).toBe('Aquisição de insumos para o SUS')
    expect(cleanTitle('CONTRATAÇÃO EXCLUSIVA ME/EPP')).toBe('Contratação exclusiva ME/EPP')
    expect(cleanTitle('PREGÃO ELETRÔNICO 01/2026 DE MATERIAL')).toBe(
      'Pregão eletrônico 01/2026 de material',
    )
  })

  it('collapses the whitespace PNCP leaves inside an object', () => {
    expect(cleanTitle('Aquisição   de\n  material')).toBe('Aquisição de material')
  })

  it('never returns an empty string for a title that was only punctuation', () => {
    expect(cleanTitle('...')).toBe('...')
  })
})

describe('tenderTitle', () => {
  const real =
    '[Portal de Compras Públicas] - REGISTRO DE PREÇO VISANDO FUTURA E EVENTUAL SELEÇÃO DAS ' +
    'MELHORES PROPOSTAS PARA CONTRATAÇÃO DE EMPRESA ESPECIALIZADA NA CONFECÇÃO DE MATERIAL ' +
    'GRÁFICO, PARA ATENDER A DEMANDA DO FUNDO MUNICIPAL DE SAÚDE.'

  it('cleans first and trims second, so the cut counts the cleaned string', () => {
    const out = tenderTitle(real)
    expect(out.startsWith('Registro de preço visando futura')).toBe(true)
    expect(out).not.toContain('[Portal')
    expect(out.length).toBeLessThanOrEqual(121)
    expect(out.endsWith('…')).toBe(true)
  })

  it('is display only — it never reports back the stored object', () => {
    // A guard for the rule, not for the arithmetic: the argument is not
    // mutated and the raw object stays available to whatever cites it.
    const object = 'AQUISIÇÃO DE DRONES.'
    expect(tenderTitle(object)).toBe('Aquisição de drones')
    expect(object).toBe('AQUISIÇÃO DE DRONES.')
  })
})

describe('displayTitle', () => {
  /**
   * `tenders.short_title` existed from the day the title work shipped — 8 712
   * of 9 059 production rows carry one, 6 306 written by the model — and the
   * web app read the column **nowhere**: not the queries, not the contract,
   * not any view. Every screen printed the raw PNCP object instead.
   */
  const OBJECT =
    '[Portal de Compras Públicas] - Aquisição de equipamentos e materiais permanentes, ' +
    'destinados à estruturação, modernização e adequação da Unidade de Atenção Psicossocial.'

  it('prefers the short title the worker wrote', () => {
    expect(displayTitle({ shortTitle: 'Equipamentos para unidade de saúde mental', object: OBJECT })).toBe(
      'Equipamentos para unidade de saúde mental',
    )
  })

  it('falls back to the cleaned object while a tender is still untitled', () => {
    // The normal state for a newly ingested tender: `sweep_titles` is hourly,
    // so 3.8% of production has no title at any moment — and always the newest
    // rows, which are the ones most likely to be on screen.
    const shown = displayTitle({ shortTitle: null, object: OBJECT })
    expect(shown).toBe(tenderTitle(OBJECT))
    expect(shown).not.toContain('[Portal de Compras Públicas]')
    expect(shown.startsWith('Aquisição de equipamentos')).toBe(true)
  })

  it('treats a blank or whitespace title as no title', () => {
    // The worker's validator refuses to store one, so this is defence against
    // a future writer rather than against today's — but a blank h1 is the one
    // failure mode with no visible symptom until someone opens the page.
    expect(displayTitle({ shortTitle: '', object: OBJECT })).toBe(tenderTitle(OBJECT))
    expect(displayTitle({ shortTitle: '   ', object: OBJECT })).toBe(tenderTitle(OBJECT))
  })

  it('never truncates a short title with the object’s limit', () => {
    // `max` exists to cut a 500-character object. A short title is short by
    // construction and must not be cut mid-word by a limit meant for prose.
    const short = 'Manutenção de ar condicionado e câmaras frias'
    expect(displayTitle({ shortTitle: short, object: OBJECT }, 20)).toBe(short)
    expect(short.length).toBeGreaterThan(20)

    // The same limit does apply to the fallback, which is what it is for.
    const trimmed = displayTitle({ shortTitle: null, object: OBJECT }, 20)
    expect(trimmed.length).toBeLessThan(tenderTitle(OBJECT).length)
    expect(trimmed).toMatch(/…$/)
  })
})
