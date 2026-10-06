import type { SelectOption } from '@/components'
import { messages } from '@/lib/messages'

/**
 * The Radar's two structured filters (D52): **modalidade** and **ME/EPP**.
 *
 * The vocabulary only — no SQL. `lib/radar/tenders.ts` turns these values into
 * the two conditions inside `scope()`, and this file is imported by the client
 * bundle (the filter form) as well as by the route, so it must not pull drizzle
 * in with it.
 *
 * ## Modalidade: filtered on the **code**, labelled with the name
 *
 * `modality_name` is free text PNCP sends, and it arrives from **two different
 * endpoints under two different field names** — `modalidadeNome` on the detail
 * API and `modalidade_licitacao_nome` on the search sweep's poorer record
 * (`worker/licitaqui/tenders.py`), each stored verbatim. An equality on that
 * column is a bet that PNCP spells the same three words the same way on both,
 * forever: one missing hyphen and the option returns **nothing** while the Radar
 * tells the reader nothing is open, which is `memory:
 * empty-result-is-not-absence` on the product's main screen.
 *
 * `tenders.modality_id` is PNCP's own code and has been there since migration
 * 0001. Measured on Neon `main` 2026-10-06: **0 of 57 878 rows** have a null
 * `modality_id`, and each of the three ids carries exactly one distinct name. So
 * the filter matches the code and the control shows the name — the value we do
 * not own is used for the label, where being wrong is cosmetic, and never for
 * the predicate, where being wrong is an empty screen.
 *
 * Measured on Neon `main` on 2026-10-06, over the 24 340 tenders whose
 * `proposals_close_at > now()`: id **6** `Pregão - Eletrônico` **17 018**, id
 * **4** `Concorrência - Eletrônica` **3 980**, id **8** `Dispensa` **3 342** —
 * and over all 57 878 rows in the table, those same three pairs and nothing
 * else. Three options is a `Select`, not a faceted search.
 *
 * They are **hardcoded here rather than read from the data**, for two reasons:
 * a `select distinct modality_name` would cost a query to draw a control, and
 * its options would then change with the UF and the keyword — the user would
 * find Dispensa missing from the list because none is open in Acre this
 * afternoon, which is a filter that lies about what exists. The strings
 * themselves are not invented: they are PNCP's own `modalidadeNome`, the same
 * text the tender screen prints on the Modalidade row, so the control and the
 * card say the same words.
 *
 * **Why three and not ten.** The sweep asks PNCP for exactly three modality
 * codes — `DEFAULT_MODALITIES = (6, 8, 4)` in `worker/licitaqui/tenders.py`,
 * Pregão Eletrônico / Dispensa / Concorrência Eletrônica — and a job payload
 * can override that tuple, while `_MODALITY_NAMES` in the same file already
 * knows ten. So a fourth modality is one payload away from arriving, and this
 * list will not know it.
 *
 * That is survivable **only** because *Todas* adds no condition at all. A
 * `modality_name in (…the three we know…)` default would silently hide every
 * edital of the new modality from every reader on the day the worker started
 * syncing it — and nothing would fail, which is the shape this repository has
 * paid for five times. The rule is therefore: the default is the absence of a
 * predicate, and an unknown modality is always visible under it.
 */
export const MODALITY_SLUGS = ['pregao-eletronico', 'concorrencia-eletronica', 'dispensa'] as const

export type ModalityFilter = (typeof MODALITY_SLUGS)[number]

/**
 * Slug → PNCP's modality code, which is what the filter matches.
 *
 * The same three numbers as `DEFAULT_MODALITIES` in
 * `worker/licitaqui/tenders.py`, which is the tuple the sweep asks PNCP for —
 * so this list and the set of modalities we actually hold have one source
 * between them, in two files that cite each other.
 *
 * Typed as a total `Record`, so a slug added to the tuple above without a code
 * here is a type error rather than a filter that matches nothing.
 */
export const MODALITY_CODES: Record<ModalityFilter, number> = {
  'pregao-eletronico': 6,
  'concorrencia-eletronica': 4,
  dispensa: 8,
}

/**
 * Slug → the `modality_name` the three codes carry today, **for the label only**.
 *
 * The slug is what travels in the URL, so `?modality=` stays readable,
 * accent-free and enumerable by Zod. The string on the right is never matched
 * against anything: it is what the option says, chosen so the control and the
 * tender screen — which prints this same column — use one wording.
 */
export const MODALITY_NAMES: Record<ModalityFilter, string> = {
  'pregao-eletronico': 'Pregão - Eletrônico',
  'concorrencia-eletronica': 'Concorrência - Eletrônica',
  dispensa: 'Dispensa',
}

/**
 * ME/EPP, filtered on **`tenders.me_epp_summary`** — the same column the card's
 * own tag renders (`radar.tags.*`), so the list and the card can never disagree
 * about why an edital is in it.
 *
 * Same measurement, same 24 340 open tenders: `none` 15 662, `exclusive`
 * 4 293, `mixed` 1 791, `quota` 489, and **2 105 where PNCP is silent**
 * (`me_epp_summary is null`).
 *
 * Two options, and the second one owns the silence: *Não exclusivo* is
 * `me_epp_summary is distinct from 'exclusive'`, which includes the null rows,
 * because **"we do not know" is not "exclusive"**. The alternative — treating
 * silence as a third state the reader has to ask for — would put 2 105 open
 * editais in a bucket nobody selects.
 */
export const ME_EPP_FILTERS = ['exclusive', 'other'] as const

export type MeEppFilter = (typeof ME_EPP_FILTERS)[number]

/** `pregao-eletronico` when the query string carries a known slug, else `null`. */
export function readModality(value: string | null | undefined): ModalityFilter | null {
  if (!value) return null
  const slug = value.trim().toLowerCase()
  return (MODALITY_SLUGS as readonly string[]).includes(slug) ? (slug as ModalityFilter) : null
}

/** `exclusive` | `other` when the query string carries one, else `null`. */
export function readMeEpp(value: string | null | undefined): MeEppFilter | null {
  if (!value) return null
  const choice = value.trim().toLowerCase()
  return (ME_EPP_FILTERS as readonly string[]).includes(choice) ? (choice as MeEppFilter) : null
}

const copy = messages.radar.list.filters

/**
 * The options, in the shape `Select` takes, with the empty value first — the
 * same construction `UF_OPTIONS` uses for "Todo o Brasil", so the three
 * controls behave identically.
 *
 * The modality labels are `MODALITY_NAMES`, not catalogue strings: PNCP's words
 * are already on the tender screen, and a second spelling in `pt-BR.json`
 * would be one more pair of strings that have to agree and eventually will
 * not. Only *Todas* and the field's own label are ours. If PNCP re-words one of
 * the three, this label goes stale and **the filter keeps working**, because it
 * matches `MODALITY_CODES`.
 */
export const MODALITY_OPTIONS: SelectOption[] = [
  { value: '', label: copy.modalityAll },
  ...MODALITY_SLUGS.map((slug) => ({ value: slug, label: MODALITY_NAMES[slug] })),
]

export const ME_EPP_OPTIONS: SelectOption[] = [
  { value: '', label: copy.meEppAll },
  { value: 'exclusive', label: copy.meEppExclusive },
  { value: 'other', label: copy.meEppOther },
]
