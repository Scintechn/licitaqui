import { describe, expect, it } from 'vitest'
import { MIN_WEBHOOK_SECRET_LENGTH, WEBHOOK_SECRET_VAR } from './config'
import { authorizeWebhook, denyWebhook, readUpdate, SECRET_HEADER } from './webhook'

/**
 * The gate on the one public endpoint that writes to `telegram_links`.
 *
 * Every way of *not* being configured has its own case, because "the variable
 * was missing in production" is the failure mode this class of bug actually
 * ships as — not a clever attack.
 */

const SECRET = 'a-webhook-secret-long-enough'
const ENV = { [WEBHOOK_SECRET_VAR]: SECRET }

function headers(value?: string): Headers {
  return new Headers(value === undefined ? {} : { [SECRET_HEADER]: value })
}

describe('authorising a delivery', () => {
  it('accepts the configured secret', () => {
    expect(authorizeWebhook(headers(SECRET), ENV)).toEqual({ ok: true })
  })

  it.each([
    ['no header at all', undefined],
    ['an empty header', ''],
    ['a wrong secret of the same length', 'b-webhook-secret-long-enough'],
    ['a prefix of the secret', SECRET.slice(0, -1)],
    ['the secret with something appended', `${SECRET}x`],
    ['the secret in the wrong case', SECRET.toUpperCase()],
  ])('refuses %s', (_name, value) => {
    expect(authorizeWebhook(headers(value), ENV)).toEqual({ ok: false, reason: 'bad_secret' })
  })

  it.each([
    ['unset', {}],
    ['empty', { [WEBHOOK_SECRET_VAR]: '' }],
    ['whitespace', { [WEBHOOK_SECRET_VAR]: '   ' }],
    ['too short to be worth having', { [WEBHOOK_SECRET_VAR]: 'x'.repeat(MIN_WEBHOOK_SECRET_LENGTH - 1) }],
  ])('fails closed when the secret is %s', (_name, env) => {
    // Note the header is *correct* for the short case — it still denies.
    expect(authorizeWebhook(headers('x'.repeat(MIN_WEBHOOK_SECRET_LENGTH - 1)), env)).toEqual({
      ok: false,
      reason: 'not_configured',
    })
  })

  it('answers 503 for a misconfiguration and 401 for a bad secret', () => {
    expect(denyWebhook('not_configured').status).toBe(503)
    expect(denyWebhook('bad_secret').status).toBe(401)
  })

  it('never says which half was wrong, and never echoes what was presented', async () => {
    const body = await denyWebhook('bad_secret').text()
    expect(body).not.toContain(SECRET)
    expect(body.toLowerCase()).not.toContain('secret')
  })
})

describe('reading an update', () => {
  const chat = { id: 4242, type: 'private' }

  function message(text: string, overrides: Record<string, unknown> = {}) {
    return { update_id: 7, message: { chat, text, ...overrides } }
  }

  it('reads /start with a token', () => {
    expect(readUpdate(message('/start abc123'))).toEqual({
      kind: 'start',
      updateId: 7,
      chatId: 4242,
      token: 'abc123',
    })
  })

  it('reads a bare /start as having no token', () => {
    expect(readUpdate(message('/start'))).toEqual({
      kind: 'start',
      updateId: 7,
      chatId: 4242,
      token: null,
    })
  })

  it('reads /start@LicitaQuiBot, which is what a group sends', () => {
    const update = readUpdate(message('/start@LicitaQuiBot tok'))
    expect(update.kind).toBe('start')
  })

  it.each([
    ['/ajuda', 'help'],
    ['/help', 'help'],
    ['/pausar', 'stop'],
    ['/parar', 'stop'],
    ['/stop', 'stop'],
    ['/AJUDA', 'help'],
  ])('reads %s as %s', (text, kind) => {
    expect(readUpdate(message(text)).kind).toBe(kind)
  })

  it.each([
    ['plain conversation', message('bom dia')],
    ['a command we do not answer', message('/menu')],
    ['a group chat', { update_id: 7, message: { chat: { id: 1, type: 'group' }, text: '/start' } }],
    ['an edited message', { update_id: 7, edited_message: { chat, text: '/start' } }],
    ['a photo with no text', { update_id: 7, message: { chat } }],
    ['no update id', { message: { chat, text: '/start' } }],
    ['no chat', { update_id: 7, message: { text: '/start' } }],
    ['an array', [1, 2, 3]],
    ['null', null],
    ['a string', 'hello'],
  ])('ignores %s', (_name, body) => {
    expect(readUpdate(body)).toEqual({ kind: 'ignore' })
  })

  it('drops an argument longer than Telegram can ever have sent', () => {
    const update = readUpdate(message(`/start ${'a'.repeat(65)}`))
    expect(update).toEqual({ kind: 'start', updateId: 7, chatId: 4242, token: null })
  })
})
