import { expect, test, type Locator, type Page } from '@playwright/test'
import { SESSION_COOKIE } from '@/lib/auth/config'
import { messages } from '@/lib/messages'
import { installRadarApi, type CompanyWorld } from '../fixtures/radar-api'
import { card, cards, scrollY } from '../fixtures/screen'
import { CARLA, MARTA, processo, tenderRun } from '../fixtures/world'
import { E2E_BASE_URL } from '../fixtures/server-env'

/**
 * D58 and D60 — **the snapshot belongs to a caller, and now says so.**
 *
 * `lib/radar/list-cache.ts` files a list under `listKey`, and two of the things
 * the list route answers are facts about the **caller** rather than about the
 * search. Neither was in the key:
 *
 *  * **the stars** (`favourites`, D23), which belong to a person — so signing
 *    out and returning to the same search inside sixty seconds restored the
 *    previous identity's marks, with **no request made at all**;
 *  * **the company it grouped by** (`?cnpj= ?? visitors.cnpj`, D19), which for a
 *    bare `/radar` lives entirely in an `httpOnly` cookie — so D55 had to switch
 *    the cache off for the commonest address in the product, and the way back
 *    from an edital opened there lost the scroll and every loaded page.
 *
 * ## Why these have to be browser tests
 *
 * Both defects are invisible to `vitest` **by construction** (CLAUDE.md §4c).
 * `environment: 'node'` has no `sessionStorage` across a navigation, no effects,
 * and no scroll position; and the deciding input is a cookie no page script can
 * read. The **mechanism** is pinned in `lib/radar/scope.test.ts` (the digest) and
 * `lib/radar/list-cache-scope.test.ts` (what it does to the key); the route that
 * stamps the cookie is pinned in `lib/radar/scope.db.test.ts`. This file is the
 * **result**: two page loads, one jar, and what is on screen.
 *
 * ## The cookies these journeys move, and why that is faithful
 *
 * Nothing here lets a request reach a route handler (`playwright.config.ts` has
 * no `DATABASE_URL`), so the fixture stamps `lq_scope` the way
 * `POST /api/radar/cnpj` would, and a sign-out is the session cookie leaving the
 * jar the way `signOut()` takes it. `/radar` is `force-dynamic` and reads that
 * jar on the server on every visit, which is the whole of how the scope reaches
 * a decision made before the first request.
 */

const copy = messages.radar
const limpeza = CARLA.limpeza
const hospitalar = CARLA.hospitalar

/** Her two clients, with editais that could not be mistaken for each other. */
function clients(): CompanyWorld[] {
  return [
    { company: limpeza.company, tenders: tenderRun(60), cnaeCount: 4 },
    {
      company: hospitalar.company,
      cnaeCount: 2,
      tenders: tenderRun(9, (index) => ({
        id: `33444555000163-1-${String(index + 1).padStart(6, '0')}/2026`,
        object:
          `AQUISIÇÃO DE MATERIAL HOSPITALAR, PROCESSO ${processo(500 + index + 1)}, ` +
          'PARA A REDE MUNICIPAL DE SAÚDE, CONFORME TERMO DE REFERÊNCIA',
      })),
    },
  ]
}

/**
 * The stars in one state, by what they promise a reader rather than by a name
 * (`favourite-on-card.spec.ts` records why `aria-pressed` is the handle).
 */
function stars(page: Page, marked: boolean): Locator {
  return page.locator('li').getByRole('button', { pressed: marked })
}

/**
 * A session in the jar, which is all a sign-in is to the scope.
 *
 * The value is an opaque token in production too — Auth.js's session strategy is
 * `database`, so "is this valid" is a row in `sessions` and not anything in the
 * cookie. Nothing in these journeys asks the database, and the shell is written
 * to render a visitor rather than fail when it cannot read a summary
 * (`lib/account/server-summary.ts`), so the one thing this changes here is the
 * scope — which is exactly the boundary under test.
 */
async function signIn(page: Page, token: string): Promise<void> {
  await page.context().addCookies([
    { name: SESSION_COOKIE, value: token, url: E2E_BASE_URL, httpOnly: true, sameSite: 'Lax' },
  ])
}

async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies({ name: SESSION_COOKIE })
}

test.describe('D58 · a restored list is not another identity’s', () => {
  const LIST = `/radar?cnpj=${MARTA.cnpj}&group=compatible`
  const ID = (n: number) => `51885242000140-1-${String(n).padStart(6, '0')}/2026`

  test('signing out does not leave the previous reader’s stars on the cards', async ({ page }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })
    await signIn(page, 'session-marta')
    api.favourites = new Set([ID(2)])

    await page.goto(LIST)
    await expect(cards(page)).toHaveCount(3)
    // Her own mark, from the list envelope — one read, not three.
    await expect(stars(page, true)).toHaveCount(1)

    /*
     * She signs out, in this tab, and comes straight back to the same search.
     *
     * `sessionStorage` survives a sign-out — it dies with the tab, not with the
     * session — so the snapshot is still there, under a minute old. That age is
     * where the defect lived: `readList` answers `fresh`, the screen asks for
     * **nothing**, and whatever the snapshot says about the stars is what gets
     * drawn for the whole of that viewing.
     */
    await signOut(page)
    api.favourites = null
    const asked = api.calls.tenders.length

    await page.goto(LIST)
    await expect(cards(page)).toHaveCount(3)

    // Not one marked star. These are not this reader's marks and there is
    // nobody here they could belong to.
    await expect(stars(page, true)).toHaveCount(0)
    await expect(stars(page, false)).toHaveCount(3)
    expect(
      api.calls.tenders.length,
      'a snapshot written under another identity must be re-read, not drawn',
    ).toBeGreaterThan(asked)
  })

  test('signing in does not leave the visitor’s empty stars on an account that has marks', async ({
    page,
  }) => {
    /*
     * The other direction, and the card is explicit that both were wrong: "after
     * a sign-in, empty stars for an account that has marks on another device —
     * which is precisely the case D23's journey celebrates."
     */
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })
    api.favourites = null

    await page.goto(LIST)
    await expect(stars(page, false)).toHaveCount(3)

    // She creates an account, and this one already has an edital marked from
    // her phone.
    await signIn(page, 'session-marta')
    api.favourites = new Set([ID(1)])
    const asked = api.calls.tenders.length

    await page.goto(LIST)
    await expect(cards(page)).toHaveCount(3)
    await expect(stars(page, true)).toHaveCount(1)
    expect(api.calls.tenders.length, 'the account’s marks had to be asked for').toBeGreaterThan(
      asked,
    )
  })

  test('the same reader still gets their own list back, with no request', async ({ page }) => {
    /*
     * The guard must not cost the ordinary case anything — this is the other
     * half of §4b: a fix that makes every restore miss would pass both tests
     * above and quietly delete the cache.
     */
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })
    await signIn(page, 'session-marta')
    api.favourites = new Set([ID(2)])

    await page.goto(LIST)
    await expect(stars(page, true)).toHaveCount(1)
    const asked = api.calls.tenders.length

    await page.goto(LIST)
    await expect(cards(page)).toHaveCount(3)
    await expect(stars(page, true)).toHaveCount(1)
    expect(api.calls.tenders.length, 'the same caller, the same list, no request').toBe(asked)
  })

  test('no identifier is handed to the client as data (§12)', async ({ page }) => {
    /*
     * **A bare `/radar`, and that is the point of the shape.**
     *
     * `listKey` has always carried the URL's `?cnpj=`, which is in the address
     * bar and in `history` already; §12's rule — and D19's reason for removing
     * `GroupedBy.cnpj` — is about the CNPJ the browser is *not* supposed to
     * know: `visitors.cnpj`, behind an `httpOnly` cookie. That is the one this
     * key had to learn to discriminate on without being told, so this is the
     * address where the answer can be checked.
     */
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
      cookieCnpj: MARTA.cnpj,
    })
    await signIn(page, 'session-marta-0a1b2c3d')
    api.favourites = new Set([ID(2)])

    await page.goto('/radar')
    expect(new URL(page.url()).search, 'the CNPJ is only in the cookie').toBe('')
    await expect(stars(page, true)).toHaveCount(1)

    /*
     * Read as keys and values, because the two carry different promises: the
     * discriminator is in the **key** and the list is in the **value**.
     */
    const jar = await page.evaluate(() => {
      const entries: { key: string; value: string }[] = []
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index)
        if (key === null) continue
        entries.push({ key, value: sessionStorage.getItem(key) ?? '' })
      }
      return entries
    })

    const lists = jar.filter((entry) => entry.key.startsWith('licitaqui.radar.list'))
    expect(lists.length, 'the snapshot is there to be checked at all').toBe(1)
    /*
     * **This test used to be called "nothing identifying reaches
     * sessionStorage", and its own body explains why that title overclaimed** —
     * see the MEI paragraph below. A title that promises more than it checks is
     * `CLAIMS.md`'s shape one layer down, so it names the rule it actually holds.
     */

    // The key: the scope is the only thing in it that could name this device,
    // and it is 22 characters of keyed HMAC. The search half is empty — this
    // URL carries no CNPJ, no UF and no keyword.
    expect(lists[0].key, 'no cookie CNPJ in the key').not.toContain(MARTA.cnpj)

    /*
     * The value: `grouping.company` has no `cnpj` field at all (D19's fix,
     * completed here — it had come back nested inside `company`).
     *
     * **What produces this value is `e2e/fixtures/radar-api.ts`, not the route**:
     * the journeys never let a request reach a route handler. So putting the
     * field back in `app/api/radar/tenders/route.ts` would not fail this test.
     * The route is guarded by `lib/radar/radar.db.test.ts`'s cookie-company
     * assertion, which runs against a real Postgres in CI
     * (`TEST_DATABASE_URL_D3`). What this test holds is the other half: that
     * nothing between the envelope and storage puts it back.
     */
    const snapshot = JSON.parse(lists[0].value) as {
      grouping: { company: Record<string, unknown> | null } | null
    }
    expect(snapshot.grouping?.company, 'the header still has a company to draw').toBeTruthy()
    expect(Object.keys(snapshot.grouping?.company ?? {})).not.toContain('cnpj')

    /*
     * **And not a blanket "the CNPJ does not appear anywhere", because that is
     * not a property this product can have.** The first version of this
     * assertion searched the whole jar for the fourteen digits and failed on
     * `legalName: "MARTA APARECIDA SOUZA 11222333000181"` — which is not a leak
     * but the Receita's own convention: a MEI's razão social *is* the person's
     * name followed by the CNPJ. The header draws that name, so it is on screen
     * before it is in storage. What §12 excludes is an identifier the client is
     * handed as data; what it cannot exclude is a substring of a name the reader
     * is being shown.
     */
    const everything = jar.map((entry) => `${entry.key}\u0001${entry.value}`).join('\u0001')
    expect(everything, 'no session token').not.toContain('session-marta-0a1b2c3d')
    expect(everything, 'nor any part of one').not.toContain('0a1b2c3d')
  })
})

test.describe('D60 · a bare /radar comes back where it was left', () => {
  test('three pages and the scroll survive an edital and Voltar', async ({ page }) => {
    /*
     * The journey `list-cache.ts` exists for, on the one shape D55 had to
     * exclude. That file records what it looked like on production before the
     * cache existed — 60 cards and 3000px of scroll replaced by "Consultando o
     * CNPJ…" — and calls it indistinguishable from having lost the search. On a
     * bare `/radar` it is not even that: the waiting state says "Procurando
     * editais…", because no CNPJ was posted (D55).
     */
    const api = await installRadarApi(page, {
      companies: clients(),
      cookieCnpj: limpeza.cnpj,
      pageSize: 20,
    })

    await page.goto('/radar')
    expect(new URL(page.url()).search, 'the whole premise: neither half in the URL').toBe('')
    await expect(cards(page)).toHaveCount(20)
    await expect(page.getByText('Brilho Limpeza')).toBeVisible()

    // She pulls the list down: 20, 40, 60.
    await page.getByRole('button', { name: 'Ver mais editais' }).click()
    await expect(cards(page)).toHaveCount(40)
    await page.getByRole('button', { name: 'Ver mais editais' }).click()
    await expect(cards(page)).toHaveCount(60)

    const chosen = card(page, processo(47))
    await chosen.scrollIntoViewIfNeeded()
    const before = await scrollY(page)
    expect(before, 'the test needs a real scroll to have anything to restore').toBeGreaterThan(1000)

    const listReads = api.calls.tenders.length

    await chosen.click()
    await expect(page).toHaveURL(/\/radar\/edital\//)

    // A document navigation: the card is an `<a>` and the tab rebuilds the
    // Radar from nothing. It is exactly the path that lost everything.
    await page.getByRole('link', { name: 'Voltar' }).click()

    await expect(cards(page)).toHaveCount(60)
    await expect(page.getByText('Brilho Limpeza')).toBeVisible()
    await expect(page.getByText(copy.states.analyzingListTitle)).toHaveCount(0)
    await expect(page.getByText(copy.states.needCnpjTitle)).toHaveCount(0)

    const after = await scrollY(page)
    expect(Math.abs(after - before), 'the scroll goes back where she was').toBeLessThan(120)

    expect(
      api.calls.tenders.length,
      'the snapshot is under a minute old: §3.1 says a re-read returns the same rows',
    ).toBe(listReads)
  })

  test('a keyword search with a cookie CNPJ keeps its cache, and does not keep the other company’s', async ({
    page,
  }) => {
    /*
     * The second shape of D60, which **predates D55**: the route resolves the
     * cookie *before* it checks for a keyword, so `/radar?q=…` is grouped by
     * that company too — its `groupedBy`, its `counts` and which tab each row
     * lands in are the cookie's, and only the row set is the keyword's. Taking
     * the cache from every keyword search would have been a product cost rather
     * than a correction, so both halves are asserted here: the cache is kept,
     * and it is not handed over when the company changes.
     */
    const api = await installRadarApi(page, {
      companies: clients(),
      cookieCnpj: limpeza.cnpj,
      pageSize: 20,
    })

    const search = '/radar?q=aquisi'
    await page.goto(search)
    await expect(page.getByText('Brilho Limpeza')).toBeVisible()
    const found = await cards(page).count()
    expect(found, 'the keyword found something to cache').toBeGreaterThan(0)
    const listReads = api.calls.tenders.length

    // Same reader, same search: restored, and nothing asked.
    await page.goto(search)
    await expect(cards(page)).toHaveCount(found)
    expect(api.calls.tenders.length, 'the kept cache D55 refused to take away').toBe(listReads)

    // Her other client, searched in between — the cookie moves and so does the
    // key, so this list is read rather than restored.
    await api.setCookieCnpj(hospitalar.cnpj)
    await page.goto(search)

    await expect(page.getByText('Vida Hospitalar')).toBeVisible()
    await expect(page.getByText('Brilho Limpeza')).toHaveCount(0)
    expect(
      api.calls.tenders.length,
      'a list grouped by another company is not this company’s list',
    ).toBeGreaterThan(listReads)
  })
})

test.describe('D70 · the scope can be behind, and the merge must not run on it', () => {
  test('a browser Back after changing company does not draw one company over another', async ({
    page,
  }) => {
    /*
     * **The path no other test in this suite can reach**, and the reason it had
     * to be written: every journey here navigates with `goto` or clicks an
     * `<a>` — both document loads, both of which re-render
     * `app/radar/page.tsx` and hand the screen a **fresh** scope. Next reuses a
     * page segment on a browser back/forward without re-rendering it (its own
     * glossary: *"Pages are not cached by default but are reused during browser
     * back/forward navigation"*), so Back is the one navigation that can leave
     * the prop behind.
     *
     * Carla reads her cleaning client's list at a bare `/radar`, switches to her
     * hospital client **inside the tab** (*Aplicar filtros* is `router.push`, not
     * a form submit, once React has hydrated), and presses Back.
     *
     * Past `REVALIDATE_AFTER_MS` that was the worst outcome available:
     * `refreshTenders` merges page 1 **by id**, Vida's ids match none of
     * Brilho's rows, so Brilho's 60 cards would have stayed under *Vida
     * Hospitalar · 2 CNAEs*. D19, recreated by the fix for D19 — which is the
     * dead end D55 wrote down.
     */
    /*
     * The clock is installed and **resumed** immediately: frozen time stalls
     * hydration (the first version of this test timed out on a filter control
     * that was rendered and hidden), and what is needed here is not a paused
     * clock but the ability to move it forward once.
     */
    await page.clock.install()
    await page.clock.resume()

    const api = await installRadarApi(page, {
      companies: clients(),
      cookieCnpj: limpeza.cnpj,
      pageSize: 20,
    })

    await page.goto('/radar')
    await expect(page.getByText('Brilho Limpeza')).toBeVisible()
    await expect(cards(page)).toHaveCount(20)

    // Her other client, from the filter form on this screen: a client-side
    // navigation, which is what keeps the stale prop alive.
    // **The disclosure is already open here, and that is D61**: `FilterRow`
    // expands on `!query.cnpj && !query.q`, so a bare `/radar` draws the whole
    // search form with an empty CNPJ field under a named company. Clicking the
    // summary would *close* it — the first version of this test did, and timed
    // out on a control that was there and hidden.
    await expect(page.getByLabel('Modalidade')).toBeVisible()
    await page.getByLabel('CNPJ da empresa').fill(hospitalar.cnpj)
    await page.getByRole('button', { name: 'Aplicar filtros' }).click()
    await expect(page.getByText('Vida Hospitalar')).toBeVisible()
    // What `POST /api/radar/cnpj` would have stamped, since the fixture answered
    // it instead of the route.
    await api.setCookieCnpj(hospitalar.cnpj)

    /*
     * Past the silent window, so the restore **revalidates** rather than being
     * served with no request at all — which is the half this fix closes.
     *
     * **It has to be the clock and not a rewrite of `savedAt` in storage.** A
     * browser Back is a *soft* navigation: the JavaScript context survives, so
     * `list-cache.ts`'s Map still holds the snapshot and `readList` reads the Map
     * **before** the storage mirror. Editing `sessionStorage` from the test
     * therefore ages a copy nothing reads — the first version of this test did
     * exactly that and the restore came back `fresh`, which is how the Map's
     * precedence got written down here.
     */
    const before = await page.evaluate(() => Date.now())
    await page.clock.fastForward('03:00')
    const after = await page.evaluate(() => Date.now())
    expect(
      after - before,
      'the clock has to have moved past REVALIDATE_AFTER_MS, or this test proves nothing',
    ).toBeGreaterThan(60_000)

    await page.goBack()

    /*
     * Whatever the scope says, the screen must agree with itself. The failure
     * this asserts against is not staleness — it is the **mixture**: a header
     * naming one company above another company's editais.
     */
    await expect(page.getByText('Vida Hospitalar')).toBeVisible()
    await expect(page.getByText('Brilho Limpeza')).toHaveCount(0)
    await expect(page.getByText('4 CNAEs')).toHaveCount(0)

    /*
     * **The rows, named** — and this is the assertion that does the work.
     * Mutating the guard to compare the answer with itself leaves the header
     * assertions above **passing**: `refreshTenders` replaces `grouping` and
     * `counts` and keeps the rows, so the screen says *Vida Hospitalar · 2
     * CNAEs* over Brilho's editais. The mixture is only visible in which
     * editais are on the page, which is why the count and a named processo are
     * both here rather than the names alone.
     */
    await expect(cards(page)).toHaveCount(9)
    await expect(card(page, processo(501)), 'Vida’s own edital').toBeVisible()
    await expect(card(page, processo(1)), 'and none of Brilho’s').toHaveCount(0)
    expect(new URL(page.url()).search, 'and it is the bare address she came back to').toBe('')
  })
})
