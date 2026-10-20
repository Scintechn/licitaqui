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
import { sendVerificationRequest } from './magic-link-email'
import { AUTH_PAGES } from './pages'
import { isProfileComplete } from './profile-check'
import { PROFILE_PATH } from '@/lib/routes'

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
 *
 * ## D45: Auto-funnel new users to checkout
 *
 * New users are detected by the `isNewUser` helper checking their `created_at`.
 * Their profile completeness is checked to determine the redirect destination:
 * - Complete profile (CNPJ + mobile) → `/conta/plano` (checkout)
 * - Incomplete profile → `/conta?tab=perfil` (profile completion)
 * - Existing users → original destination (unchanged)
 */

/**
 * Transient storage for new user IDs during the auth flow.
 * Used to communicate between the signIn event and the redirect callback.
 * In serverless, this is valid for the duration of a single request.
 */
const newUserIds = new Set<string>()

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
    list.push(
      Resend({
        apiKey: resendKey(),
        from: magicLinkFrom(),
        // Without this, `@auth/core` sends its own built-in template: English,
        // "Sign in to www.licitaquiapp.com.br", no reply-to. See
        // `magic-link-email.ts` — and note it throws on a Resend failure, so a
        // message we could not send never renders "Link enviado".
        sendVerificationRequest,
      }),
    )
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
      if (session.user && user) {
        session.user.id = String(user.id)
        // Include createdAt for welcome banner detection on first login
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userWithCreated = user as any
        if (userWithCreated.createdAt) {
          Object.assign(session.user, { createdAt: userWithCreated.createdAt })
        }
      }
      return session
    },
    async redirect({ url, baseUrl }) {
      // D45: Auto-funnel new users from signup to checkout
      // If redirecting to /radar, check if this is a new user and redirect to
      // profile completion or checkout instead, based on profile completeness.
      if (url.includes('/radar')) {
        try {
          // Check if we have a tracked new user to process
          if (newUserIds.size > 0) {
            // Get the first user ID (should be the one from this signIn call)
            const userId = Array.from(newUserIds)[0]
            newUserIds.clear() // Clean up the set

            // Check if user profile is complete (CNPJ + whatsapp)
            const isComplete = await isProfileComplete(userId)

            if (isComplete) {
              // User has complete profile → send to checkout
              return `${baseUrl}/conta/plano`
            } else {
              // User needs to complete profile first
              return `${baseUrl}${PROFILE_PATH}`
            }
          }
        } catch (error) {
          // If anything goes wrong, log it but allow normal flow
          console.error('Error in auth redirect funnel:', error)
        }

        // Default: return URL as-is for non-new-user redirects
        return url
      }

      // For any other redirect, prepend baseUrl if it's a relative path
      if (url.startsWith('/')) {
        return `${baseUrl}${url}`
      }

      // Absolute URLs stay as-is
      return url
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

      // D45: Track new users for auto-funnel redirect
      if (isNewUser) {
        newUserIds.add(String(user.id))
      }

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
