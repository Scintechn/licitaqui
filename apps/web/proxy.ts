import { NextResponse, type NextRequest } from 'next/server'
import { ADMIN_HEADERS, authorizeAdmin, denyResponse } from '@/lib/admin/auth'

/**
 * The HTTP Basic challenge in front of `/admin` (Next 16 calls this file
 * `proxy.ts`; it is what earlier versions called `middleware.ts`, and it always
 * runs on the Node.js runtime).
 *
 * This is the layer that can return `401 WWW-Authenticate` and make the browser
 * ask for a password, which a Server Component cannot. It is **not** the only
 * check: `/admin/page.tsx` and the export route call `authorizeAdmin()`
 * themselves, because a wrong `matcher` here is one of the classic ways to
 * ship an open admin page, and the page must fail closed on its own.
 *
 * It matches nothing else. Every other route on the site is public and must
 * stay as cheap as it is today.
 */

export const config = {
  matcher: ['/admin', '/admin/:path*', '/api/admin/:path*'],
}

export default function proxy(request: NextRequest): NextResponse | Response {
  const auth = authorizeAdmin(request.headers)
  if (!auth.ok) return denyResponse(auth.reason)

  const response = NextResponse.next()
  for (const [header, value] of Object.entries(ADMIN_HEADERS)) {
    response.headers.set(header, value)
  }
  return response
}
