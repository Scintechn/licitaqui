import type { Metadata } from 'next'
import { listFavourites } from '@/lib/favourites/store'
import { readCompany, segmentsByFit } from '@/lib/radar/company'
import { messages } from '@/lib/messages'
import { readAccountData } from '../account-data'
import { FavouritesView } from './favourites-view'

/**
 * `/conta/favoritos` — card **D23**.
 *
 * Dynamic, never cached, never indexed: it is a list of one person's marks
 * (§3.3). The session check and the redirects are `readAccountData`'s, which
 * is why this page has none of its own to forget.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: messages.account.meta.title,
  description: messages.account.meta.description,
  robots: { index: false, follow: false },
}

export default async function FavouritesPage() {
  const account = await readAccountData()

  /**
   * The compatibility badge comes from **the account's own CNPJ**, read now —
   * Sci's decision, 2026-09-29.
   *
   * The alternative was storing the group at the moment of marking, which
   * needs no read and goes stale: change the CNPJ, or let the segment map
   * improve, and the badge keeps claiming what was true months ago. A claim
   * about the past rendered as a claim about now is the defect this repo
   * keeps finding.
   *
   * No CNPJ on the account means no segments, so every card reads `keyword` —
   * which is honest: it is here because they put it here.
   */
  const company = account.cnpj ? await readCompany(account.cnpj) : null
  const fits = company?.data.company.segments ?? []
  const { compatible, check } = segmentsByFit(fits)

  return (
    <FavouritesView
      plan={account.plan}
      planName={account.planName}
      favourites={await listFavourites(account.userId, { compatible, check, fits })}
    />
  )
}
