'use server'

import { redirect } from 'next/navigation'
import { auth, signIn, signOut } from '@/lib/auth'
import { setUserCnpj } from '@/lib/auth/session'
import { normaliseCnpj } from '@/lib/cnpj'
import { db } from '@/lib/db'
import { companyOrLookup } from '@/lib/radar/company'
import { ACCOUNT_CREATE_PATH, ACCOUNT_PATH } from '@/lib/routes'

/**
 * The three things the account screens actually *do*, as Server Functions.
 *
 * They live in their own `'use server'` module rather than inline in the pages
 * so that the views stay pure: `sign-in-view.tsx` and `account-view.tsx` take
 * them as props and can therefore be rendered in a test with no-ops, the way
 * every other view in this app is.
 *
 * ## LGPD (§12)
 *
 * The e-mail submitted for a magic link is handed straight to Auth.js and is
 * never logged, never echoed back into the URL and never stored anywhere but
 * `verification_token`, which `useVerificationToken` deletes on first use.
 */

/** Only a path on this site. An absolute URL here would be an open redirect. */
export async function safeNext(next: string | undefined): Promise<string> {
  if (!next) return ACCOUNT_PATH
  // `//evil.com` and `/\evil.com` are both protocol-relative in some browsers.
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return ACCOUNT_PATH
  }
  return next
}

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const next = await safeNext(String(formData.get('next') ?? '') || undefined)
  await signIn('google', { redirectTo: next })
}

export async function signInWithEmail(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim()
  const next = await safeNext(String(formData.get('next') ?? '') || undefined)
  if (!email) {
    // No address typed. Say so on the screen rather than mailing nobody; the
    // address itself never enters the query string.
    redirect(`${ACCOUNT_CREATE_PATH}?erro=email`)
  }
  await signIn('resend', { email, redirectTo: next })
}

/**
 * Set or change the company this account is about (task E3).
 *
 * The setting `lib/auth/session.ts` has been deferring to since U1. Until now
 * `rememberUserCnpj` was the only way a CNPJ ever reached an account and it
 * only ever filled a `null`, so the first company anybody happened to search in
 * the Radar was theirs for good — and setting up alerts meant leaving the
 * account area, using a different feature, and coming back.
 *
 * ## Both screens post here
 *
 * `/conta` changes the company; `/conta/alertas` asks for it when the digest
 * has nothing to match against. Same write, same validation, one place — and
 * `next` says which screen to return to, run through `safeNext` because a
 * Server Function is a POST endpoint anyone can call and an absolute URL in
 * that field would be an open redirect.
 *
 * ## The company row is not waited for, and the order matters
 *
 * §3's golden rule: no web request reads BrasilAPI. `companyOrLookup` runs
 * **first**, exactly as `POST /api/radar/cnpj` does, because an *absent*
 * company is the case where it queues `company_lookup` at priority 1 and wakes
 * the worker — so the name lands in about a second. Doing it the other way
 * round, after `setUserCnpj` has left a placeholder row behind, would turn the
 * same read into a *stale* one: a background-priority refresh with no wake, and
 * a person watching a blank company name for up to two minutes.
 *
 * The write then happens in one transaction, so the placeholder that satisfies
 * `users_cnpj_fkey` and the account change are never half-applied.
 *
 * §12: the CNPJ is never logged, and never put in the redirect's query string.
 */
export async function saveCompany(formData: FormData): Promise<void> {
  const session = await auth()
  const id = session?.user?.id
  const next = await safeNext(String(formData.get('next') ?? '') || undefined)
  if (!id) redirect(ACCOUNT_CREATE_PATH)

  const cnpj = normaliseCnpj(String(formData.get('cnpj') ?? ''))
  if (!cnpj) redirect(`${next}?estado=cnpj-invalido`)

  try {
    await companyOrLookup(cnpj)
  } catch (error) {
    // The setting is worth more than the name. A code, never the CNPJ (§12).
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`company_lookup could not be enqueued (${code})`)
  }
  await db().transaction(async (tx) => setUserCnpj(Number(id), cnpj, tx))
  redirect(`${next}?estado=empresa`)
}

export async function signOutEverywhere(): Promise<void> {
  // `strategy: 'database'`, so this deletes the `sessions` row: the session is
  // over on every device, not just in this browser's cookie jar.
  await signOut({ redirectTo: '/' })
}
