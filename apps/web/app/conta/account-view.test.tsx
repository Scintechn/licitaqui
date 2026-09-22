import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import type { QuotaView } from '@/lib/radar/contract'
import { ALERTS_HREF, PLAN_HREF } from '@/lib/routes'
import { AccountView, formatCnpj, screeningsLabel, type AccountViewProps } from './account-view'

/**
 * `/conta`, plan by plan.
 *
 * The assertion this file exists for is the negative one: **no number on this
 * screen is written in the markup**. The legal brief's §5 says the limits live
 * in `plan_limits` and are changeable without a deploy, so every figure here
 * arrives through `quota` and a component that hard-coded "5" would be lying
 * the first time Sci edited a row.
 */

const copy = messages.account.screen
const noop = () => {}

const BASICO: QuotaView = {
  feature: 'screening',
  plan: 'basico',
  period: 'month',
  limit: 5,
  used: 2,
  left: 3,
}

function render(props: Partial<AccountViewProps> = {}) {
  return renderToStaticMarkup(
    <AccountView
      plan="basico"
      quota={BASICO}
      cnpj={null}
      companyName={null}
      founderSeat={null}
      seatTotal={48}
      signOutAction={noop}
      companyAction={noop}
      notice={null}
      {...props}
    />,
  )
}

describe('screeningsLabel', () => {
  it('reads the monthly allowance out of the quota, never out of the markup', () => {
    expect(screeningsLabel(BASICO)).toBe('2 de 5 neste mês')
    // The same component with a different `plan_limits` row says something else.
    expect(screeningsLabel({ ...BASICO, limit: 9, used: 0 })).toBe('0 de 9 neste mês')
  })

  it('says "sem limite" for a null quantity, not "0"', () => {
    expect(screeningsLabel({ ...BASICO, plan: 'essencial', limit: null, left: null })).toBe(
      copy.screeningsUnlimited,
    )
  })

  it('distinguishes "not included" from "none left"', () => {
    expect(screeningsLabel({ ...BASICO, limit: 0, used: 0, left: 0 })).toBe(copy.screeningsNone)
    expect(screeningsLabel({ ...BASICO, used: 5, left: 0 })).toBe('5 de 5 neste mês')
  })

  it('drops the period wording when the limit is a total, as the visitor’s is', () => {
    expect(screeningsLabel({ ...BASICO, plan: 'visitor', period: 'total', limit: 2, used: 1 })).toBe(
      '1 de 2',
    )
  })
})

describe('formatCnpj', () => {
  it('punctuates fourteen digits the way a Brazilian reads them', () => {
    expect(formatCnpj('12345678000190')).toBe('12.345.678/0001-90')
  })

  it('leaves anything else alone rather than mangling it', () => {
    expect(formatCnpj('123')).toBe('123')
  })
})

describe('AccountView', () => {
  it('names the plan in Portuguese and shows what is left of it', () => {
    const out = render()
    expect(out).toContain(messages.plans.basic.name)
    expect(out).toContain('2 de 5 neste mês')
    expect(out).toContain(copy.signOut)
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

  it('shows a founder their seat, and shows nobody else a seat row', () => {
    const founder = render({ founderSeat: 7 })
    expect(founder).toContain(copy.founderLabel)
    expect(founder).toContain('Vaga 7 de 48')
    expect(founder).toContain(copy.founderNote)
    expect(render()).not.toContain(copy.founderLabel)
  })

  it('links onward only through the route constants, so E1 and F2 move in one edit', () => {
    const out = render()
    expect(out).toContain(`href="${ALERTS_HREF}"`)
    expect(out).toContain(`href="${PLAN_HREF}"`)
    expect(out).toContain('href="/radar"')
  })

  it('leaves no message placeholder unresolved', () => {
    expect(render({ founderSeat: 48, cnpj: '12345678000190' })).not.toMatch(/\{[a-zA-Z]+\}/)
  })
})

/**
 * Task E3's third problem: the company was permanent.
 *
 * `rememberUserCnpj` only ever fills a `null`, and its comment says why —
 * "changing a company is an account setting, not a side effect of one search".
 * The reasoning was right and the setting it deferred to was never built, so
 * the first CNPJ anybody happened to search became theirs for good. A
 * bookkeeper who looked up a client before their own company was stuck.
 */
describe('changing the company', () => {
  it('offers the setting, pre-filled with the CNPJ already on the account', () => {
    const out = render({ cnpj: '12345678000190', companyName: 'Papelaria Aurora' })
    expect(out).toContain(copy.companyTitle)
    expect(out).toContain(copy.companyChange)
    expect(out).toContain('name="cnpj"')
    // Pre-filled and punctuated, so changing it is an edit and not a retype.
    expect(out).toContain('value="12.345.678/0001-90"')
  })

  it('asks for a first one when the account has none', () => {
    const out = render()
    expect(out).toContain(copy.companySave)
    expect(out).not.toContain(copy.companyChange)
  })

  it('posts back to /conta rather than trusting whatever sent it', () => {
    expect(render()).toContain('value="/conta"')
  })

  it('confirms a change, and reports a CNPJ that failed its check digits', () => {
    expect(render({ notice: 'company' })).toContain(copy.companySaved)
    expect(render({ notice: 'cnpj-invalid' })).toContain(copy.companyInvalid)
    expect(render()).not.toContain(copy.companySaved)
  })

  it('explains the wait while company_lookup is still running', () => {
    // `users.cnpj` is set immediately; the `companies` row arrives seconds
    // later with the job. §3 forbids reading BrasilAPI inside the request.
    expect(render({ cnpj: '12345678000190', companyName: null })).toContain(copy.companyPending)
    expect(render({ cnpj: '12345678000190', companyName: 'Papelaria Aurora' })).not.toContain(
      copy.companyPending,
    )
  })
})
