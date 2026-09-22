'use server'

import { sql } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { ALERTS_PATH } from '@/lib/routes'
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
 * Mint a `/start` token and send the browser to Telegram.
 *
 * This is the one tap. A server round trip rather than a link rendered with
 * the page, because a token minted at render time is already ageing while the
 * page sits open — and a person who leaves the tab and comes back would tap
 * their way to `start-token-invalid`. Minting on the press means the token is
 * always seconds old when Telegram receives it.
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
  // An external address, which is the point: on a phone this hands the person
  // to the Telegram app with the token already in the `/start`.
  redirect(link.url)
}

export async function disconnectTelegram(): Promise<void> {
  const userId = await currentUserId()
  await unlinkChat(userId)
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
