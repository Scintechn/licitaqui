import { describe, expect, it, vi } from 'vitest'

const toggleFavourite = vi.hoisted(() => vi.fn())
const isFavourite = vi.hoisted(() => vi.fn())
const rateLimitRequest = vi.hoisted(() => vi.fn(async () => ({ ok: true })))
const readViewer = vi.hoisted(() => vi.fn())

vi.mock('@/lib/favourites/store', () => ({ toggleFavourite, isFavourite }))
vi.mock('@/lib/rate-limit', () => ({ rateLimitRequest }))
vi.mock('@/lib/db', () => ({ db: () => ({}) }))
vi.mock('@/lib/auth/viewer', () => ({
  readViewer,
  hasAccount: (viewer: { kind?: string } | null) => viewer?.kind === 'user',
}))

const { GET, POST } = await import('./route')

const ID = '45699626000176-1-000463/2026'
const ACCOUNT = { kind: 'user', user: { userId: 7, plan: 'basico', cnpj: null } }
const VISITOR = { kind: 'visitor', visitor: { id: 'v1', cnpj: null } }

function call(method: typeof POST, id = ID) {
  return method(new Request(`https://x/api/tenders/${id}/favorito`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  })
}

/**
 * `POST /api/tenders/:id/favorito` — card **D23**.
 *
 * The assertion worth having here is the one about **who**. This is the only
 * Radar route that refuses a visitor outright, and it is worth a test saying
 * so, because §8's rule everywhere else is that an account adds capability and
 * is never a precondition. A favourite is keyed on `users.id`, so there is
 * nowhere to put one for somebody who has no account — and a control that
 * accepts a tap and silently forgets it is worse than one that says why.
 */
describe('POST /api/tenders/:id/favorito', () => {
  it('marks, and reports what it became', async () => {
    readViewer.mockResolvedValueOnce(ACCOUNT)
    toggleFavourite.mockResolvedValueOnce(true)

    const body = await (await call(POST)).json()
    expect(body).toEqual({ state: 'ready', favourite: true })
    expect(toggleFavourite).toHaveBeenCalledWith(7, ID, expect.anything())
  })

  it('unmarks, and reports that too', async () => {
    readViewer.mockResolvedValueOnce(ACCOUNT)
    toggleFavourite.mockResolvedValueOnce(false)

    expect(await (await call(POST)).json()).toEqual({ state: 'ready', favourite: false })
  })

  it('refuses a visitor rather than pretending to remember', async () => {
    // The one place in the Radar where an account is a precondition. There is
    // no row to write for somebody who has none, and a tap that vanishes is
    // worse than a refusal that explains itself.
    readViewer.mockResolvedValueOnce(VISITOR)
    const response = await call(POST)

    expect(response.status).toBe(401)
    expect((await response.json()).error).toBe('unauthenticated')
    expect(toggleFavourite).not.toHaveBeenCalled()
  })

  it('refuses nobody at all the same way', async () => {
    readViewer.mockResolvedValueOnce(null)
    expect((await call(POST)).status).toBe(401)
  })

  it('refuses an id that is not a PNCP control number, before the database', async () => {
    toggleFavourite.mockClear()
    const response = await call(POST, 'not-a-tender')

    expect(response.status).toBe(400)
    expect(toggleFavourite).not.toHaveBeenCalled()
  })

  it('is rate limited like every other write', async () => {
    rateLimitRequest.mockResolvedValueOnce({ ok: false, retryAfter: 30 } as never)
    const response = await call(POST)

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('30')
  })

  it('does not leak the driver error when the write fails', async () => {
    readViewer.mockResolvedValueOnce(ACCOUNT)
    toggleFavourite.mockRejectedValueOnce(
      Object.assign(new Error('insert or update on table "favourites" violates foreign key'), {
        code: '23503',
      }),
    )
    const response = await call(POST)
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('favourites')
  })

  it('never caches: the answer is per account and changes on a tap', async () => {
    readViewer.mockResolvedValueOnce(ACCOUNT)
    toggleFavourite.mockResolvedValueOnce(true)
    expect((await call(POST)).headers.get('cache-control')).toContain('no-store')
  })
})

describe('GET /api/tenders/:id/favorito', () => {
  it('tells an account whether it marked this one', async () => {
    readViewer.mockResolvedValueOnce(ACCOUNT)
    isFavourite.mockResolvedValueOnce(true)

    expect(await (await call(GET)).json()).toEqual({ state: 'ready', favourite: true })
  })

  it('answers a visitor "not marked" rather than 401', async () => {
    // Different from POST on purpose. The control has to render for everybody;
    // it is the *write* that needs an account, and that is where the refusal
    // belongs — telling a visitor they are unauthenticated just for drawing
    // the page would be a refusal they did not ask for.
    readViewer.mockResolvedValueOnce(VISITOR)
    const response = await call(GET)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state: 'ready', favourite: false })
    expect(isFavourite).not.toHaveBeenCalled()
  })
})
