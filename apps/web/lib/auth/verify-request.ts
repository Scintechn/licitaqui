/**
 * Did we just e-mail this person a magic link?
 *
 * `/conta/criar` is three screens in one: the sign-in form, the error states,
 * and the "check your inbox" confirmation. This module owns the last of those
 * decisions, as a pure function, so it can be tested without Auth.js, a
 * database or a request.
 *
 * ## Two accepted signals, and why
 *
 * `type=email` is **Auth.js's**. When the Resend provider has sent the message
 * it redirects to `${pages.verifyRequest}?provider=<id>&type=<provider type>`
 * (`@auth/core/lib/actions/signin/send-token.js`), and `pages.verifyRequest` is
 * now a bare path precisely so that redirect produces a valid URL. `type` is
 * the provider's *type*, not its id, so it stays `email` whether the transport
 * is Resend, Nodemailer or whatever replaces them.
 *
 * `enviado=1` is **ours**, and is kept for one reason: it is the spelling every
 * internal link and the `seu-jorge` journey already use, and dropping it would
 * turn a URL-syntax fix into a broken test and a broken bookmark. It is an
 * alias, not the contract.
 *
 * Neither signal is trusted with anything. The panel it turns on is static
 * text — "Link enviado", "abra o seu e-mail" — so the worst a hand-typed
 * `?type=email` achieves is telling its own author to check an inbox that has
 * nothing in it. No address is read, echoed or stored here (§12).
 */

/** The `searchParams` shape a Next.js page hands us, already awaited. */
export type SearchParams = { [key: string]: string | string[] | undefined }

/** The first value for a key, since Next gives an array for a repeated one. */
export function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Whether `/conta/criar` should show the "check your inbox" confirmation.
 *
 * Note what this deliberately does **not** do: accept `enviado` with anything
 * appended. Before the redirect was fixed the value arriving here was the
 * literal string `1?provider=resend`, and an implementation that tolerated
 * that — a `startsWith`, a `parseInt` — would have hidden the malformed URL
 * rather than surfaced it. The strict comparison is what made the defect
 * visible on screen, and it stays strict.
 */
export function magicLinkWasSent(params: SearchParams): boolean {
  return one(params.enviado) === '1' || one(params.type) === 'email'
}
