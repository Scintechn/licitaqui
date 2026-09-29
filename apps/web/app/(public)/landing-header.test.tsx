import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { Header } from './page'

/**
 * That the Landing's button names the session it can see — card **D21**.
 *
 * Signed in, the header said *"Entrar"*: a person with a live account invited
 * to create one, with — in Sci's words — *"no clue if I still logged"*. D20
 * deliberately left the marketing chrome alone, and rightly: a rail offering
 * "Ver planos" on the page selling plans would be absurd. But the button is a
 * different question from the rail, and this one was simply wrong.
 *
 * **No test could have caught it**, because nothing rendered this header with
 * a session at all — there was no session to render it with. That is the same
 * shape as the menu whose trigger was never rendered, and as the three nav
 * items that lit at once: a state the tests never put the component in.
 */

const nav = messages.radar.landing.nav

describe('the Landing header', () => {
  it('offers the Radar to somebody already signed in', () => {
    const html = renderToStaticMarkup(<Header signedIn />)
    expect(html).toContain(nav.toRadar)
    expect(html).not.toContain(nav.signIn)
    expect(html).toContain('href="/radar"')
  })

  it('still offers the account to a visitor', () => {
    const html = renderToStaticMarkup(<Header signedIn={false} />)
    expect(html).toContain(nav.signIn)
    expect(html).not.toContain(nav.toRadar)
  })
})
