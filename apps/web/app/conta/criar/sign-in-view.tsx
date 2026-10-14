import { Button, Card, Field, StateCard } from '@/components'
import type { ProviderAvailability } from '@/lib/auth/config'
import { ACCOUNT_CREATE_PATH } from '@/lib/routes'
import { messages } from '@/lib/messages'

/**
 * `/conta/criar` — sign in, or create the free Básico account (spec §10, §164).
 *
 * Pure and prop-driven, like every other view here: the page reads the
 * environment and passes the two Server Functions in, so this file renders in a
 * test with no database, no Auth.js and no network.
 *
 * ## One form, two buttons
 *
 * The consent tick is required for both ways in, and `required` on a single
 * checkbox inside a single `<form>` is what enforces it — in the browser,
 * without JavaScript, on the first tap. Google and the magic link are two
 * submit buttons with different `formAction`s rather than two forms, so there
 * is one checkbox on the screen instead of two saying the same thing.
 *
 * The wording of that tick is **not written here**: it is
 * `messages.consent.terms*`, the same fragments task F1 renders on the founders
 * form, which are the approved ones (legal brief §5 — nobody but Sci writes
 * legal sentences). Ticking it is what `users.privacy_consent_at` records.
 *
 * ## When there is no way in
 *
 * A Vercel preview has a one-off hostname and Google forbids wildcard redirect
 * URIs, so unless `AUTH_REDIRECT_PROXY_URL` is set the preview cannot complete
 * an OAuth round trip. Rather than draw a button that fails at Google, the
 * screen says so and points at the Radar, which works for a visitor either way.
 *
 * ## Layout
 *
 * This component returns just the form content (excluding the AppBar and outer
 * main wrapper). The page component wraps it in LoginSplitScreen, which handles
 * the responsive layout and AppBar rendering.
 */

const copy = messages.account.signIn
const consent = messages.consent

export type SignInViewProps = {
  availability: ProviderAvailability
  /** Where to land after signing in. Already validated as a local path. */
  next: string
  /** The magic link was just sent. */
  sent?: boolean
  /** `email` — no address was typed; anything else — the provider refused. */
  error?: 'email' | 'provider' | null | 'validation'
  /** Validation errors for profile fields (signup only) */
  validationErrors?: Record<string, string>
  googleAction: (formData: FormData) => void | Promise<void>
  emailAction: (formData: FormData) => void | Promise<void>
  /** Whether this is a login flow (returning users) or signup flow (new users) */
  mode?: 'login' | 'signup'
}

export function SignInView({
  availability,
  next,
  sent = false,
  error = null,
  validationErrors = {},
  googleAction,
  emailAction,
  mode = 'signup',
}: SignInViewProps) {
  const noWayIn = !availability.google && !availability.magicLink
  const isLogin = mode === 'login'
  const isSignup = mode === 'signup'

  return (
    <>
      <h1 className="font-display text-[26px] leading-tight font-semibold">
        {isLogin ? copy.login.title : copy.title}
      </h1>
      <p className="text-body leading-relaxed text-muted">
        {isLogin ? copy.login.subtitle : copy.subtitle}
      </p>

      {sent ? <StateCard kind="found" title={copy.sentTitle} description={copy.sentBody} /> : null}
      {error === 'email' ? (
        <StateCard kind="empty" title={copy.errorTitle} description={copy.emailMissing} />
      ) : null}
      {error === 'provider' ? (
        <StateCard kind="empty" title={copy.errorTitle} description={copy.errorBody} />
      ) : null}
      {error === 'validation' ? (
        <StateCard
          kind="empty"
          title={copy.errorTitle}
          description="Verifique os campos acima. Todos são obrigatórios para criar a conta."
        />
      ) : null}

      {noWayIn ? (
        <StateCard
          kind="limit"
          title={copy.unavailableTitle}
          description={
            availability.googleUnavailable === 'preview'
              ? copy.unavailablePreview
              : copy.unavailableConfig
          }
        />
      ) : (
        <Card className="flex flex-col gap-4">
          <form className="flex flex-col gap-4">
            <input type="hidden" name="next" value={next} />
            <input type="hidden" name="mode" value={mode} />

            {/*
              Profile fields on signup: name, birth date, mobile, and optional CNPJ.
              Only shown in signup mode. Fields are optional at signup but
              required for billing (per migration 0016_profile_identity.sql).
            */}
            {isSignup ? (
              <div className="flex flex-col gap-4">
                <Field
                  id="signup-name"
                  label={messages.account.profile.nameLabel}
                  name="name"
                  type="text"
                  placeholder={messages.account.profile.namePlaceholder}
                  hint={messages.account.profile.nameHelp}
                  error={validationErrors.name}
                  required
                  autoComplete="name"
                />

                <Field
                  id="signup-birth"
                  label={messages.account.profile.birthLabel}
                  name="birth_date"
                  type="date"
                  hint={messages.account.profile.birthHelp}
                  error={validationErrors.birth_date}
                  required
                />

                <Field
                  id="signup-mobile"
                  label={messages.account.profile.mobileLabel}
                  name="whatsapp"
                  type="tel"
                  placeholder={messages.account.profile.mobilePlaceholder}
                  hint={messages.account.profile.mobileHelp}
                  error={validationErrors.whatsapp}
                  required
                  autoComplete="tel"
                />

                <Field
                  id="signup-cnpj"
                  label={messages.account.profile.cnpjLabel}
                  name="cnpj"
                  type="text"
                  placeholder={messages.account.profile.cnpjPlaceholder}
                  hint={messages.account.profile.cnpjHelp}
                  error={validationErrors.cnpj}
                  inputMode="numeric"
                  autoComplete="organization"
                />
              </div>
            ) : null}

            {/*
              The consent record (§12). Required, never pre-ticked (LGPD art.
              8 §4), and worded only with the approved fragments — the same
              ones the founders form uses.

              It sits **above** both buttons, and that position is the fix,
              not a preference. `required` on this box is what gates the two
              submits, so the browser's own validation bubble points at it —
              and when it was last in the form, on a 390px phone that meant a
              bubble opening below the fold, under the button the user had
              just pressed. What they saw was a primary CTA that did nothing,
              on the last screen before conversion. The mechanics are
              unchanged: one box, one record, still `required`, still not
              pre-ticked. Only the order moved.

              In login flow, the user already consented on signup, so this box
              does not appear.
            */}
            {isSignup ? (
              <label className="flex items-start gap-2.5 text-meta leading-relaxed text-muted">
                <input
                  type="checkbox"
                  name="consent"
                  required
                  /*
                    20px, not 16. The wrapping <label> already makes the
                    effective target pass, so this is comfort rather than
                    compliance — and a good deal of this audience is over 60.
                  */
                  className="mt-0.5 size-5 shrink-0 accent-blue"
                />
                <span>
                  {consent.termsBefore}
                  <a href={messages.legal.termsUrl} className="text-blue">
                    {messages.legal.termsLabel}
                  </a>
                  {consent.termsBetween}
                  <a href={messages.legal.privacyUrl} className="text-blue">
                    {messages.legal.privacyLabel}
                  </a>
                  {consent.termsAfter}
                </span>
              </label>
            ) : null}

            {availability.google ? (
              <Button type="submit" formAction={googleAction} fullWidth iconEnd="arrowRight">
                {isLogin ? copy.login.google : copy.google}
              </Button>
            ) : null}

            {availability.google && availability.magicLink ? (
              <div className="flex items-center gap-3 text-meta text-muted">
                <span aria-hidden className="h-px grow bg-line" />
                {copy.or}
                <span aria-hidden className="h-px grow bg-line" />
              </div>
            ) : null}

            {availability.magicLink ? (
              <>
                <Field
                  id="sign-in-email"
                  label={copy.emailLabel}
                  name="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder={copy.emailPlaceholder}
                  hint={copy.emailHelp}
                  /*
                    The round trip comes back with `?error=email` when no
                    address was typed, and the StateCard above says so — but
                    a StateCard is a standalone block, so the field itself
                    carried no `aria-invalid` and no `aria-describedby`, and
                    somebody tabbing straight into it was told nothing was
                    wrong (3.3.1, 1.3.1). Passing the error here is what
                    attaches the message to the input; `company-form.tsx`
                    does the same with `invalid`. The StateCard stays: the
                    two are not redundant, they serve different ways of
                    arriving at the screen.
                  */
                  error={error === 'email' ? copy.emailMissing : undefined}
                />
                <Button type="submit" formAction={emailAction} variant="secondary" fullWidth>
                  {isLogin ? copy.login.emailSubmit : copy.emailSubmit}
                </Button>
              </>
            ) : null}
          </form>
        </Card>
      )}

      <div className="flex flex-col gap-1">
        {isLogin ? (
          <>
            <Button href={`${ACCOUNT_CREATE_PATH}?mode=signup`} variant="link">
              {copy.login.createAccount}
            </Button>
            <Button href="/radar" variant="link">
              {copy.keepBrowsing}
            </Button>
          </>
        ) : (
          <Button href="/radar" variant="link">
            {noWayIn ? copy.radar : copy.keepBrowsing}
          </Button>
        )}
      </div>
    </>
  )
}
