import { expect, test, type Page } from "@playwright/test";
import { installRadarApi } from "../fixtures/radar-api";
import { cards } from "../fixtures/screen";
import { MARTA, tenderRun } from "../fixtures/world";

/**
 * D30 — the Radar list is sized by its own column, not by the window.
 *
 * The grid used to be `min-[900px]:grid-cols-2 min-[1280px]:grid-cols-3`,
 * **viewport** queries. D20 then put a rail in the layout flow beside the
 * content — `hidden lg:block` from 1024px, 264px wide, collapsible to 56px
 * through `localStorage` — and nothing reconciled the numbers. The list is
 * `main` (`max-w-[1120px]`) inside `px-gutter`, so it measures
 * `min(viewport − rail, 1120) − 2×20`, and at 1280px with the rail out that is
 * 976px drawn as three columns: ~318px cards, on the screen people spend the
 * most time on.
 *
 * `radar-view.test.tsx` pins the *mechanism* — a container, container queries,
 * no viewport query. It cannot pin the *result*: `renderToStaticMarkup` has no
 * layout, so a unit test passes on a grid that still draws three columns in
 * 976px. That is CLAUDE.md §4b's pattern, the test exercising the unit and not
 * the path, and it is why this file exists. Here the question is asked the
 * only way it can be answered — measure the cards and count the ones sharing
 * the top row.
 *
 * The widths are the boundaries, not the comfortable middle. `column` below is
 * the arithmetic above, and it is what the thresholds 860 and 1080 are read
 * against.
 */

const CNPJ = MARTA.cnpj;

/** How many cards are drawn beside each other on the first row. */
async function columns(page: Page): Promise<number> {
  const tops = await cards(page).evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y };
    }),
  );
  expect(tops.length, "the list must have cards to measure").toBeGreaterThan(2);
  const first = Math.min(...tops.map((t) => t.y));
  // Equal tops is one row; the grid puts every row on one baseline.
  return tops.filter((t) => Math.abs(t.y - first) < 4).length;
}

/** `'1'` is the only value `COLLAPSED_KEY` in `components/app-shell.tsx` reads. */
async function collapseRail(page: Page): Promise<void> {
  await page.evaluate(() =>
    localStorage.setItem("licitaqui.rail.collapsed", "1"),
  );
  await page.reload();
  await expect(cards(page).first()).toBeVisible();
}

test.describe("D30 · the Radar list asks its own width", () => {
  test.beforeEach(async ({ page }) => {
    await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(6) }],
    });
    await page.goto(`/radar?cnpj=${CNPJ}&group=compatible`);
    await expect(cards(page).first()).toBeVisible();
  });

  for (const { width, expected, why } of [
    { width: 390, expected: 1, why: "a phone: the column is 350px" },
    {
      width: 1023,
      expected: 2,
      why: "just below `lg`, no rail yet — the column is 983px",
    },
    {
      width: 1024,
      expected: 1,
      why: "the rail takes 264px and leaves 720px — the defect D30 fixes",
    },
    {
      width: 1164,
      expected: 2,
      why: "the column reaches 860px, the two-column threshold",
    },
    {
      width: 1280,
      expected: 2,
      why: "the column is 976px, and the window used to say three",
    },
    {
      width: 1440,
      expected: 3,
      why: "`main` is at its 1120px cap, so the column is 1080px",
    },
  ]) {
    test(`${width}px · ${expected} column${expected > 1 ? "s" : ""} — ${why}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      expect(await columns(page)).toBe(expected);
    });
  }

  /**
   * The rail collapses to 56px and that state lives in `localStorage`, which no
   * media query can observe. A viewport query was wrong in both directions: it
   * drew columns where there was no room, and refused them where there is.
   */
  test("1024px with the rail collapsed · two columns, because the column is 928px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    expect(await columns(page)).toBe(1);

    await collapseRail(page);
    expect(await columns(page)).toBe(2);
  });

  test("1280px with the rail collapsed · three columns, because the column is 1080px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await columns(page)).toBe(2);

    await collapseRail(page);
    expect(await columns(page)).toBe(3);
  });
});
