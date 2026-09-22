'use server'

import { sql } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { ALERTS_PATH } from '@/lib/routes'
import {
  HANDOFF_COOKIE,
  HANDOFF_MAX_AGE,
  HANDOFF_PATH,
} from '@/lib/telegram/handoff'
import {
  ensureAlert,
  issueStartLink,
  saveAlert,
  setAlertActive,
  unlinkChat,
} from '@/lib/telegram/link'
import { clampPreferences, readAlertLimits } from '@/lib/telegram/quota'

/**
 * What `/conta/alertas` actually *does*, as Server Functions.
 *
 * Its own `'use server'` module, like `app/conta/actions.ts`, so the view stays
 * pure and renders in a test with no-ops for these.
 *
 * ## Every one of them re-reads the session
 *
 * A Server Function is a POST endpoint with a generated name: the button that
 * calls it is not the only thing that can. So none of these takes a user id
 * from its caller — they read the session themselves and act on that account,
 * and a signed-out call redirects instead of doing anything.
 *
 * ## The quota is enforced here, not in the markup
 *
 * §8: "quota checks: always server-side". The screen renders one keyword field
 * and one state select **because** `plan_limits` says Básico gets one of each,
 * and :func:`clampPreferences` trims the submission to the same numbers, so a
 * hand-made POST asking for five states saves one.
 */

async function currentUserId(): Promise<number> {
  const session = await auth()
  const id = session?.user?.id
  if (!id) redirect(ALERTS_PATH)
  return Number(id)
}

async function planOf(userId: number): Promise<string> {
  const found = await db().execute<{ plan: string }>(sql`
    select plan from users where id = ${userId}::bigint
  `)
  return found.rows[0]?.plan ?? 'basico'
}

/**
 * Mint a `/start` token and show the hand-off, instead of vanishing into it.
 *
 * E1 redirected this straight to `https://t.me/…`. One tap, and a cliff: once
 * the browser left, nothing on our side could tell a link that worked from one
 * that did not, which is how 22/09's failure — a webhook answering 401 to every
 * delivery because production's secret did not match the one `setWebhook` was
 * given — showed up on `/conta/alertas` as no change at all.
 *
 * So the redirect now lands back on `/conta/alertas`, which renders the deep
 * link as the primary control plus everything the person needs when tapping it
 * does not finish the job. That is one extra tap and it buys a hand-off that
 * can be observed, retried and completed by hand — the whole of task E3's first
 * problem. The `t.me` link is still one tap from that screen, and it is still
 * seconds old when it gets there, which is what E1's note about render-time
 * tokens was actually protecting.
 *
 * The plaintext token goes in a short-lived cookie because the database keeps
 * only its digest and the manual fallback has to print the real thing. See
 * `lib/telegram/handoff.ts`.
 *
 * The `alerts` row is written first, so a person who completes the link is
 * subscribed to something rather than connected to nothing.
 */
export async function connectTelegram(): Promise<void> {
  const userId = await currentUserId()
  const executor = db()
  await ensureAlert(userId, executor)
  await setAlertActive(userId, true, executor)
  const link = await issueStartLink(userId, { database: executor })

  const jar = await cookies()
  jar.set(HANDOFF_COOKIE, link.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: HANDOFF_PATH,
    maxAge: HANDOFF_MAX_AGE,
  })

  redirect(ALERTS_PATH)
}

/**
 * "Já conectei, verificar" — reload the page and look again.
 *
 * It does nothing on purpose. The bot's `/start` is what links the account, and
 * it arrives through the webhook while this page is not looking; the button is
 * simply a way to ask the question again without teaching anybody to press
 * F5. A no-op Server Function is also the cheapest honest answer: polling would
 * mean a client component and an endpoint, for a wait that is normally one
 * second (`wakeWorker`) and at worst a page refresh.
 */
export async function recheckTelegram(): Promise<void> {
  await currentUserId()
  redirect(ALERTS_PATH)
}

export async function disconnectTelegram(): Promise<void> {
  const userId = await currentUserId()
  await unlinkChat(userId)
  // Otherwise a hand-off cookie left over from the connection being undone
  // would put the screen straight back into "waiting" (task E3).
  ;(await cookies()).delete({ name: HANDOFF_COOKIE, path: HANDOFF_PATH })
  redirect(`${ALERTS_PATH}?estado=desconectado`)
}

export async function pauseTelegram(): Promise<void> {
  const userId = await currentUserId()
  await setAlertActive(userId, false)
  redirect(ALERTS_PATH)
}

export async function resumeTelegram(): Promise<void> {
  const userId = await currentUserId()
  await ensureAlert(userId)
  await setAlertActive(userId, true)
  redirect(ALERTS_PATH)
}

export async function savePreferences(formData: FormData): Promise<void> {
  const userId = await currentUserId()
  const executor = db()
  const limits = await readAlertLimits(await planOf(userId), executor)

  const preferences = clampPreferences(
    {
      states: formData.getAll('uf').map((value) => String(value)),
      keyword: String(formData.get('palavra') ?? ''),
    },
    limits,
  )

  await ensureAlert(userId, executor)
  await saveAlert(userId, preferences, executor)
  redirect(`${ALERTS_PATH}?estado=salvo`)
}
