import Link from 'next/link'
import { AppBar, Button, Card, CardRow, Field, Logo, SectionLabel, Select } from '@/components'
import { format, messages } from '@/lib/messages'
import { UF_OPTIONS } from '@/lib/radar/ufs'
import { ALERTS_PATH } from '@/lib/routes'
import { HANDOFF_MINUTES, type LinkPhase } from '@/lib/telegram/handoff'
import { type AlertLimits, MAX_KEYWORD_CHARS } from '@/lib/telegram/quota'
import { CompanyForm } from '../company-form'

/**
 * `/conta/alertas` — connect Telegram, and say what the weekly digest should
 * carry (tasks E1 and E3, spec §10).
 *
 * Pure and prop-driven, like `account-view.tsx`: every action arrives as a
 * prop, so the screen renders in a test with no session and no database.
 *
 * ## E3: the hand-off is now a state, not a leap
 *
 * E1's screen had two states — connected, and not. Pressing "Conectar" left for
 * `t.me` and whatever happened next happened somewhere this page could not see.
 * On 22/09 what happened next was a webhook answering 401 to every delivery,
 * and this screen went on offering "Conectar o Telegram" as though nothing had
 * been pressed. So there are four states now (`LinkPhase`), and the two new
 * ones are the point:
 *
 *  * **waiting** — a link was issued from this browser and is still good. The
 *    deep link is the primary control, and directly under it is the same
 *    `/start <token>` to send by hand, because the most useful thing to show
 *    somebody whose tap did not work is the thing the tap would have done.
 *  * **failed** — it was issued and nothing came back. Said plainly, with
 *    another link one press away.
 *
 * The manual fallback is offered **in the waiting state, before anything has
 * gone wrong**, rather than behind an error. Someone whose Telegram opened and
 * sat there does not know an error occurred; they know nothing happened. A
 * recovery path they have to discover is not a recovery path.
 *
 * ## The whole screen is still one tap to Telegram
 *
 * E1's exit criterion was "link in one tap from phone" and the deep link is
 * still exactly that — one tap, from this screen, with a token seconds old.
 * What E3 removes is the assumption that the tap always lands.
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
 * by the way to fix it. Until E3 that "way to fix it" was a button to the
 * Radar: leave the account area, use a different feature, come back. It is the
 * CNPJ form itself now, right here.
 */

const copy = messages.telegram
const hand = messages.telegram.handoff
const prefs = messages.notifications

export type AlertNotice = 'saved' | 'disconnected' | 'company' | 'cnpj-invalid' | null

export type AlertsViewProps = {
  /** Where the Telegram hand-off has got to. See `lib/telegram/handoff.ts`. */
  phase: LinkPhase
  /** Whether the weekly digest is switched on. False after `/pausar`. */
  active: boolean
  /** §10's caps for this plan, from `plan_limits`. */
  limits: AlertLimits
  /** The account's CNPJ, or `null` — the digest needs one. */
  cnpj: string | null
  companyName: string | null
  /** `@LicitaQuiBot`. Named in the copy so people know which chat to open. */
  botHandle: string
  keyword: string | null
  states: string[]
  /** `?estado=…` after a Server Function redirected back here. */
  notice: AlertNotice
  connectAction: () => void | Promise<void>
  recheckAction: () => void | Promise<void>
  disconnectAction: () => void | Promise<void>
  pauseAction: () => void | Promise<void>
  resumeAction: () => void | Promise<void>
  saveAction: (formData: FormData) => void | Promise<void>
  companyAction: (formData: FormData) => void | Promise<void>
}

/** "Você recebe 1 aviso por semana." — or the paid line. From `plan_limits`. */
export function frequencyLabel(limits: AlertLimits): string {
  return limits.perWeek === 1 ? copy.connected.frequencyBasic : copy.connected.frequencyPaid
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-meta leading-relaxed text-muted">{children}</p>
}

/**
 * The `/start <token>` to send by hand.
 *
 * `select-all` so one tap selects the whole command on a phone — there is no
 * copy button because that needs a client component, and a 49-character string
 * a thumb can select is the same outcome without shipping JavaScript to a page
 * that otherwise ships none.
 *
 * `break-all`: at 390 px the command is wider than the card, and a token that
 * wraps mid-string is still correct to copy, whereas one that overflows is not
 * reachable at all.
 */
function StartCommand({ command, botHandle }: { command: string; botHandle: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-meta leading-relaxed font-medium">{hand.manualTitle}</p>
      <Note>{format(hand.manualBody, { bot: botHandle })}</Note>
      <code className="block rounded-control border border-line-strong bg-fill-muted px-3 py-2 font-mono text-meta break-all select-all">
        {command}
      </code>
      <Note>{hand.manualHint}</Note>
    </div>
  )
}

export function AlertsView({
  phase,
  active,
  limits,
  cnpj,
  companyName,
  botHandle,
  keyword,
  states,
  notice,
  connectAction,
  recheckAction,
  disconnectAction,
  pauseAction,
  resumeAction,
  saveAction,
  companyAction,
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
        {notice === 'company' ? (
          <Card accent>
            <p className="text-meta leading-relaxed">{messages.account.screen.companySaved}</p>
          </Card>
        ) : null}
        {notice === 'disconnected' ? (
          <Card>
            <p className="text-meta leading-relaxed">{copy.connected.disconnected}</p>
          </Card>
        ) : null}

        <section className="flex flex-col gap-3">
          <SectionLabel>{prefs.telegramLabel}</SectionLabel>

          {phase.phase === 'linked' ? (
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
          ) : cnpj === null ? (
            <>
              <Card>
                <h2 className="font-display text-[18px] leading-tight font-semibold">
                  {copy.connect.title}
                </h2>
                <p className="pt-1 text-meta leading-relaxed text-muted">{copy.connect.body}</p>
              </Card>
              <Note>{copy.screen.needsCnpjHere}</Note>
              <CompanyForm
                action={companyAction}
                next={ALERTS_PATH}
                cnpj={null}
                invalid={notice === 'cnpj-invalid'}
                submitLabel={messages.common.save}
                hint={false}
              />
            </>
          ) : phase.phase === 'waiting' ? (
            <>
              <Card accent>
                <h2 className="font-display text-[18px] leading-tight font-semibold">
                  {hand.waitingTitle}
                </h2>
                <p className="pt-1 text-meta leading-relaxed text-muted">
                  {format(hand.waitingBody, { bot: botHandle })}
                </p>
              </Card>

              <Button
                href={phase.url}
                target="_blank"
                rel="noopener noreferrer"
                iconEnd="arrowRight"
              >
                {hand.open}
              </Button>
              <Note>{format(hand.validFor, { minutos: HANDOFF_MINUTES })}</Note>

              <StartCommand command={phase.command} botHandle={botHandle} />

              <form action={recheckAction}>
                <Button type="submit" variant="secondary">
                  {hand.recheck}
                </Button>
              </form>
              <Note>{hand.stillWaiting}</Note>
            </>
          ) : phase.phase === 'failed' ? (
            <>
              <Card>
                <h2 className="font-display text-[18px] leading-tight font-semibold">
                  {hand.failedTitle}
                </h2>
                <p className="pt-1 text-meta leading-relaxed text-muted">{hand.failedBody}</p>
              </Card>
              <form action={connectAction}>
                <Button type="submit" iconEnd="arrowRight">
                  {hand.newLink}
                </Button>
              </form>
              <Note>{copy.connect.noApp}</Note>
            </>
          ) : (
            <>
              <Card>
                <h2 className="font-display text-[18px] leading-tight font-semibold">
                  {copy.connect.title}
                </h2>
                <p className="pt-1 text-meta leading-relaxed text-muted">{copy.connect.body}</p>
              </Card>
              <form action={connectAction}>
                <Button type="submit" iconEnd="arrowRight">
                  {copy.connect.cta}
                </Button>
              </form>
              <Note>{copy.connect.help}</Note>
              <Note>{copy.connect.noApp}</Note>
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
