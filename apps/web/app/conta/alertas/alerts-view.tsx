import Link from 'next/link'
import { AppBar, Button, Card, CardRow, Field, Logo, SectionLabel, Select } from '@/components'
import { messages } from '@/lib/messages'
import { UF_OPTIONS } from '@/lib/radar/ufs'
import { type AlertLimits, MAX_KEYWORD_CHARS } from '@/lib/telegram/quota'

/**
 * `/conta/alertas` — connect Telegram, and say what the weekly digest should
 * carry (task E1, spec §10).
 *
 * Pure and prop-driven, like `account-view.tsx`: every action arrives as a
 * prop, so the screen renders in a test with no session and no database.
 *
 * ## The whole screen is one tap
 *
 * The card's exit criterion is *"link in one tap from phone"*, so the primary
 * control is a single submit button. Pressing it mints a token server-side and
 * redirects to `https://t.me/LicitaQuiBot?start=…`, which on a phone hands the
 * person straight to the Telegram app with the token already in the `/start`.
 * Nothing is copied, nothing is typed, and the token is seconds old when it
 * arrives — see `actions.ts` for why it is minted on the press rather than
 * rendered into the page.
 *
 * ## The form shows the plan's shape
 *
 * One state select and one keyword field, because Básico's `plan_limits` rows
 * say one of each (§10). The numbers arrive as `limits`; nothing here is a
 * literal, and `clampPreferences` applies the same numbers to the submission,
 * so the markup and the write cannot disagree.
 *
 * ## The CNPJ gate
 *
 * A digest is "the open tenders that match *your* company", and the matching is
 * `company_segments` over the account's CNAEs. With no CNPJ there is nothing to
 * match and the worker would skip the send — so the connect button is replaced
 * by the way to fix it, rather than offered and then quietly doing nothing.
 */

const copy = messages.telegram
const prefs = messages.notifications

export type AlertNotice = 'saved' | 'disconnected' | null

export type AlertsViewProps = {
  /** Whether a Telegram chat is attached to this account. */
  linked: boolean
  /** Whether the weekly digest is switched on. False after `/pausar`. */
  active: boolean
  /** §10's caps for this plan, from `plan_limits`. */
  limits: AlertLimits
  /** The account's CNPJ, or `null` — the digest needs one. */
  cnpj: string | null
  companyName: string | null
  keyword: string | null
  states: string[]
  /** `?estado=…` after a Server Function redirected back here. */
  notice: AlertNotice
  connectAction: () => void | Promise<void>
  disconnectAction: () => void | Promise<void>
  pauseAction: () => void | Promise<void>
  resumeAction: () => void | Promise<void>
  saveAction: (formData: FormData) => void | Promise<void>
}

/** "Você recebe 1 aviso por semana." — or the paid line. From `plan_limits`. */
export function frequencyLabel(limits: AlertLimits): string {
  return limits.perWeek === 1 ? copy.connected.frequencyBasic : copy.connected.frequencyPaid
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-meta leading-relaxed text-muted">{children}</p>
}

export function AlertsView({
  linked,
  active,
  limits,
  cnpj,
  companyName,
  keyword,
  states,
  notice,
  connectAction,
  disconnectAction,
  pauseAction,
  resumeAction,
  saveAction,
}: AlertsViewProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar
        leading={
          <Link href="/" aria-label={messages.radar.nav.home} className="inline-flex">
            <Logo size={30} />
          </Link>
        }
      />
      <main className="mx-auto flex w-full max-w-[560px] grow flex-col gap-4 px-gutter pt-6 pb-10">
        <h1 className="font-display text-[26px] leading-tight font-semibold">{prefs.title}</h1>
        <Note>{prefs.intro}</Note>

        {notice === 'saved' ? (
          <Card accent>
            <p className="text-meta leading-relaxed">{prefs.saved}</p>
          </Card>
        ) : null}
        {notice === 'disconnected' ? (
          <Card>
            <p className="text-meta leading-relaxed">{copy.connected.disconnected}</p>
          </Card>
        ) : null}

        <section className="flex flex-col gap-3">
          <SectionLabel>{prefs.telegramLabel}</SectionLabel>

          {linked ? (
            <>
              <Card padding="none">
                <div className="px-4 py-1">
                  <CardRow
                    label={copy.connected.title}
                    value={companyName ?? prefs.telegramHelp}
                  />
                  <CardRow label={prefs.digestLabel} value={frequencyLabel(limits)} last />
                </div>
              </Card>

              {active ? null : <Note>{copy.screen.paused}</Note>}

              <div className="flex flex-col gap-2 min-[560px]:flex-row">
                <form action={active ? pauseAction : resumeAction}>
                  <Button type="submit" variant="secondary">
                    {active ? copy.screen.pause : copy.screen.resume}
                  </Button>
                </form>
                <form action={disconnectAction}>
                  <Button type="submit" variant="secondary">
                    {copy.connected.disconnect}
                  </Button>
                </form>
              </div>
            </>
          ) : (
            <>
              <Card>
                <h2 className="font-display text-[18px] leading-tight font-semibold">
                  {copy.connect.title}
                </h2>
                <p className="pt-1 text-meta leading-relaxed text-muted">{copy.connect.body}</p>
              </Card>

              {cnpj ? (
                <>
                  <form action={connectAction}>
                    <Button type="submit" iconEnd="arrowRight">
                      {copy.connect.cta}
                    </Button>
                  </form>
                  <Note>{copy.connect.help}</Note>
                  <Note>{copy.connect.noApp}</Note>
                </>
              ) : (
                <>
                  <Note>{copy.screen.needsCnpj}</Note>
                  <Button href="/radar" variant="secondary" iconEnd="arrowRight">
                    {messages.account.screen.radar}
                  </Button>
                </>
              )}
            </>
          )}
        </section>

        <form action={saveAction} className="flex flex-col gap-3 pt-2">
          <SectionLabel>{copy.screen.filtersTitle}</SectionLabel>
          <Note>{prefs.digestHelp}</Note>

          <Select
            id="alerta-uf"
            name="uf"
            label={messages.radar.landing.ufLabel}
            options={UF_OPTIONS}
            defaultValue={states[0] ?? ''}
          />
          {limits.keywords === 0 ? null : (
            <Field
              id="alerta-palavra"
              name="palavra"
              label={messages.radar.landing.keywordLabel}
              placeholder={messages.radar.landing.keywordPlaceholder}
              maxLength={MAX_KEYWORD_CHARS}
              defaultValue={keyword ?? ''}
            />
          )}

          <Button type="submit" variant="secondary">
            {messages.common.save}
          </Button>
        </form>
      </main>
    </div>
  )
}
