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

  /**
   * One name for the thing, decided by Sci on 2026-09-24: **triagem**.
   *
   * The catalogue had drifted to 23 `triagem*` strings against 21 `leitura*`
   * ones, split straight through the funnel a visitor walks — the landing hero
   * said "2 triagens por IA", the plans card beside it said "2 leituras", the
   * button said "Ver triagem por IA", and the wall that appeared when she ran
   * out said "Suas triagens acabaram" over an API error reading "Suas leituras
   * por IA acabaram". Nothing asserted any of it, which is how all 21 drifted.
   *
   * The one deliberate exception is the AI notice: legal brief §2.2 rule 5
   * makes it mandatory on every result screen and §5 reserves its wording for
   * Sci, so it is excluded here rather than quietly rewritten.
   */
  /**
   * The cadence a sales page promises must be one the scheduler runs.
   *
   * `/fundadores` said *"toda semana no Básico, todo dia no Essencial"* and
   * the landing said *"No Essencial, todo dia"*. There is no daily digest
   * anywhere in the worker — `scheduler.py` holds one entry, `weekly_digest`
   * at Monday 07:00 BRT — and `plan_limits` had an `alert` row for `basico`
   * alone, so a paid plan resolved to **zero** alerts by `readLimit`'s own
   * rule. CDC art. 30 binds an advertised feature.
   *
   * This guards the copy half. The entitlement half is
   * `0006_alert_limits.sql` and `plan-limits.db.test.ts`.
   */
  it('never promises an alert cadence faster than the one that runs', () => {
    const offenders: string[] = []
    const DAILY = /(alerta|aviso|resumo)[^.]{0,80}todo dia|todo dia[^.]{0,80}(alerta|aviso|resumo)/i

    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        if (DAILY.test(node)) offenders.push(`${path}: ${node}`)
        return
      }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          walk(value, path ? `${path}.${key}` : key)
        }
      }
    }
    walk(messages, '')

    expect(offenders).toEqual([])
    // "O governo compra todo dia" is about the buyer, not about us, and stays.
    expect(messages.foundersPage.pain.title).toContain('todo dia')
  })

  it('calls an AI reading a triagem, everywhere but the AI notice', () => {
    const ALLOWED = new Set(['ai.disclaimer'])
    const offenders: string[] = []

    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        if (/leitur/i.test(node) && !ALLOWED.has(path)) offenders.push(`${path}: ${node}`)
        return
      }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          walk(value, path ? `${path}.${key}` : key)
        }
      }
    }
    walk(messages, '')

    expect(offenders).toEqual([])
    // …and the exception is still there, so this does not quietly pass by the
    // notice having been deleted.
    expect(messages.ai.disclaimer).toMatch(/leitura/i)
  })
})
