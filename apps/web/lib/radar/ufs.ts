import type { SelectOption } from '@/components'
import { format, messages } from '@/lib/messages'

/**
 * The 27 federative units, plus "Todo o Brasil" as the empty value.
 *
 * The board's canvas 01 shows a two-option select ("São Paulo (SP)", "Todo o
 * Brasil") because a wireframe does not list 27 states; the product has to.
 * The names come from the catalogue — they are the only Portuguese here — and
 * the codes are the two-letter values `GET /api/radar/tenders?state=` accepts.
 *
 * Sorted by name in pt-BR, so "Espírito Santo" lands where a Brazilian reader
 * expects rather than where a byte comparison would put it.
 *
 * ## More than one UF (2026-10-09)
 *
 * A supplier who delivers to SP, RJ and MG had to choose between one of them
 * and the whole country. A selection is now a **list of codes**, and the empty
 * list is "Todo o Brasil" — there is no separate "all" value to keep in step.
 * Every list that leaves this module is `canonicalUfs`: deduplicated and in the
 * one order below, so the same choice is the same URL, the same cache key and
 * the same SQL however it was ticked.
 */

const NAMES = messages.radar.ufNames

export type Uf = keyof typeof NAMES

export const UF_CODES = Object.keys(NAMES) as Uf[]

/** By name in pt-BR — the order the picker lists them and the summary names them. */
const BY_NAME: Uf[] = [...UF_CODES].sort((a, b) => NAMES[a].localeCompare(NAMES[b], 'pt-BR'))
const RANK = new Map<string, number>(BY_NAME.map((code, index) => [code, index]))

export const UF_OPTIONS: SelectOption[] = [
  { value: '', label: messages.radar.ufAll },
  ...BY_NAME.map((code) => ({ value: code, label: ufLabel(code) })),
]

/** "São Paulo (SP)" — the picker's line and the one-UF summary. */
export function ufLabel(code: Uf): string {
  return format(messages.radar.ufOne, { nome: NAMES[code], uf: code })
}

/**
 * IBGE's five regions. Each one ticks all of its UFs at once in the picker,
 * and a selection that is exactly one region is summarised by its name.
 */
export const UF_REGIONS = [
  { id: 'N', ufs: ['AC', 'AM', 'AP', 'PA', 'RO', 'RR', 'TO'] },
  { id: 'NE', ufs: ['AL', 'BA', 'CE', 'MA', 'PB', 'PE', 'PI', 'RN', 'SE'] },
  { id: 'CO', ufs: ['DF', 'GO', 'MS', 'MT'] },
  { id: 'SE', ufs: ['ES', 'MG', 'RJ', 'SP'] },
  { id: 'S', ufs: ['PR', 'RS', 'SC'] },
] as const satisfies ReadonlyArray<{ id: keyof typeof messages.radar.ufRegions; ufs: readonly Uf[] }>

export type UfRegion = (typeof UF_REGIONS)[number]

export function regionName(region: UfRegion): string {
  return messages.radar.ufRegions[region.id]
}

/** `SP` when the query string carries a real UF, `null` for anything else. */
export function normaliseUf(value: string | null | undefined): string | null {
  if (!value) return null
  const code = value.trim().toUpperCase()
  return RANK.has(code) ? code : null
}

/**
 * Any number of raw values → the canonical list. Each value may itself be a
 * comma-separated list, so `?uf=SP,RJ` and `?uf=SP&uf=RJ` are the same search;
 * anything that is not a UF is dropped rather than failing the whole search.
 * **All 27 is the empty list**: ticking every box is "Todo o Brasil", and
 * spelling it out would put 27 parameters in a URL that means the same as none.
 */
export function canonicalUfs(values: Iterable<string | null | undefined>): string[] {
  const found = new Set<string>()
  for (const value of values) {
    for (const part of (value ?? '').split(',')) {
      const code = normaliseUf(part)
      if (code) found.add(code)
    }
  }
  if (found.size === UF_CODES.length) return []
  return [...found].sort((a, b) => (RANK.get(a) ?? 0) - (RANK.get(b) ?? 0))
}

/** The `uf` parameters of a query string, read the one way. */
export function readUfs(params: { getAll(name: string): string[] }, name = 'uf'): string[] {
  return canonicalUfs(params.getAll(name))
}

/**
 * What the picker's button and the Radar header say about a selection
 * (approved by Sci 2026-10-09):
 *
 * | selection | text |
 * |---|---|
 * | none | Todo o Brasil |
 * | one | São Paulo (SP) |
 * | exactly one whole region | Sudeste |
 * | two or three | MG, RJ e SP |
 * | four or more | MG, RJ, SP e mais 2 |
 */
export function ufSummary(states: readonly string[]): string {
  const list = canonicalUfs(states)
  if (list.length === 0) return messages.radar.ufAll
  if (list.length === 1) return ufLabel(list[0] as Uf)
  const region = UF_REGIONS.find(
    (candidate) =>
      candidate.ufs.length === list.length &&
      candidate.ufs.every((code) => list.includes(code)),
  )
  if (region) return regionName(region)
  if (list.length <= 3) {
    return format(messages.radar.ufFew, {
      inicio: list.slice(0, -1).join(', '),
      ultimo: list[list.length - 1] ?? '',
    })
  }
  return format(messages.radar.ufMany, { lista: list.slice(0, 3).join(', '), n: list.length - 3 })
}
