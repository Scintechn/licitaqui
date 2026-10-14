'use server'

import { redirect } from 'next/navigation'
import { auth, signIn, signOut } from '@/lib/auth'
import { storeSignupProfile } from '@/lib/auth/adapter'
import { setUserCnpj } from '@/lib/auth/session'
import { normaliseCnpj } from '@/lib/cnpj'
import { db } from '@/lib/db'
import { companyOrLookup } from '@/lib/radar/company'
import { messages } from '@/lib/messages'
import { ACCOUNT_CREATE_PATH } from '@/lib/routes'
import { withQuery } from '@/lib/url'

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
  if (!next) return '/radar'
  // `//evil.com` and `/\evil.com` are both protocol-relative in some browsers.
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return '/radar'
  }
  return next
}

/**
 * Validate and store profile fields for signup.
 *
 * On signup, the form collects profile fields before authentication.
 * This validates them and stores them temporarily in the auth session
 * via URL params, then proceeds with the auth flow.
 *
 * Validation happens here so auth errors remain separate.
 */
async function validateSignupProfile(formData: FormData): Promise<{ valid: true } | { valid: false; errors: Record<string, string> }> {
  const mode = String(formData.get('mode') ?? 'signup')
  if (mode !== 'signup') return { valid: true }

  const errors: Record<string, string> = {}
  const copy = messages.account.profile

  // Name: required
  const name = String(formData.get('name') ?? '').trim()
  if (!name) errors.name = copy.nameInvalid

  // Birth date: required, must be valid and 18+
  const birthDate = String(formData.get('birth_date') ?? '').trim()
  if (!birthDate) {
    errors.birth_date = copy.birthInvalid
  } else {
    const birth = new Date(birthDate)
    const today = new Date()
    let age = today.getFullYear() - birth.getFullYear()
    const monthDiff = today.getMonth() - birth.getMonth()
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--
    }
    if (age < 18) errors.birth_date = copy.birthInvalid
  }

  // Mobile: required, basic validation
  const whatsapp = String(formData.get('whatsapp') ?? '').trim()
  if (!whatsapp || whatsapp.length < 10) errors.whatsapp = copy.mobileInvalid

  // CNPJ: optional but validate format if provided
  const cnpj = String(formData.get('cnpj') ?? '').trim()
  if (cnpj && !/^\d{14}$/.test(cnpj.replace(/\D/g, ''))) {
    errors.cnpj = copy.cnpjInvalid
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors }
  }

  return { valid: true }
}

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const next = await safeNext(String(formData.get('next') ?? '') || undefined)
  const mode = String(formData.get('mode') ?? 'signup')
  const email = String(formData.get('email') ?? '').trim()

  // Validate and store profile fields on signup
  if (mode === 'signup') {
    const validation = await validateSignupProfile(formData)
    if (!validation.valid) {
      // Redirect with validation error flag
      redirect(`${ACCOUNT_CREATE_PATH}?mode=signup&erro=validation`)
    }
    // Store the profile data to be used when creating the user account
    const name = String(formData.get('name') ?? '').trim()
    const birthDate = String(formData.get('birth_date') ?? '').trim()
    const whatsapp = String(formData.get('whatsapp') ?? '').trim()
    const cnpj = String(formData.get('cnpj') ?? '').trim()

    // Google will provide the email, but we should use what's in the form if available
    storeSignupProfile(email || '(pending-google)', {
      name,
      birth_date: birthDate,
      whatsapp,
      cnpj: cnpj || undefined,
    })
  }

  await signIn('google', { redirectTo: next })
}

export async function signInWithEmail(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim()
  const next = await safeNext(String(formData.get('next') ?? '') || undefined)
  const mode = String(formData.get('mode') ?? 'signup')

  if (!email) {
    // No address typed. Say so on the screen rather than mailing nobody; the
    // address itself never enters the query string.
    redirect(`${ACCOUNT_CREATE_PATH}?mode=${mode}&erro=email`)
  }

  // Validate and store profile fields on signup
  if (mode === 'signup') {
    const validation = await validateSignupProfile(formData)
    if (!validation.valid) {
      // Redirect with validation error flag
      redirect(`${ACCOUNT_CREATE_PATH}?mode=signup&erro=validation`)
    }
    // Store the profile data to be used when creating the user account
    const name = String(formData.get('name') ?? '').trim()
    const birthDate = String(formData.get('birth_date') ?? '').trim()
    const whatsapp = String(formData.get('whatsapp') ?? '').trim()
    const cnpj = String(formData.get('cnpj') ?? '').trim()

    storeSignupProfile(email, {
      name,
      birth_date: birthDate,
      whatsapp,
      cnpj: cnpj || undefined,
    })
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
  // `withQuery`, not `${next}?…`: `safeNext` guarantees a local path and
  // nothing more, so `next` may already carry a query string — and a second
  // `?` makes `estado` unreadable, which is exactly how the magic-link
  // confirmation was lost on 2026-09-23. Both call sites pass a bare constant
  // today; neither is required to.
  if (!cnpj) redirect(withQuery(next, 'estado=cnpj-invalido'))

  try {
    await companyOrLookup(cnpj)
  } catch (error) {
    // The setting is worth more than the name. A code, never the CNPJ (§12).
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`company_lookup could not be enqueued (${code})`)
  }
  await db().transaction(async (tx) => setUserCnpj(Number(id), cnpj, tx))
  redirect(withQuery(next, 'estado=empresa'))
}

export async function signOutEverywhere(): Promise<void> {
  // `strategy: 'database'`, so this deletes the `sessions` row: the session is
  // over on every device, not just in this browser's cookie jar.
  await signOut({ redirectTo: '/' })
}
