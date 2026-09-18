import { createHash } from 'node:crypto'

/**
 * The CNPJ: normalising it, checking it, and referring to it in a log line
 * without writing it down.
 *
 * It lived in `lib/founders/input.ts` first, because the founders form was the
 * only thing that took one. The Radar takes one on every search (§8
 * `POST /api/radar/cnpj`) and has to build the worker's `company_lookup` job
 * key from it, so the two implementations would have had to agree for ever.
 * One implementation instead: `founders/input.ts` re-exports `normaliseCnpj`
 * from here and its behaviour is unchanged.
 *
 * **Nothing here may be logged.** A CNPJ identifies a business, and for the
 * MEIs this product is built for that business is one person: §12 puts it in
 * the same bucket as a CPF or an e-mail. `cnpjRef()` is what goes in a log.
 */

/** Digits only, so `12.345.678/0001-95` and `12345678000195` are one value. */
function digits(value: string): string {
  return value.replace(/\D+/g, '')
}

/**
 * 14 digits and two valid mod-11 check digits, or `null`.
 *
 * The check digits matter beyond politeness: a typo that reaches
 * `company_lookup` spends a BrasilAPI request and writes a `lookup:not_found`
 * row that blames the API for the user's typing (`worker/licitaqui/company.py`
 * makes the same check for the same reason).
 */
export function normaliseCnpj(raw: string): string | null {
  const value = digits(raw)
  if (value.length !== 14) return null
  // 00000000000000 and friends satisfy mod-11 but are not CNPJs.
  if (/^(\d)\1{13}$/.test(value)) return null

  const checkDigit = (slice: string): number => {
    let weight = slice.length - 7
    let sum = 0
    for (let i = 0; i < slice.length; i += 1) {
      sum += Number(slice[i]) * weight
      weight -= 1
      if (weight < 2) weight = 9
    }
    const rest = sum % 11
    return rest < 2 ? 0 : 11 - rest
  }

  if (checkDigit(value.slice(0, 12)) !== Number(value[12])) return null
  if (checkDigit(value.slice(0, 13)) !== Number(value[13])) return null
  return value
}

/**
 * A log-safe handle for a CNPJ, and the second half of the worker's
 * `company_lookup` de-duplication key.
 *
 * It must stay byte-for-byte what `licitaqui.company.cnpj_ref` produces —
 * `sha256(cnpj)[:16]` over the 14 ASCII digits — because the web enqueues the
 * job and the worker looks for its own key. A different digest here would put
 * two live jobs on the queue for one CNPJ and defeat the `jobs_dedupe` index.
 */
export function cnpjRef(cnpj: string): string {
  return createHash('sha256').update(cnpj, 'ascii').digest('hex').slice(0, 16)
}

/** `12.345.678/0001-95` — display only, never a database or job value. */
export function formatCnpj(cnpj: string): string {
  return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
}
