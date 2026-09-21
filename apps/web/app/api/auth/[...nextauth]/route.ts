import { handlers } from '@/lib/auth'

/**
 * Auth.js's own endpoints (spec §5): `/api/auth/signin`, `/callback/:provider`,
 * `/signout`, `/session`, `/csrf`, `/providers`.
 *
 * Nothing in the app links to them directly — the screens use the Server
 * Functions in `app/conta/actions.ts`, which is what gives the CSRF token and
 * the redirect handling for free. This file exists because the OAuth provider
 * redirects *here*: **`/api/auth/callback/google`** is the URI that has to be
 * registered in the Google Cloud Console, exactly, for every origin that will
 * ever complete a sign-in.
 *
 * Node runtime, because the adapter talks to Postgres through `pg`.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const { GET, POST } = handlers
