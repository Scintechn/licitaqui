import NextAuth, { type NextAuthConfig } from 'next-auth'
import Google from 'next-auth/providers/google'
import Resend from 'next-auth/providers/resend'
import type { Provider } from 'next-auth/providers'
import { recordEventSafely } from '@/lib/events'
import { licitaquiAdapter } from './adapter'
import {
  magicLinkFrom,
  providerAvailability,
  redirectProxyUrl,
  resendKey,
  SESSION_COOKIE,
  SESSION_COOKIE_SECURE,
} from './config'
import { linkFounderSeat } from './founder-seat'
import { AUTH_PAGES } from './pages'

/**
 * The Auth.js (NextAuth v5) instance — spec §5 and §164.
 *
 * > Auth.js (NextAuth v5) with Postgres adapter. **Decided:** email magic link
 * > + Google. Google works on the `vercel.app` URL; magic link needs a verified
 * > sending domain (§9).
 *
 * So: Google now, magic link behind `AUTH_MAGIC_LINK=1` until G2 verifies the
 * sending domain. `lib/auth/config.ts` decides which of the two this deployment
 * can actually complete, and this file builds exactly those — an unconfigured
 * provider is *absent*, never present and broken.
 *
 * ## Sessions live in Postgres, not in a JWT
 *
 * `strategy: 'database'` is what the adapter is for, and it is what lets
 * `lib/auth/session.ts` answer "who is asking" from one row instead of
 * verifying a token in every route. It also makes signing out real: the row is
 * deleted and the session is over everywhere, which a JWT cannot do.
 *
 * ## Previews
 *
 * Google forbids wildcard redirect URIs and every preview deployment has a new
 * hostname. `redirectProxyUrl` is Auth.js's answer: Google calls back one fixed
 * deployment, which forwards to the preview that started the flow. Without it
 * (`AUTH_REDIRECT_PROXY_URL` unset) the sign-in screen does not offer Google on
 * a preview at all — see `providerAvailability`. Either way the preview builds
 * and the visitor path is untouched.
 *
 * ## LGPD (§12)
 *
 * Nothing here logs an address, a token or a name. The one event recorded on
 * sign-in carries the provider and whether a founder seat was connected.
 */

function providers(): Provider[] {
  const available = providerAvailability()
  const list: Provider[] = []

  if (available.google) {
    list.push(
      Google({
        // Refresh tokens are not requested: nothing in the product calls a
        // Google API on the user's behalf, so the only thing we want from the
        // provider is a verified address (§12: collect what is used).
        authorization: { params: { scope: 'openid email profile', prompt: 'select_account' } },
      }),
    )
  }

  if (available.magicLink) {
    list.push(Resend({ apiKey: resendKey(), from: magicLinkFrom() }))
  }

  return list
}

const secureCookies = (process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? '').startsWith('https')
  || process.env.VERCEL_ENV === 'production'
  || process.env.VERCEL_ENV === 'preview'

export const authConfig: NextAuthConfig = {
  adapter: licitaquiAdapter(),
  providers: providers(),
  session: { strategy: 'database', maxAge: 30 * 24 * 60 * 60 },
  // Behind Vercel or localhost, always. Auth.js needs to be told before it will
  // build a callback URL from the forwarded host.
  trustHost: true,
  redirectProxyUrl: redirectProxyUrl(),
  // Bare paths, every one of them, and `lib/auth/pages.ts` explains what
  // happened on 2026-09-23 when one of them was not.
  pages: { ...AUTH_PAGES },
  cookies: {
    // Pinned so `lib/auth/session.ts` can read it out of the request header.
    // See the note in that file: the API routes must be callable with a plain
    // `Request`, which rules out `next/headers`.
    sessionToken: {
      name: secureCookies ? SESSION_COOKIE_SECURE : SESSION_COOKIE,
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: secureCookies },
    },
  },
  callbacks: {
    session({ session, user }) {
      if (session.user && user) session.user.id = String(user.id)
      return session
    },
  },
  events: {
    /**
     * Run on every sign-in, not only the first: a founder who signed the Offer
     * *after* creating their account would otherwise never get their seat, and
     * during founders week that is the likely order. `linkFounderSeat` only
     * ever fills a `null`, so this cannot move a seat.
     */
    async signIn({ user, account, isNewUser }) {
      if (!user?.id) return
      const seat = await linkFounderSeat(user.id).catch(() => null)
      // Only §14's `account_created`. A repeat sign-in is not a gate metric and
      // adding a name to the closed catalogue in `lib/events` for it would be
      // an edit to a file O1 owns, for a number nobody has asked for.
      if (!isNewUser) return
      await recordEventSafely({
        name: 'account_created',
        userId: Number(user.id),
        props: { provider: account?.provider ?? null, founder_seat: seat },
      })
    },
  },
}

export const { handlers, signIn, signOut, auth } = NextAuth(authConfig)
