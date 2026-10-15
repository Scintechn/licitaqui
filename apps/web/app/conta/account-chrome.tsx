import { AppBar, Tag } from '@/components'
import { MenuTrigger } from '@/components/menu-trigger'
import { messages } from '@/lib/messages'

/**
 * The frame the three account screens share — card **D22**.
 *
 * ## Why there are three screens now
 *
 * There was one, and the menu offered three doors into it: "Minha empresa",
 * "Plano e pagamento" and "Perfil" all pointed at `/conta`. Tapping *"Plano e
 * pagamento"* landed a reader on a page headed *"Sua conta"*, and the three
 * entries were indistinguishable once you arrived.
 *
 * That also produced the visible bug: `Section` marked the current page by
 * **href**, so all three lit at once the moment D20 put the menu on `/conta`.
 * Giving items an `id` stopped the highlight; it did not stop three labels
 * leading to one room. Sci's decision, 2026-09-29, was to split rather than to
 * collapse the menu — `/conta/plano` is where billing goes when F2 lands, and
 * a menu that stops naming payment just as founders start paying is the worse
 * trade.
 *
 * ## The titles are the menu labels, deliberately
 *
 * `radar.menu.company` and `radar.menu.billing` — already approved, already
 * what the reader tapped. A page whose heading repeats the word that got you
 * there is how navigation stops needing explanation, and it meant this split
 * invented no new user-facing copy at all.
 *
 * Pure and prop-driven, like every view here, so it renders under
 * `renderToStaticMarkup` with no session and no database.
 */
export function AccountChrome({
  plan,
  planName,
  title,
  children,
  hideTitle,
}: {
  /** The raw plan key, for the tag's fallback. */
  plan: string
  /** The display name from `messages.plans`. */
  planName: string
  title: string
  children: React.ReactNode
  /** Hide the title when used in a tabbed dashboard context. */
  hideTitle?: boolean
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar
        actions={
          <>
            <Tag tone="muted">{planName || plan}</Tag>
            {/* **The control these screens never had.** Signed in, on your own
                account, with no way to reach your plan or your triagens —
                which is how D20 was found. `MenuTrigger` renders nothing
                outside a shell, so this stays inert wherever a view is
                rendered on its own. */}
            <MenuTrigger />
          </>
        }
      />
      <main className="mx-auto flex w-full grow flex-col gap-4 px-gutter pt-6 pb-10" style={{ maxWidth: '1400px' }}>
        {!hideTitle && <h1 className="font-display text-[26px] leading-tight font-semibold">{title}</h1>}
        {children}
      </main>
    </div>
  )
}
