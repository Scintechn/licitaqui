import { Button, Field } from '@/components'
import { formatCnpj } from '@/lib/cnpj'
import { messages } from '@/lib/messages'

/**
 * Ask for the company's CNPJ, wherever it is needed (task E3).
 *
 * One form, two screens. `/conta` uses it to **change** the company — the
 * account setting `lib/auth/session.ts` had been deferring to since U1 without
 * anyone building it, which is why the first CNPJ somebody searched in the
 * Radar became theirs for good. `/conta/alertas` uses it to **ask** for one,
 * because a weekly digest with no company has nothing to match against and the
 * old screen answered that by sending people away to a different feature.
 *
 * Both post to `saveCompany` in `app/conta/actions.ts`; the hidden `next` is
 * how it knows which screen to come back to, and it is run through `safeNext`
 * there rather than trusted here.
 *
 * Pure and prop-driven, so both screens' tests render it with a no-op action.
 *
 * ## The field
 *
 * `mono` and `inputMode="numeric"`, matching the Radar's CNPJ field: the same
 * value typed on the same phones. It is not `type="number"` — a CNPJ is a
 * string of digits with punctuation people paste, not a quantity, and the
 * spinner and locale parsing that come with `number` are both wrong for it.
 *
 * §12: the CNPJ is shown to its owner and goes nowhere else. It is never put in
 * a query string, and `saveCompany` never logs it.
 */

const copy = messages.account.screen

export type CompanyFormProps = {
  /** `saveCompany`. Takes the CNPJ and the `next` path. */
  action: (formData: FormData) => void | Promise<void>
  /** Where to return after saving. Validated server-side by `safeNext`. */
  next: string
  /** The CNPJ already on the account, pre-filled so a change is an edit. */
  cnpj: string | null
  /** True after a redirect carrying `?estado=cnpj-invalido`. */
  invalid?: boolean
  submitLabel: string
  /** `/conta` explains what the company is for; `/conta/alertas` said it already. */
  hint?: boolean
}

export function CompanyForm({
  action,
  next,
  cnpj,
  invalid = false,
  submitLabel,
  hint = true,
}: CompanyFormProps) {
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <Field
        id="conta-cnpj"
        name="cnpj"
        label={messages.radar.landing.cnpjLabel}
        placeholder={messages.radar.landing.cnpjPlaceholder}
        defaultValue={cnpj ? formatCnpj(cnpj) : ''}
        error={invalid ? copy.companyInvalid : undefined}
        hint={hint ? copy.companyHelp : undefined}
        inputMode="numeric"
        mono
      />
      <Button type="submit" variant="secondary">
        {submitLabel}
      </Button>
    </form>
  )
}
