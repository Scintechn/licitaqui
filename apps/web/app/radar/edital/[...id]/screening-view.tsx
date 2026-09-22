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
import { cn } from '@/lib/cn'
import { accountHref } from '@/lib/routes'
import { format, messages } from '@/lib/messages'
import { priceHref, tenderHref } from '@/lib/radar/client'
import type { ErrorCode, QuotaView, TenderDetail, VisitorView } from '@/lib/radar/contract'
import { errorText } from '@/lib/radar/error-text'
import { agencyLine, tenderTitle } from '@/lib/radar/format'
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

/** Canvas 04's tabs. "Documentos" is not one: it is locked, so it is a link. */
export type ScreeningTab = 'summary' | 'requirements'

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
  status: ScreeningStatus
  tab?: ScreeningTab
  onSelectTab?: (tab: ScreeningTab) => void
  /** Back to the Opportunity screen this came from. */
  backHref: string
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
      {model.score === null ? null : (
        <div className={cn('shrink-0 font-display text-[26px] leading-none font-semibold', ink)}>
          {model.score}
          <span className="text-[14px]">/10</span>
          <span className="sr-only"> {page.verdict.scoreLabel}</span>
        </div>
      )}
    </div>
  )
}

/**
 * Canvas 04's strip, now drawn by `components/tabs.tsx` — the one tab
 * implementation, which the Opportunity screen also uses. The set is this
 * screen's own: Resumo and Exigências are panels, Documentos is a link out,
 * because on *this* screen the files are not merely locked, they are somewhere
 * else entirely (§8: files only with an account).
 */
const TAB_PREFIX = 'screening'

function ScreeningTabs({
  active,
  onSelect,
  tenderId,
}: {
  active: ScreeningTab
  onSelect?: (tab: ScreeningTab) => void
  tenderId: string
}) {
  const items: TabItem<ScreeningTab | 'files'>[] = [
    { id: 'summary', label: page.tabs.summary },
    {
      id: 'files',
      label: page.tabs.files,
      href: accountHref(tenderHref(tenderId)),
      icon: 'locked',
    },
    { id: 'requirements', label: page.tabs.requirements },
  ]
  return (
    <Tabs
      items={items}
      active={active}
      onSelect={onSelect as ((tab: ScreeningTab | 'files') => void) | undefined}
      idPrefix={TAB_PREFIX}
    />
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
  quota,
  onRetry,
}: {
  status: Exclude<ScreeningStatus, { kind: 'ready' }>
  tenderId: string
  backHref: string
  quota: QuotaView | null
  onRetry?: () => void
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
      return <StateCard kind="empty" title={page.noTextTitle} description={page.noTextBody} action={back} />
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
              href={accountHref(`${tenderHref(tenderId)}/triagem`)}
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
  status,
  tab = 'summary',
  onSelectTab,
  backHref,
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

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar leading={<AppBarBack href={backHref}>{page.back}</AppBarBack>} title={page.title} />

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
              {tender ? tenderTitle(tender.object, 80) : page.title}
            </h1>
            {tender ? <p className="text-meta text-muted">{agencyLine(tender)}</p> : null}
          </div>
          {allowance ? (
            <Tag tone="attention" className="shrink-0">
              {allowance}
            </Tag>
          ) : null}
        </div>

        {ready ? (
          <ScreeningTabs active={tab} onSelect={onSelectTab} tenderId={tenderId} />
        ) : null}

        {ready && model ? (
          <>
            {tab === 'summary' ? (
              <TabPanel idPrefix={TAB_PREFIX} id="summary" className="flex flex-col gap-3">
                <Verdict model={model} />

                <section className="flex flex-col gap-1">
                  <SectionLabel tone="muted">{page.detailsTitle}</SectionLabel>
                  <FindingRows findings={model.qualification} />
                </section>

                <LockedBlock
                  icon="margin"
                  href={priceHref(tenderId)}
                  title={page.priceTitle}
                  description={page.priceBody}
                />
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
                {model.citations && model.citations.citations > 0
                  ? format(page.citations, {
                      conferidas: model.citations.verified,
                      total: model.citations.citations,
                    })
                  : page.citationsNone}{' '}
                {page.shared}
              </p>
              <p className="m-0">{disclaimer}</p>
            </div>
          </>
        ) : (
          <Pending
            status={pending}
            tenderId={tenderId}
            backHref={backHref}
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
    </div>
  )
}
