import Link from 'next/link'
import { AppBar, Button, Card, Field, Logo, StateCard } from '@/components'
import type { ProviderAvailability } from '@/lib/auth/config'
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
  error?: 'email' | 'provider' | null
  googleAction: (formData: FormData) => void | Promise<void>
  emailAction: (formData: FormData) => void | Promise<void>
}

export function SignInView({
  availability,
  next,
  sent = false,
  error = null,
  googleAction,
  emailAction,
}: SignInViewProps) {
  const noWayIn = !availability.google && !availability.magicLink

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar
        leading={
          <Link href="/" aria-label={messages.radar.nav.home} className="inline-flex">
            <Logo size={30} />
          </Link>
        }
      />
      <main className="mx-auto flex w-full max-w-[460px] grow flex-col gap-4 px-gutter pt-6 pb-10">
        <h1 className="font-display text-[26px] leading-tight font-semibold">{copy.title}</h1>
        <p className="text-body leading-relaxed text-muted">{copy.subtitle}</p>

        {sent ? <StateCard kind="found" title={copy.sentTitle} description={copy.sentBody} /> : null}
        {error === 'email' ? (
          <StateCard kind="empty" title={copy.errorTitle} description={copy.emailMissing} />
        ) : null}
        {error === 'provider' ? (
          <StateCard kind="empty" title={copy.errorTitle} description={copy.errorBody} />
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

              {availability.google ? (
                <Button type="submit" formAction={googleAction} fullWidth iconEnd="arrowRight">
                  {copy.google}
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
                  />
                  <Button type="submit" formAction={emailAction} variant="secondary" fullWidth>
                    {copy.emailSubmit}
                  </Button>
                </>
              ) : null}

              {/*
                The consent record (§12). Required, never pre-ticked (LGPD art.
                8 §4), and worded only with the approved fragments — the same
                ones the founders form uses.
              */}
              <label className="flex items-start gap-2.5 text-meta leading-relaxed text-muted">
                <input
                  type="checkbox"
                  name="consent"
                  required
                  className="mt-0.5 size-4 shrink-0 accent-blue"
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
            </form>
          </Card>
        )}

        <div className="flex flex-col gap-1">
          <Button href="/radar" variant="link">
            {noWayIn ? copy.radar : copy.keepBrowsing}
          </Button>
        </div>
      </main>
    </div>
  )
}
