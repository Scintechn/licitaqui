import { describe, expect, it } from 'vitest'
import {
  agencyLine,
  ageParts,
  clockTime,
  daysUntil,
  deadlineFull,
  deadlineShort,
  deadlineTall,
  meEppSummary,
  money,
  cleanTitle,
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

  it('rounds centavos away on a card, and keeps zero as a number', () => {
    expect(money('101597.40')).toBe('R$ 101.597')
    expect(money('0')).toBe('R$ 0')
  })

  it('has nothing to say about a missing or unparseable value', () => {
    expect(money(null)).toBeNull()
    expect(money('')).toBeNull()
    expect(money('sigiloso')).toBeNull()
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
