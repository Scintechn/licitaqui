import ptBR from '@/messages/pt-BR.json'
import { brl, brlExact, FOUNDERS, NOTICE, PLAN_PRICES, PROMO } from './product'

/**
 * **Product facts, substituted into the catalogue once at load.**
 *
 * `{$vagas}` is not `{count}`. The `$` marks a value resolved *here*, before
 * any component sees the string, and the distinction is load-bearing: most
 * copy is rendered straight (`{messages.plans.essential.price}`) with no call
 * to {@link format} at all, so a price written as an ordinary `{preco}`
 * argument would reach the screen as the literal text `{preco}`.
 *
 * Resolving at load means every existing render site keeps working untouched,
 * and the catalogue stops repeating a number that lives in
 * `docs/product.json`. `"48 vagas"` written by hand in ten strings is how
 * D11b, D7 and D6 each happened.
 */
const PRODUCT_FACTS: Readonly<Record<string, string>> = Object.freeze({
  // The contractual total (terms §6), not how many are open today. How
  // many remain is a live number from `/api/founders/seats`, which reads
  // the cap out of `app_settings`.
  // **The rule, written where the guard can reach it:** the CONTRACT
  // declares the ceiling and the mechanism (25 seats, two lots); the PAGE
  // declares the current state (17 open). They crossed on 2026-09-27 —
  // the badge said 25 while the counter said 17, so the 18th person would
  // have read "25 vagas" and been waitlisted without warning.
  //
  // `{$vagas}` is the ceiling, for copy describing the offer.
  // `{$vagasAbertas}` is what is open, for copy describing today.
  vagas: String(FOUNDERS.seatsTotal),
  vagasAbertas: String(FOUNDERS.seatsOpenDefault),
  precoBasico: brl(PLAN_PRICES.basico),
  precoPromocional: brl(PLAN_PRICES.promocional),
  precoEssencial: brl(PLAN_PRICES.essencial),
  precoPro: brl(PLAN_PRICES.pro),
  // The `R$ 26,00` form the billing screens and receipts use. Missed by
  // the first binding pass, and the guard caught it — which is the only
  // reason it is not still sitting in the catalogue saying R$ 26,00.
  precoPromocionalExato: brlExact(PLAN_PRICES.promocional),
  precoEssencialExato: brlExact(PLAN_PRICES.essencial),
  mesesPromocionais: String(PROMO.months),
  // Derived, never stored: the month the new price starts is always the
  // one after the promo ends, and two numbers that must agree are two
  // numbers that eventually do not.
  mesPosPromo: `${PROMO.months + 1}º`,
  diasAvisoPreco: String(NOTICE.priceChangeDays),
  /** `2026-10-08` → `08/10`, the form Brazilian copy uses. */
  aberturaData: FOUNDERS.opensOn.split('-').slice(1).reverse().join('/'),
})

/** `{$name}` → its value. An unknown name is **left in place**, never dropped. */
function substituteFacts(text: string): string {
  return text.replaceAll(/\{\$(\w+)\}/g, (whole, name: string) => PRODUCT_FACTS[name] ?? whole)
}

function resolveDeep<T>(node: T): T {
  if (typeof node === 'string') return substituteFacts(node) as T
  if (Array.isArray(node)) return node.map(resolveDeep) as T
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, resolveDeep(value)]),
    ) as T
  }
  return node
}

/**
 * The single Brazilian Portuguese message catalogue (CLAUDE.md: keys in
 * English, values in pt-BR). It is imported, not fetched: the product ships one
 * locale, so the strings belong in the bundle and public pages stay static.
 *
 * There is no i18n runtime yet on purpose — adding `next-intl` before there is
 * a second locale would buy nothing. When one arrives, this module is the seam.
 */
export const messages = resolveDeep(ptBR)

export type Messages = typeof ptBR

export type MessageValues = Record<string, string | number>

const plural = new Intl.PluralRules('pt-BR')

/**
 * The slice of ICU MessageFormat the catalogue actually uses:
 *
 *   `{nome}`                                       — a named argument
 *   `{count, plural, =0 {…} one {…} other {…}}`    — a pt-BR plural, `#` = count
 *
 * Anything it does not understand is left in place rather than thrown away, so
 * a typo shows up in the UI as `{typo}` instead of silently disappearing.
 */
export function format(template: string, values: MessageValues = {}): string {
  let out = ''
  let i = 0
  while (i < template.length) {
    if (template[i] !== '{') {
      out += template[i]
      i += 1
      continue
    }
    const end = closingBrace(template, i)
    if (end === -1) {
      out += template[i]
      i += 1
      continue
    }
    out += resolve(template.slice(i + 1, end), values)
    i = end + 1
  }
  return out
}

/** Index of the `}` that closes the `{` at `start`, or -1 when unbalanced. */
function closingBrace(source: string, start: number): number {
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function resolve(body: string, values: MessageValues): string {
  const comma = body.indexOf(',')

  if (comma === -1) {
    const name = body.trim()
    return name in values ? String(values[name]) : `{${body}}`
  }

  const name = body.slice(0, comma).trim()
  const rest = body.slice(comma + 1).trimStart()
  if (!rest.startsWith('plural')) return `{${body}}`

  const count = Number(values[name])
  if (!Number.isFinite(count)) return `{${body}}`

  const options = parseOptions(rest.slice('plural'.length).replace(/^\s*,/, ''))
  const chosen =
    options.get(`=${count}`) ?? options.get(plural.select(count)) ?? options.get('other')
  if (chosen === undefined) return `{${body}}`

  return format(chosen, values).replaceAll('#', String(count))
}

/** Reads `=0 {…} one {…} other {…}` into a map, keeping nested braces intact. */
function parseOptions(source: string): Map<string, string> {
  const options = new Map<string, string>()
  let i = 0
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i += 1
    let key = ''
    while (i < source.length && !/[\s{]/.test(source[i])) {
      key += source[i]
      i += 1
    }
    while (i < source.length && /\s/.test(source[i])) i += 1
    if (source[i] !== '{') break
    const end = closingBrace(source, i)
    if (end === -1) break
    options.set(key, source.slice(i + 1, end))
    i = end + 1
  }
  return options
}
