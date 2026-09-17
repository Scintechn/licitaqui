import ptBR from '@/messages/pt-BR.json'

/**
 * The single Brazilian Portuguese message catalogue (CLAUDE.md: keys in
 * English, values in pt-BR). It is imported, not fetched: the product ships one
 * locale, so the strings belong in the bundle and public pages stay static.
 *
 * There is no i18n runtime yet on purpose — adding `next-intl` before there is
 * a second locale would buy nothing. When one arrives, this module is the seam.
 */
export const messages = ptBR

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
