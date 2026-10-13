/**
 * What somebody typed into the profile form, carried across one rejection —
 * task **F31**.
 *
 * ## Why this exists
 *
 * `saveProfile` answers a rejected field with `redirect(…?erro=…)`, which is a
 * 303 to a fresh **GET**: the POST body is gone by the time the form renders
 * again. The first version of this screen then filled the fields from the
 * database — and for the account this screen exists for, a magic-link signup
 * with `name`, `whatsapp` and `cnpj` all null, that meant **one wrong digit in
 * the CNPJ emptied all three fields**. On the last screen before money. Found
 * by review, 2026-10-13; the view's own comment had claimed the opposite.
 *
 * ## Why a cookie and not the query string, and not `useActionState`
 *
 * **Not the query string**: these are a person's name and mobile number. A URL
 * is in the address bar, in the history, in a screenshot and in any referrer —
 * §12 says a name does not go there.
 *
 * **Not `useActionState`**: the form is a Server Component with no client
 * JavaScript at all, deliberately — `Field` is server-rendered for that
 * reason. Returning state instead of redirecting would make the whole form a
 * client component for three text inputs.
 *
 * A short-lived `httpOnly` cookie is the pattern already in this codebase:
 * `HANDOFF_COOKIE` in `lib/telegram/handoff.ts` does the same thing for the
 * Telegram token, set by an action and read by the screen.
 *
 * ## It is deleted by the action, not by the page
 *
 * A Server Component may **read** cookies and may not write them — Next allows
 * `set`/`delete` only in a Server Function or a route handler. So the page
 * cannot clear it after reading, and the lifecycle is: `saveProfile` writes it
 * on rejection and **deletes it on success**, and `MAX_AGE` is the backstop
 * for somebody who abandons the form. Two minutes, which is long enough to fix
 * a typo and short enough that it is not a store.
 *
 * Nothing here is logged (§12).
 */
import { cookies } from 'next/headers'

export const DRAFT_COOKIE = 'licitaqui_perfil_draft'
/** Scoped to the one screen that reads it. */
export const DRAFT_PATH = '/conta/perfil'
/** Seconds. Long enough to correct a field, short enough not to be storage. */
export const DRAFT_MAX_AGE = 120

export type ProfileDraft = { name: string; birthDate: string; mobile: string; cnpj: string }

/**
 * Caps, so a crafted post cannot push a large cookie back at the browser —
 * which is a way to make somebody's own requests fail. Generous against the
 * schema's own limits (a 120-char name, an E.164 number, 18 CNPJ characters).
 */
const MAX_FIELD = 160

const clip = (value: unknown): string => String(value ?? '').slice(0, MAX_FIELD)

export function encodeDraft(draft: ProfileDraft): string {
  return JSON.stringify({
    n: clip(draft.name),
    b: clip(draft.birthDate),
    m: clip(draft.mobile),
    c: clip(draft.cnpj),
  })
}

/**
 * `null` for anything that is not a draft this module wrote.
 *
 * **Adding a field invalidates cookies written by the previous deploy**, which
 * is intended: the birth date arrived in the same change, and a three-key
 * draft from the version before it would fill three fields from the cookie and
 * the fourth from the database. One person mid-correction at deploy time loses
 * their typed values once, inside `DRAFT_MAX_AGE`, which is 120 seconds — and
 * then the form is pre-filled from the account as it always was.
 */
export function decodeDraft(raw: string | undefined): ProfileDraft | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { n, b, m, c } = parsed as Record<string, unknown>
    // Every key or none: a half-decoded draft would fill some fields from the
    // cookie and the rest from the database, which is the confusing state this
    // module exists to avoid.
    if (
      typeof n !== 'string' ||
      typeof b !== 'string' ||
      typeof m !== 'string' ||
      typeof c !== 'string'
    ) {
      return null
    }
    return { name: clip(n), birthDate: clip(b), mobile: clip(m), cnpj: clip(c) }
  } catch {
    // Not JSON. Somebody else's cookie, or a truncated one.
    return null
  }
}

/** Read it. Safe in a Server Component; does not and cannot clear it. */
export async function readDraft(): Promise<ProfileDraft | null> {
  return decodeDraft((await cookies()).get(DRAFT_COOKIE)?.value)
}
