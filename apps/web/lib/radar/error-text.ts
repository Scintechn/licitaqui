import { messages } from '@/lib/messages'
import type { ApiError, ErrorCode } from './contract'

/**
 * `ErrorCode` → a sentence in Brazilian Portuguese.
 *
 * `contract.ts`: "the API never carries Portuguese". Every Radar route answers
 * a code from the union below, and this is the single place that turns one
 * into words — so a new code added to the contract shows up here as a
 * TypeScript error rather than as a blank error state on a phone.
 *
 * Codes that are not specific to the Radar reuse `messages.errors.*`, which E0
 * already wrote and Sci has reviewed; only the Radar's own wording lives under
 * `messages.radar.errors.*`.
 */

const radar = messages.radar.errors
const shared = messages.errors

const TEXT: Record<ErrorCode, string> = {
  validation: radar.validation,
  bad_request: radar.badRequest,
  not_found: radar.notFound,
  rate_limited: shared.rateLimited,
  quota_exceeded: radar.quotaExceeded,
  visitor_expired: radar.visitorExpired,
  account_required: radar.accountRequired,
  server_error: shared.generic,
}

/** Field codes the routes put in `fields`, e.g. `{ cnpj: 'cnpjInvalid' }`. */
const FIELD_TEXT: Record<string, string> = {
  cnpjInvalid: radar.cnpjInvalid,
  cnpjRequired: radar.cnpjRequired,
  stateInvalid: radar.stateInvalid,
  tenderIdInvalid: radar.tenderIdInvalid,
  jobIdInvalid: radar.jobIdInvalid,
}

export function errorText(code: ErrorCode): string {
  return TEXT[code] ?? shared.generic
}

export function fieldErrorText(code: string | undefined | null): string | undefined {
  if (!code) return undefined
  return FIELD_TEXT[code]
}

/**
 * The most useful sentence for a failed response: the field message when the
 * route named a field, the code's message otherwise. `cnpjRequired` on an
 * empty Radar is "digite o CNPJ", which is help; "confira os campos" is not.
 */
export function apiErrorText(error: ApiError): string {
  const first = error.fields ? Object.values(error.fields)[0] : undefined
  return fieldErrorText(first) ?? errorText(error.error)
}

/**
 * A server error on a route that only reads the tender cache is, more often
 * than not, PNCP having been down long enough that there is nothing to read
 * (§9 measured three hours). The catalogue has a sentence that says so without
 * blaming the user, and it is the honest thing to show beside an empty list.
 */
export const PNCP_DOWN = shared.pncpDown
export const NETWORK_ERROR = shared.network
