import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { assertDeepLinkable, type Env, linkSecret, TOKEN_TTL_SECONDS } from './config'

/**
 * The `/start <token>` credential: single-use, short-lived, and a deep link.
 *
 * ## Why the expiry is inside the token
 *
 * `telegram_links` (spec §6.3, `db/migrations/0001_initial.sql:251`) is
 * `user_id`, `chat_id`, `start_token`, `linked_at`. **There is no column for
 * when a token was issued**, and adding one is a schema change, which is its
 * own PR (CLAUDE.md) that E1 would then have to wait for.
 *
 * So the token carries its own clock: four bytes of expiry, twelve bytes of
 * randomness, and a truncated HMAC over both. Editing the expiry invalidates
 * the signature, so it cannot be extended by the person holding it.
 *
 * That is not merely a way around the missing column — it is also what lets a
 * **public, unauthenticated** endpoint reject a junk `/start` without touching
 * the database. `POST /api/telegram/webhook` accepts arbitrary JSON from the
 * internet; making a stranger's guess cost one HMAC instead of one query is
 * worth the sixteen bytes.
 *
 * ## Single use, and supersession
 *
 * The signature proves the token is ours and unexpired. It does **not** prove
 * the token is still outstanding — that is the database's job:
 *
 *  * `issue()` writes the token's digest into `telegram_links.start_token`,
 *    which is `primary key (user_id)`, so minting a second token for the same
 *    account overwrites the first and the first stops working;
 *  * `linkChat()` clears the column in the same statement that sets
 *    `chat_id`, so the token works exactly once.
 *
 * ## The database holds a digest, not the token
 *
 * `start_token` stores `sha256(token)`. A token is a bearer credential — it is
 * enough, on its own, to attach a Telegram chat to somebody's account — and a
 * credential that is only ever compared does not need to be stored in a form
 * that can be used. The column keeps its spec name and its unique index; only
 * the bytes in it changed, and nothing but this file reads them.
 */

/** Big-endian seconds since the epoch, then randomness. 16 bytes, 22 chars. */
const EXPIRY_BYTES = 4
const NONCE_BYTES = 12
const PAYLOAD_BYTES = EXPIRY_BYTES + NONCE_BYTES

/**
 * 120 bits of tag. Not the full 256: the token has to fit Telegram's 64-char
 * `start` parameter alongside the payload, and 120 bits is far beyond forgeable
 * for a value that stops being useful in fifteen minutes.
 */
const SIGNATURE_BYTES = 15

const PAYLOAD_CHARS = Math.ceil((PAYLOAD_BYTES * 4) / 3) // 22
const SIGNATURE_CHARS = Math.ceil((SIGNATURE_BYTES * 4) / 3) // 20
export const TOKEN_CHARS = PAYLOAD_CHARS + SIGNATURE_CHARS // 42, inside Telegram's 64

/**
 * Domain separation. `AUTH_SECRET` also signs Auth.js's own artefacts, so the
 * key actually used here is derived from it with this label and is not the
 * same key.
 */
const KEY_LABEL = 'licitaqui.telegram.start-token.v1'

export type TokenVerdict =
  | { ok: true; expiresAt: Date }
  /** Not a token we ever issued: wrong shape, wrong length, wrong signature. */
  | { ok: false; reason: 'malformed' | 'bad_signature' }
  /** Ours, but too old. The copy for this is `telegram/start-token-invalid`. */
  | { ok: false; reason: 'expired' }

export class LinkSecretMissing extends Error {
  constructor() {
    super('neither TELEGRAM_LINK_SECRET nor AUTH_SECRET is set; /start cannot be signed')
    this.name = 'LinkSecretMissing'
  }
}

function key(env: Env): Buffer {
  const secret = linkSecret(env)
  if (!secret) throw new LinkSecretMissing()
  return createHmac('sha256', secret).update(KEY_LABEL).digest()
}

function sign(payload: Buffer, env: Env): Buffer {
  return createHmac('sha256', key(env)).update(payload).digest().subarray(0, SIGNATURE_BYTES)
}

export type MintedToken = {
  /** What goes in the deep link. Never logged, never stored in the clear. */
  token: string
  /** What goes in `telegram_links.start_token`. */
  digest: string
  expiresAt: Date
}

/**
 * A fresh token. The caller is responsible for storing `digest`; until it does,
 * the token verifies but links nothing.
 */
export function mintToken(
  options: { env?: Env; now?: Date; ttlSeconds?: number } = {},
): MintedToken {
  const env = options.env ?? process.env
  const now = options.now ?? new Date()
  const ttl = options.ttlSeconds ?? TOKEN_TTL_SECONDS
  // Whole seconds: the payload has four bytes for this, so the value that goes
  // in is the value that must come back out. Keeping the milliseconds in the
  // returned `expiresAt` would make it disagree with `verifyToken` by up to a
  // second, which is the kind of difference a test finds and a person does not.
  const expirySeconds = Math.floor(now.getTime() / 1000) + ttl
  const expiresAt = new Date(expirySeconds * 1000)

  const payload = Buffer.alloc(PAYLOAD_BYTES)
  payload.writeUInt32BE(expirySeconds, 0)
  randomBytes(NONCE_BYTES).copy(payload, EXPIRY_BYTES)

  const token = `${payload.toString('base64url')}${sign(payload, env).toString('base64url')}`
  assertDeepLinkable(token)
  return { token, digest: digestOf(token), expiresAt }
}

/**
 * Whether this is a token we issued and it has not expired.
 *
 * Says nothing about whether it is still outstanding — only the database knows
 * that, and `link.ts` asks it. Never throws on input: everything reaching this
 * arrived over a public webhook.
 */
export function verifyToken(
  token: string,
  options: { env?: Env; now?: Date } = {},
): TokenVerdict {
  const env = options.env ?? process.env
  const now = options.now ?? new Date()

  if (typeof token !== 'string' || token.length !== TOKEN_CHARS) {
    return { ok: false, reason: 'malformed' }
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return { ok: false, reason: 'malformed' }

  const payload = Buffer.from(token.slice(0, PAYLOAD_CHARS), 'base64url')
  const presented = Buffer.from(token.slice(PAYLOAD_CHARS), 'base64url')
  if (payload.length !== PAYLOAD_BYTES || presented.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: 'malformed' }
  }

  let expected: Buffer
  try {
    expected = sign(payload, env)
  } catch {
    // Unconfigured is not "invalid token": it is our fault, and the route
    // turns it into a 503 rather than telling the person their link is bad.
    throw new LinkSecretMissing()
  }
  if (!timingSafeEqual(expected, presented)) return { ok: false, reason: 'bad_signature' }

  // The signature is checked *before* the clock, so an expired-but-genuine
  // token and a forgery are distinguishable to us and not to a stranger.
  const expiresAt = new Date(payload.readUInt32BE(0) * 1000)
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' }
  return { ok: true, expiresAt }
}

/** What `telegram_links.start_token` holds. See the file docblock. */
export function digestOf(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
