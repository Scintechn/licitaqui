/**
 * The founders CSV endpoint, in one place: the form on the page and the route
 * that answers it must agree, and a typo between them is a button that 404s.
 *
 * It lives under `/api/admin/` so the `proxy.ts` matcher covers it with the
 * same Basic-auth challenge as the page.
 */
export const EXPORT_PATH = '/api/admin/founders/export'
