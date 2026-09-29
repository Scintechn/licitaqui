import { headers } from 'next/headers'
import { db } from '@/lib/db'
import { hasAccount, readViewer } from './viewer'

/**
 * Whether this request carries a signed-in account, read on the server.
 *
 * ## Why a screen needs this at all
 *
 * §8's rule is that an account *adds capability* and is never a precondition,
 * so almost nothing asks. The exception is the files: *"files only with an
 * account"*. The screening screen's **Documentos** tab was written to that
 * rule and applied it to everybody — it was an unconditional locked link to
 * `accountHref(...)`, so a paying Essencial subscriber met a padlock and a
 * bounce to `/conta` for documents they could open one screen back. Sci found
 * it on his own account on 2026-09-29.
 *
 * ## Why not the visitor field the screen already has
 *
 * `ScreeningResponse.visitor` is `null` for an account **and** for a caller
 * with no viewer at all, because `visitorWindow()` returns null whenever the
 * caller is not a visitor. Reading that absence as "has an account" is the
 * same move as reading a missing `plan_limits` row as zero — an absence
 * standing in for a fact, which this repo has now been bitten by twice.
 *
 * So: ask, once, on the server, where the request is.
 *
 * `headers().get('cookie')` and not `cookies()`: the latter returns values
 * already percent-decoded and `sessionTokenFromCookies` decodes again, which
 * threw `URIError` on an unrelated cookie and told a subscriber they had no
 * plan. Same reasoning as `readPriceBandEntitlement`.
 *
 * A failed read answers `false` — the locked link, which is wrong for an
 * account and harmless, rather than unlocking files for somebody who may have
 * no account at all.
 */
export async function readHasAccount(): Promise<boolean> {
  try {
    return hasAccount(await readViewer((await headers()).get('cookie'), db()))
  } catch {
    return false
  }
}
