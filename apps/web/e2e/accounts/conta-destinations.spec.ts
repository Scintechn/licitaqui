import { expect, test, type Locator, type Page } from '@playwright/test'
import { SESSION_COOKIE } from '@/lib/auth/config'
import { messages } from '@/lib/messages'
import { ACCOUNT_CREATE_PATH } from '@/lib/routes'

/**
 * **Sci's two questions on `/conta`, signed in** — *"who is me?"* and *"why are
 * these links here if they are in the side panel?"* — as assertions (**D22**).
 *
 * D22's decision was taken on 2026-09-29 and its acceptance is one sentence:
 *
 * > Each nav entry leads somewhere that differs from the others, or the menu
 * > has as many entries as it has destinations; `currentItem` needs no special
 * > case for a tie.
 *
 * Two of its three parts have shipped: `/conta/empresa` and `/conta/plano` are
 * real routes with no tie-break in `currentItem`, and **since 2026-10-09
 * `/conta` names the signed-in account** — the e-mail assertion below was
 * `test.fail(…)` until that landed and is now an ordinary test.
 *
 * **One part is still open.** `/conta` draws four buttons to four places the
 * rail beside it already offers, and that cannot simply be deleted: while a
 * collapsed rail unmounts the nav (**D77**), those buttons are most of the
 * navigation such a reader has. So it stays `test.fail(…)` and waits on D77's
 * ruling, with its own comment saying so.
 *
 * ## Why this file is in `accounts/` and not in `journeys/`
 *
 * Everything here needs a **session and a database**, and there is no way to
 * make one from a test: the session strategy is `database` (spec §5), so the
 * cookie is an opaque token and "is this valid" is a row in `sessions` — no
 * secret this process holds can mint one. `readAccountData` redirects a
 * signed-out caller to `/conta/criar`, so a hermetic run would resolve four of
 * the six rail entries to that one address for a reason that has nothing to do
 * with the menu, and the distinctness assertion would fail for the wrong
 * reason.
 *
 * That is the same wall `ricardo-telegram.spec.ts` hit and the same contract
 * this project already advertises — `.github/workflows/ci-e2e.yml` says in so
 * many words that `accounts` *"needs a published deployment, a session cookie
 * for a test account"* — so the env is the one that already exists:
 *
 * ```
 * E2E_BASE_URL=https://… \
 * E2E_SESSION_COOKIE=<the authjs.session-token value of a test account> \
 * E2E_SESSION_EMAIL=<that account's e-mail, for the identity assertion> \
 *   pnpm --filter @licitaqui/web exec playwright test --project=accounts
 * ```
 *
 * A local `next start` with a `DATABASE_URL` is a published environment for
 * this purpose, and is how the assertions below were proved. **It skips with
 * its reason when it has none of that, and never pretends to have passed.**
 *
 * ## What `journeys/rail-destinations.spec.ts` covers instead
 *
 * The rail is not a signed-in feature — `app/radar/layout.tsx` wraps everybody
 * — so distinctness at the `href` the rail renders, the single marking, and the
 * two rail widths are asserted hermetically there, on every PR. This file is
 * the stronger version of the first two (the URL the browser **lands** on, on
 * each of the six destinations) plus the two that only exist signed in.
 */

const BASE = process.env.E2E_BASE_URL
const COOKIE = process.env.E2E_SESSION_COOKIE
/** The account's own address. Only test 3 needs it, and only that one skips. */
const EMAIL = process.env.E2E_SESSION_EMAIL

const MISSING =
  'needs a published environment and a session cookie for a test account: ' +
  'E2E_BASE_URL + E2E_SESSION_COOKIE'

const menu = messages.radar.menu

/** `lg` exactly: the narrowest window at which the rail is in the layout flow. */
const WINDOW = { width: 1024, height: 900 } as const

/** `components/app-shell.tsx`'s rail widths and its `localStorage` key. */
const RAIL = { expanded: 264, collapsed: 56 } as const
const COLLAPSED_KEY = 'licitaqui.rail.collapsed'

test.use({ viewport: WINDOW })

/**
 * The rail's own nav — scoped, and `exact` on the name.
 *
 * The `<aside>` also holds the logo and the plan strip's link, which are not
 * nav entries; and `aria-current="page"` is spent elsewhere on these screens
 * too, so a document-wide count would assert several unrelated decisions at
 * once. `exact: true` because Playwright matches `name` as a **substring**,
 * which is how D56's own e2e came to require the defect it was written to
 * catch.
 */
function rail(page: Page): Locator {
  return page.getByRole('complementary', { name: menu.title, exact: true })
}

function railNav(page: Page): Locator {
  return rail(page).getByRole('navigation')
}

/**
 * Go to an account screen and refuse to continue if the session was not taken.
 *
 * **The guard a `test.fail` test cannot have.** A rejected or expired
 * cookie sends every account route to `/conta/criar`, where there is no rail
 * and no account data — so inside a `test.fail` body that produces a failure,
 * which *satisfies the annotation*, and the run reports an expected failure
 * having proved nothing at all. Nothing can fix that from inside it;
 * what fixes it is that the positive counterparts beside them call this and
 * **must pass**, so a stale `E2E_SESSION_COOKIE` reddens the run with a
 * sentence saying so instead of being quietly absorbed.
 */
async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path)
  expect(
    new URL(page.url()).pathname,
    `the session was not accepted on ${path} — this run proves nothing about D22; ` +
      'refresh E2E_SESSION_COOKIE',
  ).not.toBe(ACCOUNT_CREATE_PATH)
}

/** Where each rail entry points, resolved, read off the rendered rail. */
async function railHrefs(page: Page): Promise<string[]> {
  const entries = railNav(page).getByRole('link')
  await expect(entries.first(), 'the rail renders its entries').toBeVisible()
  return entries.evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).href))
}

/** Everything `main` links to, resolved the same way, for the comparison. */
function mainHrefs(page: Page): Promise<string[]> {
  return page
    .locator('main a[href]')
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).href))
}

/**
 * Measured from the same locator the rest of the file asserts on, not from a
 * `querySelector` of its own: two selectors for one element is how a test comes
 * to measure something other than the thing it is asserting about.
 */
async function boxes(page: Page): Promise<{ rail: number; column: number; overflow: number }> {
  return rail(page).evaluate((aside) => {
    const column = aside.nextElementSibling
    const round = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().width) : -1)
    return {
      rail: round(aside),
      column: round(column),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
}

test.describe('D22 · the account area, signed in', () => {
  test.skip(!BASE || !COOKIE, MISSING)

  test.beforeEach(async ({ context }) => {
    const { hostname, protocol } = new URL(BASE ?? 'http://127.0.0.1')
    await context.addCookies([
      {
        // Auth.js writes the `__Secure-` name on https; both spellings are
        // pinned in `lib/auth/config.ts` precisely so they cannot drift.
        name: protocol === 'https:' ? `__Secure-${SESSION_COOKIE}` : SESSION_COOKIE,
        value: COOKIE ?? '',
        domain: hostname,
        path: '/',
        httpOnly: true,
        secure: protocol === 'https:',
        sameSite: 'Lax',
      },
    ])
  })

  /**
   * The strong form of D22's acceptance: not six distinct `href`s, six distinct
   * **arrivals**.
   *
   * `href` distinctness is what the hermetic lane can see, and it would not
   * catch two addresses that redirect to one page — which is precisely the
   * class the four `/conta/*` entries fall into for anybody without a session.
   * Signed in, each one is allowed to be itself.
   */
  test('every rail entry lands somewhere the others do not', async ({ page }) => {
    await page.goto('/radar')
    const hrefs = await railHrefs(page)

    // A floor, not the contract: an empty nav satisfies the set equality below
    // for free, so a rail that stopped rendering must fail here instead.
    expect(hrefs.length, 'six entries today').toBeGreaterThanOrEqual(6)

    const landed: string[] = []
    for (const href of hrefs) {
      await page.goto(href)
      const url = new URL(page.url())
      /**
       * **The wrong-reason guard.** Every gated entry redirects a signed-out
       * caller to `/conta/criar`; without this, a run whose session cookie was
       * stale would report "all six land on the same page" as a D22 regression
       * instead of as a bad cookie.
       */
      expect(
        url.pathname,
        'the session was not accepted — this run proves nothing about D22; ' +
          'refresh E2E_SESSION_COOKIE',
      ).not.toBe(ACCOUNT_CREATE_PATH)
      landed.push(`${url.origin}${url.pathname}`)
    }

    expect(
      new Set(landed).size,
      `two rail entries lead to the same page (D22): ${landed.join(' · ')}`,
    ).toBe(hrefs.length)
  })

  /**
   * One marking per page, on **every** page — which is the assertion the
   * original defect needed.
   *
   * Marking by `href` lit "Minha empresa", "Plano e pagamento" and "Perfil" at
   * once the moment D20 put the menu on `/conta`, and it did so on `/conta`
   * alone: a test that only ever looked at `/radar` saw one marking and passed,
   * which is exactly what happened. So this visits each of the six.
   */
  test('exactly one entry is marked current on each destination', async ({ page }) => {
    await page.goto('/radar')
    const hrefs = await railHrefs(page)

    for (const href of hrefs) {
      await page.goto(href)
      const path = new URL(page.url()).pathname
      const marked = railNav(page).locator('[aria-current]')
      await expect(marked, `exactly one rail entry is marked on ${path}`).toHaveCount(1)

      /**
       * And the **right** one: without this, a `currentItem` that always
       * answered `'alerts'` would be green on all six. Longest match wins, so
       * `/conta/plano` is Plano and not Perfil — the tie `currentItem` must not
       * need a special case for.
       */
      const markedPath = new URL(
        await marked.evaluate((node) => (node as HTMLAnchorElement).href),
      ).pathname
      expect(markedPath, `the marked entry on ${path} is the page we are on`).toBe(path)
    }
  })

  /**
   * **Expected to fail. It is the unmet half of D22's acceptance.**
   *
   * *"Who is me?"* — `/conta` is the one screen whose subject is the account,
   * and nothing on it names the account. The reason is two lines of code:
   * `app/conta/account-data.ts:63` selects `plan, cnpj, founder_seat` and never
   * `email`, and `app/conta/page.tsx` hands `AccountView` only `plan` and
   * `planName`. `lib/auth/session.ts` says in its own LGPD note that the
   * e-mail *"is fetched only where a screen actually shows it, which is
   * `/conta` and nowhere else"* — a sentence that is true about the intent and
   * false about the code.
   *
   * **What it is waiting on:** the e-mail reaching the view — one column in
   * `readAccountData`'s select, one prop, one rendered node. It needs **no new
   * copy**: the assertion is on the address itself, which is data, so nothing
   * here invents a user-facing sentence (legal brief §5). Whether it is
   * labelled, and with which word, is Sci's.
   *
   * **The e-mail landed on 2026-10-09 (D22), so the annotation is gone.** It
   * was `test.fail()` while the address was missing — Playwright runs such a
   * test and requires it to fail, so a passing body turned the run red and
   * told somebody to come here. That is what happened; this is that edit, and
   * the body is unchanged. `.first()` stays: it guards the opposite defect,
   * the address rendered twice.
   */
  test('“who is me?” · /conta names the signed-in account', async ({ page }) => {
    test.skip(
      !EMAIL,
      'needs the test account’s own address in E2E_SESSION_EMAIL: the assertion is that ' +
        'the signed-in identity is on the page, and only the runner knows which identity',
    )

    await page.goto('/conta')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()

    /**
     * The address as text, anywhere on the page a reader can see it. Not a
     * label and not a test id: there is no approved string for this yet, and
     * asserting on one this file invented would be writing copy (legal brief
     * §5) and would pin a wording Sci has not chosen.
     *
     * `account.screen.dataBody` is *"A gente guarda seu e-mail, o CNPJ…"* — a
     * sentence **about** storing an address, which is why this matches the
     * address itself and never the word "e-mail".
     *
     * **`.first()`, and it is not laziness.** A bare `toBeVisible()` on a
     * locator that resolves to two nodes throws a **strict-mode violation**.
     * While this was a `test.fail` that satisfied the annotation exactly as
     * well as the address being absent did, so a second rendering would have
     * read as "still missing". It is an ordinary test now and the hazard has
     * inverted: a strict-mode throw would read as a regression. Either way
     * `.first()` keeps this test about presence, and the count below is what
     * owns "exactly once".
     * Same reason for `.first()` on the heading above.
     */
    await expect(
      page.getByText(EMAIL ?? '', { exact: false }).first(),
      'nothing on /conta says whose account it is — D22’s unmet half',
    ).toBeVisible()
  })

  /**
   * The same fact as a count, in a test that must **pass**.
   *
   * It read `toHaveCount(0)` while the address was missing, and the fix had to
   * come here and invert it rather than tiptoe around it — which is the whole
   * reason it was written as a count and not as prose in a card.
   *
   * **Exactly one**, not "at least one": two renderings of the same address is
   * its own defect, and `.first()` on the test above would hide it.
   */
  test('/conta shows the account’s address exactly once', async ({
    page,
  }) => {
    test.skip(!EMAIL, 'needs the test account’s own address in E2E_SESSION_EMAIL')

    await visit(page, '/conta')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    await expect(
      page.getByText(EMAIL ?? '', { exact: false }),
      'D22: /conta must name the account it is about, once',
    ).toHaveCount(1)
  })

  /**
   * **Expected to fail. The second unmet half.**
   *
   * *"Why are these links here if they are in the side panel?"* —
   * `app/conta/account-view.tsx:72-83` draws four buttons to `/radar`,
   * `ALERTS_HREF`, `COMPANY_PATH` and `PLAN_PATH`, three of them **using the
   * rail's own message keys** (`messages.radar.menu.company`,
   * `messages.radar.menu.billing`). At 1024px the rail offering those same four
   * destinations is 264px to the left of them, in the layout flow, on screen.
   *
   * They are not redundant by accident: they predate the rail. D20 put the
   * menu on `/conta` for the first time, and these buttons were what `/conta`
   * had instead of navigation.
   *
   * **What it is waiting on:** a decision, which is why this is a failing
   * assertion and not a patch. Deleting them is one diff; but collapsing the
   * rail **unmounts** the nav entirely at this width (D77), and while that is
   * true these four buttons are the only navigation a reader with a collapsed
   * rail has. So the two cards are coupled, and whether `/conta` keeps a way
   * out is Sci's call rather than this lane's.
   *
   * Asserted where the rail is in the layout flow — `test.use` pins 1024px —
   * because below `lg` the rail does not exist and the duplication is not
   * duplication at all.
   */
  test.fail('“why are these links here?” · /conta does not repeat the rail', async ({ page }) => {
    await page.goto('/conta')
    const rail = new Set((await railHrefs(page)).map((href) => new URL(href).pathname))
    expect(rail.size, 'the rail is on screen at 1024px').toBeGreaterThanOrEqual(6)

    const repeated = (await mainHrefs(page))
      .map((href) => new URL(href).pathname)
      .filter((path) => rail.has(path))

    expect(
      repeated,
      `the page repeats destinations the rail already offers: ${repeated.join(' · ')}`,
    ).toEqual([])
  })

  /**
   * And the same fact measured positively, in a test that must **pass**.
   *
   * `test.fail` above is satisfied by any failure, including `<main>`
   * disappearing — which would make `repeated` empty, the annotation report
   * "expected to fail but passed", and point at a fix that did not happen. So
   * the four paths are named here, as the set they are today. It goes red
   * either way: delete one button and this fails; delete all four and this
   * fails while the tripwire above passes. **A record of the defect, not an
   * endorsement**, and a fix deletes it.
   */
  test('today /conta repeats exactly four rail destinations — D22’s unmet half', async ({
    page,
  }) => {
    await visit(page, '/conta')
    const rail = new Set((await railHrefs(page)).map((href) => new URL(href).pathname))
    const repeated = (await mainHrefs(page))
      .map((href) => new URL(href).pathname)
      .filter((path) => rail.has(path))

    expect(
      [...repeated].sort(),
      'D22: account-view.tsx:72-83, four buttons the rail beside them already offers',
    ).toEqual(['/conta/alertas', '/conta/empresa', '/conta/plano', '/radar'])
  })

  /**
   * The same invariant on the other four account screens, where it **holds** —
   * so it is a guard and not a known failure.
   *
   * Worth asserting separately rather than folding into the test above: those
   * four were written after the rail existed and none of them links to a rail
   * destination (`plan-view.tsx` points at `PLAN_HREF`, which is `/fundadores`;
   * `favoritos` links editais; `alertas` links the Landing). Folding them in
   * would hide four passing paths behind one expected failure, which is how a
   * regression on any of them would go unnoticed until `/conta` is fixed.
   *
   * `/conta/plano` is asserted on, never edited: a billing lane is live in that
   * file and this only reads what is there today.
   */
  test('the other account screens do not repeat the rail either', async ({ page }) => {
    await visit(page, '/conta')
    const rail = new Set((await railHrefs(page)).map((href) => new URL(href).pathname))

    const checked: string[] = []
    /** Every `<main>` link the walk actually looked at, across all four. */
    const examined: string[] = []

    // `/radar` is filtered out **before** the navigation rather than skipped
    // after it: it is a rail destination itself and its list links editais and
    // group chips, which is a different question. Skipping after the `goto`
    // cost a page load to learn nothing.
    for (const path of [...rail].filter((one) => one !== '/conta' && one !== '/radar')) {
      await visit(page, path)
      // The screen rendered at all — otherwise an error page with no `<main>`
      // would satisfy every assertion below by having nothing in it.
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()

      const links = (await mainHrefs(page)).map((href) => new URL(href).pathname)
      examined.push(...links)
      expect(links.filter((one) => rail.has(one)), `${path} repeats a rail destination`).toEqual([])
      checked.push(path)
    }

    /**
     * **Two floors, because one of them is not enough and the first version of
     * this test had neither.**
     *
     * Every assertion above is inside a loop over a set this test did not
     * write, so a rail offering only `/conta` and `/radar` would skip the body
     * and report green over nothing — that is what `checked` catches. But
     * `toEqual([])` is *also* satisfied by a screen with no links at all, and
     * **two of these four have none**: `company-view.tsx` is a card and a form,
     * and `favourites-view.tsx` renders only a `StateCard` for an account with
     * nothing marked. So a walk could visit all four and compare nothing.
     *
     * `examined` is the floor for that. One link is what `/conta/plano`
     * contributes today (`PLAN_HREF` → `/fundadores`, `plan-view.tsx:70`);
     * `/conta/alertas` contributes one only in the Telegram `waiting` phase, so
     * it cannot be relied on. One, therefore — low, and deliberately: it proves
     * the comparison ran against a real href at least once rather than
     * pretending the four screens are equally informative. The number of links
     * on a screen is not this test's business; that it looked is.
     */
    expect(
      checked.sort(),
      'the walk visited the four account screens it claims to have checked',
    ).toHaveLength(4)
    expect(
      examined.length,
      'the walk compared no `main` link at all on any of the four — it asserted nothing',
    ).toBeGreaterThanOrEqual(1)
  })

  /**
   * The rail beside `/conta`'s content, in both of its states.
   *
   * The widths themselves are pinned hermetically in
   * `journeys/rail-destinations.spec.ts`; what is signed-in-only here is that
   * the **account** layout gets them too. `app/conta/layout.tsx` renders the
   * shell only for `shell.summary?.signedIn`, so this is the only place the
   * account area's own rail can be measured at all.
   */
  test('the rail is beside the account content, expanded and collapsed', async ({ page }) => {
    await visit(page, '/conta')
    const expanded = await boxes(page)
    expect(expanded.rail, 'the expanded rail is `w-[264px]`').toBe(RAIL.expanded)
    // *"the side panel didnt should block the main page"* — Sci, 2026-09-29. A
    // rail in the flow leaves the content the window minus itself; one drawn
    // over it would leave the whole window. 1024 − 264 = 760.
    expect(expanded.column).toBe(WINDOW.width - RAIL.expanded)
    expect(expanded.overflow, 'no sideways scroll at 1024px').toBeLessThanOrEqual(0)
    await expect(railNav(page).locator('[aria-current]')).toHaveCount(1)

    await page.evaluate(
      ([key]) => {
        try {
          window.localStorage.setItem(key, '1')
        } catch {
          // Blocked site data: the assertion below sees 264 and says so.
        }
      },
      [COLLAPSED_KEY] as const,
    )
    await page.reload()

    const collapsed = await boxes(page)
    expect(
      collapsed.rail,
      'the collapsed rail is `w-[56px]` — the assertion that proves the ' +
        'localStorage state was read, which no media query can observe',
    ).toBe(RAIL.collapsed)
    expect(collapsed.column).toBe(WINDOW.width - RAIL.collapsed)
    expect(collapsed.overflow, 'no sideways scroll at 1024px').toBeLessThanOrEqual(0)
  })
})
