import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { format, messages } from '@/lib/messages'
import type { QuotaView } from '@/lib/radar/contract'
import { ALERTS_HREF, COMPANY_PATH, PLAN_PATH } from '@/lib/routes'
import { AccountView, formatCnpj, screeningsLabel } from './account-view'

/**
 * `/conta` — the profile, since **D22** split this screen in three.
 *
 * It was one page doing three jobs, with three menu entries pointing at it.
 * The plan assertions now live in `plano/plan-view.test.tsx` and the company
 * ones in `empresa/company-view.test.tsx`, deliberately: a test file covering
 * three screens cannot say which one broke.
 *
 * `screeningsLabel` and `formatCnpj` stay here because they are still exported
 * from this module and used by the screens that moved.
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

const EMAIL = 'quem.sou.eu@example.com'

function render(email: string = EMAIL) {
  return renderToStaticMarkup(
    <AccountView
      email={email}
      plan="basico"
      planName={messages.plans.basic.name}
      signOutAction={noop}
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

describe('AccountView — the profile', () => {
  it('names the plan and offers the way out', () => {
    const out = render()
    expect(out).toContain(messages.plans.basic.name)
    expect(out).toContain(copy.signOut)
  })

  it('leads to the other two account screens, not back to itself', () => {
    // The point of D22. Before the split, "Minha empresa" and "Plano e
    // pagamento" both pointed at `/conta` — three menu entries, one room.
    const out = render()
    expect(out).toContain(`href="${COMPANY_PATH}"`)
    expect(out).toContain(`href="${PLAN_PATH}"`)
    expect(COMPANY_PATH).not.toBe(PLAN_PATH)
  })

  it('links onward only through the route constants, so E1 and F2 move in one edit', () => {
    const out = render()
    expect(out).toContain(`href="${ALERTS_HREF}"`)
    expect(out).toContain('href="/radar"')
  })

  it('leaves no message placeholder unresolved', () => {
    expect(render()).not.toMatch(/\{[a-zA-Z]+\}/)
  })
})

describe('the LGPD data-subject line (legal brief §1)', () => {
  it('is rendered, now that there is a real address to name', () => {
    // `support.email` was the string "TODO(Sci): endereço de contato", so this
    // sentence was suppressed rather than ship a placeholder. Brief §1 calls
    // the channel mandatory, which made a suppressed sentence the wrong fix
    // and a missing address the actual bug.
    expect(render()).toContain(messages.legal.dataRequest.split('{email}')[0])
  })

  it('names privacidade@, the mandatory channel — not contato@', () => {
    const out = render()
    expect(out).toContain('privacidade@licitaquiapp.com.br')
    expect(out).toContain(
      format(messages.legal.dataRequest, { email: messages.support.privacyEmail }),
    )
  })

  it('never ships a TODO to a data subject', () => {
    expect(render()).not.toContain('TODO')
    expect(messages.support.email).not.toContain('TODO')
    expect(messages.support.privacyEmail).not.toContain('TODO')
  })
})

describe('AccountView — who is signed in (D22)', () => {
  it('shows the address, because the page asks "sua conta" and never said whose', () => {
    expect(render()).toContain(EMAIL)
  })

  it('renders whatever address it is given, never a fixture of its own', () => {
    // The first version of this test asserted `EMAIL` against a component that
    // could have hardcoded it and passed. A second address is what makes the
    // prop load-bearing.
    const other = 'outra.pessoa@example.com'
    const out = render(other)
    expect(out).toContain(other)
    expect(out).not.toContain(EMAIL)
  })

  it('reads the address out of `users`, not only out of a prop', () => {
    // `environment: 'node'` cannot run `readAccountData`, and a view-only
    // assertion passes for ever against a prop nothing populates — which is
    // exactly how `radar.opportunity.screeningCost` shipped. The end-to-end
    // proof is `e2e/accounts/conta-destinations.spec.ts`, which needs a real
    // session and so cannot run in CI; this is the merge-blocking half.
    const source = readFileSync(new URL('./account-data.ts', import.meta.url), 'utf8')
    // Matched as a shape, not a spelling: `task/f2-asaas-subscriptions` adds
    // `name` to this same select, and a literal would go red on a correct
    // merge. What must hold is that the query reads `email` from `users`.
    expect(source).toMatch(/select[^`]*\bemail\b[^`]*from users/)
    expect(source).toContain('email: user.email,')
  })
})
