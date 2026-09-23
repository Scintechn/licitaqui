import type { ReactNode } from 'react'
import {
  AppBar,
  AppBarBack,
  AppBarActionLink,
  Button,
  Card,
  Icon,
  LockedBlock,
  SectionLabel,
  StateCard,
  Status,
  TabPanel,
  Tabs,
  type StatusKind,
  type TabItem,
} from '@/components'
import { cn } from '@/lib/cn'
import { format, messages } from '@/lib/messages'
import { ACCOUNT_HREF, ALERTS_HREF } from '@/lib/routes'
import { screeningHref, type RadarSearch } from '@/lib/radar/client'
import type {
  ErrorCode,
  Freshness,
  ScreeningAvailability,
  TenderDetail,
  TenderGroup,
} from '@/lib/radar/contract'
import { errorText } from '@/lib/radar/error-text'
import { pncpEditalUrl } from '@/lib/radar/pncp'
import {
  agencyLine,
  ageParts,
  daysUntil,
  deadlineFull,
  deadlineTall,
  meEppSummary,
  tenderTitle,
} from '@/lib/radar/format'
import { tenderBudget } from '@/lib/radar/headline'
import { mayShowUrgency, statusChipLabel, statusNotice } from '@/lib/radar/tender-status'
import { TenderTags } from '../../tender-card'
import { TenderStatusBanner } from '../../tender-status-banner'
import { CopyId } from './copy-id'
import { ITEMS_PAGE, TenderItems } from './tender-items'

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
const statusCopy = copy.status

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

  // Legal brief §2.2 rule 6, through the one gate: "Ainda dá tempo" is a claim
  // about the world, and on a tender the agency has stopped it is false. So
  // the item does not drop out *here* on a condition of its own — it asks
  // `mayShowUrgency`, the same predicate the countdown and the deadline block
  // ask, which is what stops the next reason anybody adds from forgetting.
  const days = daysUntil(tender.proposalsCloseAt, now)
  if (mayShowUrgency(tender) && days !== null && days >= 0) {
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
 * The Objeto, whole, in the agency's own words — directly under the
 * deadline/value box.
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
 * você" is our commentary on it, "Operação" is metadata about it, and the
 * `Itens`/`Documentos` tabs below are its parts — so all three follow it: a
 * person reads the thing before reading what we say about the thing. That is
 * §2.2 rule 4 — a conclusion without its source is a defect — applied to the
 * whole screen rather than only to the screening CTA further down, which it
 * also still sits above.
 *
 * It is a sibling of the two-column block, not a cell inside it, so it spans
 * the whole content column and carries the weight immediately under the box.
 * Sci asked for exactly this by name: *"The Objeto should be right after the
 * box with the price, and below to them, like we have now 'Por que este edital
 * apareceu para você' and 'Operação'. The Objeto will place the entire weight
 * below to the box."*
 *
 * ## This order has been silently reverted once — it is pinned
 *
 * Task #56 made the move; `task/b9-tender-status` branched before it landed
 * and its merge (`cc4b766`) resolved the conflict in its own favour, putting
 * the block back under the grid, restoring `max-w-[62ch]` and **deleting the
 * three tests that guarded the order**. B9's own diff touches this component
 * zero times, so nobody decided any of it — and with the guards gone CI stayed
 * green while undoing a change Sci had asked for. The tests are back, under
 * `OpportunityView · the whole Objeto`, and one of them now also pins the
 * Objeto above `role="tablist"`. If you are moving this block, they are what
 * you have to argue with.
 *
 * ## Verbatim, with the agency's own line breaks
 *
 * No `trimObject`, no ellipsis. `whitespace-pre-line` keeps the newlines PNCP
 * published — many órgãos paragraph these, and flattening them turns a list of
 * lots into a wall — while still collapsing the runs of padding spaces that
 * come out of their form fields.
 *
 * ## The measure: there was a cap, and Sci removed it on 2026-09-22
 *
 * This block shipped with `max-w-[68ch]` — about 570px — and the argument for
 * it was a real one: at the 920px content width an unconstrained line runs
 * past 105 characters of dense, often uppercase legal prose, and 45–75
 * characters is where a measure reads comfortably. That is a typographic
 * argument and it is not wrong.
 *
 * It lost to an alignment argument. Sci: *"why does the Objeto text not take
 * the entire width like the table above?"* Everything this block touches is
 * full width — the deadline/value box above it, the items table below it —
 * and the two columns under it are ~440px each. At 571px the Objeto lined up
 * with **nothing on the screen**, so it read as a mistake rather than as a
 * measure. He has heard the 105-character argument and chosen consistency
 * with the block's neighbours, which is his call to make.
 *
 * So there is **no width cap here, deliberately**, and
 * `OpportunityView · the whole Objeto` now fails if one comes back — the test
 * was inverted rather than deleted, because the next person to notice the long
 * line will be right about the typography and still wrong about the screen.
 * The measure does need help, and it is bought with leading. Measured in
 * Chrome on the worst object we hold — 1 928 characters, no line breaks of its
 * own — the uncapped block renders at **140–145 characters per line** at
 * 1280px, not the ~105 this comment used to estimate. Only **294 of 6 299**
 * objects carry the agency's own newlines, so that unbroken flow is the normal
 * case and not the exception. `leading-loose` (2.0 rather than 1.625) is what
 * lets the eye find the start of the next line at that measure; it costs about
 * 73px of height on that worst case and ~10px on a typical two-line object.
 * At 390px the same text is 51–57 characters per line and the leading is
 * simply comfortable. Width was not available as a lever and is not one here.
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
      <p className="m-0 text-body leading-loose whitespace-pre-line">{object}</p>
    </section>
  )
}

/**
 * The Documentos tab.
 *
 * It used to be a loose "EDITAL E ANEXOS · CRIAR CONTA" button under the call
 * to action with, for a signed-in user, a bare
 * `TR, Edital e seus anexos 32.2026.zip` link hanging beneath it. Same tender,
 * two screens, two design systems — tabs after the AI reading and a stray
 * block before it.
 *
 * The gate itself does not move: §8 is "files only with an account", and
 * `files: null` means the request never asked for the URLs, so an
 * unauthenticated response cannot carry them. What changes is that the lock is
 * now a *state of the tab* rather than an absence outside it. The tab is
 * selectable for a visitor precisely so they can open it and find out that the
 * agency published documents and that an account opens them — a padlocked
 * link straight out to the sign-up, which is what the screening screen does,
 * would answer the question by refusing to let them ask it.
 *
 * `files: []` is the third state and a different fact: the agency published
 * nothing. It gets its own sentence rather than the upsell.
 */
function Files({ tender }: { tender: TenderDetail }) {
  if (tender.files === null) {
    return (
      <LockedBlock
        href={ACCOUNT_HREF}
        title={page.filesLocked}
        description={page.filesLockedNote}
      />
    )
  }
  if (tender.files.length === 0) {
    return (
      <StateCard kind="empty" title={page.files.emptyTitle} description={page.files.emptyBody} />
    )
  }
  return (
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
  )
}

/**
 * The record, in the shape PNCP gives it — the object above, then tabs.
 *
 * PNCP puts `Itens · Arquivos · Atas de Registro de Preço · Contratos/Empenhos
 * · Histórico` under the object, and it is the page people cross-check us
 * against. Matching the shape is not imitation; it is not making someone learn
 * two mental models for the same record.
 *
 * Two tabs and not five, because we hold two: `tender_items` and
 * `tender_files`. Atas, contratos and histórico are PNCP endpoints nothing in
 * this product syncs, and a tab that opens on "não temos isto" is worse than
 * no tab.
 *
 * **Itens is the default.** It is the reason Sci was opening PNCP beside us,
 * it is PNCP's own first tab, and it is the one that is never locked.
 *
 * What stays *outside*: the status banner, the title, the deadline/value card,
 * "Por que este edital apareceu para você", "Operação" and the whole Objeto.
 * The Objeto in particular is never going behind a tab — §2.2 rule 4 wants the
 * agency's own words read before any reading of ours, and a tab is one click
 * more than "already on the screen".
 */
const TAB_PREFIX = 'tender'
export type OpportunityTab = 'items' | 'files'

function Record({
  tender,
  tab,
  onSelectTab,
  itemsVisible,
  onShowMoreItems,
}: {
  tender: TenderDetail
  tab: OpportunityTab
  onSelectTab?: (tab: OpportunityTab) => void
  itemsVisible?: number
  onShowMoreItems?: () => void
}) {
  const tabs: TabItem<OpportunityTab>[] = [
    { id: 'items', label: page.tabs.items },
    {
      id: 'files',
      label: page.tabs.files,
      // The padlock says the state before the tab is opened; the panel says
      // what to do about it. No `href`, so it stays a tab and not a link out.
      icon: tender.files === null ? 'locked' : undefined,
    },
  ]

  return (
    // `pt-7`: the third topic block, on the same 42px boundary as the pair
    // above it. See the note on that block.
    <section className="flex flex-col gap-3 pt-7">
      <Tabs items={tabs} active={tab} onSelect={onSelectTab} idPrefix={TAB_PREFIX} />
      {tab === 'items' ? (
        <TabPanel idPrefix={TAB_PREFIX} id="items">
          <TenderItems
            items={tender.items}
            visible={itemsVisible}
            onShowMore={onShowMoreItems}
          />
        </TabPanel>
      ) : (
        <TabPanel idPrefix={TAB_PREFIX} id="files">
          <Files tender={tender} />
        </TabPanel>
      )}
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
  /**
   * The same filters, for the links that leave this screen *forwards*.
   *
   * Required, and not derived from `backHref`: the triagem CTA below used to
   * be built from the tender id alone, so it dropped the search and the
   * triagem screen — which reads its own "Voltar" out of its query string —
   * had nothing to read. Two presses of Voltar then landed on a bare `/radar`.
   */
  search: RadarSearch
  /**
   * Whether a reading of this edital exists, and whether this caller has paid
   * for it. `null` while the route has not answered — the CTA is not drawn
   * then, because `tender` is null too.
   */
  screening?: ScreeningAvailability | null
  /**
   * Whether a first-time reader is told, under the button, that opening costs
   * one of their triagens.
   *
   * Its own switch, deliberately: the **label** is settled (Sci's ruling
   * above), the **cost line** is a separate question still with him, and the
   * two must not be tangled — turning it on changes one boolean and nothing
   * about which words the button uses. Off by default, because an unchanged
   * label is what he approved and a caption he has not seen is not part of it.
   *
   * Never shown to someone who has already spent on this tender: re-opening
   * their own triagem costs nothing (`quota.spend` de-duplicates on the
   * tender id), so a cost line there would be false.
   */
  showScreeningCost?: boolean
  now?: Date
  onRetry?: () => void
  /** Which tab of the record is open. The screen owns it; this stays pure. */
  tab?: OpportunityTab
  onSelectTab?: (tab: OpportunityTab) => void
  /** How many item rows the Itens tab has grown to. */
  itemsVisible?: number
  onShowMoreItems?: () => void
}

export function OpportunityView({
  tender,
  freshness,
  status,
  backHref,
  search,
  screening = null,
  showScreeningCost = false,
  now = new Date(),
  onRetry,
  tab = 'items',
  onSelectTab,
  itemsVisible = ITEMS_PAGE,
  onShowMoreItems,
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
  // The gate (§2.2 rule 6). `urgency === false` suppresses the countdown, the
  // "restantes" caption and the closed notice below — not the dates, which
  // stay on the screen, muted and labelled as the previous ones.
  const urgency = mayShowUrgency(tender)
  const notice = statusNotice(tender)
  const statusChip = statusChipLabel(tender)
  const days = daysUntil(tender.proposalsCloseAt, now)
  const why = reasons(tender, now)
  // The three states of a tender's budget, decided once in `headline.ts` so
  // this screen and the Radar card cannot say different things about the same
  // row. `budget.value === null` means there is no figure to set in Archivo —
  // the agency declared the budget confidential, published none at all, or
  // published a zero, which is the same absence wearing a number.
  const budget = tenderBudget(tender)
  const age = ageParts(freshness?.ageSeconds)
  // `null` for an id this app cannot parse: no link at all beats a link to a
  // page that does not exist, on the screen whose point is checking us.
  const pncpUrl = pncpEditalUrl(tender.id)
  const aiNotice = `${messages.ai.disclaimer} ${messages.ai.notLegalAdvice}`

  return (
    <div className="flex min-h-dvh flex-col">
      {bar}

      <main className="mx-auto flex w-full max-w-[960px] grow flex-col gap-3.5 px-gutter pb-10">
        {/* Above the title, because it governs everything under it (§3.1). */}
        <TenderStatusBanner tender={tender} />

        <div className="flex flex-col gap-1">
          <h1 className="font-display text-[24px] leading-tight font-semibold text-balance">
            {tenderTitle(tender.object, 180)}
          </h1>
          <p className="text-body text-muted">{agencyLine(tender)}</p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Status kind={badge.kind}>{badge.label}</Status>
          {/* Beside COMPATÍVEL, not ten rows down in the Operação block —
              §3.3. It repeats the banner deliberately: the badge row is what
              the eye reads with the title, and this is the state of it. */}
          {statusChip === null ? null : <Status kind="check">{statusChip}</Status>}
          <TenderTags tender={tender} />
        </div>

        {/* "As propostas já encerraram" is itself a claim about the clock, and
            on a suspended tender it is false — the órgão may resume it with new
            dates. So it passes through the same gate as the countdown rather
            than standing beside the status banner contradicting it. */}
        {tender.closed && urgency ? (
          <p className="rounded-[10px] bg-attention-soft px-3 py-2.5 text-meta text-ink">
            {page.closedNotice}
          </p>
        ) : null}

        <Card className="flex flex-col gap-3">
          {/* The block the screenshot was taken of. Suspended, it keeps the
              date — a user needs to know which date is the one that lapsed —
              but the label becomes "Prazo suspenso", the figure goes muted and
              is captioned "data anterior", and the whole right-hand column
              ("último dia" over "restantes") does not render at all. §3.2. */}
          <div className="flex items-end justify-between gap-3 border-b border-line pb-3">
            <div>
              <SectionLabel tone="muted">
                {notice ? notice.deadlineLabel : page.proposalsUntil}
              </SectionLabel>
              <div
                className={cn(
                  'pt-1 font-display text-[22px] leading-none font-semibold',
                  notice && 'text-muted',
                )}
              >
                {deadlineTall(tender.proposalsCloseAt) ?? copy.card.noDeadline}
              </div>
              {notice && tender.proposalsCloseAt ? (
                <div className="pt-1 text-meta text-muted">{statusCopy.previousDeadline}</div>
              ) : null}
            </div>
            {!urgency || days === null ? null : (
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
              {budget.value === null ? (
                <span className="text-meta text-muted">{budget.note}</span>
              ) : (
                <span className="font-display text-[28px] leading-none font-semibold tabular-nums">
                  {budget.value}
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

        {/* Directly under the box, spanning the column — a sibling of the
            two-column block and never a cell inside it. See `FullObject`. */}
        <FullObject object={tender.object} />

        {/* Sci: *"for the two sections below, we need a little separation,
            increase the padding between each topic."* Two boundaries were
            too tight, and the full-width Objeto above made the first of them
            worse: a paragraph now running the whole column straight into a
            section label, with only `main`'s 14px rhythm between them.

            The numbers come from `app/(public)/sections.tsx`, which already
            solves exactly this shape — a two-column block that stacks —
            with the rhythm PR #55 settled at 40/48:

              between topics   `pt-7` + main's `gap-3.5`  = **42px** (≈ #55's 40)
              stacked, <900px  `gap-7`                    = **28px**
              columns, ≥900px  `min-[900px]:gap-10`       = **40px** (was 32)

            Borrowing them keeps one system rather than inventing a second
            scale for the app screens.

            `pt-7` here and on `<Record>`, not a bigger gap on `main`: what
            needed air is a change of subject, not the header's tightly
            coupled rows (title → badges → card), which are one topic and
            want to stay at 14px. The two `pt-7`s together are also what keeps
            this block from reading as floating — 42px above it and 42px
            below, rather than 42 above and 14 below. */}
        <div className="flex flex-col gap-7 pt-7 min-[900px]:grid min-[900px]:grid-cols-2 min-[900px]:items-start min-[900px]:gap-10">
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

        {/* PNCP's shape: the object, then the record's tabs. */}
        <Record
          tender={tender}
          tab={tab}
          onSelectTab={onSelectTab}
          itemsVisible={itemsVisible}
          onShowMoreItems={onShowMoreItems}
        />

        <div className="mt-auto flex flex-col gap-2 pt-2">
          {/* Legal brief §2.2 rule 5: the AI notice appears on EVERY result
              screen, not only in the terms. This screen prints a compatibility
              reading — "Por que este edital apareceu para você" — so it is a
              result screen, and the notice was missing from it. It sits above
              the call to action, which is where the reading stops being read
              and starts being acted on. */}
          <p className="text-caption leading-relaxed text-muted">{aiNotice}</p>
          {/* Sci: *"I already have the AI Triage for this item … but the
              button remains like the first time, for my user."* — and his
              ruling on the cure: *"If it is the first time of that user, the
              CTA stays as-is. However, if the user already requested the
              triage before, he only wants to see it again, so we could change
              the text."*

              So the switch is `spent`, and only `spent`. **Not `ready`**: a
              tender whose analysis exists because somebody else opened it
              (§3.2 shares the reading) is still a first-time request for this
              user, and Sci wants that to read exactly as it always has. The
              first-time label is therefore untouched. */}
          <Button href={screeningHref(tender.id, search)} fullWidth iconEnd="arrowRight">
            {screening?.spent ? page.screeningCtaRequested : page.screeningCta}
          </Button>
          {showScreeningCost && screening !== null && !screening.spent ? (
            <p className="text-caption leading-relaxed text-muted">
              {screening.ready ? page.screeningCostReady : page.screeningCost}
            </p>
          ) : null}
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
