import type { ReactNode } from 'react'
import {
  AppBar,
  AppBarBack,
  AppBarActionLink,
  Button,
  Card,
  Icon,
  SectionLabel,
  StateCard,
  Status,
  type StatusKind,
} from '@/components'
import { format, messages } from '@/lib/messages'
import { ACCOUNT_HREF, ALERTS_HREF } from '@/lib/routes'
import { tenderHref } from '@/lib/radar/client'
import type { ErrorCode, Freshness, TenderDetail, TenderGroup } from '@/lib/radar/contract'
import { errorText } from '@/lib/radar/error-text'
import { pncpEditalUrl } from '@/lib/radar/pncp'
import {
  agencyLine,
  ageParts,
  daysUntil,
  deadlineFull,
  deadlineTall,
  meEppSummary,
  money,
  tenderTitle,
} from '@/lib/radar/format'
import { TenderTags } from '../../tender-card'
import { CopyId } from './copy-id'

/**
 * The Opportunity screen — canvas 03, `Oportunidade.dc.html`.
 *
 * Same shape as `radar-view.tsx`: a pure function of a view model, so every
 * state can be rendered in a test. `opportunity-screen.tsx` does the fetching.
 *
 * ## What the board shows that this screen does not claim
 *
 * The board's "Por que você pode participar" lists five ticks, three of which
 * are *absences* — "não exige atestado técnico", "não exige capital mínimo",
 * "não exige amostra". Those three are findings of the AI screening (task D4):
 * they are read out of the edital PDF and each one carries the page it came
 * from. `GET /api/tenders/:id` knows nothing about them, and printing them
 * from the tender header would be inventing a legal fact about a document
 * nobody has read — the one mistake this product cannot make.
 *
 * So the list here is exactly the facts the tender carries — the CNAE match,
 * the ME/EPP regime, favoured treatment, price registration, the time left —
 * and a line under it points at the screening for the rest. When D4 lands, its
 * findings join this list with their page references.
 */

const copy = messages.radar
const page = copy.opportunity

/** The badge on the detail: how the *viewer's* CNAEs reached this tender. */
export function matchKind(tender: TenderDetail): TenderGroup {
  if (tender.matchedSegments.some((fit) => fit.fit === 'compatible')) return 'compatible'
  if (tender.matchedSegments.length > 0) return 'check'
  return 'keyword'
}

const BADGE: Record<TenderGroup, { kind: StatusKind; label: string }> = {
  compatible: { kind: 'compatible', label: copy.list.badges.compatible },
  check: { kind: 'check', label: copy.list.badges.check },
  keyword: { kind: 'keyword', label: copy.list.badges.keyword },
}

/** Every reason we can state from the tender itself, in the board's order. */
export function reasons(tender: TenderDetail, now: Date): string[] {
  const out: string[] = []

  const compatible = tender.matchedSegments.filter((fit) => fit.fit === 'compatible')
  const check = tender.matchedSegments.filter((fit) => fit.fit === 'check')
  if (compatible.length > 0) {
    out.push(format(page.why.compatible, { segmentos: compatible.map((f) => f.segment).join(', ') }))
  }
  if (check.length > 0) {
    out.push(format(page.why.check, { segmentos: check.map((f) => f.segment).join(', ') }))
  }

  const regime = meEppSummary(tender.meEppSummary)
  if (regime === 'exclusive') out.push(page.why.exclusive)
  if (regime === 'quota') out.push(page.why.quota)
  if (regime === 'mixed') out.push(page.why.mixed)
  if (tender.favoredTreatment && regime !== 'exclusive' && regime !== 'mixed') {
    out.push(page.why.favored)
  }
  if (tender.priceRegistration) out.push(page.why.priceRegistration)

  const days = daysUntil(tender.proposalsCloseAt, now)
  if (days !== null && days >= 0) {
    out.push(format(page.why.open, { prazo: format(copy.card.daysLeft, { count: days }) }))
  }

  return out
}

type OperationIcon = 'deadline' | 'company' | 'tender' | 'search'

function OperationRow({
  icon,
  label,
  children,
}: {
  icon: OperationIcon
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5 text-body">
      <Icon name={icon} size={18} className="mt-0.5 text-muted" />
      <dt className="w-[84px] shrink-0 text-muted">{label}</dt>
      <dd className="m-0 min-w-0 grow">{children}</dd>
    </div>
  )
}

/**
 * The Id contratação PNCP, verbatim, with a copy button beside it.
 *
 * It sits in this block and not under the title because this is where the
 * verifiable facts are: the id belongs next to Modalidade and Situação, as
 * another thing the reader can check against the source.
 *
 * `min-w-0` on the `dd` plus `break-all` here is what keeps 28 monospace
 * characters inside a 390px frame: the row shrinks below its content's natural
 * width and the id wraps mid-string rather than pushing the column out. The
 * copy button is `shrink-0` and wraps onto its own line only if it has to.
 */
function PncpIdValue({ id }: { id: string }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-meta break-all select-all">{id}</span>
      <CopyId id={id} />
    </span>
  )
}

function Operation({ tender }: { tender: TenderDetail }) {
  const place = [tender.city, tender.state].filter(Boolean).join('/')
  const rows: Array<{ key: string; icon: OperationIcon; label: string; value: ReactNode }> = []

  if (tender.modalityName) {
    rows.push({
      key: 'modality',
      icon: 'tender',
      label: page.operation.modality,
      value: tender.modalityName,
    })
  }
  if (tender.unitName) {
    rows.push({ key: 'unit', icon: 'company', label: page.operation.unit, value: tender.unitName })
  }
  if (place) rows.push({ key: 'place', icon: 'company', label: page.operation.place, value: place })

  const opens = deadlineFull(tender.proposalsOpenAt)
  if (opens) {
    rows.push({ key: 'opens', icon: 'deadline', label: page.operation.opensAt, value: opens })
  }
  const closes = deadlineFull(tender.proposalsCloseAt)
  if (closes) {
    rows.push({ key: 'closes', icon: 'deadline', label: page.operation.closesAt, value: closes })
  }

  if (tender.itemCount !== null) {
    rows.push({
      key: 'items',
      icon: 'search',
      label: page.operation.items,
      value: format(copy.card.items, { count: tender.itemCount }),
    })
  }
  if (tender.status) {
    rows.push({ key: 'status', icon: 'search', label: page.operation.status, value: tender.status })
  }

  // Last, because it is the reference the rest of the block can be checked
  // against rather than another fact about the procurement.
  if (tender.id) {
    rows.push({
      key: 'pncpId',
      icon: 'tender',
      label: page.operation.pncpId,
      value: <PncpIdValue id={tender.id} />,
    })
  }

  if (rows.length === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel tone="muted">{page.operationTitle}</SectionLabel>
      <dl className="m-0 flex flex-col gap-2">
        {rows.map((row) => (
          <OperationRow key={row.key} icon={row.icon} label={row.label}>
            {row.value}
          </OperationRow>
        ))}
      </dl>
    </section>
  )
}

/**
 * The Objeto, whole, in the agency's own words — the last thing on the screen
 * before the AI is offered.
 *
 * ## Why it is not collapsed
 *
 * Every other reading of this text on the screen is abbreviated: the `h1`
 * trims it at 180 characters, the card trims it shorter still. This block is
 * the one place the full text exists, and the complaint that produced it was
 * that reading the source cost too many interactions. A "ler mais" here would
 * answer that complaint with one more click, so there is no toggle: the object
 * is expanded, always, however long it runs. The screen already scrolls, the
 * call to action is `mt-auto` at the end of it, and nothing above moves.
 *
 * ## Why it sits directly under the deadline/value box
 *
 * The Objeto is what the edital **is**. "Por que este edital apareceu para
 * você" is our commentary on it and "Operação" is metadata about it, so both
 * follow it: a person reads the thing before reading what we say about the
 * thing. That is §2.2 rule 4 — a conclusion without its source is a defect —
 * applied to the whole screen rather than only to the screening CTA further
 * down, which it also still sits above.
 *
 * It is a sibling of the two-column block, not a cell inside it, so it spans
 * the whole content column and carries the weight immediately under the box.
 *
 * ## Verbatim, with the agency's own line breaks
 *
 * No `trimObject`, no ellipsis. `whitespace-pre-line` keeps the newlines PNCP
 * published — many órgãos paragraph these, and flattening them turns a list of
 * lots into a wall — while still collapsing the runs of padding spaces that
 * come out of their form fields.
 *
 * ## The measure is not the container
 *
 * Spanning the column does not mean setting the type across it. At the 920px
 * content width an unconstrained line runs past 105 characters of dense,
 * often uppercase legal prose, which is where a long measure hurts most.
 * `max-w-[68ch]` — about 570px — keeps it inside the 45–75 character band
 * that reads comfortably while being half again the 444px left column it no
 * longer lives in, so the block still reads as the wide one. At 390px the
 * gutter is the constraint and this cap never applies.
 *
 * It does not assume the `h1` above is a prefix of this text. When the `h1`
 * becomes a generated short title, this block is unchanged and becomes the
 * only place the real wording lives.
 */
function FullObject({ object }: { object: string }) {
  if (!object.trim()) return null
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel tone="muted">{page.objectTitle}</SectionLabel>
      <p className="m-0 max-w-[68ch] text-body leading-relaxed whitespace-pre-line">{object}</p>
    </section>
  )
}

function Files({ tender }: { tender: TenderDetail }) {
  // `files: null` is the locked block (§8: "files only with an account");
  // `files: []` would mean the agency published nothing, which is different.
  if (tender.files === null) {
    return (
      <Button variant="locked" href={ACCOUNT_HREF} fullWidth>
        {page.filesLocked}
      </Button>
    )
  }
  if (tender.files.length === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel tone="muted">{page.filesLocked}</SectionLabel>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {tender.files.map((file) => (
          <li key={file.sequence}>
            <a
              href={file.url ?? '#'}
              className="inline-flex min-h-touch items-center gap-2 text-body text-blue"
            >
              <Icon name="tender" size={16} />
              {file.title ?? file.docType ?? `#${file.sequence}`}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

export type OpportunityStatus =
  | { kind: 'ready' }
  | { kind: 'analyzing' }
  | { kind: 'notFound' }
  | { kind: 'error'; code: ErrorCode; text?: string }

/**
 * Everything the screen can be before it has a tender: the job still running,
 * an id PNCP no longer serves, or a route that failed. One `<main>` with the
 * matching state card, so the app bar and the way back never disappear.
 */
function Pending({
  status,
  backHref,
  onRetry,
}: {
  status: Exclude<OpportunityStatus, { kind: 'ready' }>
  backHref: string
  onRetry?: () => void
}) {
  const title =
    status.kind === 'analyzing'
      ? copy.states.analyzingTenderTitle
      : status.kind === 'notFound'
        ? page.notFoundTitle
        : copy.states.errorTitle

  return (
    <main className="mx-auto w-full max-w-[960px] px-gutter pb-10">
      <h1 className="sr-only">{title}</h1>
      {status.kind === 'analyzing' ? (
        <StateCard
          kind="analyzing"
          title={title}
          description={copy.states.analyzingTenderBody}
        />
      ) : (
        <StateCard
          kind="empty"
          title={title}
          description={
            status.kind === 'notFound' ? page.notFoundBody : (status.text ?? errorText(status.code))
          }
          action={
            onRetry && status.kind === 'error' ? (
              <Button variant="link" className="px-0" onClick={onRetry}>
                {copy.states.errorAction}
              </Button>
            ) : (
              <Button variant="link" href={backHref} className="px-0" iconEnd="arrowRight">
                {page.backToRadar}
              </Button>
            )
          }
        />
      )}
    </main>
  )
}

export type OpportunityViewProps = {
  tender: TenderDetail | null
  freshness: Freshness | null
  status: OpportunityStatus
  /** Where "Voltar" goes: the Radar, with the filters the user came from. */
  backHref: string
  now?: Date
  onRetry?: () => void
}

export function OpportunityView({
  tender,
  freshness,
  status,
  backHref,
  now = new Date(),
  onRetry,
}: OpportunityViewProps) {
  const bar = (
    <AppBar
      leading={<AppBarBack href={backHref}>{page.back}</AppBarBack>}
      actions={<AppBarActionLink icon="alert" label={page.follow} href={ALERTS_HREF} />}
    />
  )

  if (status.kind !== 'ready') {
    return (
      <div className="flex min-h-dvh flex-col">
        {bar}
        <Pending status={status} backHref={backHref} onRetry={onRetry} />
      </div>
    )
  }

  if (!tender) {
    return (
      <div className="flex min-h-dvh flex-col">
        {bar}
        <Pending status={{ kind: 'notFound' }} backHref={backHref} />
      </div>
    )
  }

  const badge = BADGE[matchKind(tender)]
  const days = daysUntil(tender.proposalsCloseAt, now)
  const why = reasons(tender, now)
  // `null` means there is no figure to set in Archivo — either the agency
  // declared the budget confidential, or it published none at all.
  const value = tender.confidentialBudget ? null : money(tender.estimatedValue)
  const age = ageParts(freshness?.ageSeconds)
  // `null` for an id this app cannot parse: no link at all beats a link to a
  // page that does not exist, on the screen whose point is checking us.
  const pncpUrl = pncpEditalUrl(tender.id)
  const aiNotice = `${messages.ai.disclaimer} ${messages.ai.notLegalAdvice}`

  return (
    <div className="flex min-h-dvh flex-col">
      {bar}

      <main className="mx-auto flex w-full max-w-[960px] grow flex-col gap-3.5 px-gutter pb-10">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-[24px] leading-tight font-semibold text-balance">
            {tenderTitle(tender.object, 180)}
          </h1>
          <p className="text-body text-muted">{agencyLine(tender)}</p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Status kind={badge.kind}>{badge.label}</Status>
          <TenderTags tender={tender} />
        </div>

        {tender.closed ? (
          <p className="rounded-[10px] bg-attention-soft px-3 py-2.5 text-meta text-ink">
            {page.closedNotice}
          </p>
        ) : null}

        <Card className="flex flex-col gap-3">
          <div className="flex items-end justify-between gap-3 border-b border-line pb-3">
            <div>
              <SectionLabel tone="muted">{page.proposalsUntil}</SectionLabel>
              <div className="pt-1 font-display text-[22px] leading-none font-semibold">
                {deadlineTall(tender.proposalsCloseAt) ?? copy.card.noDeadline}
              </div>
            </div>
            {days === null ? null : (
              <div className="text-right">
                <div className="font-display text-[22px] leading-none font-semibold">
                  {days < 0 ? copy.card.closed : format(copy.card.daysLeft, { count: days })}
                </div>
                {days < 0 ? null : <div className="text-meta text-muted">{page.remaining}</div>}
              </div>
            )}
          </div>

          <div>
            <SectionLabel tone="muted">{page.estimatedValue}</SectionLabel>
            <div className="flex items-baseline justify-between gap-3 pt-1">
              {/* Same rule as the Radar card: the 28px Archivo slot is for a
                  figure, and PNCP withholds the budget on most tenders. With no
                  figure the slot collapses to a quiet line and the deadline
                  block directly above — already the card's other half — stays
                  the biggest thing on the screen. */}
              {value === null ? (
                <span className="text-meta text-muted">
                  {tender.confidentialBudget ? copy.card.confidential : copy.card.noValue}
                </span>
              ) : (
                <span className="font-display text-[28px] leading-none font-semibold tabular-nums">
                  {value}
                </span>
              )}
              {tender.itemCount === null ? null : (
                <span className="text-meta text-muted">
                  {format(copy.card.items, { count: tender.itemCount })}
                </span>
              )}
            </div>
          </div>
        </Card>

        <FullObject object={tender.object} />

        <div className="flex flex-col gap-3.5 min-[900px]:grid min-[900px]:grid-cols-2 min-[900px]:items-start min-[900px]:gap-8">
          <section className="flex flex-col gap-2">
            <SectionLabel tone="muted">{page.whyTitle}</SectionLabel>
            {why.length === 0 ? (
              <StateCard kind="empty" title={page.whyEmptyTitle} description={page.whyEmptyBody} />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {why.map((reason) => (
                  <li key={reason} className="flex items-start gap-2.5 text-body">
                    <Icon name="check" size={16} strokeWidth={2.4} className="mt-1 text-success" />
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-caption leading-relaxed text-muted">{page.requirementsNote}</p>
          </section>

          <Operation tender={tender} />
        </div>

        <div className="mt-auto flex flex-col gap-2 pt-2">
          {/* Legal brief §2.2 rule 5: the AI notice appears on EVERY result
              screen, not only in the terms. This screen prints a compatibility
              reading — "Por que este edital apareceu para você" — so it is a
              result screen, and the notice was missing from it. It sits above
              the call to action, which is where the reading stops being read
              and starts being acted on. */}
          <p className="text-caption leading-relaxed text-muted">{aiNotice}</p>
          <Button href={`${tenderHref(tender.id)}/triagem`} fullWidth iconEnd="arrowRight">
            {page.screeningCta}
          </Button>
          <Files tender={tender} />
          {/* The source of every fact above. PNCP is the official record
              (Lei 14.133 art. 174); the bidding system below it is where the
              dispute happens, which is a different place and a different
              claim — so both links exist and neither is called "o edital".

              The accessible name is the visible label plus a hidden "(abre em
              uma nova aba)": an aria-label saying something else would name
              the control differently from its text (WCAG 2.5.3). */}
          {pncpUrl ? (
            <Button
              variant="secondary"
              href={pncpUrl}
              rel="noopener noreferrer"
              target="_blank"
              fullWidth
            >
              {page.pncpLink}
              <span className="sr-only"> {page.pncpLinkNewTab}</span>
            </Button>
          ) : null}
          {tender.biddingSystemUrl ? (
            <Button
              variant="secondary"
              href={tender.biddingSystemUrl}
              rel="noreferrer noopener"
              target="_blank"
              fullWidth
            >
              {page.systemLink}
            </Button>
          ) : null}
          {age ? (
            <p className="pt-1 text-caption text-muted">
              {format(freshness?.state === 'stale' ? copy.freshness.stale : copy.freshness.fresh, {
                idade: age.unit === 'now' ? copy.age.now : format(copy.age[age.unit], { count: age.count }),
              })}
            </p>
          ) : null}
        </div>
      </main>
    </div>
  )
}
