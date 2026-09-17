import { describe, expect, it } from 'vitest'
import { format, messages } from './messages'

describe('format', () => {
  it('substitutes named arguments', () => {
    expect(format('Vaga garantida, {nome}!', { nome: 'Ana' })).toBe('Vaga garantida, Ana!')
  })

  it('substitutes numbers and repeated arguments', () => {
    expect(format('{n} de {n}', { n: 48 })).toBe('48 de 48')
  })

  it('leaves an unknown argument visible instead of dropping it', () => {
    expect(format('Olá, {quemQuer}.')).toBe('Olá, {quemQuer}.')
  })

  it('leaves text without arguments untouched', () => {
    expect(format('Sem fidelidade.')).toBe('Sem fidelidade.')
  })

  it('picks the exact "=0" branch before the plural category', () => {
    expect(format(messages.founders.seats.left, { count: 0 })).toBe('Vagas esgotadas')
  })

  it('picks "one" for a single item', () => {
    expect(format(messages.founders.seats.left, { count: 1 })).toBe('Resta 1 vaga')
  })

  it('picks "other" and replaces # with the count', () => {
    expect(format(messages.founders.seats.left, { count: 12 })).toBe('Restam 12 vagas')
    expect(format(messages.founders.seats.left, { count: 48 })).toBe('Restam 48 vagas')
  })

  it('does not choke on an unbalanced brace', () => {
    expect(format('R$ 26 {por mês')).toBe('R$ 26 {por mês')
  })

  it('ignores a format it does not implement rather than guessing', () => {
    expect(format('{valor, number, currency}', { valor: 26 })).toBe('{valor, number, currency}')
  })

  it('keeps the plural untouched when the count is not a number', () => {
    expect(format(messages.founders.seats.left, { count: 'muitas' })).toBe(
      messages.founders.seats.left,
    )
  })
})

describe('messages', () => {
  it('is the pt-BR catalogue the offer page reads from', () => {
    expect(messages.brand.name).toBe('LicitaQui')
    expect(messages.foundersPage.hero.promises).toHaveLength(4)
  })
})
