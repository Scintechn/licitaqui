import { sql } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { messages } from '@/lib/messages'
import { countUsage, FEATURES, quotaView, readLimit } from '@/lib/radar/quota'
import { ACCOUNT_CREATE_PATH } from '@/lib/routes'
import type { QuotaView } from '@/lib/radar/contract'

/**
 * What all three account screens need, read once (card **D22**).
 *
 * `/conta` was one page doing this inline. Splitting it into three would have
 * meant three copies of the same session check, the same `users` read and the
 * same quota arithmetic — and three places for them to drift, which is how
 * `plan_limits` came to be read as zero in one half of the codebase and as
 * uncapped in the other.
 *
 * **The redirects live here too**, deliberately. A signed-out visitor must
 * reach `/conta/criar` from every one of the three, and a session naming a
 * user who is gone — LGPD deletion, a rolled-back database — must too. Leaving
 * that to each page is the kind of thing that is correct on the day it is
 * written and missing from the fourth page somebody adds.
 *
 * `plan_limits` + `usage` are the same two tables the API routes charge
 * against, read through the same module, so no account screen can disagree
 * with what a screening request will actually allow.
 */

type Row = {
  plan: string
  name: string | null
  cnpj: string | null
  founder_seat: number | null
}

export type AccountData = {
  /** The signed-in account. `readAccountData` has already redirected if none. */
  userId: number
  plan: string
  /** The display name, or the raw key when the map has no entry. */
  planName: string
  quota: QuotaView
  cnpj: string | null
  companyName: string | null
  founderSeat: number | null
  /**
   * `users.name`, which may be null: a magic-link signup gives us only an
   * address. Read here because **Asaas requires a name on a customer** and
   * `/conta/plano` has to know whether this account can be billed at all
   * before it offers a subscribe button (F2). Not rendered anywhere — §12
   * keeps a person's name off the screens that do not need it.
   */
  userName: string | null
}

/**
 * `plan_limits` and `users.plan` spell the plans in Portuguese ids; the
 * catalogue keys them in English. One map, rather than a lookup that silently
 * prints a raw id at a person.
 */
const PLAN_NAMES: Record<string, string> = {
  basico: messages.plans.basic.name,
  promocional: messages.plans.promo.name,
  essencial: messages.plans.essential.name,
  pro: messages.plans.pro.name,
}

export async function readAccountData(): Promise<AccountData> {
  const session = await auth()
  const id = session?.user?.id
  if (!id) redirect(ACCOUNT_CREATE_PATH)

  const executor = db()
  const found = await executor.execute<Row>(sql`
    select plan, name, cnpj, founder_seat from users where id = ${id}::bigint
  `)
  const user = found.rows[0]
  // The session names a user who is gone. Signing in again is the only honest
  // next step.
  if (!user) redirect(ACCOUNT_CREATE_PATH)

  const limit = await readLimit(user.plan, FEATURES.screening, executor)
  const used = await countUsage({ userId: Number(id) }, limit, executor)

  const company = user.cnpj
    ? await executor.execute<{ name: string | null }>(sql`
        select coalesce(trade_name, legal_name) as name from companies where cnpj = ${user.cnpj}
      `)
    : null

  return {
    userId: Number(id),
    plan: user.plan,
    planName: PLAN_NAMES[user.plan] ?? user.plan,
    quota: quotaView(limit, used),
    cnpj: user.cnpj,
    companyName: company?.rows[0]?.name ?? null,
    founderSeat: user.founder_seat === null ? null : Number(user.founder_seat),
    userName: user.name,
  }
}
