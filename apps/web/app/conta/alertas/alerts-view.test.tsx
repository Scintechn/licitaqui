import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { format, messages } from '@/lib/messages'
import { HANDOFF_MINUTES, type LinkPhase } from '@/lib/telegram/handoff'
import type { AlertLimits } from '@/lib/telegram/quota'
import { AlertsView, type AlertsViewProps, frequencyLabel } from './alerts-view'

/**
 * `/conta/alertas`, rendered with no session and no database — the house
 * pattern for a pure view.
 *
 * E1 pinned one property here: **one control, one tap**, and that the screen
 * never renders a stale `t.me` link. E3 keeps the first and replaces the
 * second, deliberately — see "the hand-off" below.
 */

const BASICO: AlertLimits = { perWeek: 1, keywords: 1, states: 1 }
const BOT = '@LicitaQuiBot'
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBB'

const WAITING: LinkPhase = {
  phase: 'waiting',
  token: TOKEN,
  url: `https://t.me/LicitaQuiBot?start=${TOKEN}`,
  command: `/start ${TOKEN}`,
  expiresAt: new Date('2026-09-22T09:15:00.000Z'),
}

const BASE: AlertsViewProps = {
  phase: { phase: 'idle' },
  active: false,
  limits: BASICO,
  cnpj: '36955612000185',
  companyName: 'Scint Tecnologia',
  botHandle: BOT,
  keyword: null,
  states: [],
  notice: null,
  connectAction: () => {},
  recheckAction: () => {},
  disconnectAction: () => {},
  pauseAction: () => {},
  resumeAction: () => {},
  saveAction: () => {},
  companyAction: () => {},
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

  it('never renders a t.me link before one has been asked for', () => {
    // E1's rule, and it still holds for `idle`: a token in the markup of a page
    // nobody asked to connect from is a token ageing for no reason.
    expect(render()).not.toContain('t.me')
  })
})

/**
 * The state E1 did not have, and the reason E3 is a launch blocker.
 *
 * On 22/09 a `/start` was turned away at the webhook and this screen showed no
 * change whatsoever — the person had pressed the only button there was and the
 * page still offered it. Whatever stops a hand-off, the screen has to be able
 * to say that one is in flight and hand over a way to finish it.
 */
describe('the hand-off', () => {
  it('renders the deep link once a link has actually been issued', () => {
    const html = render({ phase: WAITING })
    expect(html).toContain(WAITING.url)
    expect(html).toContain(messages.telegram.handoff.open)
    // Opened in a new tab so the account page — the only thing that can show
    // the result — survives the trip.
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('shows the /start to send by hand before anything has visibly failed', () => {
    // Somebody whose Telegram opened and sat there does not know an error
    // happened; they know nothing happened. A fallback behind an error state
    // they never reach is not a fallback.
    const html = render({ phase: WAITING })
    expect(html).toContain(`/start ${TOKEN}`)
    expect(html).toContain(messages.telegram.handoff.manualTitle)
    expect(html).toContain(format(messages.telegram.handoff.manualBody, { bot: BOT }))
  })

  it('offers a way to ask again without teaching anybody to press F5', () => {
    expect(render({ phase: WAITING })).toContain(messages.telegram.handoff.recheck)
    expect(render({ phase: WAITING })).toContain(messages.telegram.handoff.stillWaiting)
  })

  it('takes the validity window from the token TTL, never from a literal', () => {
    expect(render({ phase: WAITING })).toContain(
      format(messages.telegram.handoff.validFor, { minutos: HANDOFF_MINUTES }),
    )
  })

  it('says plainly that nothing arrived, and offers another link', () => {
    const html = render({ phase: { phase: 'failed' } })
    expect(html).toContain(messages.telegram.handoff.failedTitle)
    expect(html).toContain(messages.telegram.handoff.failedBody)
    expect(html).toContain(messages.telegram.handoff.newLink)
    // A dead token is never printed: it would link nothing and read as advice.
    expect(html).not.toContain('/start ')
  })

  it('does not leave a failed or waiting screen looking like a fresh start', () => {
    expect(render({ phase: WAITING })).not.toContain(messages.telegram.connect.cta)
    expect(render({ phase: { phase: 'failed' } })).not.toContain(messages.telegram.connect.cta)
  })
})

describe('the CNPJ, asked for where it is needed', () => {
  it('asks for the CNPJ here instead of sending people to the Radar', () => {
    // Task E3's second problem: `rememberUserCnpj` fires as a side effect of a
    // Radar search, so setting up alerts used to mean leaving the account area,
    // using a different feature and coming back.
    const html = render({ cnpj: null, companyName: null })
    expect(html).toContain(messages.telegram.screen.needsCnpjHere)
    expect(html).toContain('name="cnpj"')
    expect(html).toContain(messages.radar.landing.cnpjLabel)
    expect(html).not.toContain(messages.account.screen.radar)
  })

  it('does not offer the connect button until there is a company to match', () => {
    const html = render({ cnpj: null, companyName: null })
    expect(html).toContain(messages.telegram.connect.title)
    expect(html).not.toContain(messages.telegram.connect.cta)
  })

  it('shows the error when the CNPJ did not pass its check digits', () => {
    const html = render({ cnpj: null, companyName: null, notice: 'cnpj-invalid' })
    expect(html).toContain(messages.account.screen.companyInvalid)
  })
})

describe('once connected', () => {
  it('says how often, from plan_limits and never from a literal', () => {
    const html = render({ phase: { phase: 'linked' }, active: true })
    expect(html).toContain(messages.telegram.connected.frequencyBasic)
    expect(html).toContain(messages.telegram.screen.pause)
    expect(html).toContain(messages.telegram.connected.disconnect)
  })

  it('offers "voltar a receber" once paused, and says it is paused', () => {
    const html = render({ phase: { phase: 'linked' }, active: false })
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
    const html = render({
      phase: { phase: 'linked' },
      active: true,
      states: ['RJ'],
      keyword: 'papel',
    })
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
    expect(render({ notice: 'disconnected' })).toContain(
      messages.telegram.connected.disconnected,
    )
    expect(render({ notice: 'company' })).toContain(messages.account.screen.companySaved)
    expect(render({ notice: null })).not.toContain(messages.notifications.saved)
  })
})
