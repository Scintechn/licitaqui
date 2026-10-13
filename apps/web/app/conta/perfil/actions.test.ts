import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `saveProfile` — the POST behind F31's gate, and this test exists for one
 * seam in particular.
 *
 * ## The seam: the schema's field names are not the form's
 *
 * `profileInput` is keyed `name`/`mobile`/`cnpj`, because every identifier in
 * this repo is English. The inputs are `nome`/`celular`/`cnpj`, because a form
 * field's name is what a browser autofills. The action translates between
 * them, and **nothing else in the repository would notice if it stopped**:
 * `profileErrors` would still return its keys, the schema would still reject
 * the right things, the view would still render three `Field`s — and
 * `page.tsx` filters `?erro=` against `nome|celular|cnpj`, so `erro=name,mobile`
 * is silently dropped and the person gets a form that refused their entry and
 * then displays no error at all.
 *
 * That is §4b's shape exactly: every unit green, the path broken. So this
 * asserts the **query string the action produces** against the names the page
 * accepts, rather than asserting the map it happens to be implemented with.
 *
 * `profileInput` is deliberately **not** mocked — it is half of what is under
 * test. The database, the session, the lookup queue and `redirect` are.
 */

const setUserProfile = vi.fn()
const setUserCnpj = vi.fn()
const companyOrLookup = vi.fn()

/** `redirect()` throws in Next; the test has to be able to see that it did. */
class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`)
  }
}

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: '7' } }) }))
/** The draft cookie's jar. `set`/`delete` are what the action does with it. */
const jar = { set: vi.fn(), delete: vi.fn(), get: vi.fn(() => undefined) }
vi.mock('next/headers', () => ({ cookies: async () => jar }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to)
  },
}))
vi.mock('@/lib/auth/session', () => ({
  setUserProfile: (...args: unknown[]) => setUserProfile(...args),
  setUserCnpj: (...args: unknown[]) => setUserCnpj(...args),
}))
vi.mock('@/lib/radar/company', () => ({
  companyOrLookup: (...args: unknown[]) => companyOrLookup(...args),
}))
vi.mock('@/lib/db', () => ({
  db: () => ({
    // The transaction runs its callback with a stand-in executor, so the two
    // writes are observed in the order the action makes them.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true }),
  }),
}))

const { saveProfile } = await import('./actions')
const { PLAN_PATH, PROFILE_PATH } = await import('@/lib/routes')
const { DRAFT_COOKIE, DRAFT_MAX_AGE, DRAFT_PATH, decodeDraft } = await import(
  '@/lib/profile/draft'
)

const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.append(key, value)
  return data
}

const VALID = {
  nome: 'Maria Silva',
  nascimento: '1980-05-20',
  celular: '+55 11 99999-9999',
  cnpj: '36.955.612/0001-85',
}

/** The action always redirects, so every call is expected to throw. */
async function run(fields: Record<string, string>): Promise<string> {
  try {
    await saveProfile(form(fields))
  } catch (error) {
    if (error instanceof Redirected) return error.to
    throw error
  }
  throw new Error('saveProfile returned without redirecting')
}

beforeEach(() => {
  setUserProfile.mockReset()
  setUserCnpj.mockReset()
  companyOrLookup.mockReset()
  jar.set.mockReset()
  jar.delete.mockReset()
})

describe('saveProfile (F31)', () => {
  it('writes the name and the mobile normalised, and the CNPJ as digits', async () => {
    const to = await run(VALID)

    expect(setUserProfile).toHaveBeenCalledTimes(1)
    expect(setUserProfile.mock.calls[0]?.[0]).toBe(7)
    expect(setUserProfile.mock.calls[0]?.[1]).toEqual({
      name: 'Maria Silva',
      birthDate: '1980-05-20',
      mobile: '+5511999999999',
    })
    expect(setUserCnpj).toHaveBeenCalledTimes(1)
    expect(setUserCnpj.mock.calls[0]?.[1]).toBe('36955612000185')
    expect(to).toBe(`${PLAN_PATH}?estado=cadastro-salvo`)
  })

  it('writes both fields inside one transaction, with the same executor', async () => {
    await run(VALID)
    const profileTx = setUserProfile.mock.calls[0]?.[2]
    const cnpjTx = setUserCnpj.mock.calls[0]?.[2]
    expect(profileTx).toEqual({ tx: true })
    // The same object, not merely an equal one: a half-saved profile passes
    // one half of `canBill` and fails the other.
    expect(profileTx).toBe(cnpjTx)
  })

  /*
   * The seam this file exists for. These are the names `page.tsx` accepts; if
   * the action emits the schema's own keys instead, the page filters them out
   * and renders a rejected form with no error on it.
   */
  it('names the rejected fields the way the form and the page do', async () => {
    expect(await run({ ...VALID, nome: '' })).toBe(`${PROFILE_PATH}?erro=nome`)
    expect(await run({ ...VALID, nascimento: '2020-01-01' })).toBe(
      `${PROFILE_PATH}?erro=nascimento`,
    )
    expect(await run({ ...VALID, celular: 'x' })).toBe(`${PROFILE_PATH}?erro=celular`)
    expect(await run({ ...VALID, cnpj: '123' })).toBe(`${PROFILE_PATH}?erro=cnpj`)
  })

  it('names every rejected field, not just the first', async () => {
    const to = await run({ nome: '', nascimento: '', celular: 'x', cnpj: '' })
    expect(to).toBe(
      `${PROFILE_PATH}?erro=${encodeURIComponent('nome,nascimento,celular,cnpj')}`,
    )
  })

  it('writes nothing at all when anything is rejected', async () => {
    await run({ ...VALID, cnpj: '123' })
    expect(setUserProfile).not.toHaveBeenCalled()
    expect(setUserCnpj).not.toHaveBeenCalled()
  })

  it('still saves when the company lookup cannot be enqueued', async () => {
    companyOrLookup.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'queue' }))
    const to = await run(VALID)
    expect(setUserCnpj).toHaveBeenCalledTimes(1)
    expect(to).toBe(`${PLAN_PATH}?estado=cadastro-salvo`)
  })

  /*
   * A Server Function is a POST endpoint with a generated name, so the form is
   * not the only thing that can call it. The user id comes from the session —
   * `7` above — and never from the post, which is F33's defect one screen over.
   */
  it('ignores a user id in the post and uses the session', async () => {
    await run({ ...VALID, userId: '99', id: '99' })
    expect(setUserProfile.mock.calls[0]?.[0]).toBe(7)
  })

  /* F32: no form collects a CPF, so nothing here may write `users.cpf`. */
  it('does not write a CPF even when one is posted', async () => {
    await run({ ...VALID, cpf: '12345678909' })
    expect(setUserProfile.mock.calls[0]?.[1]).toEqual({
      name: 'Maria Silva',
      birthDate: '1980-05-20',
      mobile: '+5511999999999',
    })
  })
})

/*
 * **The round-trip, which no unit test on either side could see.** Found by
 * review 2026-10-13: `saveProfile` answers a rejection with a redirect — a 303
 * to a fresh GET — so the post body is gone, and `page.tsx` then filled the
 * fields from the database. For the account this screen exists for, a
 * magic-link signup with `name`, `whatsapp` and `cnpj` all null, **one wrong
 * digit emptied all three fields** on the last screen before money.
 *
 * `profile-view.test.tsx` takes `values` as a prop, so it renders whatever it
 * is handed and can never notice. This asserts the carrier.
 */
describe('saveProfile and what was typed', () => {
  it('carries every field back when one is rejected', async () => {
    await run({
      nome: 'Maria Silva',
      nascimento: '1980-05-20',
      celular: '11999999999',
      cnpj: '36.955.612/0001-8',
    })

    expect(jar.set).toHaveBeenCalledTimes(1)
    const [name, value, options] = jar.set.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(name).toBe(DRAFT_COOKIE)
    // Every field, not only the valid ones: the person typed all three.
    expect(JSON.parse(value)).toEqual({
      n: 'Maria Silva',
      b: '1980-05-20',
      m: '11999999999',
      c: '36.955.612/0001-8',
    })
    expect(decodeDraft(value)).toEqual({
      name: 'Maria Silva',
      birthDate: '1980-05-20',
      mobile: '11999999999',
      cnpj: '36.955.612/0001-8',
    })
    // A name and a mobile are personal data: not readable by script, scoped to
    // the one screen, and short-lived (§12).
    expect(options.httpOnly).toBe(true)
    expect(options.path).toBe(DRAFT_PATH)
    expect(options.maxAge).toBe(DRAFT_MAX_AGE)
  })

  it('never puts a typed value in the redirect URL', async () => {
    const to = await run({ ...VALID, cnpj: '123' })
    expect(to).not.toContain('Maria')
    expect(to).not.toContain('11999999999')
    expect(to).not.toContain('1980')
    expect(to).toBe(`${PROFILE_PATH}?erro=cnpj`)
  })

  /*
   * A Server Component may read cookies and not write them, so the page cannot
   * clear this after rendering — the action owns both ends. Without the
   * delete, a stale draft would re-fill the form for `DRAFT_MAX_AGE` after a
   * successful save.
   */
  it('clears the draft once the profile saves', async () => {
    await run(VALID)
    expect(jar.set).not.toHaveBeenCalled()
    expect(jar.delete).toHaveBeenCalledWith({ name: DRAFT_COOKIE, path: DRAFT_PATH })
  })
})

describe('decodeDraft', () => {
  it('refuses anything this module did not write', () => {
    for (const raw of [
      undefined,
      '',
      'not json',
      '{}',
      '[]',
      'null',
      '{"n":"a","m":"b"}',
      '{"n":"a","b":"c","m":"d"}',
      '{"n":1,"b":2,"m":3,"c":4}',
    ]) {
      expect(decodeDraft(raw as string | undefined), JSON.stringify(raw)).toBeNull()
    }
  })

  it('caps each field, so a crafted post cannot push a large cookie back', () => {
    const long = 'x'.repeat(500)
    const draft = decodeDraft(JSON.stringify({ n: long, b: long, m: long, c: long }))
    expect(draft?.name.length).toBe(160)
    expect(draft?.birthDate.length).toBe(160)
    expect(draft?.mobile.length).toBe(160)
    expect(draft?.cnpj.length).toBe(160)
  })
})
