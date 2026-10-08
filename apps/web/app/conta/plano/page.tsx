import type { Metadata } from 'next'
import { readSubscription } from '@/lib/asaas/subscription'
import { messages } from '@/lib/messages'
import { FOUNDERS } from '@/lib/product'
import { readAccountData } from '../account-data'
import { confirmCancel, goToCheckout, PLAN_STATES, type PlanState } from './actions'
import { PlanView } from './plan-view'

/**
 * `/conta/plano` — cards **D22**, **F2** and **D8**.
 *
 * `PLAN_PATH` has named this route since U1 and nothing served it until D22.
 * F2 makes it the screen the terms of use point at by address, which is why
 * the cancel control belongs here and nowhere else.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: messages.account.meta.title,
  description: messages.account.meta.description,
  robots: { index: false, follow: false },
}

type Search = Promise<{ [key: string]: string | string[] | undefined }>

/**
 * `?estado=` → one of the action module's states, or `null`.
 *
 * Deliberately **not** `app/conta/notice.ts`'s `noticeFrom`: that one returns
 * `AccountNotice`, a two-value union about the company form, and widening it
 * would make every screen that reads it know about billing. The states here
 * are declared beside the actions that redirect with them.
 */
function planState(value: string | string[] | undefined): PlanState | null {
  const one = Array.isArray(value) ? value[0] : value
  return PLAN_STATES.includes(one as PlanState) ? (one as PlanState) : null
}

export default async function PlanPage({ searchParams }: { searchParams?: Search }) {
  const account = await readAccountData()
  const found = await readSubscription(account.userId)
  const search = (await searchParams) ?? {}

  return (
    <PlanView
      plan={account.plan}
      planName={account.planName}
      quota={account.quota}
      founderSeat={account.founderSeat}
      // The offer's size from `docs/product.json`, never `MAX_SEAT` — that is
      // a database CHECK bound, and rendering it told a founder "Vaga 1 de 48"
      // while the terms sold 25 (E19).
      seatTotal={FOUNDERS.seatsTotal}
      subscription={
        found.state === 'found' ? found.subscription
        : found.state === 'unavailable' ? 'unavailable'
        : null
      }
      // Asaas requires a document and a name on a customer. This is the same
      // condition `startCheckout` re-checks server-side; here it decides
      // whether the subscribe button is offered at all, so the action's own
      // `needs_company` branch is a guard rather than the normal path.
      canBill={Boolean(account.cnpj) && Boolean(account.companyName || account.userName)}
      state={planState(search.estado)}
      confirmingCancel={search.cancelar === '1'}
      onCheckout={goToCheckout}
      onCancel={confirmCancel}
    />
  )
}
