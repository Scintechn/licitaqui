import Link from 'next/link'
import { AppBar, AppBarActionLink, Button, Icon, Logo, Select, StateCard } from '@/components'
import { cn } from '@/lib/cn'
import type {
  CompanyView,
  ErrorCode,
  Freshness,
  TenderCard,
  TenderGroup,
  VisitorView,
} from '@/lib/radar/contract'
import { ageParts } from '@/lib/radar/format'
import { errorText } from '@/lib/radar/error-text'
import { format, messages } from '@/lib/messages'
import { radarHref } from '@/lib/radar/client'
import { ACCOUNT_HREF, ALERTS_HREF } from '@/lib/routes'
import { TENDER_GROUPS } from '@/lib/radar/contract'
import { UF_OPTIONS } from '@/lib/radar/ufs'
import { TenderCardView } from './tender-card'

/**
 * The Radar — canvas 02, `Editais.dc.html`.
 *
 * Everything this screen can look like, as one pure function of a view model:
 * app bar, heading, the visitor strip, the three group tabs with their counts,
 * the filter row, the "atualizado há X" line, and then either the list or one
 * of the state cards. No hooks, no fetching and no clock — `radar-screen.tsx`
 * owns all three — which is what lets every state below be rendered and
 * asserted with `renderToStaticMarkup`.
 *
 * ## The states are the screen
 *
 * Spec §3 exists so a screen never waits on PNCP or the AI. That makes the
 * non-ready states first-class here rather than a spinner bolted on:
 *
 * | status | what happened |
 * |---|---|
 * | `analyzing` | `202` + a job: the CNPJ has never been looked up (§3.1 step 4) |
 * | `noSegments` | the CNAEs reach no segment — B6 leaves 777 of 1,332 codes unmapped on purpose |
 * | `manualCnae` | BrasilAPI had no answer, so the row has no CNAEs at all (§9) |
 * | `needCnpj` | nothing to search by: no CNPJ on the device and no keyword |
 * | `timeout` | 60 s passed with the job still queued (§3.1) |
 * | `error` | a code from the contract, including PNCP being down |
 * | `ready` + 0 tenders | the group is genuinely empty under these filters |
 *
 * `noSegments` is the one worth reading twice. It is not a failure and it is
 * not rare: a CNPJ whose activities are not in B6's map is a normal outcome,
 * and the board's empty state ("Nenhum edital compatível agora") would blame
 * the filters for something the filters did not do. It gets its own words.
 */

const copy = messages.radar
const list = copy.list

export type RadarStatus =
  | { kind: 'ready' }
  | { kind: 'analyzing'; what: 'company' | 'list' }
  | { kind: 'timeout' }
  | { kind: 'error'; code: ErrorCode; text?: string }
  | { kind: 'needCnpj' }
  | { kind: 'noSegments' }
  | { kind: 'manualCnae' }

export type RadarQuery = {
  cnpj: string | null
  state: string | null
  q: string | null
  group: TenderGroup
}

export type RadarViewProps = {
  query: RadarQuery
  status: RadarStatus
  company: CompanyView | null
  visitor: VisitorView | null
  counts: Record<TenderGroup, number> | null
  tenders: TenderCard[]
  freshness: Freshness | null
  /**
   * The cursor for the next page, straight from the envelope. `null` is the
   * end of the list and hides the control — there is nothing more to fetch.
   */
  nextCursor?: string | null
  /** A page is in flight: the button says so and refuses a second press. */
  loadingMore?: boolean
  /** Absent means no pagination at all, the way `onRetry` works. */
  onLoadMore?: () => void
  /** Injected so the countdown on every card is assertable. */
  now?: Date
  /**
   * Client-side navigation. When it is absent every control still works: the
   * tabs are real links and the filters are a real GET form, so the screen
   * degrades to full navigations instead of breaking.
   */
  onNavigate?: (href: string) => void
  onRetry?: () => void
}

/* ------------------------------------------------------------------ pieces */

function CompanyLine({ company, query }: { company: CompanyView | null; query: RadarQuery }) {
  const name = company?.tradeName || company?.legalName || list.companyFallback
  const cnaes = company ? company.segments.length : 0
  const where = query.state ?? copy.ufAll
  return (
    <p className="flex items-center gap-1.5 text-meta text-muted">
      <span>
        {name} · {format(list.cnaeCount, { count: cnaes })} · {where}
      </span>
      <Icon name="chevronRight" size={14} />
    </p>
  )
}

/**
 * The visitor strip of canvas 02: "Visitante · 2 dias · 2 triagens · Criar
 * conta". Plan §5 gives the banner to task D4, which needs it on the screening
 * screen too; it lives here for now because canvas 02 draws it, and it is one
 * self-contained function for D4 to lift.
 */
export function VisitorBanner({ visitor, now }: { visitor: VisitorView; now: Date }) {
  const msLeft = new Date(visitor.expiresAt).getTime() - now.getTime()
  const days = Math.max(0, Math.ceil(msLeft / 86_400_000))
  const screenings =
    visitor.screeningsLeft === null
      ? copy.visitor.unlimited
      : format(copy.visitor.screenings, { count: visitor.screeningsLeft })

  if (visitor.expired) {
    return (
      <div className="mx-gutter">
        <StateCard
          kind="limit"
          title={copy.visitor.expiredTitle}
          description={copy.visitor.expiredBody}
          action={
            <Button variant="link" href={ACCOUNT_HREF} className="px-0">
              {copy.visitor.createAccount}
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="mx-gutter flex items-center gap-2.5 rounded-[10px] bg-attention-soft px-3 py-2.5 text-meta">
      <Icon name="visitor" size={18} className="text-attention" />
      <span className="grow text-ink">
        <strong className="font-semibold text-attention">{copy.visitor.label}</strong>{' '}
        ·{' '}
        {format(copy.visitor.line, {
          dias: format(copy.visitor.days, { count: days }),
          triagens: screenings,
        })}
      </span>
      <Link
        href={ACCOUNT_HREF}
        className="inline-flex min-h-8 items-center font-semibold text-blue no-underline"
      >
        {copy.visitor.createAccount}
      </Link>
    </div>
  )
}

/**
 * The three group chips with their counts. Real links, so the group is in the
 * URL: shareable, reloadable, and `Back` returns to the tab you were on.
 * `next/link` navigates on the client, which is why there is no click handler
 * here re-implementing what the browser and the router already do.
 */
function GroupTabs({
  active,
  counts,
  query,
}: {
  active: TenderGroup
  counts: Record<TenderGroup, number> | null
  query: RadarQuery
}) {
  return (
    <nav aria-label={list.resultsLabel} className="flex gap-2 overflow-x-auto px-gutter pt-3 pb-2">
      {TENDER_GROUPS.map((group) => {
        const current = group === active
        return (
          <Link
            key={group}
            href={radarHref({ ...query, group })}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-9 items-center gap-1.5 rounded-pill px-2.5 text-meta font-medium',
              'whitespace-nowrap no-underline transition-colors',
              current
                ? 'bg-blue text-surface'
                : 'border border-line-strong bg-surface text-ink hover:bg-fill-muted',
            )}
          >
            {list.groups[group]}
            {counts ? <span className="font-mono text-caption">{counts[group]}</span> : null}
          </Link>
        )
      })}
    </nav>
  )
}

/**
 * What the selected tab actually means, in one line, under the tabs.
 *
 * The three hints — "seu CNAE atende", "pode haver exigências", "achado pela
 * busca" — existed only inside "Como funciona" on the marketing landing, which
 * is a page a founder arriving from an e-mail link never passes. Inside the
 * Radar the tabs were bare labels, so "Verificar" was a word with no stated
 * meaning on the screen where it decides whether someone opens an edital.
 *
 * It is also the framing rule doing its job: brief §2.2 rule 2 says a
 * compatibility verdict must always show why, and "pode haver exigências" is
 * the sentence that keeps "Verificar" a reading rather than a judgement.
 */
function GroupHint({ group }: { group: TenderGroup }) {
  return (
    <p className="px-gutter pb-1 text-meta text-muted">{list.groupHint[group]}</p>
  )
}

/**
 * "Filtros" and "Ordenar: prazo". The filters are a `<details>` holding a real
 * GET form, so they work before React has hydrated and the result is a URL the
 * user can share or bookmark. Sorting is by deadline and is not a choice: the
 * list query orders by `proposals_close_at`, and offering a control that
 * changes nothing would be a lie.
 */
function FilterRow({
  query,
  onNavigate,
}: {
  query: RadarQuery
  onNavigate?: (href: string) => void
}) {
  return (
    <div className="px-gutter">
      <details className="group">
        <summary
          className={cn(
            'flex cursor-pointer list-none items-center justify-between py-1 text-body',
            '[&::-webkit-details-marker]:hidden',
          )}
        >
          <span className="inline-flex min-h-touch items-center gap-1.5">
            <Icon name="filters" size={16} />
            {list.filters}
          </span>
          <span className="text-muted">{list.sort}</span>
        </summary>

        <form
          method="get"
          action="/radar"
          className="flex flex-col gap-3 pt-1 pb-3 min-[560px]:flex-row min-[560px]:items-end"
          onSubmit={
            onNavigate
              ? (event) => {
                  event.preventDefault()
                  const data = new FormData(event.currentTarget)
                  onNavigate(
                    radarHref({
                      cnpj: String(data.get('cnpj') ?? '') || null,
                      state: String(data.get('uf') ?? '') || null,
                      q: String(data.get('q') ?? '').trim() || null,
                      group: query.group,
                    }),
                  )
                }
              : undefined
          }
        >
          <input type="hidden" name="cnpj" value={query.cnpj ?? ''} />
          {query.group === 'compatible' ? null : (
            <input type="hidden" name="group" value={query.group} />
          )}
          <Select
            id="radar-uf"
            name="uf"
            label={copy.landing.ufLabel}
            defaultValue={query.state ?? ''}
            options={UF_OPTIONS}
            className="min-[560px]:w-56"
          />
          <div className="flex grow flex-col gap-1.5">
            <label htmlFor="radar-q" className="text-meta font-medium text-ink">
              {copy.landing.keywordLabel}
            </label>
            <input
              id="radar-q"
              name="q"
              type="search"
              defaultValue={query.q ?? ''}
              placeholder={copy.landing.keywordPlaceholder}
              /* 16px (`text-base`): below that iOS Safari zooms on focus. */
              className="min-h-control w-full rounded-control border border-line-strong bg-surface px-3 text-base text-ink placeholder:text-muted"
            />
          </div>
          <Button type="submit" variant="secondary" className="min-[560px]:w-auto">
            {list.apply}
          </Button>
        </form>
      </details>
    </div>
  )
}

/** "Atualizado há 12 minutos", and what we are doing about it when it is old. */
export function FreshnessLine({ freshness }: { freshness: Freshness | null }) {
  if (!freshness) return null
  const parts = ageParts(freshness.ageSeconds)
  if (!parts) {
    return <p className="px-gutter pb-2 text-caption text-muted">{copy.freshness.unknown}</p>
  }
  const age = parts.unit === 'now' ? copy.age.now : format(copy.age[parts.unit], { count: parts.count })
  const template = freshness.state === 'stale' ? copy.freshness.stale : copy.freshness.fresh
  return <p className="px-gutter pb-2 text-caption text-muted">{format(template, { idade: age })}</p>
}

/**
 * "Ver mais editais", and the line that says where in the list you are.
 *
 * ## A button, not infinite scroll
 *
 * The list is ordered by deadline, so people scan it for the ones they can
 * still bid on rather than browsing it. A press is a decision to see the next
 * twenty; a scroll is not, and auto-loading would keep the footer moving away
 * and keep fetching for someone who stopped reading two screens ago.
 *
 * ## What the counts do while a page loads
 *
 * Nothing. The tab badge is the **total** under the current filters — 79 — and
 * paging does not change it: blanking it or spinning it would say the total is
 * being recounted, and it would make all three tabs flicker on every press.
 * The progress that *is* real gets its own line ("Mostrando 20 de 79"), which
 * keeps its old numbers while the page is in flight and updates once the rows
 * are actually on screen. The only control that changes state is the button
 * itself.
 *
 * The line is `aria-live="polite"` because the rows append below the button:
 * without it, a screen-reader user presses "Ver mais editais" and is told
 * nothing happened.
 */
function More({
  shown,
  total,
  nextCursor,
  loading,
  onLoadMore,
}: {
  shown: number
  total: number | null
  nextCursor: string | null
  loading: boolean
  onLoadMore?: () => void
}) {
  // No handler means no client navigation — the same contract `onRetry` has —
  // and a cursor of `null` means the last page is already on screen.
  if (!onLoadMore || shown === 0) return null

  return (
    <div className="flex flex-col items-center gap-2 pt-4">
      <p aria-live="polite" className="text-caption text-muted">
        {format(list.showing, { shown, total: total ?? shown })}
      </p>
      {nextCursor ? (
        <Button
          variant="secondary"
          onClick={onLoadMore}
          disabled={loading}
          aria-busy={loading || undefined}
          className="w-full min-[560px]:w-auto"
        >
          {loading ? list.moreLoading : list.more}
        </Button>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ states */

const EMPTY: Record<TenderGroup, { title: string; body: string }> = {
  compatible: { title: copy.states.emptyTitle, body: copy.states.emptyBody },
  check: { title: copy.states.emptyCheckTitle, body: copy.states.emptyCheckBody },
  keyword: { title: copy.states.emptyKeywordTitle, body: copy.states.emptyKeywordBody },
}

function RetryAction({ label, onRetry }: { label: string; onRetry?: () => void }) {
  if (!onRetry) return null
  return (
    <Button variant="link" className="px-0" onClick={onRetry}>
      {label}
    </Button>
  )
}

function Body({
  status,
  group,
  tenders,
  now,
  onRetry,
}: {
  status: RadarStatus
  group: TenderGroup
  tenders: TenderCard[]
  now: Date
  onRetry?: () => void
}) {
  switch (status.kind) {
    case 'analyzing':
      return (
        <StateCard
          kind="analyzing"
          title={
            status.what === 'company'
              ? copy.states.analyzingCompanyTitle
              : copy.states.analyzingListTitle
          }
          description={
            status.what === 'company'
              ? copy.states.analyzingCompanyBody
              : copy.states.analyzingListBody
          }
        />
      )
    case 'timeout':
      return (
        <StateCard
          kind="empty"
          title={copy.states.timeoutTitle}
          description={copy.states.timeoutBody}
          action={<RetryAction label={copy.states.timeoutAction} onRetry={onRetry} />}
        />
      )
    case 'error':
      // `empty`, not `limit`: `limit` draws the board's padlock, which would
      // tell the user a plan is missing when what is missing is an answer.
      return (
        <StateCard
          kind="empty"
          title={copy.states.errorTitle}
          description={status.text ?? errorText(status.code)}
          action={<RetryAction label={copy.states.errorAction} onRetry={onRetry} />}
        />
      )
    case 'needCnpj':
      return (
        <StateCard
          kind="empty"
          title={copy.states.needCnpjTitle}
          description={copy.states.needCnpjBody}
          action={
            <Button variant="link" href="/" className="px-0" iconEnd="arrowRight">
              {copy.states.needCnpjAction}
            </Button>
          }
        />
      )
    case 'noSegments':
      return (
        <StateCard
          kind="empty"
          title={copy.states.noSegmentsTitle}
          description={copy.states.noSegmentsBody}
          action={
            <Button variant="link" href="/" className="px-0" iconEnd="arrowRight">
              {copy.states.noSegmentsAction}
            </Button>
          }
        />
      )
    case 'manualCnae':
      if (tenders.length > 0) break
      return (
        <StateCard
          kind="empty"
          title={copy.states.manualCnaeTitle}
          description={copy.states.manualCnaeBody}
        />
      )
    case 'ready':
      break
  }

  if (tenders.length === 0) {
    return (
      <StateCard
        kind="empty"
        title={EMPTY[group].title}
        description={EMPTY[group].body}
        action={
          <Button variant="link" href="/" className="px-0" iconEnd="arrowRight">
            {copy.states.emptyAction}
          </Button>
        }
      />
    )
  }

  return (
    <ul className="grid list-none grid-cols-1 gap-2.5 p-0 min-[900px]:grid-cols-2 min-[1280px]:grid-cols-3">
      {tenders.map((tender) => (
        <li key={tender.id} className="flex">
          <TenderCardView tender={tender} now={now} />
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------- shell */

export function RadarView({
  query,
  status,
  company,
  visitor,
  counts,
  tenders,
  freshness,
  nextCursor = null,
  loadingMore = false,
  now = new Date(),
  onNavigate,
  onRetry,
  onLoadMore,
}: RadarViewProps) {
  const showList = status.kind === 'ready' || status.kind === 'manualCnae'

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#radar"
        className="sr-only focus:not-sr-only focus:absolute focus:m-2 focus:rounded-control focus:bg-surface focus:px-3 focus:py-2"
      >
        {copy.nav.skip}
      </a>

      <AppBar
        leading={
          <Link href="/" aria-label={copy.nav.home} className="inline-flex">
            <Logo size={30} />
          </Link>
        }
        actions={
          <>
            <AppBarActionLink icon="alert" label={copy.nav.alerts} href={ALERTS_HREF} />
            <AppBarActionLink icon="account" label={copy.nav.account} href={ACCOUNT_HREF} />
          </>
        }
      />

      <main id="radar" className="mx-auto flex w-full max-w-[1120px] grow flex-col pb-10">
        <div className="flex flex-col gap-1 px-gutter pb-2.5">
          <h1 className="font-display text-[28px] leading-tight font-semibold">{list.title}</h1>
          <CompanyLine company={company} query={query} />
        </div>

        {visitor ? <VisitorBanner visitor={visitor} now={now} /> : null}

        <GroupTabs active={query.group} counts={counts} query={query} />
        <GroupHint group={query.group} />

        <FilterRow query={query} onNavigate={onNavigate} />

        {showList ? <FreshnessLine freshness={freshness} /> : null}

        <div className="px-gutter">
          <Body
            status={status}
            group={query.group}
            tenders={showList ? tenders : []}
            now={now}
            onRetry={onRetry}
          />
          {showList ? (
            <More
              shown={tenders.length}
              total={counts ? counts[query.group] : null}
              nextCursor={nextCursor}
              loading={loadingMore}
              onLoadMore={onLoadMore}
            />
          ) : null}
        </div>
      </main>
    </div>
  )
}
