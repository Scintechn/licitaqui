import Link from 'next/link'
import { Button, Field } from '@/components'
import { formatCnpj } from '@/lib/cnpj'
import { messages } from '@/lib/messages'
import { AccountChrome } from '../account-chrome'

const copy = messages.account.profile

/**
 * The CNPJ field's value, which arrives from one of two places and must not be
 * mangled by either.
 *
 * `users.cnpj` is `char(14)`, so it is formatted for a reader. A **draft** is
 * whatever was typed a moment ago, possibly mid-correction (`36.955.612/0001-8`
 * is what a rejected one looks like), and `formatCnpj` would rearrange it into
 * something the person did not type. So the mask is applied only to a value
 * that is exactly fourteen digits, which is the only thing the column can hold.
 */
function cnpjValue(value: string | null): string {
  if (!value) return ''
  return /^\d{14}$/.test(value) ? formatCnpj(value) : value
}

/**
 * The profile a subscriber completes before paying — task **F31**.
 *
 * ## Four fields, and the two that are missing are missing on purpose
 *
 * Sci asked for name, birth date, mobile, **CPF or CNPJ** and an optional
 * business name. This renders **name, birth date, mobile and CNPJ**. Two are
 * still absent, each for a written-down reason:
 *
 *  * **The CPF** — the policy names it from v1.4, so it is no longer a legal
 *    blocker; what stops it is Sci's **F32** ruling that a CNPJ stays required
 *    to use the Radar, which leaves a CPF satisfying only Asaas. `users.cpf`
 *    exists and stays empty, and F32 is parked until a CPF-only payer appears.
 *  * **The business name** — there is no column for it. `companies` holds what
 *    the Receita returns for the CNPJ; a trade name somebody types has
 *    nowhere to go, and a field whose answer is discarded is worse than no
 *    field. Carded as **F38**.
 *
 * The birth date arrived with the policy: v1.4 (13/10/2026) names it in §2 and
 * §4(c) and declares the 18+ purpose in §5, which is the amendment this form
 * waited on. It is used for nothing else — see `lib/profile/age.ts`.
 *
 * ## No client JavaScript
 *
 * A plain `<form action={…}>` posting to a Server Function, four
 * `Field`s and a submit. `Field` is a Server Component for exactly this
 * reason. The errors come back through `?erro=` rather than from a client
 * validator, which means **the server's rules are the only rules** — there is
 * no second copy on the client to disagree with `lib/profile/input.ts`.
 *
 * ## The values come back on an error, and that took a cookie
 *
 * `defaultValue` is re-filled from what was typed, because a form that clears
 * itself on a rejected CNPJ is a form somebody abandons — and for the account
 * this screen exists for, a magic-link signup with all three columns null, the
 * first version of it emptied **all three** fields on one wrong digit.
 *
 * It did that while this comment claimed the opposite. The claim was that the
 * values travel in the POST — they do not: `saveProfile` answers a rejection
 * with a redirect, which is a 303 to a fresh GET, and the body is gone. The
 * page then filled the fields from the database. Found by review 2026-10-13,
 * and the false comment was the worst part of it, because it told the next
 * reader this was handled.
 *
 * They now travel in a short-lived `httpOnly` path-scoped cookie
 * (`lib/profile/draft.ts`), which is the pattern `HANDOFF_COOKIE` already uses
 * here. **Not** the query string: a name and a mobile in an address bar are in
 * the history and in every screenshot (§12).
 */
export type ProfileViewProps = {
  /** `saveProfile`. */
  action: (formData: FormData) => void | Promise<void>
  /** Already on the account, so a correction is an edit and not a retype. */
  values: {
    name: string | null
    birthDate: string | null
    mobile: string | null
    cnpj: string | null
  }
  /** Field names from `?erro=`, e.g. `['nome', 'cnpj']`. */
  errors: readonly string[]
  /** For `AccountChrome`'s plan tag, like every other account screen. */
  plan: string
  planName: string
  /** Hide the AccountChrome title when used as a dashboard tab. */
  hideTitle?: boolean
}

export function ProfileView({ action, values, errors, plan, planName, hideTitle }: ProfileViewProps) {
  const failed = (field: string) => errors.includes(field)

  return (
    /*
     * `AccountChrome`, like every other screen under `/conta` — it carries the
     * app bar, the plan tag and the menu. The first version of this view drew
     * its own `<h1>` and nothing else, which left the one screen somebody is
     * sent to mid-checkout with **no way to navigate out of it**, and named a
     * type-scale token that does not exist. The heading is the chrome's.
     *
     * `styles/tokens.test.ts` caught that token, and then caught it a second
     * time **inside this comment**, because the guard greps the file rather
     * than parsing it. So do not spell a non-existent token here, even to
     * record that it was removed.
     */
    <AccountChrome plan={plan} planName={planName} title={copy.title} hideTitle={hideTitle}>
      <p className="text-body text-muted">{copy.subtitle}</p>

      <form action={action} className="flex flex-col gap-4">
        <Field
          id="perfil-nome"
          name="nome"
          label={copy.nameLabel}
          placeholder={copy.namePlaceholder}
          defaultValue={values.name ?? ''}
          error={failed('nome') ? copy.nameInvalid : undefined}
          hint={failed('nome') ? undefined : copy.nameHelp}
          autoComplete="name"
          maxLength={120}
          required
        />

        <Field
          id="perfil-nascimento"
          name="nascimento"
          label={copy.birthLabel}
          defaultValue={values.birthDate ?? ''}
          error={failed('nascimento') ? copy.birthInvalid : undefined}
          hint={failed('nascimento') ? undefined : copy.birthHelp}
          // `type="date"` for the native picker, and because a typed date is
          // ambiguous between dd/mm and mm/dd — `lib/profile/age.ts` takes only
          // the `YYYY-MM-DD` this posts, for the same reason `parseMobile`
          // refuses to guess a country code.
          type="date"
          autoComplete="bday"
          required
        />

        <Field
          id="perfil-celular"
          name="celular"
          label={copy.mobileLabel}
          placeholder={copy.mobilePlaceholder}
          defaultValue={values.mobile ?? ''}
          error={failed('celular') ? copy.mobileInvalid : undefined}
          hint={failed('celular') ? undefined : copy.mobileHelp}
          // `type="tel"`, not `inputMode="numeric"`: a `+` has to be typable,
          // which is the whole of "BR or other country" at the keyboard.
          type="tel"
          autoComplete="tel"
          required
        />

        <Field
          id="perfil-cnpj"
          name="cnpj"
          label={copy.cnpjLabel}
          placeholder={copy.cnpjPlaceholder}
          defaultValue={cnpjValue(values.cnpj)}
          error={failed('cnpj') ? copy.cnpjInvalid : undefined}
          hint={failed('cnpj') ? undefined : copy.cnpjHelp}
          inputMode="numeric"
          autoComplete="off"
          mono
          required
        />

        <Button type="submit">{copy.submit}</Button>
      </form>

      <p className="text-meta leading-[1.45] text-muted">
        {copy.privacy.split('{politica}')[0]}
        <Link href="/privacidade" className="underline hover:no-underline">
          {copy.privacyLink}
        </Link>
        {copy.privacy.split('{politica}')[1]}
      </p>
    </AccountChrome>
  )
}
