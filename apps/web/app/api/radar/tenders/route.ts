import { NextResponse } from 'next/server'
import { z } from 'zod'
import { PRIVATE_NO_STORE } from '@/lib/cache'
import { normaliseCnpj } from '@/lib/cnpj'
import { db } from '@/lib/db'
import { readCompany, segmentsByFit } from '@/lib/radar/company'
import { TENDER_GROUPS, type TenderListResponse } from '@/lib/radar/contract'
import { countGroups, listFreshness, listTenders, MAX_LIMIT } from '@/lib/radar/tenders'
import { loadVisitor } from '@/lib/radar/visitor'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `GET /api/radar/tenders?group=compatible&state=SP&q=` (spec §8).
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
  cnpj: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  cursor: z.string().max(200).optional(),
  includeClosed: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
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
    // Read only: a GET never mints an identity. The cookie is set by the first
    // POST /api/radar/cnpj, which is where §8 puts it.
    const visitor = await loadVisitor(request.headers.get('cookie'))

    const cnpj = params.cnpj ? normaliseCnpj(params.cnpj) : (visitor?.cnpj ?? null)
    if (params.cnpj && !cnpj) {
      return fail({ state: 'error', error: 'validation', fields: { cnpj: 'cnpjInvalid' } }, 400)
    }

    const headers: Record<string, string> = { 'cache-control': PRIVATE_NO_STORE }

    // No CNPJ and no search term: there is nothing to filter the whole of PNCP
    // by, and "every open tender in Brazil" is the portal this product exists
    // to replace. Say what is missing rather than returning a random page.
    if (!cnpj && !params.q) {
      return fail({ state: 'error', error: 'validation', fields: { cnpj: 'cnpjRequired' } }, 400, headers)
    }

    const executor = db()
    const company = cnpj ? await readCompany(cnpj, executor) : null
    const fits = company?.data.company.segments ?? []
    const { compatible, check } = segmentsByFit(fits)
    const match = { compatible, check, fits }

    const filters = {
      state: params.state ?? null,
      q: params.q ?? null,
      includeClosed: params.includeClosed ?? false,
      limit: params.limit,
      cursor: params.cursor ?? null,
    }

    const [page, counts, freshness] = await Promise.all([
      listTenders(match, params.group, filters, executor),
      countGroups(match, filters, executor),
      listFreshness({ state: filters.state }, { executor }),
    ])

    return NextResponse.json(
      {
        state: 'ready' as const,
        group: params.group,
        tenders: page.tenders,
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
