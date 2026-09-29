import type { Metadata } from 'next'
import { listFavourites } from '@/lib/favourites/store'
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
  return (
    <FavouritesView
      plan={account.plan}
      planName={account.planName}
      favourites={await listFavourites(account.userId)}
    />
  )
}
