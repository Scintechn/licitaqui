import type { Metadata } from 'next'
import { readDraft } from '@/lib/profile/draft'
import { readAccountData } from '../account-data'
import { saveProfile } from './actions'
import { ProfileView } from './profile-view'

export const metadata: Metadata = {
  title: 'Complete seu cadastro · LicitaQui',
  // `noindex`: a signed-in form, and there is nothing here for a crawler.
  robots: { index: false, follow: false },
}

/**
 * `/conta/perfil` — the profile gate before the checkout (task **F31**).
 *
 * `readAccountData` does the session check and the redirect for all the
 * account screens (D22), so this page has neither.
 *
 * The fields are **pre-filled** — from the draft cookie if the last attempt
 * was rejected, otherwise from the account — which makes this the edit form as
 * well as the gate: somebody sent here by `goToCheckout` with a CNPJ already
 * saved only has to add their name and mobile.
 *
 * **Being the edit form required a link, which it did not have.** It was
 * reachable from one place, the plan screen's no-checkout branch, and that
 * block disappears the moment `canBill` is true — so a subscriber who mistyped
 * their mobile could never get back here. `/conta` now links it
 * (`account.profile.editAction`). Found by review, after this comment had
 * already claimed the screen was an edit form.
 */
export default async function ProfilePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const account = await readAccountData()
  const search = (await searchParams) ?? {}
  // What was typed, if the last attempt was rejected. Falls back to the
  // account, so a first visit is pre-filled and a correction keeps the input.
  const draft = await readDraft()

  /*
   * `?erro=nome,celular`. Split and filtered against the three field names we
   * render, so a crafted `?erro=<script>` cannot reach the view — it is read
   * by `errors.includes(...)` only, but the allow-list is one line and means
   * the query string can never decide what is rendered, only which of three
   * approved sentences shows.
   */
  const raw = Array.isArray(search.erro) ? search.erro[0] : search.erro
  const errors = String(raw ?? '')
    .split(',')
    .filter((field) => ['nome', 'nascimento', 'celular', 'cnpj'].includes(field))

  return (
    <ProfileView
      action={saveProfile}
      values={{
        name: draft?.name ?? account.userName,
        birthDate: draft?.birthDate ?? account.birthDate,
        mobile: draft?.mobile ?? account.whatsapp,
        cnpj: draft?.cnpj ?? account.cnpj,
      }}
      errors={errors}
      plan={account.plan}
      planName={account.planName}
    />
  )
}
