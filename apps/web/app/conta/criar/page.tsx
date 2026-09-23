import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { providerAvailability } from '@/lib/auth/config'
import { magicLinkWasSent, one } from '@/lib/auth/verify-request'
import { messages } from '@/lib/messages'
import { ACCOUNT_PATH } from '@/lib/routes'
import { safeNext, signInWithEmail, signInWithGoogle } from '../actions'
import { SignInView } from './sign-in-view'

/**
 * `/conta/criar` — the address the canvases have always given "Criar conta",
 * and the one `lib/routes.ts` now points every account control at.
 *
 * Dynamic and never cached: it depends on the session cookie and on which
 * providers this deployment can complete (§3.3, "user data: dynamic, no CDN
 * cache"). Someone who is already signed in is sent to `/conta` rather than
 * shown a sign-in form they do not need.
 *
 * `?next=` comes from `accountHref()` — the screening screen sends the tender
 * the visitor was reading so they land back on it. It is run through
 * `safeNext()` before it reaches a redirect: an absolute URL there would be an
 * open redirect with our domain's name on it.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: messages.account.meta.createTitle,
  description: messages.account.meta.createDescription,
  robots: { index: false, follow: false },
}

type Search = Promise<{ [key: string]: string | string[] | undefined }>

export default async function CreateAccountPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams
  const next = await safeNext(one(params.next))

  const session = await auth().catch(() => null)
  if (session?.user) redirect(ACCOUNT_PATH)

  const erro = one(params.erro) ?? one(params.error)

  return (
    <SignInView
      availability={providerAvailability()}
      next={next}
      sent={magicLinkWasSent(params)}
      error={erro === 'email' ? 'email' : erro ? 'provider' : null}
      googleAction={signInWithGoogle}
      emailAction={signInWithEmail}
    />
  )
}
