import type { Metadata } from 'next'
import { messages } from '@/lib/messages'
import { FOUNDERS } from '@/lib/product'
import { readAccountData } from '../account-data'
import { PlanView } from './plan-view'

/**
 * `/conta/plano` — card **D22**, and **F2**'s address when billing opens.
 *
 * `PLAN_PATH` has named this route since U1 and nothing served it, which is
 * why the split lands here: the menu entry that says "Plano e pagamento"
 * already pointed at it, and checkout has a page to open onto on 10-29.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: messages.account.meta.title,
  description: messages.account.meta.description,
  robots: { index: false, follow: false },
}

export default async function PlanPage() {
  const account = await readAccountData()
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
    />
  )
}
