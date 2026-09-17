type ClassValue = string | number | false | null | undefined

/**
 * Joins class names, dropping anything falsy. Deliberately tiny: we do not need
 * `clsx` + `tailwind-merge` because components expose closed variant props and
 * append `className` last, so the caller's classes already win by source order
 * in the generated stylesheet only when they are more specific — for overrides
 * use a variant, not a competing utility.
 */
export function cn(...values: ClassValue[]): string {
  const out: string[] = []
  for (const value of values) {
    if (!value && value !== 0) continue
    const text = String(value).trim()
    if (text) out.push(text)
  }
  return out.join(' ')
}
