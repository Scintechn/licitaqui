import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import type { AlertLimits } from '@/lib/telegram/quota'
import { AlertsView, type AlertsViewProps, frequencyLabel } from './alerts-view'

/**
 * `/conta/alertas`, rendered with no session and no database — the house
 * pattern for a pure view.
 *
 * The property worth pinning is the one the card's exit criterion rests on:
 * **one control, one tap.** The connect button is a submit inside a form whose
 * action mints the token and redirects to `t.me`, so there is nothing to copy
 * and nothing to paste, and the screen must never render a stale `t.me` link
 * into the HTML.
 */

const BASICO: AlertLimits = { perWeek: 1, keywords: 1, states: 1 }

const BASE: AlertsViewProps = {
  linked: false,
  active: false,
  limits: BASICO,
  cnpj: '36955612000185',
  companyName: 'Scint Tecnologia',
  keyword: null,
  states: [],
  notice: null,
  connectAction: () => {},
  disconnectAction: () => {},
  pauseAction: () => {},
  resumeAction: () => {},
  saveAction: () => {},
}

function render(overrides: Partial<AlertsViewProps> = {}): string {
  return renderToStaticMarkup(<AlertsView {...BASE} {...overrides} />)
}

describe('before connecting', () => {
  it('offers the one control the exit criterion asks for', () => {
    const html = render()
    expect(html).toContain(messages.telegram.connect.cta)
    expect(html).toContain('type="submit"')
    expect(html).toContain(messages.telegram.connect.help)
  })

  it('never renders a t.me link into the page', () => {
    // A token in the markup is a token that starts ageing on render, and the
    // person who leaves the tab open taps their way to `start-token-invalid`.
    expect(render()).not.toContain('t.me')
  })

  it('sends someone with no CNPJ to the Radar instead of offering a dead button', () => {
    const html = render({ cnpj: null, companyName: null })
    expect(html).toContain(messages.telegram.screen.needsCnpj)
    expect(html).not.toContain(messages.telegram.connect.cta)
    expect(html).toContain(messages.account.screen.radar)
  })
})

describe('once connected', () => {
  it('says how often, from plan_limits and never from a literal', () => {
    const html = render({ linked: true, active: true })
    expect(html).toContain(messages.telegram.connected.frequencyBasic)
    expect(html).toContain(messages.telegram.screen.pause)
    expect(html).toContain(messages.telegram.connected.disconnect)
  })

  it('offers "voltar a receber" once paused, and says it is paused', () => {
    const html = render({ linked: true, active: false })
    expect(html).toContain(messages.telegram.screen.paused)
    expect(html).toContain(messages.telegram.screen.resume)
    expect(html).not.toContain(messages.telegram.screen.pause)
  })

  it('reads the frequency line off the plan, not off the plan name', () => {
    expect(frequencyLabel(BASICO)).toBe(messages.telegram.connected.frequencyBasic)
    expect(frequencyLabel({ perWeek: null, keywords: 10, states: null })).toBe(
      messages.telegram.connected.frequencyPaid,
    )
  })
})

describe('the filters', () => {
  it('pre-fills the state and keyword the account already chose', () => {
    const html = render({ linked: true, active: true, states: ['RJ'], keyword: 'papel' })
    expect(html).toContain('value="RJ" selected')
    expect(html).toContain('value="papel"')
  })

  it('hides the keyword field for a plan that includes none', () => {
    const html = render({ limits: { ...BASICO, keywords: 0 } })
    expect(html).not.toContain('name="palavra"')
    expect(html).toContain('name="uf"')
  })

  it('shows the notice a Server Function redirected back with', () => {
    expect(render({ notice: 'saved' })).toContain(messages.notifications.saved)
    expect(render({ notice: 'disconnected', linked: false })).toContain(
      messages.telegram.connected.disconnected,
    )
    expect(render({ notice: null })).not.toContain(messages.notifications.saved)
  })
})
