import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProviderAvailability } from '@/lib/auth/config'
import { messages } from '@/lib/messages'
import { SignInView } from './sign-in-view'

/**
 * The sign-in screen, in each state a deployment can put it in.
 *
 * The two that matter most are the ones nobody would think to open: a Vercel
 * preview, where Google cannot complete a round trip, and a deployment with no
 * secrets. Both must produce a page that explains itself and still offers the
 * Radar — never a button that fails at Google.
 */

const copy = messages.account.signIn
const noop = () => {}

function render(availability: Partial<ProviderAvailability>, props = {}) {
  return renderToStaticMarkup(
    <SignInView
      availability={{
        google: false,
        magicLink: false,
        googleUnavailable: null,
        ...availability,
      }}
      next="/conta"
      googleAction={noop}
      emailAction={noop}
      {...props}
    />,
  )
}

describe('SignInView', () => {
  it('draws the Google button and the consent tick when Google is available', () => {
    const out = render({ google: true })
    expect(out).toContain(copy.google)
    expect(out).toContain('type="checkbox"')
    expect(out).toContain('required=""')
    // The wording is the approved one from the founders form, never a new
    // sentence written here (legal brief §5).
    expect(out).toContain(messages.consent.termsBefore)
    expect(out).toContain(`href="${messages.legal.termsUrl}"`)
    expect(out).toContain(`href="${messages.legal.privacyUrl}"`)
  })

  it('never pre-ticks the consent box (LGPD art. 8 §4)', () => {
    expect(render({ google: true })).not.toContain('checked')
  })

  it('carries ?next= through as a hidden field, so the round trip survives', () => {
    const out = render({ google: true }, { next: '/radar/edital/x/triagem' })
    expect(out).toContain('name="next"')
    expect(out).toContain('value="/radar/edital/x/triagem"')
  })

  it('hides the e-mail field until the magic-link flag is on (G2)', () => {
    const withoutEmail = render({ google: true })
    expect(withoutEmail).not.toContain(copy.emailSubmit)
    expect(withoutEmail).not.toContain('name="email"')

    const withEmail = render({ google: true, magicLink: true })
    expect(withEmail).toContain(copy.emailSubmit)
    expect(withEmail).toContain(copy.emailLabel)
    expect(withEmail).toContain('name="email"')
    // Both ways in, one consent tick.
    expect(withEmail.match(/type="checkbox"/g)).toHaveLength(1)
    // …and the "ou" divider between them, which only appears with both.
    // (`copy.or` is the word "ou", which also lives inside the headline, so the
    // divider is asserted by its rule rather than by the word.)
    expect(withEmail).toContain('h-px grow bg-line')
    expect(withoutEmail).not.toContain('h-px grow bg-line')
  })

  it('explains a preview instead of offering a button that cannot work', () => {
    const out = render({ googleUnavailable: 'preview' })
    expect(out).toContain(copy.unavailableTitle)
    expect(out).toContain(copy.unavailablePreview)
    expect(out).not.toContain(copy.google)
    expect(out).not.toContain('type="checkbox"')
    // The visitor path is untouched, so the way out is the Radar.
    expect(out).toContain('href="/radar"')
    expect(out).toContain(copy.radar)
  })

  it('says so plainly when nothing is configured', () => {
    const out = render({ googleUnavailable: 'not_configured' })
    expect(out).toContain(copy.unavailableConfig)
    expect(out).not.toContain(copy.google)
  })

  it('confirms a magic link was sent', () => {
    const out = render({ google: true, magicLink: true }, { sent: true })
    expect(out).toContain(copy.sentTitle)
    expect(out).toContain(copy.sentBody)
  })

  it('reports the two failures the round trip can come back with', () => {
    expect(render({ google: true }, { error: 'email' })).toContain(copy.emailMissing)
    expect(render({ google: true }, { error: 'provider' })).toContain(copy.errorBody)
  })

  it('always offers to keep browsing without an account', () => {
    expect(render({ google: true })).toContain(copy.keepBrowsing)
  })

  it('is written in Brazilian Portuguese, with no key left unresolved', () => {
    const out = render({ google: true, magicLink: true })
    expect(out).toContain(copy.title)
    expect(out).not.toMatch(/\{[a-zA-Z]+\}/)
  })
})
