import Link from 'next/link'
import {
  AppBar,
  AppBarAction,
  AppBarActionLink,
  Button,
  Field,
  Icon,
  Logo,
  Select,
  StateCard,
} from '@/components'
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
import { radarHref, tenderHref } from '@/lib/radar/client'
import { everyGroupEmpty, otherPopulatedGroup } from '@/lib/radar/group'
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
  /** The tab on screen: chosen, or elected by `bestGroup()` from the counts. */
  group: TenderGroup
  /**
   * The user pressed this tab. An elected one must not be written into the
   * filter form as though it had been, or changing the UF would carry a
   * decision the user never made into a search where it may be wrong again.
   */
  groupChosen?: boolean
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
  /**
   * Opens the menu drawer (canvas 09). Absent on the server pass and wherever
   * there is no drawer to open — the control is then not rendered at all
   * rather than rendered inert.
   */
  onOpenMenu?: () => void
}

/* ------------------------------------------------------------------ pieces */

function CompanyLine({ company, query }: { company: CompanyView | null; query: RadarQuery }) {
  const name = company?.tradeName || company?.legalName || list.companyFallback
  const cnaes = company ? company.segments.length : 0
  const where = query.state ?? copy.ufAll
  // No chevron. It used to draw one here, inside a `<p>` with no link, no
  // button and no handler — the universal "tap me" affordance on something
  // that could not be tapped, which is worse than no affordance at all: it
  // teaches people the header is dead. The way to change the search is the
  // filter row below, which now says so in as many words.
  return (
    <p className="text-meta text-muted">
      {name} · {format(list.cnaeCount, { count: cnaes })} · {where}
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
 *
 * ## The count is the whole point of the chip
 *
 * A user on an empty tab cannot see that the answer is one chip away unless
 * the chips say how much is in them, so the number is not decoration: it is
 * what stops an empty Compatíveis reading as a broken screen. Two things it
 * needs in order to do that job.
 *
 * **It has to be said out loud.** A bare `0` next to "Verificar" is a digit
 * with no noun: a screen reader announced "Verificar 0" and left the listener
 * to guess. The visible number keeps its place and carries the words with it
 * (`tabs.count`, "nenhum edital" / "36 editais") in text only assistive
 * technology reads.
 *
 * **Zero has to look like zero.** On an unselected chip the count is quiet;
 * an empty one is quieter still, so the eye separates "nothing here" from "36
 * here" without reading either number.
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
        const count = counts ? counts[group] : null
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
            {count === null ? null : (
              <>
                {/* No `opacity-*` on a count: a muted grey at 60% stops
                    clearing AA, and `styles/contrast.test.ts` only measures
                    the tokens themselves. The quiet version of zero is a
                    different token, not a faded one. */}
                <span
                  aria-hidden
                  className={cn(
                    'font-mono text-caption tabular-nums',
                    current ? '' : count === 0 ? 'text-muted' : 'text-ink',
                  )}
                >
                  {count}
                </span>
                <span className="sr-only">{format(copy.tabs.count, { count })}</span>
              </>
            )}
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
 * "Trocar empresa ou filtros", and "Ordenar: prazo" beside it. The filters are
 * a `<details>` holding a real GET form, so they work before React has
 * hydrated and the result is a URL the user can share or bookmark. Sorting is
 * by deadline and is not a choice: the list query orders by
 * `proposals_close_at`, and offering a control that changes nothing would be a
 * lie.
 *
 * ## Two things the `<summary>` must not do
 *
 * **It must not say the sort order.** "Ordenar: prazo" used to be a second
 * `<span>` inside the `<summary>`, which made the computed accessible name of
 * the control "Trocar empresa ou filtros Ordenar: prazo" (WCAG 4.1.2). A
 * statement about the list is not part of the name of the button that changes
 * it. The label now sits outside the `<details>` entirely, positioned over the
 * row's right end so the line looks exactly as it did — and left
 * `pointer-events-none`, so the summary keeps the full-width tap target it
 * always had. Do not move it back inside, and do not shrink the `<details>` to
 * the left half to make room: the form it opens is full-width and would be
 * squeezed with it.
 *
 * **It must look like it opens.** The native marker is hidden and the
 * `filters` icon is identical open and closed, so this 350×52 control — the
 * only way to change the search — read as a caption. The `chevronRight`
 * rotates a quarter turn on open; `group-open:` reads the `[open]` attribute
 * off the `<details>`, and the reduced-motion rule in `tokens.css` already
 * flattens the transition for anyone who asked for that.
 */
function FilterRow({
  query,
  onNavigate,
}: {
  query: RadarQuery
  onNavigate?: (href: string) => void
}) {
  return (
    <div className="relative px-gutter">
      <details className="group">
        <summary
          className={cn(
            'flex cursor-pointer list-none items-center py-1 text-body',
            '[&::-webkit-details-marker]:hidden',
          )}
        >
          {/*
            `changeCompany` — "Trocar empresa ou filtros" — not `filters`.
            The string was written for exactly this and was rendered nowhere;
            "Filtros" does not tell anybody that the whole search lives in
            here, which is why people went back to the home page to look for
            another company.
          */}
          <span className="inline-flex min-h-touch items-center gap-1.5">
            <Icon name="filters" size={16} />
            {list.changeCompany}
            <Icon
              name="chevronRight"
              size={16}
              className="transition-transform group-open:rotate-90"
            />
          </span>
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
          {/*
            The CNPJ was a hidden input: carried through every search and
            editable nowhere, so the one thing you could not change from the
            Radar was the company — the whole reason people bounced back to
            the landing. It is the same `name="cnpj"` posting to the same
            `/radar`, which already treats `?cnpj=` as a real, shareable
            address; making it visible is the entire change.
          */}
          <Field
            id="radar-cnpj"
            name="cnpj"
            type="text"
            inputMode="numeric"
            maxLength={18}
            mono
            label={copy.landing.cnpjLabel}
            placeholder={copy.landing.cnpjPlaceholder}
            defaultValue={query.cnpj ?? ''}
            className="min-[560px]:w-60"
          />
          {query.groupChosen ? <input type="hidden" name="group" value={query.group} /> : null}
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
              className="min-h-control w-full rounded-control border border-field-line bg-surface px-3 text-base text-ink placeholder:text-muted"
            />
          </div>
          <Button type="submit" variant="secondary" className="min-[560px]:w-auto">
            {list.apply}
          </Button>
        </form>
      </details>

      {/*
        Outside the `<details>`, so it is not part of the summary's accessible
        name (4.1.2), and drawn over the row's right end so the line is the one
        the board drew. `min-h-touch` and `top-1` are the summary's own box —
        the two labels share a baseline. `pointer-events-none` hands the click
        back to the summary underneath, which keeps the tap target full width.
      */}
      <span className="pointer-events-none absolute top-1 right-gutter inline-flex min-h-touch items-center text-body text-muted">
        {list.sort}
      </span>
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

/**
 * What an empty tab says — which depends on what the *other* tabs hold.
 *
 * Three different facts were all rendered as "Nenhum edital compatível agora":
 * this group is empty and another one is not; this group is empty and so are
 * the other two; and the search itself found nothing anywhere. The first is
 * the one Sci hit, and the only honest thing to do with it is name the tab
 * that has the results and link to it — the counts on the chips say the same
 * thing, but the person reading an empty state is looking here.
 *
 * "Every group is empty" is a different sentence and not a louder version of
 * the same one: there is no tab to send anyone to, so the way out is the
 * filters, and the copy says what is true — the list is rebuilt every thirty
 * minutes (§3.2) and nothing open matches right now.
 */
function EmptyGroup({
  query,
  counts,
}: {
  query: RadarQuery
  counts: Record<TenderGroup, number> | null
}) {
  const group = query.group
  const elsewhere = otherPopulatedGroup(counts, group)

  if (everyGroupEmpty(counts)) {
    return (
      <StateCard
        kind="empty"
        title={list.allEmpty.title}
        description={list.allEmpty.body}
        action={
          <Button variant="link" href="/" className="px-0" iconEnd="arrowRight">
            {copy.states.emptyAction}
          </Button>
        }
      />
    )
  }

  return (
    <StateCard
      kind="empty"
      title={EMPTY[group].title}
      description={EMPTY[group].body}
      action={
        elsewhere ? (
          <Button
            variant="link"
            href={radarHref({ ...query, group: elsewhere })}
            className="px-0"
            iconEnd="arrowRight"
          >
            {format(list.seeOther, {
              quantos: format(copy.tabs.count, { count: counts ? counts[elsewhere] : 0 }),
              grupo: list.groups[elsewhere],
            })}
          </Button>
        ) : (
          <Button variant="link" href="/" className="px-0" iconEnd="arrowRight">
            {copy.states.emptyAction}
          </Button>
        )
      }
    />
  )
}

function Body({
  status,
  group,
  counts,
  query,
  tenders,
  now,
  onRetry,
}: {
  status: RadarStatus
  group: TenderGroup
  counts: Record<TenderGroup, number> | null
  query: RadarQuery
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
    return <EmptyGroup query={query} counts={counts} />
  }

  return (
    <ul className="grid list-none grid-cols-1 gap-2.5 p-0 min-[900px]:grid-cols-2 min-[1280px]:grid-cols-3">
      {tenders.map((tender) => (
        <li key={tender.id} className="flex">
          {/* The card carries the search into the tender's URL, which is where
              the Opportunity screen reads its "Voltar" link from. */}
          <TenderCardView
            tender={tender}
            now={now}
            href={tenderHref(tender.id, { ...query, group })}
          />
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
  onOpenMenu,
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
            {/* Canvas 09's trigger.

                The drawer, its API, its view and its tests all shipped in
                #93 — and this control did not, so `onOpenMenu` sat on the
                props type, called by nothing, and `radar.nav.menu` ("Abrir
                menu") stayed the approved string rendered in zero files that
                `menu-view.tsx`'s own docstring cites as the bug. An unused
                optional prop is legal TypeScript, so the build was green and
                every test passed: `menu-view.test.tsx` renders `MenuView`
                directly and never asks whether anything can reach it.

                Rendered only when a handler exists, so the Landing's example
                panel does not draw a button that opens nothing. */}
            {onOpenMenu ? (
              <AppBarAction icon="menu" label={copy.nav.menu} onClick={onOpenMenu} />
            ) : null}
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
            counts={counts}
            query={query}
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
