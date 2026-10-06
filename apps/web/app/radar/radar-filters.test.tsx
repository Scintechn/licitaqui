import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { ME_EPP_PARAM, MODALITY_PARAM } from '@/lib/radar/client'
import type { CompanyView, TenderCard } from '@/lib/radar/contract'
import { ME_EPP_OPTIONS, MODALITY_NAMES, MODALITY_OPTIONS } from '@/lib/radar/filters'
import { RadarView, type RadarViewProps } from './radar-view'

/**
 * D52 — the Radar's filter row, now five controls and a button.
 *
 * In its own file because `radar-view.test.tsx` is touched by three other lanes
 * this week. What is asserted here is the **mechanism**: that both controls
 * exist inside the one form that searches, that they carry the value the URL
 * carries, and that the arrangement asks *this column* for its width rather
 * than the window.
 *
 * It cannot assert the arrangement works. `environment: 'node'` has no boxes
 * (CLAUDE.md §4c), so a grid that draws four 150px columns inside a 720px
 * content box passes every string assertion below.
 * `e2e/journeys/radar-filters.spec.ts` is what measures.
 */

const copy = messages.radar
const filters = copy.list.filters

const COMPANY: CompanyView = {
  cnpj: '51885242000140',
  legalName: 'PAPELARIA CENTRAL LTDA',
  tradeName: 'Papelaria Central',
  mainCnae: '4761003',
  size: 'ME',
  isMei: false,
  state: 'SP',
  city: 'Campinas',
  segments: [
    {
      segment: 'Gráfico / Escritório',
      fit: 'compatible',
      fromMainCnae: true,
      fromSecondaryCnae: false,
    },
  ],
}

const TENDER: TenderCard = {
  id: '51885242000140-1-000744/2026',
  object: 'Registro de preços de baterias e pilhas',
  shortTitle: null,
  agencyName: 'Prefeitura de Campinas',
  city: 'Campinas',
  state: 'SP',
  modalityName: 'Pregão - Eletrônico',
  proposalsCloseAt: '2026-09-30T11:30:00.000Z',
  estimatedValue: '48196.00',
  confidentialBudget: false,
  priceRegistration: true,
  meEppSummary: 'exclusive',
  favoredTreatment: true,
  itemCount: 7,
  segments: ['Gráfico / Escritório'],
  matchedSegments: [COMPANY.segments[0]],
  status: 'Divulgada no PNCP',
  pncpUpdatedAt: '2026-09-16T10:00:00.000Z',
  group: 'compatible',
}

function render(query: Partial<RadarViewProps['query']> = {}): string {
  const props: RadarViewProps = {
    query: { cnpj: COMPANY.cnpj, state: 'SP', q: null, group: 'compatible', ...query },
    status: { kind: 'ready' },
    company: COMPANY,
    visitor: null,
    counts: { compatible: 12, check: 7, keyword: 3 },
    tenders: [TENDER],
    freshness: { state: 'fresh', updatedAt: '2026-09-17T14:48:00.000Z', ageSeconds: 720 },
    now: new Date('2026-09-17T15:00:00.000Z'),
  }
  return renderToStaticMarkup(<RadarView {...props} />)
}

/** The one `<form>` on the screen, so "inside the search" is a real claim. */
function form(markup: string): string {
  const open = markup.indexOf('<form')
  const close = markup.indexOf('</form>')
  expect(open, 'the Radar draws a GET form').toBeGreaterThan(-1)
  expect(close).toBeGreaterThan(open)
  return markup.slice(open, close)
}

const FILE = readFileSync(new URL('./radar-view.tsx', import.meta.url), 'utf8')

/**
 * The file with every comment removed.
 *
 * Required, not tidiness: the docblock above the list grid *quotes* the
 * viewport queries D30 replaced — `min-[900px]:` and `lg:block` — so a scan of
 * the raw file finds them and reports a defect that is only a sentence about
 * one. CLAUDE.md §4b names the inverse mistake in the same breath: a grep that
 * found its word inside a comment and read as confirmation.
 */
const SOURCE = FILE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

describe('both filters are in the form that searches', () => {
  it('draws a modalidade select with the three measured values', () => {
    const fields = form(render())
    expect(fields).toContain(`name="${MODALITY_PARAM}"`)
    expect(fields).toContain(filters.modality)
    expect(fields).toContain(filters.modalityAll)
    for (const name of Object.values(MODALITY_NAMES)) expect(fields).toContain(name)
    // Exactly the options the vocabulary defines, and no fourth one.
    for (const option of MODALITY_OPTIONS) expect(fields).toContain(`value="${option.value}"`)
  })

  it('draws an ME/EPP select whose words are the card tag’s own', () => {
    const fields = form(render())
    expect(fields).toContain(`name="${ME_EPP_PARAM}"`)
    expect(fields).toContain(filters.meEpp)
    expect(fields).toContain(filters.meEppAll)
    for (const option of ME_EPP_OPTIONS) expect(fields).toContain(option.label)
    // The agreement that matters: the option and the tag are one string, so a
    // card marked *Exclusivo ME/EPP* is exactly a card this option keeps.
    expect(filters.meEppExclusive).toBe(copy.tags.exclusive)
  })

  it('selects what the URL asked for, so a shared address shows its own filters', () => {
    const fields = form(render({ modality: 'dispensa', meEpp: 'exclusive' }))
    // `defaultValue` on a server-rendered `<select>` becomes `selected`.
    expect(fields).toContain('<option value="dispensa" selected="">')
    expect(fields).toContain('<option value="exclusive" selected="">')
  })

  it('selects *Todas* when the URL carries no filter', () => {
    const fields = form(render())
    // The empty option is the selected one on both selects — two of them.
    expect(fields.match(/<option value="" selected="">/g)?.length).toBe(2)
    expect(fields).not.toContain('<option value="dispensa" selected="">')
  })

  it('keeps every control in one form, with the submit that applies them', () => {
    const fields = form(render())
    for (const name of ['cnpj', 'uf', MODALITY_PARAM, ME_EPP_PARAM, 'q']) {
      expect(fields).toContain(`name="${name}"`)
    }
    expect(fields).toContain(copy.list.apply)
    // …and the form is a real GET to `/radar`, so the filters work with no
    // JavaScript at all — the same property the three old controls had.
    expect(fields).toContain('action="/radar"')
    expect(fields).toContain('method="get"')
  })
})

describe('the arrangement asks this column, not the window', () => {
  it('wraps the form in a container', () => {
    // The wrapper sits immediately around the `<form>`, and the rendered
    // markup says so too — `@container` on the `px-gutter` div would also pass
    // a source grep and would capture a fixed descendant (`sheet.tsx`).
    // Immediately around the `<form>`, inside the `<details>`: asserted on the
    // rendered markup, not on a source grep, because `@container` one element
    // up on the `px-gutter` div would change no width, pass any grep, and
    // silently capture a `position: fixed` descendant (`sheet.tsx` says why).
    expect(render()).toContain('</summary><div class="@container"><form')
  })

  it('uses container queries for the two thresholds', () => {
    expect(SOURCE).toContain('@min-[560px]:grid-cols-2 @min-[880px]:grid-cols-4')
    expect(SOURCE).toContain('@min-[560px]:col-span-2 @min-[880px]:col-span-3')
  })

  /**
   * Both spellings, because the sweep that fixed D29 and D30 searched only one
   * of them and `md:` inside the app shell is D32. Nothing in this file may ask
   * the **window** about a width above 720px: `main` is
   * `min(viewport − rail, 1120) − 2×20`, and the rail is 264px the window
   * cannot see.
   */
  it('has no viewport breakpoint above 720px anywhere in the file', () => {
    const viewport = [...SOURCE.matchAll(/(^|[^@\w[])min-\[(\d+)px\]:/g)].map((match) =>
      Number(match[2]),
    )
    expect(viewport.length, 'the old 560px queries are still here').toBeGreaterThan(0)
    for (const width of viewport) expect(width).toBeLessThanOrEqual(720)
    // Tailwind's named viewport breakpoints are 768px and up: `md:` is 768,
    // which is 48px past the content box at the moment the rail appears.
    expect(SOURCE).not.toMatch(/(^|[^@\w-])(md|lg|xl|2xl):/m)
  })
})
