import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readViewer } from '@/lib/auth/viewer'
import { PRIVATE_NO_STORE } from '@/lib/cache'
import { normaliseCnpj } from '@/lib/cnpj'
import { db } from '@/lib/db'
import { readCompany, segmentsByFit } from '@/lib/radar/company'
import { TENDER_GROUPS, TENDER_SORTS, DEFAULT_SORT, type TenderListResponse } from '@/lib/radar/contract'
import { ME_EPP_FILTERS, MODALITY_SLUGS } from '@/lib/radar/filters'
import { countGroups, listFreshness, listTenders, MAX_LIMIT } from '@/lib/radar/tenders'
import { loadVisitor } from '@/lib/radar/visitor'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `GET /api/radar/tenders?group=compatible&state=SP&q=&modality=&meepp=` (§8).
 *
 * > Reads from DB; groups Compatible / Check / Keyword
 *
 * Reads only. It never queues a sweep: §3.2 keeps open tenders inside 30
 * minutes through the scheduler's `sync_open_tenders`, whose key is a due
 * instant and whose window comes from a watermark — a key this route invented
 * would create a second, watermark-less sweep. The response still says how old
 * the list is, so the Radar can show "atualizado há X min" and the user is
 * never told stale data is fresh.
 *
 * The CNPJ comes from the query string when given, otherwise from the CNPJ this
 * device last searched (`visitors.cnpj`), so the Radar survives a reload
 * without putting the company back in every URL.
 *
 * ## `favourites` rides with the rows (D23)
 *
 * The envelope names which of this page's tenders the caller has already
 * marked, and it comes from the **same statement** as the rows
 * (`listTenders`'s `exists` projection). D23's rule is that the badge and the
 * list are one read; the list and its stars are the same rule, and the
 * alternative — a `GET /api/tenders/:id/favorito` per card — is thirteen
 * answers free to disagree with the one list they describe.
 *
 * This is why a read route that used to need no identity now reads one. It
 * still **mints** nothing: `readViewer` never inserts a `visitors` row, and a
 * caller with no account gets an empty array rather than a 401 — unlike
 * `POST /api/tenders/:id/favorito`, which has nowhere to put a row and says so.
 * The fallback CNPJ it computes is deliberately the same one it computed before,
 * from the visitor row and not from the account — see the comment at the call.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RATE_LIMIT = { limit: 120, windowMs: 60_000 }

const query = z.object({
  group: z.enum(TENDER_GROUPS).default('compatible'),
  state: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'stateInvalid')
    .optional(),
  q: z.string().trim().max(200).optional(),
  /**
   * D52's two filters. Enums, not free text: the modality slug is mapped to one
   * PNCP code in `lib/radar/filters.ts` (`MODALITY_CODES`, matched against
   * `tenders.modality_id` — the name is free text from two endpoints, the id is
   * the key), and a value this list does not know is a 400 rather than a filter
   * that matches nothing — the reader would otherwise be shown an empty Radar
   * and told nothing was open.
   */
  modality: z.enum(MODALITY_SLUGS).optional(),
  meepp: z.enum(ME_EPP_FILTERS).optional(),
  cnpj: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  cursor: z.string().max(200).optional(),
  includeClosed: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  /**
   * The order (D51). `.default` rather than `.optional`, so every read below
   * has an order without restating the fallback — the same shape as `group`,
   * and like `group` an unrecognised value is a 400 rather than a silent
   * substitution: this route is called by our own client, which has no reason
   * to ask for an order that does not exist.
   */
  sort: z.enum(TENDER_SORTS).default(DEFAULT_SORT),
})

function fail(body: TenderListResponse, status: number, headers?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': PRIVATE_NO_STORE, ...headers },
  })
}

export async function GET(request: Request): Promise<NextResponse<TenderListResponse>> {
  const decision = await rateLimitRequest('radar-tenders', request.headers, RATE_LIMIT)
  if (!decision.ok) {
    return fail({ state: 'error', error: 'rate_limited' }, 429, {
      'retry-after': String(decision.retryAfter),
    })
  }

  const url = new URL(request.url)
  const parsed = query.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return fail(
      {
        state: 'error',
        error: 'validation',
        fields: { [String(issue?.path[0] ?? 'form')]: issue?.message ?? 'invalid' },
      },
      400,
    )
  }
  const params = parsed.data

  try {
    const executor = db()

    // Read only: a GET never mints an identity. `readViewer` is the non-creating
    // reader — the cookie is set by the first POST /api/radar/cnpj, which is
    // where §8 puts it.
    const cookie = request.headers.get('cookie')
    const viewer = await readViewer(cookie, executor)
    const viewerUserId = viewer?.kind === 'user' ? viewer.user.userId : null

    let cnpj = params.cnpj ? normaliseCnpj(params.cnpj) : null
    if (params.cnpj && !cnpj) {
      return fail({ state: 'error', error: 'validation', fields: { cnpj: 'cnpjInvalid' } }, 400)
    }

    /*
     * The fallback is **the CNPJ this device last searched**, unchanged.
     *
     * `cnpjOf(viewer)` is right here and is deliberately not used: for a
     * signed-in caller it answers `users.cnpj`, and those two can disagree
     * permanently. `attachCnpj` only writes `visitors.cnpj` while the caller is a
     * visitor, and `rememberUserCnpj` only ever fills a `null`, so an account set
     * to company A by the offer form keeps A while the reader searches B all
     * afternoon — and this fallback decides the compatible/check grouping of a
     * keyword search. Preferring the account's company may well be the better
     * product, but it is a product decision this card did not ask for, so it is
     * not made here.
     *
     * Two reads instead of one in exactly one case: a signed-in caller who omits
     * `?cnpj=`. `readViewer` stops at the session for them, so the visitor row is
     * read only when it is going to be used.
     */
    if (!cnpj) {
      cnpj =
        viewer?.kind === 'visitor'
          ? viewer.visitor.cnpj
          : ((await loadVisitor(cookie, executor))?.cnpj ?? null)
    }

    const headers: Record<string, string> = { 'cache-control': PRIVATE_NO_STORE }

    // No CNPJ and no search term: there is nothing to filter the whole of PNCP
    // by, and "every open tender in Brazil" is the portal this product exists
    // to replace. Say what is missing rather than returning a random page.
    if (!cnpj && !params.q) {
      return fail({ state: 'error', error: 'validation', fields: { cnpj: 'cnpjRequired' } }, 400, headers)
    }

    const company = cnpj ? await readCompany(cnpj, executor) : null
    const fits = company?.data.company.segments ?? []
    const { compatible, check } = segmentsByFit(fits)
    const match = { compatible, check, fits }

    const filters = {
      state: params.state ?? null,
      q: params.q ?? null,
      modality: params.modality ?? null,
      meEpp: params.meepp ?? null,
      includeClosed: params.includeClosed ?? false,
      limit: params.limit,
      cursor: params.cursor ?? null,
      sort: params.sort,
    }

    const [page, counts, freshness] = await Promise.all([
      listTenders(match, params.group, filters, executor, viewerUserId),
      countGroups(match, filters, executor),
      listFreshness({ state: filters.state }, { executor }),
    ])

    return NextResponse.json(
      {
        state: 'ready' as const,
        group: params.group,
        tenders: page.tenders,
        // The stars, from the same statement as the rows (D23).
        favourites: page.favourites,
        // What the groups above were computed from, reported by the code that
        // computed them (D19). The header renders this and nothing else: it
        // cannot resolve `visitors.cnpj` itself — the cookie is `httpOnly` —
        // so before this field existed the screen guessed from `?cnpj=` and
        // said "sem CNAE lido" over a list grouped by a real company.
        groupedBy: cnpj
          ? {
              company: company?.data.company ?? null,
              cnaeCount: company?.data.cnaeCount ?? 0,
            }
          : null,
        counts,
        nextCursor: page.nextCursor,
        freshness: {
          // `absent` means the database holds no open tender at all — a fresh
          // deploy, or a worker that has stopped. Reported as stale, which is
          // what an empty list of unknown age is.
          state: freshness.state === 'fresh' ? ('fresh' as const) : ('stale' as const),
          updatedAt: freshness.updatedAt?.toISOString() ?? null,
          ageSeconds: freshness.ageSeconds,
        },
      },
      { status: 200, headers },
    )
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`GET /api/radar/tenders failed (${code})`)
    return fail({ state: 'error', error: 'server_error' }, 500)
  }
}
