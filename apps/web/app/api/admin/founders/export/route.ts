import { ADMIN_HEADERS, authorizeAdmin, denyResponse } from '@/lib/admin/auth'
import { CSV_CONTENT_TYPE, csvFilename } from '@/lib/admin/csv'
import { foundersCsv, listAllFounders } from '@/lib/admin/founders'

/**
 * `POST /api/admin/founders/export` — the founders list as a CSV download.
 *
 * ## Why POST
 *
 * The response is the personal data of every founder (spec §6.3, §12). A `GET`
 * would be a link: prefetchable, crawlable, bookmarkable, and one browser
 * history entry away from being shared. A `POST` is a button someone pressed.
 *
 * ## Checks, in order
 *
 *  1. `authorizeAdmin()` — the same function `proxy.ts` and the page use. The
 *     proxy already ran; this runs again so the route is safe on its own.
 *  2. Same-origin — a cross-site form post would carry the browser's stored
 *     Basic credentials. The attacker could not read the response (no CORS),
 *     but a download nobody asked for is not something to shrug at.
 *
 * Nothing is logged: not the rows, not the count, not who exported. The
 * response is `private, no-store` and `noindex` like the rest of `/admin`.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Rejects a cross-site submit while allowing a direct `curl` (no Origin header). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === (request.headers.get('host') ?? new URL(request.url).host)
  } catch {
    return false
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeAdmin(request.headers)
  if (!auth.ok) return denyResponse(auth.reason)

  if (!sameOrigin(request)) {
    return new Response('Origem inválida.\n', {
      status: 403,
      headers: { ...ADMIN_HEADERS, 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  let csv: string
  try {
    csv = foundersCsv(await listAllFounders())
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`/api/admin/founders/export failed (${code})`)
    return new Response('Não foi possível gerar o CSV.\n', {
      status: 500,
      headers: { ...ADMIN_HEADERS, 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  return new Response(csv, {
    status: 200,
    headers: {
      ...ADMIN_HEADERS,
      'content-type': CSV_CONTENT_TYPE,
      'content-disposition': `attachment; filename="${csvFilename('fundadores')}"`,
    },
  })
}

/** A `GET` here would be exactly the shareable link the POST exists to avoid. */
export async function GET(): Promise<Response> {
  return new Response('Use o botão "Exportar CSV" em /admin.\n', {
    status: 405,
    headers: { ...ADMIN_HEADERS, allow: 'POST', 'content-type': 'text/plain; charset=utf-8' },
  })
}
