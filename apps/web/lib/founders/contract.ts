/**
 * The wire contract between `/api/founders*` and the offer page's form.
 *
 * Pure types and codes, no database and no copy: the browser imports this file,
 * so it must stay free of Drizzle and `pg`, and every message the user reads is
 * looked up in `messages.founders.*` from the code the API returns.
 */

/** `POST /api/founders` — what happened to the person who just submitted. */
export type SignupOk =
  | { status: 'seated'; seat: number; seatsTaken: number; seatsLeft: number }
  | { status: 'waitlisted'; position: number }
  | { status: 'already_registered'; seat: number | null; position: number | null }

export type SignupErrorCode =
  /** A field is missing or malformed; `fields` says which, as catalogue keys. */
  | 'validation'
  /** The body was not JSON, or not an object. */
  | 'bad_request'
  /** Too many submissions from this address. */
  | 'rate_limited'
  /** Anything unexpected. The browser shows `founders.errors.generic`. */
  | 'server_error'

export type SignupError = {
  status: 'error'
  error: SignupErrorCode
  /** `{ email: 'emailInvalid' }` — keys under `messages.founders.errors`. */
  fields?: Record<string, string>
}

export type SignupResponse = SignupOk | SignupError

/** `GET /api/founders/seats` — what the seat grid draws. */
export type SeatsResponse = {
  total: number
  taken: number
  left: number
  soldOut: boolean
}
