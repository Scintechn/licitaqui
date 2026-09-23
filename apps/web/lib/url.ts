/**
 * Joining a query string onto a path that may already have one.
 *
 * ## Why this exists
 *
 * On 2026-09-23 every e-mail sign-in landed on a page that did not load. The
 * redirect out of `/api/auth/verify-request` was
 *
 * ```
 * /conta/criar?enviado=1?provider=resend&type=email
 *                       ↑ two `?` in one URL
 * ```
 *
 * because `pages.verifyRequest` carried a query string of its own and
 * `@auth/core` joins that one with `${pages.verifyRequest}${url.search}` — a
 * bare concatenation (`lib/pages/index.js`, the `verifyRequest` branch). The
 * second `?` is not a separator, so `enviado` parsed as `1?provider=resend`,
 * the "Link enviado" panel never rendered, and the screen showed the empty
 * sign-in form again — to somebody whose e-mail had *already been sent*. It
 * looked broken and it had worked, which is the worst possible ordering.
 *
 * The one-line fix was to stop putting a query string in `pages.verifyRequest`
 * (see `lib/auth/index.ts`). This module is the other half: a `?` appended to a
 * value that might already contain one is a **pattern**, not an incident, and
 * the same shape is one careless `next=` away in `app/conta/actions.ts`.
 *
 * `lib/radar/client.ts` has its own `withParams`, which is safe because every
 * caller hands it a path built by `editalPath()`. It is left alone deliberately
 * — it is R2's file and it is provably correct — but if it ever grows a caller
 * that passes a URL with a query, it should call this instead.
 */

/**
 * `base` with `query` appended, using `?` or `&` as `base` requires.
 *
 * Returns `base` unchanged when there is nothing to append, so a caller never
 * has to special-case the empty parameter set.
 *
 * A fragment is preserved and stays last: `/x#top` + `a=1` is `/x?a=1#top`.
 * Nothing in the product builds one today, but a query appended *after* a `#`
 * is not a query at all, and that is the same class of silent breakage this
 * module exists to stop.
 */
export function withQuery(base: string, query: string | URLSearchParams): string {
  const search = typeof query === 'string' ? query.replace(/^[?&]+/, '') : query.toString()
  if (!search) return base

  const hash = base.indexOf('#')
  const path = hash === -1 ? base : base.slice(0, hash)
  const fragment = hash === -1 ? '' : base.slice(hash)

  // `?` only if there is not one already. A base ending in `?` or `&` already
  // has its separator, and adding another would make an empty parameter.
  const separator = !path.includes('?') ? '?' : /[?&]$/.test(path) ? '' : '&'
  return `${path}${separator}${search}${fragment}`
}
