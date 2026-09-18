import { describe, expect, it } from 'vitest'
import { BOM, csvField, csvFilename, DELIMITER, LINE_ENDING, toCsv, type CsvColumn } from './csv'
import { foundersCsv, type FounderRow } from './founders'

/**
 * The export is the only file that leaves the product carrying personal data,
 * and a CSV writer that gets quoting wrong shifts every column after the
 * offending value — silently, in a file nobody re-reads. Hence a parser here:
 * the assertions are about what a reader gets back, not about the string.
 */

/** A minimal RFC 4180 reader, so the tests check round-trips, not byte strings. */
function parse(csv: string): string[][] {
  const text = csv.startsWith(BOM) ? csv.slice(BOM.length) : csv
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0

  while (i < text.length) {
    const character = text[i]
    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      field += character
      i += 1
      continue
    }
    if (character === '"') {
      quoted = true
      i += 1
      continue
    }
    if (character === DELIMITER) {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (text.startsWith(LINE_ENDING, i)) {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += LINE_ENDING.length
      continue
    }
    field += character
    i += 1
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const columns: CsvColumn<{ a: string; b: string }>[] = [
  { header: 'a', value: (row) => row.a },
  { header: 'b', value: (row) => row.b },
]

describe('csvField', () => {
  it('quotes everything, so nothing depends on guessing', () => {
    expect(csvField('simples')).toBe('"simples"')
    expect(csvField(42)).toBe('"42"')
  })

  it('writes an empty cell for null and undefined', () => {
    expect(csvField(null)).toBe('""')
    expect(csvField(undefined)).toBe('""')
  })

  it('doubles inner quotes', () => {
    expect(csvField('cadeiras 12" e 14"')).toBe('"cadeiras 12"" e 14"""')
  })
})

describe('a value that would corrupt the file', () => {
  it('survives a comma', () => {
    const csv = toCsv(columns, [{ a: 'Silva, Souza & Cia', b: 'ok' }])
    expect(parse(csv)).toEqual([
      ['a', 'b'],
      ['Silva, Souza & Cia', 'ok'],
    ])
  })

  it('survives the delimiter itself', () => {
    const csv = toCsv(columns, [{ a: `antes${DELIMITER}depois`, b: 'ok' }])
    expect(parse(csv)[1]).toEqual([`antes${DELIMITER}depois`, 'ok'])
  })

  it('survives a double quote', () => {
    const csv = toCsv(columns, [{ a: 'Maria "Duda" Souza', b: 'ok' }])
    expect(parse(csv)[1]).toEqual(['Maria "Duda" Souza', 'ok'])
  })

  it('survives a quote wrapped around the whole value', () => {
    const csv = toCsv(columns, [{ a: '"tudo entre aspas"', b: 'ok' }])
    expect(parse(csv)[1]).toEqual(['"tudo entre aspas"', 'ok'])
  })

  it('survives a newline, without inventing a row', () => {
    const csv = toCsv(columns, [{ a: 'linha 1\nlinha 2', b: 'ok' }])
    const rows = parse(csv)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual(['linha 1\nlinha 2', 'ok'])
  })

  it('survives all of them at once, in the same row', () => {
    const nasty = `Silva, "Duda"${DELIMITER} & Cia\nfilial`
    const csv = toCsv(columns, [{ a: nasty, b: 'depois' }])
    const rows = parse(csv)
    expect(rows).toHaveLength(2)
    // The column after the nasty one is still the column after it.
    expect(rows[1]).toEqual([nasty, 'depois'])
  })
})

describe('spreadsheet formula injection', () => {
  it('neutralises a leading = and @', () => {
    expect(csvField('=HYPERLINK("http://mau.test","clique")')).toBe(
      '"\'=HYPERLINK(""http://mau.test"",""clique"")"',
    )
    expect(csvField('@SUM(A1:A9)')).toBe('"\'@SUM(A1:A9)"')
  })

  it('neutralises a signed value that is not a number', () => {
    expect(csvField('+HYPERLINK(1)')).toBe('"\'+HYPERLINK(1)"')
    expect(csvField('-cmd|calc')).toBe('"\'-cmd|calc"')
  })

  it('leaves a phone number alone: every WhatsApp in the database starts with +55', () => {
    expect(csvField('+5511999998888')).toBe('"+5511999998888"')
    expect(csvField('-12,5')).toBe('"-12,5"')
  })
})

describe('toCsv', () => {
  it('starts with the BOM and the header row, and ends with a line break', () => {
    const csv = toCsv(columns, [])
    expect(csv.startsWith(BOM)).toBe(true)
    expect(csv.endsWith(LINE_ENDING)).toBe(true)
    expect(parse(csv)).toEqual([['a', 'b']])
  })
})

describe('foundersCsv', () => {
  const row: FounderRow = {
    id: 7,
    name: 'Silva, "Duda" & Cia',
    email: 'duda@exemplo.test',
    whatsapp: '+5511999998888',
    cnpj: '00394429000100',
    sells: 'cadeiras 12" e 14"\nmesas',
    source: 'influencer',
    seat: 3,
    contactConsent: true,
    createdAt: new Date('2026-09-18T12:34:56.000Z'),
  }

  it('round-trips a hostile row into exactly two lines and ten columns', () => {
    const rows = parse(foundersCsv([row]))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual([
      'id',
      'vaga',
      'nome',
      'email',
      'whatsapp',
      'cnpj',
      'o_que_vende',
      'origem',
      'consentimento_contato',
      'criado_em',
    ])
    expect(rows[1]).toEqual([
      '7',
      '3',
      'Silva, "Duda" & Cia',
      'duda@exemplo.test',
      '+5511999998888',
      '00394429000100',
      'cadeiras 12" e 14"\nmesas',
      'influencer',
      'sim',
      '2026-09-18T12:34:56.000Z',
    ])
  })

  it('writes empty cells for a waitlisted founder who left the optional fields blank', () => {
    const rows = parse(
      foundersCsv([{ ...row, seat: null, sells: null, source: null, contactConsent: false }]),
    )
    expect(rows[1][1]).toBe('')
    expect(rows[1][6]).toBe('')
    expect(rows[1][7]).toBe('')
    expect(rows[1][8]).toBe('nao')
  })
})

describe('csvFilename', () => {
  it('names the file by the day it was exported', () => {
    expect(csvFilename('fundadores', new Date('2026-09-18T23:59:00Z'))).toBe(
      'licitaqui-fundadores-2026-09-18.csv',
    )
  })
})
