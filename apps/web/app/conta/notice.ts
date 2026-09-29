import type { AccountNotice } from './account-view'

/**
 * `?estado=` → the banner an account screen shows after an action.
 *
 * Shared because `/conta` and `/conta/empresa` both redirect back with it, and
 * two copies of a string comparison is two places to add a third state to.
 */
export type Search = Promise<{ [key: string]: string | string[] | undefined }>

export function noticeFrom(value: string | string[] | undefined): AccountNotice {
  const one = Array.isArray(value) ? value[0] : value
  if (one === 'empresa') return 'company'
  if (one === 'cnpj-invalido') return 'cnpj-invalid'
  return null
}
