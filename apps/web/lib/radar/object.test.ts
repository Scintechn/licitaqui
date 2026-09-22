import { describe, expect, it } from 'vitest'
import { tenderObject, TITLE_MAX } from './object'

/** A real object from production, 361 characters, shouted for half of them. */
const OLINDA =
  'AQUISICAO DE MATERIAIS TERAPEUTICOS PARA AS UNIDADES DO NUCLEO DE INTEGRACAO DE ' +
  'DESENVOLVIMENTO INFANTIL NIDI  CENTRO DE ATENCAO PSICOSSOCIAL INFANTIL CAPSI E ' +
  'POLICLINICA DA CRIANCA  por meio de Dispensa Eletronica de Licitacao com fundamento ' +
  'no art. 75  inc. II da Lei n  14.133 21  visando atender as necessidades da ' +
  'Secretaria de Saude do Municipio de Olinda'

const SHORT = 'Registro de preços de baterias e pilhas'

describe('tenderObject', () => {
  it('keeps the title inside the card’s budget and the full text whole', () => {
    const { title, full } = tenderObject(OLINDA)
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX + 1) // +1 for the ellipsis
    expect(title.endsWith('…')).toBe(true)
    expect(full.length).toBeGreaterThan(300)
    expect(full).toContain('Secretaria de Saude do Municipio de Olinda')
  })

  it('cleans both the same way, so opening it is not a different sentence', () => {
    const { title, full } = tenderObject('[Portal de Compras Públicas] - AQUISIÇÃO DE DRONES.')
    expect(title).toBe('Aquisição de drones')
    expect(full).toBe('Aquisição de drones')
  })

  it('is expandable only when there is more to read', () => {
    expect(tenderObject(OLINDA).expandable).toBe(true)
    expect(tenderObject(SHORT).expandable).toBe(false)
    // Exactly at the budget: the title is the whole object, so no control.
    expect(tenderObject('a'.repeat(TITLE_MAX)).expandable).toBe(false)
    expect(tenderObject('a'.repeat(TITLE_MAX + 1)).expandable).toBe(true)
  })

  it('never invents text: the full string is the object, collapsed whitespace aside', () => {
    const { full } = tenderObject(OLINDA)
    expect(full.replace(/\s+/g, ' ')).toBe(full)
    for (const word of ['MATERIAIS', 'TERAPEUTICOS', 'NUCLEO']) {
      expect(full.toUpperCase()).toContain(word)
    }
  })
})
