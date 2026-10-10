import {
  AppBar,
  AppBarBack,
  Button,
  CardRow,
  Icon,
  LockedBlock,
  SectionLabel,
  StateCard,
  TabPanel,
  Tabs,
  Tag,
  type TabItem,
} from '@/components'
import { ActionBar } from '@/components/action-bar'
import { MenuTrigger } from '@/components/menu-trigger'
import { cn } from '@/lib/cn'
import { accountHref } from '@/lib/routes'
import { format, messages } from '@/lib/messages'
import { priceHref, screeningHref, tenderHref, type RadarSearch } from '@/lib/radar/client'
import { FavouriteButton } from './favourite-button'
import { Files } from './opportunity-view'
import type { ErrorCode, QuotaView, TenderDetail, VisitorView } from '@/lib/radar/contract'
import { errorText } from '@/lib/radar/error-text'
import { agencyLine, displayTitle } from '@/lib/radar/format'
import type { Blocker, Finding, ScreeningModel } from '@/lib/radar/screening-result'
import { VisitorBanner } from '../../radar-view'
import { TenderStatusBanner } from '../../tender-status-banner'

/**
 * The screening screen — canvas 04, `Triagem.dc.html`.
 *
 * A pure function of a view model, the way `opportunity-view.tsx` is: every
 * state below can be rendered in a test with no network and no DOM.
 * `screening-screen.tsx` does the asking, the polling and the clock.
 *
 * ## Every finding carries its page, including the ones that did not check out
 *
 * This is the card's acceptance criterion and the reason the product is worth
 * anything: a claim about a 58-page edital that does not say *where* it came
 * from cannot be checked, and an unverifiable legal claim about a public tender
 * is the one thing we must never print. So the page reference is part of the
 * row, in mono, at the end — and when `check_citations` could not confirm the
 * page, the row says so instead of quietly dropping the number. See
 * `lib/radar/screening-result.ts`.
 *
 * ## …and the whole screen says it is not advice
 *
 * `docs/legal/README.md` puts the "não é assessoria jurídica" notice on *every*
 * AI result screen, and it is task D4 that owes it. It is rendered once, under
 * the findings, from `messages.ai.disclaimer` + `messages.ai.notLegalAdvice` —
 * copy, not new wording.
 *
 * ## Why `VisitorBanner` is imported rather than moved here
 *
 * It was drawn in `radar-view.tsx` for canvas 02 and canvas 04 needs the same
 * component. Lifting it into its own file would be tidier, and it is what the
 * card asks for — but `task/r2-radar-polish` is editing exactly those lines
 * (it repoints the two `/conta/criar` links inside it), and a move plus an edit
 * is a guaranteed conflict for no behaviour. Importing costs nothing and can be
 * turned into a move in one commit once R2 has landed.
 */

const copy = messages.radar
const page = copy.screening

/**
 * `files` is a **panel**, not a link (D31).
 *
 * It was special-cased out of this union and given an `href` to the tender's
 * own Documentos tab, so opening it navigated to another page and left the
 * reader at the top of it — Sci, 2026-09-30: *"I kind of get sent back to the
 * previous view, and I need to scroll to see the attachment."* `Resumo` and
 * `Exigências` were panels and behaved; this one was a destination and did not.
 */
export type ScreeningTab = 'summary' | 'files' | 'requirements'

export type ScreeningStatus =
  /** The analysis is on screen. */
  | { kind: 'ready' }
  /** The job is queued or running; §3.1's poll is in flight. */
  | { kind: 'analyzing' }
  /** §3.1's 60 s went by and the job had not finished. Never an endless spinner. */
  | { kind: 'timeout' }
  /** A scanned PDF (§7.2): a real, permanent answer, and nothing was charged. */
  | { kind: 'noText' }
  /** The job failed, or the row it wrote cannot be read as an analysis. */
  | { kind: 'failed' }
  /** §10: the visitor's 2, or Básico's 5 a month, are gone. */
  | { kind: 'quota' }
  | { kind: 'notFound' }
  | { kind: 'error'; code: ErrorCode; text?: string }

export type ScreeningViewProps = {
  tenderId: string
  /** The header, from `GET /api/tenders/:id`. `null` while it is loading. */
  tender: TenderDetail | null
  model: ScreeningModel | null
  quota: QuotaView | null
  visitor: VisitorView | null
  /**
   * Whether this request carries an account (**§8: files only with an
   * account**), read on the server by `readHasAccount`.
   *
   * **Not derived from `visitor`.** That field is `null` for an account *and*
   * for a caller with no viewer at all, because `visitorWindow()` returns null
   * whenever the caller is not a visitor — reading the absence as "signed in"
   * is the same move as reading a missing `plan_limits` row as zero.
   */
  signedIn: boolean
  status: ScreeningStatus
  tab?: ScreeningTab
  onSelectTab?: (tab: ScreeningTab) => void
  /** Back to the Opportunity screen this came from. */
  backHref: string
  /**
   * The search that got the user here, for every link that leaves this screen
   * — Documentos, the price block and the two "Criar conta" buttons. Required
   * for the same reason `client.ts` makes it required: a link that drops it
   * strands the user on a Radar with no CNPJ and no tab.
   */
  search: RadarSearch
  onRetry?: () => void
  now?: Date
}

// ────────────────────────────────── pieces ──────────────────────────────────

/** "1 de 2 sem conta" — the allowance, in the header, where the board puts it. */
export function quotaLabel(quota: QuotaView | null): string | null {
  if (!quota) return null
  if (quota.limit === null) return page.quota.unlimited
  const template = quota.period === 'total' || quota.period === null ? page.quota.visitor : page.quota.month
  return format(template, { usadas: quota.used, total: quota.limit })
}

/**
 * `p. 43`, or the em dash the board prints when a claim cited no page.
 *
 * An unverified page is still shown — the number is what lets a reader go and
 * look — but it is marked, and the explanation is in the accessible name as
 * well as in the colour, because colour is never the only signal here either.
 */
function PageRef({ finding }: { finding: Pick<Finding, 'page' | 'pageUnverified'> }) {
  if (finding.page === null) {
    return <span aria-hidden>{page.noPage}</span>
  }
  const label = format(page.page, { numero: finding.page })
  // `whitespace-nowrap`: the board gives this slot 28px and "p.18" is wider
  // than that at 11px mono, so without it the reference breaks across two lines
  // on any row whose label wraps.
  if (!finding.pageUnverified) return <span className="whitespace-nowrap">{label}</span>
  return (
    <span className="whitespace-nowrap text-attention" title={page.pageUnverified}>
      {label}
      <span className="sr-only"> · {page.pageUnverified}</span>
      <span aria-hidden>*</span>
    </span>
  )
}

const TONE: Record<Finding['tone'], string> = {
  good: 'text-success',
  attention: 'text-attention',
  neutral: 'text-ink',
}

/**
 * A value longer than this is prose, not a verdict — a delivery address, a
 * judgment criterion — and beside a label at 390px it squeezes both columns
 * into three wrapped lines each. Those stack instead.
 */
const SHORT_VALUE = 36

function FindingRows({ findings }: { findings: Finding[] }) {
  return (
    <div>
      {findings.map((finding, index) => {
        const last = index === findings.length - 1
        const note = finding.note ? (
          <span className="block text-caption leading-relaxed text-muted">{finding.note}</span>
        ) : null

        if (finding.value.length > SHORT_VALUE) {
          return (
            <div
              key={finding.id}
              className={cn('flex flex-col gap-0.5 py-2.5 text-body', !last && 'border-b border-line')}
            >
              <span className="flex items-baseline gap-2.5">
                <span className="grow text-muted">{finding.label}</span>
                <span className="min-w-7 shrink-0 text-right font-mono text-label text-muted">
                  <PageRef finding={finding} />
                </span>
              </span>
              <span className={cn('font-medium', TONE[finding.tone])}>{finding.value}</span>
              {note}
            </div>
          )
        }

        return (
          <CardRow
            key={finding.id}
            last={last}
            label={
              <span className="flex flex-col">
                <span>{finding.label}</span>
                {note}
              </span>
            }
            value={<span className={TONE[finding.tone]}>{finding.value}</span>}
            aside={<PageRef finding={finding} />}
          />
        )
      })}
    </div>
  )
}

function Blockers({ blockers }: { blockers: Blocker[] }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel tone="muted">{page.blockersTitle}</SectionLabel>
      {blockers.length === 0 ? (
        <p className="m-0 flex items-start gap-2.5 text-body">
          <Icon name="check" size={16} strokeWidth={2.4} className="mt-1 text-success" />
          <span>{page.noBlockers}</span>
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {blockers.map((blocker) => (
            <li key={blocker.id} className="flex items-start gap-2.5 text-body">
              <Icon name="warning" size={16} className="mt-1 shrink-0 text-attention" />
              <span className="grow">{blocker.text}</span>
              <span className="min-w-7 shrink-0 text-right font-mono text-label text-muted">
                <PageRef finding={blocker} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The green verdict card: the score, what it means, and why. */
function Verdict({ model }: { model: ScreeningModel }) {
  const good = model.score !== null && model.score >= 8
  const hard = model.score !== null && model.score < 5
  // The board draws a hairline a shade darker than each soft fill. Only
  // attention has a line token, so the other two are the same token at low
  // alpha rather than two new hex values (CLAUDE.md: no invented colours).
  const box = good
    ? 'border-success/25 bg-success-soft'
    : hard
      ? 'border-error/25 bg-error-soft'
      : 'border-attention-line bg-attention-soft'
  const ink = good ? 'text-success' : hard ? 'text-error' : 'text-attention'
  const dot = good ? 'bg-success' : hard ? 'bg-error' : 'bg-attention'

  return (
    <div className={cn('flex items-center gap-3 rounded-card border p-3', box)}>
      <span
        aria-hidden
        className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-pill', dot)}
      >
        <Icon
          name={good ? 'check' : 'warning'}
          size={18}
          strokeWidth={2.6}
          className="text-surface"
        />
      </span>
      <div className="grow">
        <div className={cn('text-lead font-semibold', ink)}>{model.verdict}</div>
        {model.reason ? <div className="text-meta text-ink">{model.reason}</div> : null}
      </div>
      {/* The label was `sr-only`, so a sighted reader met a bare "4/10" under a
          heading reading *Difícil*, with nothing saying which end is good. Two
          independent reviews called that ambiguous, and the string to fix it
          has shipped all along — it was simply never on screen. Visible text
          rather than an `aria-label`, so both readers get the same sentence.
          The scale runs 10 = "Boa para empresa pequena". */}
      {model.score === null ? null : (
        <div className={cn('shrink-0 text-right', ink)}>
          <div className="font-display text-[26px] leading-none font-semibold">
            {model.score}
            <span className="text-[14px]">/10</span>
          </div>
          <div className="pt-0.5 text-caption leading-tight text-muted">
            {page.verdict.scoreLabel}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Canvas 04's strip, now drawn by `components/tabs.tsx` — the one tab
 * implementation, which the Opportunity screen also uses.
 *
 * **All three are panels** (D31). This used to say that Documentos was a link
 * out "because on *this* screen the files are not merely locked, they are
 * somewhere else entirely", and that was wrong twice over: the files are on
 * this screen — `screening-screen.tsx` fetches the tender, and the route
 * returns `files` to any caller with an account — and a tab that navigates is
 * not a tab. It dropped the reader at the top of another page with the annexes
 * below the fold, which is how Sci found it.
 */
const TAB_PREFIX = 'screening'

function ScreeningTabs({
  active,
  onSelect,
  signedIn,
  withRequirements = true,
}: {
  active: ScreeningTab
  onSelect?: (tab: ScreeningTab) => void
  signedIn: boolean
  /** `false` when there is no analysis to list requirements from (`unreadable`). */
  withRequirements?: boolean
}) {
  /**
   * **The lock is for a visitor, not for everybody.**
   *
   * This was an unconditional `accountHref(...)` with a padlock, written to
   * §8's rule — *"files only with an account"* — and applied to people who
   * have one. A paying Essencial subscriber met a padlock and a bounce to
   * `/conta` for documents they could open one screen back, on the tender
   * page, with no lock at all. Sci found it on his own account, 2026-09-29.
   *
   * Signed in, the tab is an ordinary link to the tender's own **Documentos**
   * tab, which is where the files live — this screen never held them.
   */
  const items: TabItem<ScreeningTab>[] = [
    { id: 'summary', label: page.tabs.summary },
    {
      id: 'files',
      label: page.tabs.files,
      // No `href`: this opens a panel here (D31). The padlock stays for a
      // visitor as the affordance that says why the panel will offer a signup
      // rather than a list — `Files` draws that block from `files === null`,
      // so the tab and the panel cannot disagree about who may read the edital.
      ...(signedIn ? {} : { icon: 'locked' as const }),
    },
    ...(withRequirements ? [{ id: 'requirements' as const, label: page.tabs.requirements }] : []),
  ]
  return (
    <Tabs items={items} active={active} onSelect={onSelect} idPrefix={TAB_PREFIX} />
  )
}

// ─────────────────────────────── pending states ──────────────────────────────

/**
 * Everything the screen can be before it has an analysis. Each one is a real
 * answer with a way forward — there is no state here that is only a spinner,
 * because a spinner with no ceiling is what makes a working product look broken.
 */
function Pending({
  status,
  tenderId,
  backHref,
  search,
  quota,
  onRetry,
  inShell = false,
}: {
  status: Exclude<ScreeningStatus, { kind: 'ready' }>
  tenderId: string
  backHref: string
  search: RadarSearch
  quota: QuotaView | null
  onRetry?: () => void
  /** Drawn inside the unreadable frame, whose action bar already goes back to the edital. */
  inShell?: boolean
}) {
  const back = (
    <Button variant="link" href={backHref} className="px-0" iconEnd="arrowRight">
      {page.openTender}
    </Button>
  )
  const retry = onRetry ? (
    <Button variant="link" className="px-0" onClick={onRetry}>
      {copy.states.timeoutAction}
    </Button>
  ) : (
    back
  )

  switch (status.kind) {
    case 'analyzing':
      return (
        <StateCard kind="analyzing" title={page.analyzingTitle} description={messages.ai.analyzing} />
      )
    case 'timeout':
      return (
        <StateCard
          kind="analyzing"
          title={page.timeoutTitle}
          description={page.timeoutBody}
          action={retry}
        />
      )
    case 'noText':
      return (
        <StateCard
          kind="empty"
          title={page.noTextTitle}
          description={page.noTextBody}
          action={inShell ? undefined : back}
        />
      )
    case 'failed':
      return (
        <StateCard kind="empty" title={page.failedTitle} description={page.failedBody} action={retry} />
      )
    case 'quota':
      return (
        <StateCard
          kind="limit"
          title={page.quotaTitle}
          description={format(
            quota && quota.period && quota.period !== 'total'
              ? page.quotaPlanBody
              : page.quotaVisitorBody,
            { total: quota?.limit ?? 2 },
          )}
          action={
            <Button
              href={accountHref(screeningHref(tenderId, search))}
            >
              {copy.visitor.createAccount}
            </Button>
          }
        />
      )
    case 'notFound':
      return (
        <StateCard
          kind="empty"
          title={copy.opportunity.notFoundTitle}
          description={copy.opportunity.notFoundBody}
          action={
            <Button variant="link" href="/radar" className="px-0" iconEnd="arrowRight">
              {copy.opportunity.backToRadar}
            </Button>
          }
        />
      )
    default:
      return (
        <StateCard
          kind="empty"
          title={copy.states.errorTitle}
          description={status.text ?? errorText(status.code)}
          action={retry}
        />
      )
  }
}

// ──────────────────────────────────── view ───────────────────────────────────

export function ScreeningView({
  tenderId,
  tender,
  model,
  quota,
  visitor,
  signedIn,
  status,
  tab = 'summary',
  onSelectTab,
  backHref,
  search,
  onRetry,
  now = new Date(),
}: ScreeningViewProps) {
  const allowance = quotaLabel(quota)
  const ready = status.kind === 'ready' && model !== null
  // A `ready` row we could not parse into an analysis is a failure, not an
  // empty screen: `parseScreening` returns `null` only when `result` is not
  // even an object.
  const pending: Exclude<ScreeningStatus, { kind: 'ready' }> =
    status.kind === 'ready' ? { kind: 'failed' } : status

  const disclaimer = `${messages.ai.disclaimer} ${messages.ai.notLegalAdvice}`

  /**
   * **The files could not be read — but the edital still has documents and a
   * price** (Sci, 2026-10-09). A scanned PDF (`noText`, §7.2: never sent to the
   * model) or a failed reading used to replace the whole screen with one card,
   * and with it went the Documentos tab, the price block and the action bar —
   * none of which depends on the analysis. The price band is built from the
   * items and past awards, and the files are the tender's. So the screen keeps
   * its frame: *Resumo* holds the same card as before plus the price block,
   * *Documentos* lists the files, and only *Exigências* — which is nothing but
   * the analysis — is left out. OCR, which would turn the scan into a reading,
   * is a separate card.
   */
  const unreadable = !ready && (pending.kind === 'noText' || pending.kind === 'failed')
  const shell = ready || unreadable
  /**
   * The tab actually drawn. Exigências is not offered here, so a `tab` still set
   * to it — state carried over from another triagem, since `tab` is a
   * `useState` that outlives a change of edital — shows Resumo, and the tabs and
   * the panel are both told so; otherwise no tab is `aria-selected` and the
   * panel is labelled by a tab marked unselected (found in review).
   */
  const shown: ScreeningTab = unreadable && tab === 'requirements' ? 'summary' : tab
  const filesPanel = (
    <TabPanel idPrefix={TAB_PREFIX} id="files" className="flex flex-col gap-3">
      {/* The same component the Edital screen draws, so the two
          cannot disagree about one viewer — and so a visitor meets
          the locked block here instead of being bounced to signup
          on a page they did not ask for. */}
      {tender ? (
        <Files tender={tender} signupHref={accountHref(tenderHref(tenderId, search, 'files'))} />
      ) : null}
    </TabPanel>
  )
  const priceBlock = (
    <LockedBlock
      icon="margin"
      href={priceHref(tenderId, search)}
      title={page.priceTitle}
      description={page.priceBody}
    />
  )

  return (
    <div className="flex min-h-dvh flex-col">
      {/* D85: the star is here too — reading the triagem is the moment
          somebody validates an edital, and marking it used to mean going back
          a screen. The menu is D24 half 2; see `opportunity-view.tsx`. */}
      <AppBar
        leading={<AppBarBack href={backHref}>{page.back}</AppBarBack>}
        title={page.title}
        actions={
          <>
            {/* Gated on the tender for the reason in `price-view.tsx`. */}
            {tender ? <FavouriteButton tenderId={tender.id} /> : null}
            <MenuTrigger />
          </>
        }
      />

      <main className="mx-auto flex w-full max-w-[960px] grow flex-col gap-3 px-gutter pb-10">
        {/* §3.5: the same banner on every AI result screen for the tender.
            Screening a suspended edital is still worth doing — the findings
            hold whatever the órgão does next — it is just not urgent, and a
            reader who arrived straight here from a link would otherwise never
            learn the tender had been stopped. */}
        {tender ? <TenderStatusBanner tender={tender} /> : null}

        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="font-display text-[22px] leading-tight font-semibold text-balance">
              {/* Shorter than the Opportunity screen's 180: the tender's full
                  object is that screen's job, and a 120-character PNCP object in
                  block capitals takes eight lines at 390px before the analysis
                  starts. */}
              {tender ? displayTitle(tender, 80) : page.title}
            </h1>
            {tender ? <p className="text-meta text-muted">{agencyLine(tender)}</p> : null}
          </div>
          {allowance ? (
            <Tag tone="attention" className="shrink-0">
              {allowance}
            </Tag>
          ) : null}
        </div>

        {shell ? (
          <ScreeningTabs
            active={shown}
            onSelect={onSelectTab}
            signedIn={signedIn}
            withRequirements={ready}
          />
        ) : null}

        {ready && model ? (
          <>
            {tab === 'files' ? (
              filesPanel
            ) : tab === 'summary' ? (
              <TabPanel idPrefix={TAB_PREFIX} id="summary" className="flex flex-col gap-3">
                <Verdict model={model} />

                <section className="flex flex-col gap-1">
                  <SectionLabel tone="muted">{page.detailsTitle}</SectionLabel>
                  <FindingRows findings={model.qualification} />
                </section>

                {priceBlock}
              </TabPanel>
            ) : (
              <TabPanel idPrefix={TAB_PREFIX} id="requirements" className="flex flex-col gap-3.5">
                <section className="flex flex-col gap-1">
                  <SectionLabel tone="muted">{page.requirementsTitle}</SectionLabel>
                  <FindingRows findings={model.requirements} />
                </section>
                <Blockers blockers={model.blockers} />
              </TabPanel>
            )}

            <div className="flex flex-col gap-1 pt-1 text-caption leading-relaxed text-muted">
              <p className="m-0">
                {/* The aggregate ratio — "6 de 7 páginas citadas conferem" —
                    is gone. A reader who cannot tell *which* of the seven
                    failed discounts all seven, including the page the blocker
                    depends on, so disclosing the error rate in one number cost
                    trust in every citation rather than buying it in one.

                    Nothing is hidden by removing it: `pageUnverified` already
                    marks the failing row itself, in colour, with a `*` and an
                    `sr-only` explanation — *"A página citada não confere:
                    procure no edital inteiro"*. Per-row failure is actionable
                    and contained; the ratio was neither.

                    `citationsNone` stays, because "this reading cited no page
                    at all" is a different statement and a reader needs it. */}
                {model.citations && model.citations.citations > 0 ? null : (
                  <>{page.citationsNone} </>
                )}
                {page.shared}
              </p>
              <p className="m-0">{disclaimer}</p>
            </div>
          </>
        ) : unreadable && shown === 'files' ? (
          filesPanel
        ) : unreadable ? (
          <TabPanel idPrefix={TAB_PREFIX} id="summary" className="flex flex-col gap-3">
            <Pending
              inShell
              status={pending}
              tenderId={tenderId}
              backHref={backHref}
              search={search}
              quota={quota}
              onRetry={onRetry}
            />
            {priceBlock}
          </TabPanel>
        ) : (
          <Pending
            status={pending}
            tenderId={tenderId}
            backHref={backHref}
            search={search}
            quota={quota}
            onRetry={onRetry}
          />
        )}

        {visitor ? (
          // Directly under the notice, not pushed to the bottom of the
          // viewport: `mt-auto` on a `min-h-dvh` column leaves a field of empty
          // ivory between the analysis and the banner on a short screening.
          <div className="-mx-gutter pt-3">
            <VisitorBanner visitor={visitor} now={now} />
          </div>
        ) : null}
      </main>

      {/* D25 (3). The funnel's next step, which on this screen is the price
          question — the LockedBlock above says the same thing in the same
          words, and `radar.screening.barPrice` is the price screen's own h1
          without its question mark (Sci, 2026-09-30). The second slot goes
          back to the edital, because the reader who wants the Itens or the
          anexos after reading the triagem has no other way there below `lg`
          but the AppBar's "Voltar", which is a browser-history word and not a
          destination.

          Only when this step has an answer: a bar offering the next step under
          "Lendo o edital…" would be offering it before this step has finished.
          An unreadable edital *is* an answer, and the price does not depend on
          it (see `unreadable`). */}
      {shell ? (
        <ActionBar
          primary={{ href: priceHref(tenderId, search), label: page.barPrice }}
          secondary={{ href: backHref, label: messages.common.tender }}
        />
      ) : null}
    </div>
  )
}
