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

  it('attaches the e-mail error to the e-mail field, not only to a card above it', () => {
    // The StateCard alone is a standalone block: somebody tabbing straight
    // into the input was told nothing was wrong, because nothing on the input
    // said so (WCAG 3.3.1 and 1.3.1).
    const out = render({ google: true, magicLink: true }, { error: 'email' })
    expect(out).toContain('aria-invalid="true"')
    expect(out).toContain('aria-describedby="sign-in-email-error sign-in-email-hint"')
    expect(out).toContain('id="sign-in-email-error"')
    // Belt and braces: the card stays, so the message is on the screen for
    // somebody who never reaches the field.
    expect(out).toContain(copy.errorTitle)
    // …and it is the approved string, in both places, not a new sentence.
    expect(out.split(copy.emailMissing).length - 1).toBe(2)
  })

  it('leaves the field valid when the round trip came back clean', () => {
    const out = render({ google: true, magicLink: true })
    expect(out).not.toContain('aria-invalid')
    expect(out).toContain('aria-describedby="sign-in-email-hint"')
  })

  it('puts the required consent tick above the buttons it gates', () => {
    // `required` on this box is what blocks both submits, so the browser
    // points its validation bubble at it. Last in the form, on a 390px phone,
    // that bubble opened below the fold under the button just pressed — the
    // primary CTA looked dead at the last screen before conversion.
    const out = render({ google: true, magicLink: true })
    const tick = out.indexOf('type="checkbox"')
    expect(tick).toBeGreaterThan(-1)
    expect(tick).toBeLessThan(out.indexOf(copy.google))
    expect(tick).toBeLessThan(out.indexOf(copy.emailSubmit))
    // Still inside the one form, or it would gate nothing at all.
    expect(out.indexOf('<form')).toBeLessThan(tick)
  })

  it('keeps the LGPD mechanics the move was not allowed to change', () => {
    const out = render({ google: true, magicLink: true })
    // One box, still required, still never pre-ticked (LGPD art. 8 §4), and
    // still worded with the approved fragments only (legal brief §5).
    expect(out.match(/type="checkbox"/g)).toHaveLength(1)
    expect(out).toContain('required=""')
    expect(out).not.toContain('checked')
    expect(out).toContain(messages.consent.termsBefore)
    expect(out).toContain(messages.consent.termsBetween)
    expect(out).toContain(messages.consent.termsAfter)
  })

  it('draws the tick at 20px, for an audience that is often over 60', () => {
    expect(render({ google: true })).toContain('size-5')
    expect(render({ google: true })).not.toContain('size-4 shrink-0')
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
