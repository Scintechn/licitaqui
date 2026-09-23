import { afterEach, describe, expect, it, vi } from 'vitest'
import { magicLinkEmail, REPLY_TO, sendVerificationRequest } from './magic-link-email'

const URL_WITH_PARAMS =
  'https://www.licitaquiapp.com.br/api/auth/callback/resend?callbackUrl=%2Fradar&token=abc123&email=jorge%40exemplo.com.br'

describe('magicLinkEmail', () => {
  it('is in Portuguese, not @auth/core’s English default', () => {
    const mail = magicLinkEmail(URL_WITH_PARAMS)
    // The exact string the built-in template produced, which is what shipped
    // until 2026-09-23 and is the thing this module exists to replace.
    expect(mail.subject).not.toMatch(/sign in/i)
    expect(mail.html).not.toMatch(/sign in/i)
    expect(mail.text).not.toMatch(/sign in/i)
    expect(mail.subject).toBe('Seu link de acesso à LicitaQui')
  })

  it('carries the sign-in link in both parts', () => {
    const mail = magicLinkEmail(URL_WITH_PARAMS)
    expect(mail.text).toContain(URL_WITH_PARAMS)
    // In HTML the ampersands are entities, so assert on the escaped form —
    // and on the href actually pointing at it.
    expect(mail.html).toContain(URL_WITH_PARAMS.replace(/&/g, '&amp;'))
    expect(mail.html).toContain(`href="${URL_WITH_PARAMS.replace(/&/g, '&amp;')}"`)
  })

  it('escapes the URL so a query string cannot break out of the attribute', () => {
    const hostile = 'https://example.com/?a=1"><script>alert(1)</script>'
    const mail = magicLinkEmail(hostile)
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).toContain('&lt;script&gt;')
  })

  it('says the three things MJ-2 promises: one use, 24 hours, and what to ignore', () => {
    const mail = magicLinkEmail(URL_WITH_PARAMS)
    expect(mail.text).toContain('24 horas')
    expect(mail.text).toContain('uma vez só')
    expect(mail.text).toMatch(/Se não foi você que pediu/)
  })

  it('offers a human to reply to (brief §1)', () => {
    expect(REPLY_TO).toBe('contato@licitaquiapp.com.br')
    expect(magicLinkEmail(URL_WITH_PARAMS).text).toContain(REPLY_TO)
  })

  it('loads no remote resource — no image, no pixel, no external stylesheet', () => {
    const { html } = magicLinkEmail(URL_WITH_PARAMS)
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toMatch(/<link/i)
    expect(html).not.toMatch(/url\(/i)
  })
})

describe('sendVerificationRequest', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubFetch(response: Response) {
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  const provider = { apiKey: 'test-key', from: 'LicitaQui <ola@licitaquiapp.com.br>' }

  it('posts to Resend with the reply-to set', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 200 }))
    await sendVerificationRequest({
      identifier: 'jorge@exemplo.com.br',
      url: URL_WITH_PARAMS,
      provider,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [endpoint, init] = fetchMock.mock.calls[0]
    expect(endpoint).toBe('https://api.resend.com/emails')
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.reply_to).toBe(REPLY_TO)
    expect(body.to).toBe('jorge@exemplo.com.br')
    expect(body.subject).toBe('Seu link de acesso à LicitaQui')
    // Both parts, every time: text-only lands in spam, html-only is
    // unreadable where html is stripped.
    expect(body.text).toBeTruthy()
    expect(body.html).toBeTruthy()
  })

  it('throws when Resend refuses, so "Link enviado" is never shown for a mail that failed', async () => {
    stubFetch(new Response('domain not verified', { status: 403 }))
    await expect(
      sendVerificationRequest({
        identifier: 'jorge@exemplo.com.br',
        url: URL_WITH_PARAMS,
        provider,
      }),
    ).rejects.toThrow(/403/)
  })

  it('never puts the address or the token in the error (§12)', async () => {
    stubFetch(new Response('nope', { status: 500 }))
    let message = ''
    try {
      await sendVerificationRequest({
        identifier: 'jorge@exemplo.com.br',
        url: URL_WITH_PARAMS,
        provider,
      })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('500')
    expect(message).not.toContain('jorge@exemplo.com.br')
    expect(message).not.toContain('abc123')
    expect(message).not.toContain('token')
  })
})
