import type { SelectOption } from '@/components'
import { messages } from '@/lib/messages'

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
 */

const NAMES = messages.radar.ufNames

export const UF_CODES = Object.keys(NAMES) as Array<keyof typeof NAMES>

export const UF_OPTIONS: SelectOption[] = [
  { value: '', label: messages.radar.ufAll },
  ...UF_CODES.map((code) => ({ value: code, label: `${NAMES[code]} (${code})` })).sort((a, b) =>
    a.label.localeCompare(b.label, 'pt-BR'),
  ),
]

/** `SP` when the query string carries a real UF, `null` for anything else. */
export function normaliseUf(value: string | null | undefined): string | null {
  if (!value) return null
  const code = value.trim().toUpperCase()
  return (UF_CODES as string[]).includes(code) ? code : null
}
