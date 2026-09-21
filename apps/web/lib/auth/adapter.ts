import { sql } from 'drizzle-orm'
import type { Adapter, AdapterAccount, AdapterSession, AdapterUser } from 'next-auth/adapters'
import { db, type Executor } from '@/lib/db'
import { linkFounderSeat } from './founder-seat'

/**
 * The Auth.js Postgres adapter, written against **our** schema (spec §5, §6.2).
 *
 * ## Why not `@auth/pg-adapter`
 *
 * Migration `0001` already ships `accounts`, `sessions` and `verification_token`
 * with the quoted camel-case column names Auth.js expects, so three of the four
 * tables would have worked as they are. `users` would not: ours is §6.2's, with
 * `plan`, `cnpj`, `founder_seat` and `privacy_consent_at`, and without the
 * `"emailVerified"` and `image` columns the stock adapter inserts into. The
 * stock adapter would therefore have needed a migration to add two columns we
 * do not want, in a separate PR, before U1 could ship at all.
 *
 * Forty lines of SQL against the schema we have is the smaller thing, and it
 * buys two properties the stock adapter cannot give:
 *
 *  - **account creation is ours.** A new user is born on `basico` with their
 *    privacy consent recorded and their founder seat connected (§6.2, §12), in
 *    the same call, rather than in a callback that can be skipped.
 *  - **we store less.** `image` — a Google profile photo URL — is never
 *    written. Nothing in the product shows one, and §12's rule is to collect
 *    what the product uses. `emailVerified` is likewise not stored: the column
 *    exists in Auth.js's model to tell a magic-link address from an unverified
 *    one, and both of our providers only ever hand back an address the provider
 *    itself verified. The adapter reports `null` for both, which is a legal
 *    `AdapterUser` and is read by nothing.
 *
 * If a later card genuinely needs either column, it is a migration in its own
 * PR and three lines here.
 *
 * ## LGPD (§12)
 *
 * No statement in this file is logged, no error message carries an address or a
 * token, and every value is bound. `sessionToken` and the OAuth tokens are
 * written and read, never printed.
 */

type UserRow = {
  id: string
  email: string
  name: string | null
}

type SessionRow = {
  sessionToken: string
  userId: string
  expires: Date | string
}

function toUser(row: UserRow): AdapterUser {
  return {
    id: String(row.id),
    email: row.email,
    name: row.name,
    // Not stored — see the note above. Both are part of `AdapterUser` and are
    // read by nothing in this product.
    image: null,
    emailVerified: null,
  }
}

function toSession(row: SessionRow): AdapterSession {
  return {
    sessionToken: row.sessionToken,
    userId: String(row.userId),
    expires: new Date(row.expires),
  }
}

const USER_COLUMNS = sql`id, email, name`

/**
 * `given ?? db()`, evaluated per call and never at module load.
 *
 * `lib/auth/index.ts` builds the adapter while the module graph is being
 * imported, and `next build` imports every route module with no `DATABASE_URL`
 * set. Resolving the pool eagerly here fails the build on
 * `/api/auth/[...nextauth]` — which is precisely the reason `db()` is lazy in
 * the first place, as its own note says. Tests pass their executor in.
 */
export function licitaquiAdapter(given?: Executor): Adapter {
  const database = (): Executor => given ?? db()

  async function userById(id: string): Promise<AdapterUser | null> {
    const found = await database().execute<UserRow>(sql`
      select ${USER_COLUMNS} from users where id = ${id}::bigint
    `)
    const row = found.rows[0]
    return row ? toUser(row) : null
  }

  return {
    /**
     * A new account.
     *
     * `on conflict (email)` rather than a plain insert: Auth.js calls this only
     * after `getUserByEmail` answered `null`, so two tabs finishing the same
     * Google flow at once would otherwise raise a unique violation and show the
     * second one an error for something that worked.
     *
     * `privacy_consent_at` is set here because this is the moment the person
     * accepted — the sign-in screen states it above the button, in the wording
     * `messages.consent.terms*` already carries (§12, legal brief §5).
     */
    async createUser(user) {
      const created = await database().execute<UserRow>(sql`
        insert into users (email, name, plan, privacy_consent_at)
        values (${user.email}, ${user.name ?? null}, 'basico', now())
        on conflict (email) do update
          set name = coalesce(users.name, excluded.name)
        returning ${USER_COLUMNS}
      `)
      const row = created.rows[0]
      if (!row) throw new Error('createUser wrote no row')
      // A founder who signed the Offer gets their seat on the way in (§6.3).
      await linkFounderSeat(row.id, database())
      return toUser(row)
    },

    getUser: (id) => userById(id),

    async getUserByEmail(email) {
      // `users.email` is `citext`, so this is already case-insensitive.
      const found = await database().execute<UserRow>(sql`
        select ${USER_COLUMNS} from users where email = ${email}
      `)
      const row = found.rows[0]
      return row ? toUser(row) : null
    },

    async getUserByAccount({ provider, providerAccountId }) {
      const found = await database().execute<UserRow>(sql`
        select u.id, u.email, u.name
          from accounts a
          join users u on u.id = a."userId"
         where a.provider = ${provider}
           and a."providerAccountId" = ${providerAccountId}
      `)
      const row = found.rows[0]
      return row ? toUser(row) : null
    },

    /**
     * Auth.js updates only `name` and `email`; everything else on `users` is
     * the product's and must not be touched from here. `coalesce` therefore
     * keeps whatever is already stored when the partial omits a field.
     */
    async updateUser(user) {
      const updated = await database().execute<UserRow>(sql`
        update users
           set name  = coalesce(${user.name ?? null}, name),
               email = coalesce(${user.email ?? null}, email)
         where id = ${user.id}::bigint
        returning ${USER_COLUMNS}
      `)
      const row = updated.rows[0]
      if (!row) throw new Error('updateUser matched no row')
      return toUser(row)
    },

    /** LGPD deletion (§12). `accounts`, `sessions` and `usage` cascade. */
    async deleteUser(userId) {
      await database().execute(sql`delete from users where id = ${userId}::bigint`)
    },

    async linkAccount(account: AdapterAccount) {
      await database().execute(sql`
        insert into accounts (
          "userId", type, provider, "providerAccountId",
          refresh_token, access_token, expires_at, token_type, scope, id_token, session_state
        ) values (
          ${account.userId}::bigint, ${account.type}, ${account.provider}, ${account.providerAccountId},
          ${account.refresh_token ?? null}, ${account.access_token ?? null},
          ${account.expires_at ?? null}, ${account.token_type ?? null},
          ${account.scope ?? null}, ${account.id_token ?? null},
          ${typeof account.session_state === 'string' ? account.session_state : null}
        )
        on conflict (provider, "providerAccountId") do update
          set access_token  = excluded.access_token,
              refresh_token = coalesce(excluded.refresh_token, accounts.refresh_token),
              expires_at    = excluded.expires_at,
              id_token      = excluded.id_token,
              scope         = excluded.scope
      `)
    },

    async unlinkAccount({ provider, providerAccountId }) {
      await database().execute(sql`
        delete from accounts
         where provider = ${provider} and "providerAccountId" = ${providerAccountId}
      `)
    },

    async createSession(session) {
      await database().execute(sql`
        insert into sessions ("sessionToken", "userId", expires)
        values (${session.sessionToken}, ${session.userId}::bigint, ${session.expires.toISOString()}::timestamptz)
      `)
      return session
    },

    async getSessionAndUser(sessionToken) {
      const found = await database().execute<SessionRow & UserRow>(sql`
        select s."sessionToken", s."userId", s.expires, u.id, u.email, u.name
          from sessions s
          join users u on u.id = s."userId"
         where s."sessionToken" = ${sessionToken}
      `)
      const row = found.rows[0]
      if (!row) return null
      return { session: toSession(row), user: toUser(row) }
    },

    async updateSession(session) {
      const updated = await database().execute<SessionRow>(sql`
        update sessions
           set expires = coalesce(${session.expires?.toISOString() ?? null}::timestamptz, expires)
         where "sessionToken" = ${session.sessionToken}
        returning "sessionToken", "userId", expires
      `)
      const row = updated.rows[0]
      return row ? toSession(row) : null
    },

    async deleteSession(sessionToken) {
      await database().execute(sql`delete from sessions where "sessionToken" = ${sessionToken}`)
    },

    /** Magic link (behind the flag until G2). Table is singular, per §6.2. */
    async createVerificationToken(token) {
      await database().execute(sql`
        insert into verification_token (identifier, token, expires)
        values (${token.identifier}, ${token.token}, ${token.expires.toISOString()}::timestamptz)
      `)
      return token
    },

    /** One use only: the delete *is* the read, so a replayed link finds nothing. */
    async useVerificationToken({ identifier, token }) {
      const used = await database().execute<{ identifier: string; token: string; expires: Date | string }>(sql`
        delete from verification_token
         where identifier = ${identifier} and token = ${token}
        returning identifier, token, expires
      `)
      const row = used.rows[0]
      if (!row) return null
      return { identifier: row.identifier, token: row.token, expires: new Date(row.expires) }
    },
  }
}
