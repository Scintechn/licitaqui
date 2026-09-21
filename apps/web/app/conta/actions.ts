'use server'

import { redirect } from 'next/navigation'
import { signIn, signOut } from '@/lib/auth'
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

export async function signOutEverywhere(): Promise<void> {
  // `strategy: 'database'`, so this deletes the `sessions` row: the session is
  // over on every device, not just in this browser's cookie jar.
  await signOut({ redirectTo: '/' })
}
