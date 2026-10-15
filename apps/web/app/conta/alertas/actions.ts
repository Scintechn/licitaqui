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
      // `getAll`, because the form renders one field per keyword the plan
      // grants. `get` returned only the first, which is how ten became one.
      keywords: formData.getAll('palavra').map((value) => String(value)),
    },
    limits,
  )

  await ensureAlert(userId, executor)
  await saveAlert(userId, preferences, executor)
  redirect(`${ALERTS_PATH}?estado=salvo`)
}

/**
 * Create a new custom alert with keywords, states, and frequency.
 *
 * Unlike the preferences form which manages a single Telegram weekly digest,
 * this creates a new alert row that the user can manage independently.
 */
export async function createAlert(formData: FormData): Promise<void> {
  const userId = await currentUserId()
  const executor = db()
  const plan = await planOf(userId)
  const limits = await readAlertLimits(plan, executor)

  const keywords = formData.getAll('keywords').map((v) => String(v))
  const states = formData.getAll('states').map((v) => String(v))
  const frequency = String(formData.get('frequency') ?? 'weekly')
  const channel = String(formData.get('channel') ?? 'telegram')

  // Validate input
  if (keywords.length === 0) {
    throw new Error('Adicione pelo menos uma palavra-chave')
  }
  // Empty states means all states (Todo o Brasil)

  // Enforce quota
  const keywordLimit = limits.keywords ?? 10
  if (keywords.length > keywordLimit) {
    throw new Error(
      `Máximo de ${keywordLimit} palavra-chave permitida para seu plano`
    )
  }

  // Trim and dedupe keywords
  const cleanKeywords = Array.from(new Set(keywords.map((k) => k.trim()))).filter(
    (k) => k.length > 0
  )

  // Insert new alert - build raw SQL with proper array handling
  const kw = cleanKeywords.map(k => `'${k.replace(/'/g, "''")}'`).join(',')
  const st = states.length > 0
    ? `array[${states.map(s => `'${s.replace(/'/g, "''")}'`).join(',')}]`
    : `array[]::text[]`
  const ch = `'${channel.replace(/'/g, "''")}'`
  const fr = `'${frequency.replace(/'/g, "''")}'`

  await executor.execute(sql`
    insert into alerts (user_id, kind, keywords, states, channel, frequency, active)
    values (
      ${userId}::bigint,
      'keyword',
      array[${sql.raw(kw)}],
      ${sql.raw(st)},
      ${ch},
      ${fr},
      true
    )
  `)

  // Return success - client will handle redirect
  return { success: true }
}

/**
 * Update an existing alert's keywords, states, and frequency.
 */
export async function updateAlert(
  alertId: string | number,
  formData: FormData
): Promise<void> {
  const userId = await currentUserId()
  const executor = db()
  const plan = await planOf(userId)
  const limits = await readAlertLimits(plan, executor)

  const keywords = formData.getAll('keywords').map((v) => String(v))
  const states = formData.getAll('states').map((v) => String(v))
  const frequency = String(formData.get('frequency') ?? 'weekly')

  // Validate input
  if (keywords.length === 0) {
    throw new Error('Adicione pelo menos uma palavra-chave')
  }
  // Empty states means all states (Todo o Brasil)

  // Enforce quota
  const keywordLimit = limits.keywords ?? 10
  if (keywords.length > keywordLimit) {
    throw new Error(
      `Máximo de ${keywordLimit} palavra-chave permitida para seu plano`
    )
  }

  // Trim and dedupe keywords
  const cleanKeywords = Array.from(new Set(keywords.map((k) => k.trim()))).filter(
    (k) => k.length > 0
  )

  // Update alert (verify ownership)
  const kw = cleanKeywords.map(k => `'${k.replace(/'/g, "''")}'`).join(',')
  const st = states.length > 0
    ? `array[${states.map(s => `'${s.replace(/'/g, "''")}'`).join(',')}]`
    : `array[]::text[]`
  const fr = `'${frequency.replace(/'/g, "''")}'`

  const result = await executor.execute(sql`
    update alerts
    set keywords = array[${sql.raw(kw)}],
        states = ${sql.raw(st)},
        frequency = ${fr}
    where id = ${Number(alertId)}::bigint
      and user_id = ${userId}::bigint
    returning id
  `)

  if (result.rows.length === 0) {
    throw new Error('Alerta não encontrado ou acesso negado')
  }

  // Return success - client will handle redirect
  return { success: true }
}

/**
 * Delete an alert.
 */
export async function deleteAlert(alertId: string | number): Promise<void> {
  const userId = await currentUserId()
  const executor = db()

  // Delete alert (verify ownership)
  const result = await executor.execute(sql`
    delete from alerts
    where id = ${Number(alertId)}::bigint
      and user_id = ${userId}::bigint
    returning id
  `)

  if (result.rows.length === 0) {
    throw new Error('Alerta não encontrado ou acesso negado')
  }

  // Return success - client will handle redirect
  return { success: true }
}
