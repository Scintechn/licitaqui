import Link from 'next/link'
import { FocusKeyword } from './focus-keyword'
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
  ErrorCode,
  Freshness,
  GroupedBy,
  TenderCard,
  TenderGroup,
  TenderSort,
  VisitorView,
} from '@/lib/radar/contract'
import { ageParts } from '@/lib/radar/format'
import { errorText } from '@/lib/radar/error-text'
import { format, messages } from '@/lib/messages'
import { ME_EPP_PARAM, MODALITY_PARAM, radarHref, tenderHref } from '@/lib/radar/client'
import { everyGroupEmpty, otherPopulatedGroup } from '@/lib/radar/group'
import { ACCOUNT_HREF, ALERTS_HREF } from '@/lib/routes'
import { DEFAULT_SORT, TENDER_GROUPS, TENDER_SORTS } from '@/lib/radar/contract'
import {
  ME_EPP_OPTIONS,
  MODALITY_OPTIONS,
  readMeEpp,
  readModality,
  type MeEppFilter,
  type ModalityFilter,
} from '@/lib/radar/filters'
import { listKey } from '@/lib/radar/list-cache'
import { UF_OPTIONS } from '@/lib/radar/ufs'
import { FavouriteNotices } from './favourite-notice'
import { FavouriteStar } from './favourite-star'
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
 * | `manualCnae` | neither BrasilAPI nor CNPJá could read the CNAEs, or both said the CNPJ does not exist (§9) |
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
  | { kind: 'manualCnae'; cnpjNotFound: boolean }

export type RadarQuery = {
  cnpj: string | null
  state: string | null
  q: string | null
  /** D52's modalidade filter, or `null` for *Todas*. */
  modality?: ModalityFilter | null
  /** D52's ME/EPP filter, or `null` for *Todas*. */
  meEpp?: MeEppFilter | null
  /** The tab on screen: chosen, or elected by `bestGroup()` from the counts. */
  group: TenderGroup
  /**
   * The user pressed this tab. An elected one must not be written into the
   * filter form as though it had been, or changing the UF would carry a
   * decision the user never made into a search where it may be wrong again.
   *
   * **Read by every address this screen builds out of `query`, not only by the
   * form** — the sort links (D51) had to learn the same rule, and the filter
   * form's `onSubmit` turned out never to have known it while its hidden field
   * did. Anything that spreads `query` into `radarHref` has to answer this flag.
   */
  groupChosen?: boolean
  /**
   * The order the list came back in (D51). Optional, and absent means
   * `DEFAULT_SORT`: the Landing's example panel and anything else that renders
   * this screen as an illustration has no order to state, and the deadline
   * order is the one it has always drawn.
   */
  sort?: TenderSort | null
}

export type RadarViewProps = {
  query: RadarQuery
  status: RadarStatus
  /**
   * The company the **list route** grouped by, straight from its envelope
   * (D19). There is deliberately no second company prop: the header's name,
   * its CNAE count and the tab help all read this one field, so they cannot
   * disagree with the list they sit above.
   */
  grouping: GroupedBy | null
  visitor: VisitorView | null
  counts: Record<TenderGroup, number> | null
  tenders: TenderCard[]
  /**
   * Which of `tenders` the reader has marked — D23's stars, straight from the
   * list envelope through `RadarScreen`.
   */
  favourites?: ReadonlySet<string>
  /**
   * A card's star was pressed. **Absent means no star is drawn at all**, the way
   * `onOpenMenu` works: the Landing's example panel has no viewer to report
   * marks for, and a control that cannot persist anything must not be rendered
   * looking as though it can.
   */
  onFavourite?: (tenderId: string, marked: boolean) => void
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

/**
 * How many CNAEs the list was grouped by — or **`null` for "we do not know"**.
 *
 * One function, because the header and the tab help have to give the same
 * answer and the first attempt at D19 let them differ: the header refused to
 * say whether a company existed while the hint beneath it asserted that no CNAE
 * had been read. Three states, in one place, read by both.
 *
 * "There is no company" is a claim, and only a list route that **answered**
 * supports it. `analyzing`, `timeout` and `error` are states in which nobody
 * asked or nobody replied — the request that would have reported a cookie CNPJ
 * never came back — so reading an absence out of them would be D19 in the
 * opposite direction. `needCnpj` is the one unanswered status that does know:
 * it is reached only when there is neither a CNPJ nor a search term.
 */
function cnaeState(grouping: GroupedBy | null, status: RadarStatus): number | null {
  if (grouping) return grouping.cnaeCount
  return status.kind === 'ready' || status.kind === 'needCnpj' ? 0 : null
}

/**
 * How many of B6's 14 segments those CNAEs actually reach — `null` while the
 * route has not answered, the same unknown `cnaeState` reports.
 *
 * **CNAEs read and segments reached are different numbers, and the tab hint
 * depends on the second one.** D19 fixed the header's half: it no longer says
 * "sem CNAE lido" over a list grouped by a real company. This is the step
 * further in, raised as `TO_VALIDATE.md` #13 and decided by Sci on 2026-10-06:
 * a company whose CNAEs map to **no** segment was still told *"seu CNAE
 * atende"* over an empty Compatíveis tab. That is a claim about a match where
 * there is no match to claim — B6 leaves 777 of 1 332 CNAEs unmapped on
 * purpose, so it is a normal outcome and not an error, and the screen already
 * has `noSegments` copy for exactly this state. The hint was the one place
 * that did not know.
 */
function segmentState(grouping: GroupedBy | null): number | null {
  if (!grouping) return null
  return grouping.company?.segments.length ?? 0
}

/**
 * "Papelaria Central · 3 CNAEs · SP" — and the two cases where it may not say
 * that (D19).
 *
 * ## One supplier, and it is the route that did the grouping
 *
 * Every fact here comes from `grouping`. It used to come from whatever company
 * the screen had resolved itself, which was `null` unless the URL carried
 * `?cnpj=` — while the list route resolved `?cnpj= ?? visitors.cnpj` and
 * grouped 13 editais by that company. So the line read *"Sua empresa · sem
 * CNAE lido"* above *"Compatíveis 13"*, and the false half was the half
 * claiming a match. The browser cannot fix that by looking harder: the visitor
 * cookie is `httpOnly`, and only the route can see it.
 *
 * ## "sem CNAE lido" now means it
 *
 * `cnaeCount` counts **CNAEs** — `main_cnae` plus `secondary_cnaes`. It used to
 * be `company.segments.length`, a count of the 14 POC-1 segments those CNAEs
 * reach, which is a different number in both directions (`company.ts`).
 *
 * ## Three renderings, because there are three states
 *
 * - **Nothing known yet** — the list has not answered, so the CNPJ driving it
 *   may exist and be invisible from here. The line names no company and claims
 *   no CNAE: unknown is reported as unknown, never as absent.
 * - **No company at all** — a keyword search with no CNPJ anywhere. It says so,
 *   and every row in the list is `keyword` by construction (`labels([])` is
 *   `array[]::text[]`, and `&&` against it is false).
 * - **A CNPJ, read or not** — named when there is a name, and the CNAE count is
 *   whatever was actually on record, including zero.
 */
function CompanyLine({
  grouping,
  query,
  status,
}: {
  grouping: GroupedBy | null
  query: RadarQuery
  status: RadarStatus
}) {
  const where = query.state ?? copy.ufAll
  // No chevron. It used to draw one here, inside a `<p>` with no link, no
  // button and no handler — the universal "tap me" affordance on something
  // that could not be tapped, which is worse than no affordance at all: it
  // teaches people the header is dead. The way to change the search is the
  // filter row below, which now says so in as many words.
  if (!grouping) {
    // `null` is "the route has not answered", which is not the same fact as
    // "there is no company" — see `cnaeState`.
    const unknown = cnaeState(grouping, status) === null
    return (
      <p className="text-meta text-muted">
        {unknown ? list.companyFallback : list.noCompany} · {where}
      </p>
    )
  }

  const company = grouping.company
  const name = company?.tradeName || company?.legalName || list.companyFallback
  return (
    <p className="text-meta text-muted">
      {name} · {format(list.cnaeCount, { count: grouping.cnaeCount })} · {where}
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
function GroupHint({
  group,
  cnaeCount,
  segmentCount,
}: {
  group: TenderGroup
  /** CNAEs on record, or **`null` for "nobody has asked yet"** — see below. */
  cnaeCount: number | null
  /** Segments those CNAEs reach, same `null`. See {@link segmentState}. */
  segmentCount: number | null
}) {
  /**
   * Two of the three hints are claims about the reader's CNAEs — *"seu CNAE
   * atende"*, *"pode haver exigências"* — and a claim about a CNAE that was
   * never read is the other half of D19. The header says "sem CNAE lido" two
   * lines above; this said "seu CNAE atende" anyway, because it was a lookup on
   * `group` alone and `group` can come straight from the URL.
   *
   * **Three states, not two, and the third one cost a review finding.** The
   * first fix took `grouping?.cnaeCount ?? 0`, which collapses *unknown* into
   * *zero* — so while `CompanyLine` was carefully refusing to say whether a
   * company exists, this line two rows below asserted *"sem CNAE lido para
   * comparar"* about a CNAE nobody had looked for. It rendered on the server
   * Suspense frame, for the whole of `waitForData`'s sixty-second window on a
   * first-time CNPJ, and on every `timeout` and `error`. So `null` means
   * unknown and draws **nothing**: the two sentences now agree in all three
   * states, which is what D19's test holds them to.
   *
   * `keyword` is untouched throughout: "achado pela busca" is a statement about
   * the search term and is true whether or not a CNPJ is in play.
   */
  const claimsCnae = group === 'compatible' || group === 'check'
  if (claimsCnae && cnaeCount === null) return null
  // Three ways a CNAE claim can be unsupported, and they are different facts:
  // nothing read at all, read but reaching no segment, and (above) not asked
  // yet. Only the last draws nothing — the other two say which it is.
  const text = !claimsCnae
    ? list.groupHint[group]
    : cnaeCount === 0
      ? list.groupHintNoCnae
      : segmentCount === 0
        ? list.groupHintNoSegment
        : list.groupHint[group]
  return <p className="px-gutter pb-1 text-meta text-muted">{text}</p>
}

/**
 * "Ordenar: prazo", and now a control that means it (D51).
 *
 * Sci, 2026-10-06: *"The sort can be by Value (Asc/Desc); By Time (prazo)."*
 * Until D51 this was a statement, and `FilterRow`'s comment said why a control
 * would have been a lie: the list query ordered by `proposals_close_at` and
 * nothing else. `tenders.ts` now takes a `sort`, so the sentence becomes three
 * links.
 *
 * ## Three links in a `<details>`, and no JavaScript anywhere
 *
 * Each order is a real `<a href>` to the same Radar with `?sort=` — shareable,
 * reloadable, and working on the first paint before React hydrates, exactly
 * like the group chips and the filter form. A `<select>` could not do that: with
 * no JavaScript, changing a select submits nothing. `<details>` gives the
 * disclosure with a native keyboard and a native role.
 *
 * It is keyed on the active order, which is how it closes again. `<details
 * open>` is DOM state React does not own, so after a client-side navigation the
 * menu would otherwise hang open over the list it has just re-sorted. A new key
 * is a new element and a new element is closed — no effect, so this is also the
 * real behaviour under `environment: 'node'` (CLAUDE.md §4c) rather than
 * something only a browser does.
 *
 * ## What it inherits from the label it replaces, and what it cannot
 *
 * **It stays outside the filter `<details>`**, which is the whole point of the
 * span it replaces (WCAG 4.1.2): "Trocar empresa ou filtros Ordenar: prazo" is
 * not the name of the button that opens the search. It stays absolutely
 * positioned over the row's right end for the other reason given there too —
 * the form inside that `<details>` is full width, and shrinking the disclosure
 * to make room would shrink the form with it.
 *
 * **`pointer-events-none` could not survive, and that is the whole of what
 * changed.** A control has to receive the click it is drawn for. So the filter
 * summary keeps its full-width tap target *everywhere except under this box* —
 * the right end of the row, past its own label, where there was nothing to aim
 * at. Nothing else about the summary moved.
 *
 * ## "Ordenar:" is dropped below 480px rather than overrunning the row
 *
 * At 390px the row has 350px of content (`--spacing-gutter` is 20px a side) and
 * "Trocar empresa ou filtros" with its two glyphs takes most of them.
 * "Ordenar: prazo" fits in what is left — it always has — and **"Ordenar: maior
 * valor" plus a chevron does not**: because this box is `absolute`, it does not
 * wrap or push, it lands *on top of* the filter label. That is measured, not
 * reasoned: `e2e/journeys/radar-sort.spec.ts` compares the two boxes at 390px,
 * and making this prefix unconditional makes it fail on exactly that assertion.
 * So the prefix is hidden below 480px, where the content box is wide enough for
 * the longest of the three, and the trigger reads just "maior valor".
 *
 * A **viewport** breakpoint is correct here only because it is *below* 720px:
 * 720 is the content box at the moment the app shell's 264px rail joins the
 * layout, so no window at or under that width can be answering about a
 * different box than the one this row lives in (CLAUDE.md, D29/D30/D32). The
 * `min-[560px]` breakpoints on the form two blocks down are the same bet.
 *
 * The accessible name carries the full phrase at every width, so the prefix is
 * never the only thing that says what the control is for — and it is the
 * catalogue's own two strings joined, not a third string that could drift from
 * them.
 */
function SortMenu({ query }: { query: RadarQuery }) {
  const active = query.sort ?? DEFAULT_SORT
  /**
   * Two names, not one. The trigger is named after the order **in effect**
   * ("Ordenar: prazo"), the way a label and its value read together; each option
   * is named after what choosing it **does** ("Ordenar por prazo"). Giving both
   * the same name would put two differently-behaving controls with one name on
   * the same row — and, incidentally, make them indistinguishable to a
   * `getByLabel` in `e2e/`.
   */
  const current = `${list.sort} ${list.sortOrders[active]}`
  return (
    <details key={active} className="group/sort absolute top-1 right-gutter">
      <summary
        aria-label={current}
        className={cn(
          'flex min-h-touch cursor-pointer list-none items-center gap-1 text-body text-muted',
          // One line, whatever the order is called: a wrap between "Ordenar:"
          // and the value would break the row the board draws.
          'whitespace-nowrap [&::-webkit-details-marker]:hidden',
        )}
      >
        <span className="hidden min-[480px]:inline">{list.sort} </span>
        {list.sortOrders[active]}
        <Icon
          name="chevronRight"
          size={16}
          className="transition-transform group-open/sort:rotate-90"
        />
      </summary>
      {/* `bg-surface` and a border rather than a shadow: there is no shadow
          token, and the menu has to be opaque over the list underneath. */}
      <ul className="absolute right-0 z-20 mt-1 w-max rounded-control border border-line-strong bg-surface py-1">
        {TENDER_SORTS.map((sort) => (
          <li key={sort}>
            <Link
              href={radarHref({
                ...query,
                /**
                 * **The tab is carried only if the reader picked it.**
                 * `query.group` is *the tab on screen* — chosen, or the one
                 * `bestGroup()` elected from the counts — and spreading it here
                 * would write an election into the URL as though it had been a
                 * decision. That is the trap `RadarQuery.groupChosen` exists to
                 * name, and it does not stop at this link: `FilterRow`'s hidden
                 * `group` field is gated on `groupChosen`, so a promoted tab
                 * then starts travelling with every filter the reader applies,
                 * and a later search opens on a tab nobody chose — which may be
                 * empty, which is the whole reason `bestGroup()` exists.
                 *
                 * Dropping it costs nothing the reader can see: the counts do
                 * not change with the order, so the next load elects the same
                 * tab and the list stays where it is.
                 */
                group: query.groupChosen ? query.group : null,
                sort,
              })}
              aria-current={sort === active ? 'true' : undefined}
              aria-label={format(list.sortBy, { ordem: list.sortOrders[sort] })}
              className={cn(
                'flex min-h-touch items-center px-3 text-body whitespace-nowrap no-underline',
                sort === active ? 'font-semibold text-ink' : 'text-ink hover:bg-fill-muted',
              )}
            >
              {list.sortOrders[sort]}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * **The CNPJ could not be read and there is no keyword** — so nothing can be
 * listed, and the one useful thing on the screen is the keyword field. The
 * manual-CNAE card says *"busque por palavra-chave"*; this is what makes that
 * sentence an instruction the reader can follow without hunting for it: the
 * search opens, with the cursor already in the field (Sci, 2026-10-09).
 *
 * Not when both sources said the CNPJ does not exist: that card asks the reader
 * to check the number, and moving their cursor to a different field would argue
 * with it.
 */
export function asksForKeyword(status: RadarStatus, query: RadarQuery): boolean {
  return status.kind === 'manualCnae' && !status.cnpjNotFound && !query.q
}

/**
 * "Trocar empresa ou filtros", and the sort control beside it. The filters are
 * a `<details>` holding a real GET form, so they work before React has
 * hydrated and the result is a URL the user can share or bookmark. **The order
 * is a real choice since D51** — it used not to be, and the paragraph that
 * explained why a control would have been a lie now lives on `SortMenu`, which
 * is the control.
 *
 * ## Two things the `<summary>` must not do
 *
 * **It must not say the sort order.** "Ordenar: prazo" used to be a second
 * `<span>` inside the `<summary>`, which made the computed accessible name of
 * the control "Trocar empresa ou filtros Ordenar: prazo" (WCAG 4.1.2). A
 * statement about the list is not part of the name of the button that changes
 * it. The order sits outside the `<details>` entirely, positioned over the
 * row's right end so the line looks exactly as it did. Do not move it back
 * inside, and do not shrink the `<details>` to the left half to make room: the
 * form it opens is full-width and would be squeezed with it.
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
  askForKeyword = false,
  checkTheNumber = false,
  onNavigate,
}: {
  query: RadarQuery
  /** See `asksForKeyword`: open, with the cursor in the keyword field. */
  askForKeyword?: boolean
  /**
   * Both sources said the CNPJ does not exist, and the card asks the reader to
   * check it. The CNPJ field is in here, so the search opens — without moving
   * the cursor, which is a choice about *which* field that the reader makes.
   */
  checkTheNumber?: boolean
  onNavigate?: (href: string) => void
}) {
  // **Open when there is nothing to search by.**
  //
  // The whole search — CNPJ, UF and keyword — lives inside this `<details>`,
  // and it was closed on every load. A visitor arriving with no CNPJ therefore
  // met a Radar with no visible way to search: a collapsed row labelled
  // "Trocar empresa ou filtros", which says *change* the company when there is
  // no company yet, and an empty-state card whose only affordance was a text
  // link. The exposure grew when `/fundadores` gained an "Ir para o Radar" CTA
  // pointing cold visitors straight at this state.
  //
  // The intent is "nothing to list, so the search is the only thing on this
  // screen worth doing". Once either half is set the disclosure goes back to
  // closed, because then the list is the content and the search is secondary.
  //
  // **This condition no longer means that, and the sentence that used to say so
  // has been deleted rather than left standing.** It read "the same one that
  // produces the `needCnpj` state in `listState()`" — a function that does not
  // exist in this repository, and since D55 an untrue claim besides: `needCnpj`
  // is now the list route's `cnpjRequired` answer, and a bare `/radar` with a
  // CNPJ in the visitor cookie renders a full list with this disclosure open
  // over it and an empty CNPJ field inside it. What the screen should do about
  // that is a product decision, so it is **D61** and not a correction made
  // here; what could not stay is the comment asserting the two agree.
  //
  // `open` is only the initial attribute: `<details>` stays uncontrolled, so a
  // reader can still collapse it.
  const nothingToSearchBy = !query.cnpj && !query.q

  return (
    <div className="relative px-gutter">
      <details className="group" open={nothingToSearchBy || askForKeyword || checkTheNumber}>
        {askForKeyword ? <FocusKeyword cnpj={query.cnpj} /> : null}
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

        {/* D52 — five controls and a button, arranged by **this column's** width.

            The form lives in `main` (`max-w-[1120px]`) inside `px-gutter`, so
            its own width is

              min(viewport − rail, 1120) − 2×20

            and the rail is `components/app-shell.tsx`'s: in the layout flow
            from `lg` (1024px), **264px** wide, or 56px when the reader
            collapses it — `localStorage` state no media query can observe.
            At 1024px with the rail out this form is **720px**, not 1024.

            Three controls fitted on one line from 560px of *window*, and 560
            is below 720, so that query was safe by accident (there is no rail
            yet). Five do not: one row needs about 200px per control, so
            4 × 200 + 3 × 12 of gap = **836px**, and the threshold had to go
            above 720 — where a viewport query is wrong by up to 264px. That
            is D29, D30 and D32, three times already in this repository. So the
            thresholds below are container queries, and the numbers are this
            column's width, not the window's:

              column < 560    one control per row (390px phone: 350px column)
              column 560–879  two columns; keyword and button span both
              column ≥ 880    four columns; keyword spans 3, button takes 1

            880 is 836 rounded up for the labels; at 880 each column is
            (880 − 36) / 4 = **211px**, and at the usual desktop — 1440px with
            the rail out — it is 261px, wider than the `w-60` / `w-56` these
            fields used to be pinned to. Those two widths are gone: the grid
            owns the arrangement now, and a fixed `w-60` inside a 211px cell
            would overflow the column it is supposed to fit.

            `@container` on a wrapper because an element cannot query itself,
            and around the form only — `container-type: inline-size` makes the
            element a containing block for fixed descendants (`sheet.tsx`), so
            it must not creep up onto the `px-gutter` div.

            `environment: 'node'` has no boxes (CLAUDE.md §4c), so the unit test
            pins the mechanism — the container, the thresholds, no viewport
            query above 720 — and `e2e/journeys/radar-filters.spec.ts` measures
            the result at 390px and inside the shell at desktop. */}
        <div className="@container">
          <form
            method="get"
            action="/radar"
            className={cn(
              'grid grid-cols-1 items-end gap-3 pt-1 pb-3',
              '@min-[560px]:grid-cols-2 @min-[880px]:grid-cols-4',
            )}
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
                        // Read back through the same reader the URL is read with,
                        // so a hand-edited `<option>` cannot put a value in the
                        // address that `readSearch` would then drop.
                        modality: readModality(String(data.get(MODALITY_PARAM) ?? '')),
                        meEpp: readMeEpp(String(data.get(ME_EPP_PARAM) ?? '')),
                        // The same rule as the sort links above, and the same
                        // rule as the hidden `group` field below — which is
                        // already gated on `groupChosen`, so until now the two
                        // halves of this one form disagreed: with JavaScript the
                        // elected tab was pinned, without it the election stood.
                        group: query.groupChosen ? query.group : null,
                        // Applying a filter must not quietly re-sort the list.
                        sort: query.sort,
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
            />
            {query.groupChosen ? <input type="hidden" name="group" value={query.group} /> : null}
            {/*
              The same for the order, and only when it is not the default — a
              hidden `sort=deadline` would put a parameter into the URL of every
              search anybody applies, which `searchParams` deliberately keeps out.
            */}
            {query.sort && query.sort !== DEFAULT_SORT ? (
              <input type="hidden" name="sort" value={query.sort} />
            ) : null}
            <Select
              id="radar-uf"
              name="uf"
              label={copy.landing.ufLabel}
              defaultValue={query.state ?? ''}
              options={UF_OPTIONS}
            />
            {/*
              D52 — modalidade and ME/EPP, the two filters Sci asked for on
              2026-10-06. Both are `Select`s and not chips: `modality_id` holds
              exactly three values over all 58 495 rows — ids 6, 4 and 8, each
              carrying one name — and ME/EPP is one question with two answers plus
              *Todas*. The option is **labelled** with `modality_name` and
              **filtered** on `modality_id`: the name is PNCP's free text, sent
              from two different endpoints under two different field names, and
              the id is the key.

              The ME/EPP option reads `me_epp_summary`, **the same column the
              card's own tag renders**, and the option label is the tag's own
              string — so no card under *Exclusivo ME/EPP* can be tagged as
              anything but ME/EPP work. *Exclusivo* holds `exclusive` **and**
              `mixed` (Sci, 2026-10-06): a `mixed` edital has exclusive items and
              its card says *Exclusivos e cotas ME/EPP*, so it belongs in the
              answer to "where do I get a reserved lane", and leaving it out put
              1 810 open editais under a heading saying the opposite of their own
              tag. `quota` stays on the other side, because a cota is not
              exclusivity. `lib/radar/filters.ts` has the measurement.

              What the structured field does *not* agree with is the triagem one
              tap away: D36 measured the two disagreeing on 14 of 27 readings.
              This filter follows PNCP deliberately, and will follow whatever
              D36 decides.
            */}
            <Select
              id="radar-modality"
              name={MODALITY_PARAM}
              label={list.filters.modality}
              defaultValue={query.modality ?? ''}
              options={MODALITY_OPTIONS}
            />
            <Select
              id="radar-meepp"
              name={ME_EPP_PARAM}
              label={list.filters.meEpp}
              defaultValue={query.meEpp ?? ''}
              options={ME_EPP_OPTIONS}
            />
            <div className="flex flex-col gap-1.5 @min-[560px]:col-span-2 @min-[880px]:col-span-3">
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
            <Button
              type="submit"
              variant="secondary"
              /* Full width where it has a row to itself, its own cell at ≥880. */
              className="@min-[560px]:col-span-2 @min-[880px]:col-span-1"
            >
              {list.apply}
            </Button>
          </form>
        </div>
      </details>

      <SortMenu query={query} />
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
  favourites,
  now,
  onRetry,
  onFavourite,
}: {
  status: RadarStatus
  group: TenderGroup
  counts: Record<TenderGroup, number> | null
  query: RadarQuery
  tenders: TenderCard[]
  favourites?: ReadonlySet<string>
  now: Date
  onRetry?: () => void
  onFavourite?: (tenderId: string, marked: boolean) => void
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
    case 'manualCnae': {
      /*
       * **Drawn above the list, not instead of it.** It used to `break` as soon
       * as there were editais, which meant the sentence about them — "the ones
       * below come only from your keyword" — could only ever render with
       * nothing below it, and the reader looking at a keyword's editais was
       * never told the CNPJ had not been read. Approved by Sci 2026-10-09 with
       * the three sentences; `manualCnaeBody` (which promised a retry "em
       * alguns minutos" that a 6-hour cache could not keep) is gone.
       */
      const card = (
        <StateCard
          kind="empty"
          title={copy.states.manualCnaeTitle}
          description={
            status.cnpjNotFound
              ? copy.states.manualCnaeBodyNotFound
              : query.q
                ? copy.states.manualCnaeBodyKeyword
                : copy.states.manualCnaeBodyNoKeyword
          }
        />
      )
      // No keyword and nothing found: the card is the page, and the open
      // search above it (`FilterRow`) is what it asks the reader to use. An
      // "empty group" card under it would only repeat the zero.
      if (tenders.length === 0 && !query.q) return card
      return (
        <div className="flex flex-col gap-4">
          {card}
          <Body
            status={{ kind: 'ready' }}
            group={group}
            counts={counts}
            query={query}
            tenders={tenders}
            favourites={favourites}
            now={now}
            onRetry={onRetry}
            onFavourite={onFavourite}
          />
        </div>
      )
    }
    case 'ready':
      break
  }

  if (tenders.length === 0) {
    return <EmptyGroup query={query} counts={counts} />
  }

  return (
    /* D30 — how many cards fit is a fact about this column, not about the
       window, so the thresholds are container queries.

       They used to be `min-[900px]:` and `min-[1280px]:`, **viewport**
       queries, and D20 then put a rail in the layout flow beside the content:
       `hidden lg:block` from 1024px and **264px** wide, or 56px when the
       reader collapses it — `localStorage` state that no media query can
       observe at all. This list is `main` (`max-w-[1120px]`) inside
       `px-gutter`, so its own width is

         min(viewport − rail, 1120) − 2×20

       and the two numbers never met. At 1280 with the rail out that is
       1016 − 40 = **976px**, and the window's answer was three columns —
       ~318px cards on the screen the product is used on most. Same defect as
       D29 on the tender screen, one floor down.

       **860 and 1080 are today's thresholds restated, not new ones.** 860 is
       what this column measured at the old 900px breakpoint, where there is
       no rail yet (900 − 40); 1080 is what it measures at `main`'s
       `max-w-[1120px]` cap (1120 − 40), which is the width the old 1280px
       query actually delivered when it was right — at 1280 with the rail
       collapsed. Below `lg` the two rules are identical. **Three bands move,
       and they are exactly the bands the window could not see:**

         viewport 1024–1163, rail 264   column  720–859  2 → **1**
         viewport 1280–1383, rail 264   column  976–1079 3 → **2**
         viewport 1176–1279, rail  56   column     1080  2 → **3**

       The third is the rule working, not a regression escaping it: at 1200
       with the rail retracted this column really is 1080px — the same width
       it has at 1440 with the rail out, where three columns were never in
       dispute. It is named here because it is the one band where a card gets
       *narrower* than before (535px → 353px), and a reader comparing two
       machines deserves to find it written down.

       The step from two 535px cards to three 353px ones at 1080 is inherited,
       not introduced: the old query made the same jump at 1280.

       The wrapper is here because an element cannot query itself, and it is
       `@container` and nothing else — `container-type: inline-size` also makes
       the element a containing block for fixed descendants (`sheet.tsx` says
       so at its `centre` box), so it stays around the list rather than going
       on the `px-gutter` div, where it would silently capture the
       `position: fixed` bar D25 (3) is about to add. `radar-view.test.tsx`
       asserts that placement as markup, because moving it up one element
       changes no width and would otherwise pass every test in the suite.

       These widths are read from the source; `environment: 'node'` has no
       layout to measure them in. `e2e/journeys/radar-columns.spec.ts` is what
       actually looks. */
    /* D56's live region is a **sibling** of the container, after it, and that is
       not tidiness: `container-type: inline-size` makes this div a containing
       block for `position: fixed` descendants, so a region nested inside it
       would anchor to the bottom of the grid instead of the bottom of the
       window — off screen on a full page. The same trap `sheet.tsx` documents
       at its `centre` box, and `favourite-feedback.test.tsx` asserts the
       placement as an ancestor relation because no width changes with it.

       `listKey` is what the notice is scoped to: a sentence about a press on
       *Compatíveis* must not still be pinned to the window after a tab, a sort
       or a filter change, and this subtree stays mounted across all three.

       `scope: ''` — and this is the one caller that passes that. D58/D60 made
       the caller's identity the first field of the cache key; here the string
       is a **React identity** and not a cache key, and it never was one: it
       also carries the *rendered* group rather than the chosen one. Nothing is
       stored under it.

       And the identity cannot change without this string changing anyway, which
       is the part worth stating precisely rather than half: a sign-in or a
       sign-out is a document load, and the *company* — which `POST
       /api/radar/cnpj` does change inside one document — always arrives with a
       `?cnpj=` this string already carries. So the real scope would add nothing
       but length. */
    <FavouriteNotices active={Boolean(onFavourite)} listKey={listKey({ ...query, group, scope: '' })}>
      <div className="@container">
        <ul className="grid list-none grid-cols-1 gap-2.5 p-0 @min-[860px]:grid-cols-2 @min-[1080px]:grid-cols-3">
          {tenders.map((tender) => (
            <li key={tender.id} className="flex">
              {/* The card carries the search into the tender's URL, which is
                  where the Opportunity screen reads its "Voltar" link from. */}
              <TenderCardView
                tender={tender}
                now={now}
                href={tenderHref(tender.id, { ...query, group })}
                /* D23. Seeded from the envelope, so it never paints the wrong
                   state, and rendered outside the card's anchor — see
                   `tender-card.tsx` for the box arithmetic. */
                action={
                  onFavourite ? (
                    <FavouriteStar
                      tenderId={tender.id}
                      marked={favourites?.has(tender.id) ?? false}
                      onChange={onFavourite}
                    />
                  ) : undefined
                }
              />
            </li>
          ))}
        </ul>
      </div>
    </FavouriteNotices>
  )
}

/* ------------------------------------------------------------------- shell */

export function RadarView({
  query,
  status,
  grouping,
  visitor,
  counts,
  tenders,
  favourites,
  freshness,
  nextCursor = null,
  loadingMore = false,
  now = new Date(),
  onNavigate,
  onRetry,
  onLoadMore,
  onOpenMenu,
  onFavourite,
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
          <CompanyLine grouping={grouping} query={query} status={status} />
        </div>

        {visitor ? <VisitorBanner visitor={visitor} now={now} /> : null}

        <GroupTabs active={query.group} counts={counts} query={query} />
        {/* The same number the line above renders, through the same function:
            these two sentences are the pair D19's test holds against each
            other, so they must not be able to read different states. */}
        <GroupHint
          group={query.group}
          cnaeCount={cnaeState(grouping, status)}
          segmentCount={segmentState(grouping)}
        />

        <FilterRow
          query={query}
          askForKeyword={asksForKeyword(status, query)}
          checkTheNumber={status.kind === 'manualCnae' && status.cnpjNotFound}
          onNavigate={onNavigate}
        />

        {showList ? <FreshnessLine freshness={freshness} /> : null}

        <div className="px-gutter">
          <Body
            status={status}
            group={query.group}
            counts={counts}
            query={query}
            tenders={showList ? tenders : []}
            favourites={favourites}
            now={now}
            onRetry={onRetry}
            onFavourite={onFavourite}
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
