import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { COMPANY_PATH } from '@/lib/routes'
import { CompanyView } from './company-view'

/**
 * `/conta/empresa` — card **D22**.
 *
 * These assertions lived in `account-view.test.tsx` while the CNPJ shared one
 * page with the plan and the profile. Splitting the screens split the tests
 * with them: a file covering three screens cannot say which one broke.
 *
 * The task underneath is still E3's third problem — **the company used to be
 * permanent**. `rememberUserCnpj` only ever fills a `null`, correctly, and the
 * setting it deferred to was never built, so the first CNPJ anybody happened
 * to search became theirs for good. A bookkeeper who looked up a client before
 * their own company was stuck.
 */

const copy = messages.account.screen
const noop = () => {}

function render(over: Partial<Parameters<typeof CompanyView>[0]> = {}) {
  return renderToStaticMarkup(
    <CompanyView
      plan="basico"
      planName={messages.plans.basic.name}
      cnpj={null}
      companyName={null}
      notice={null}
      companyAction={noop}
      {...over}
    />,
  )
}

describe('the company screen', () => {
  it('is headed by the words the reader tapped to get here', () => {
    // The heading is `radar.menu.company`, not a new string. A page whose
    // title repeats the menu entry is how navigation stops needing
    // explanation — and it meant D22 invented no user-facing copy.
    expect(render()).toContain(messages.radar.menu.company)
  })

  it('says plainly when no CNPJ has been searched yet', () => {
    expect(render()).toContain(copy.companyNone)
  })

  it('prefers the company name, and falls back to the punctuated CNPJ', () => {
    expect(render({ cnpj: '12345678000190', companyName: 'Papelaria Aurora' })).toContain(
      'Papelaria Aurora',
    )
    expect(render({ cnpj: '12345678000190' })).toContain('12.345.678/0001-90')
  })

  it('offers the setting, pre-filled with the CNPJ already on the account', () => {
    const out = render({ cnpj: '12345678000190' })
    expect(out).toContain(copy.companyTitle)
    expect(out).toContain(copy.companyChange)
  })

  it('asks for a first one when the account has none', () => {
    expect(render()).toContain(copy.companySave)
  })

  it('posts back to this screen, not to the one it was split from', () => {
    // `next` used to be `/conta`, which was the same page. Now it is not, and
    // saving a CNPJ must return the reader where they were rather than to a
    // different screen that happens to share a prefix.
    expect(render()).toContain(COMPANY_PATH)
  })

  it('confirms a change, and reports a CNPJ that failed its check digits', () => {
    expect(render({ notice: 'company' })).toContain(copy.companySaved)
    expect(render({ notice: 'cnpj-invalid' })).toBeTruthy()
  })

  it('explains the wait while company_lookup is still running', () => {
    // A CNPJ with no company row yet is the normal state for a few seconds
    // after saving, and silence there reads as a failure.
    expect(render({ cnpj: '12345678000190', companyName: null })).toContain(copy.companyPending)
  })

  it('leaves no message placeholder unresolved', () => {
    expect(render({ cnpj: '12345678000190' })).not.toMatch(/\{[a-zA-Z]+\}/)
  })
})
