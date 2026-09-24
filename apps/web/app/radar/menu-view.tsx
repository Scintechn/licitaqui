import Link from 'next/link'
import { Button, Icon, Logo, SectionLabel, type IconName } from '@/components'
import type { AccountSummary } from '@/lib/account/summary'
import { cn } from '@/lib/cn'
import { format, messages } from '@/lib/messages'
import { ACCOUNT_PATH, accountHref, PLAN_HREF } from '@/lib/routes'

/**
 * Canvas 09 — `docs/design/wireframes/Menu.dc.html` — finally rendered.
 *
 * The canvas was drawn with the rest of the design set and never carded (D5):
 * `grep -in "menu" docs/DEVELOPMENT_PLAN.md` returned nothing, `AppBar` had no
 * drawer, and `radar.nav.menu` — "Abrir menu" — sat approved in the catalogue
 * with nothing rendering it. The consequence was not cosmetic: a signed-in
 * person could not see, from any screen they actually use, what plan they were
 * on, how many triagens were left, how many alerts they get, or that they were
 * signed in at all. That lived only on `/conta`, which nothing linked to but a
 * bare person icon.
 *
 * Pure and prop-driven, like every other view here, so it renders under
 * `renderToStaticMarkup` in the node test environment. The drawer behaviour
 * (focus, Escape, scroll lock) is `components/sheet.tsx`'s, and the fetching
 * is the screen's.
 *
 * ## The strip renders for a visitor too
 *
 * A menu that goes blank for the people most likely to open it would
 * reproduce the gap it was written to close. With no account the strip says
 * what a visitor has — 2 triagens, no alerts — and offers the account instead
 * of the upgrade.
 *
 * ## The numbers come from `plan_limits`, never from a literal
 *
 * Including the uncomfortable one: `plan_limits` holds an `alert` row for
 * `basico` alone, so a paid plan answers zero alerts here. That is true, it is
 * what `/fundadores` contradicts, and card D6 is where it gets fixed. This
 * screen's job is to report it.
 */

const copy = messages.radar.menu
const account = messages.account.screen

/** Plans that already include everything the upgrade link would sell. */
const PAID_PLANS = new Set(['promocional', 'essencial', 'pro'])

type Item = { href: string; icon: IconName; label: string }

const MAIN: Item[] = [
  { href: '/radar', icon: 'search', label: copy.radar },
  { href: '/conta/alertas', icon: 'alert', label: copy.alerts },
  { href: '/conta', icon: 'company', label: copy.company },
  { href: '/conta', icon: 'money', label: copy.billing },
]

/**
 * `/ajuda` is **not built**. `lib/routes.ts` spends a paragraph on exactly
 * this: Next prefetches a `<Link>` on viewport entry, so an unbuilt
 * destination is "a burst of 404s on every page view" — and this menu renders
 * six links at once. The row is out until the route exists; `copy.help` stays
 * in the catalogue for the day it does.
 *
 * `Perfil` goes to `ACCOUNT_PATH` (`/conta`), not `ACCOUNT_HREF`
 * (`/conta/criar`). The strip above it only renders for a signed-in viewer,
 * so the sign-up screen is the one page that item can never mean.
 */
const ACCOUNT: Item[] = [{ href: ACCOUNT_PATH, icon: 'account', label: copy.profile }]

/**
 * `plan_limits` and `users.plan` spell the plans in Portuguese ids; the
 * catalogue keys them in English. One map, here, rather than a lookup that
 * silently falls back to printing the raw id at a person.
 */
const PLAN_COPY: Record<string, string> = {
  basico: messages.plans.basic.name,
  promocional: messages.plans.promo.name,
  essencial: messages.plans.essential.name,
  pro: messages.plans.pro.name,
}

function planLabel(plan: string): string {
  return PLAN_COPY[plan] ?? copy.planVisitor
}

/** "3 de 5 triagens usadas no mês", from the same strings `/conta` uses. */
function screeningsLine(summary: AccountSummary): string {
  const { limit, used, period } = summary.screenings
  if (limit === null) return account.screeningsUnlimited
  if (limit === 0) return account.screeningsNone
  const template = period === 'month' ? account.screeningsMonth : account.screeningsTotal
  return format(template, { usadas: used, total: limit })
}

export function MenuView({
  summary,
  current,
  onDismiss,
  titleId,
}: {
  /** `null` while the strip is still loading — the links work regardless. */
  summary: AccountSummary | null
  /** Which item to mark as the page you are on. */
  current?: string
  onDismiss: () => void
  titleId: string
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex min-h-[60px] items-center gap-3 py-2 pr-3 pl-gutter">
        <Link href="/radar" aria-label={messages.radar.nav.home} className="inline-flex grow">
          <Logo />
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={messages.common.close}
          className={
            'inline-flex size-touch items-center justify-center rounded-pill border-0 ' +
            'bg-transparent text-ink transition-colors hover:bg-fill-muted'
          }
        >
          <Icon name="close" size={22} />
        </button>
      </div>

      {/* The a11y name of the dialog. Visually hidden: the canvas has no
          visible "Menu" heading, and inventing one to satisfy a rule would
          change the design rather than describe it. */}
      <h2 id={titleId} className="sr-only">
        {copy.title}
      </h2>

      <nav className="flex grow flex-col gap-1 px-3 py-2">
        <Section label={copy.sectionMain} items={MAIN} current={current} />
        <Section label={copy.sectionAccount} items={ACCOUNT} current={current} />
      </nav>

      <div className="px-3 pb-4">
        <PlanStrip summary={summary} />
      </div>
    </div>
  )
}

function Section({ label, items, current }: { label: string; items: Item[]; current?: string }) {
  return (
    <>
      <div className="px-3 pt-3 pb-1">
        <SectionLabel tone="muted">{label}</SectionLabel>
      </div>
      {items.map((item) => {
        const here = current === item.href
        return (
          <Link
            key={`${item.href}-${item.label}`}
            href={item.href}
            aria-current={here ? 'page' : undefined}
            className={cn(
              'flex min-h-touch items-center gap-3 rounded-card px-3 text-body no-underline',
              'transition-colors hover:bg-fill-muted',
              here ? 'bg-blue-soft font-semibold text-ink' : 'text-ink',
            )}
          >
            <Icon name={item.icon} size={20} className="shrink-0 text-muted" />
            {item.label}
          </Link>
        )
      })}
    </>
  )
}

function PlanStrip({ summary }: { summary: AccountSummary | null }) {
  if (summary === null) {
    return (
      <div className="rounded-card border border-line bg-surface p-3.5">
        <div className="text-meta text-muted">{messages.common.loading}</div>
      </div>
    )
  }

  const { limit, used } = summary.screenings
  const pct = limit === null || limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100))
  const planName = summary.signedIn ? planLabel(summary.plan) : copy.planVisitor

  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3.5">
      <div className="text-body font-semibold text-ink">{planName}</div>
      <div className="text-meta text-muted">
        {screeningsLine(summary)} ·{' '}
        {format(copy.alertsWeekly, { count: summary.alerts.limit ?? 0 })}
      </div>
      {limit === null || limit === 0 ? null : (
        <div
          className="h-1.5 w-full overflow-hidden rounded-pill bg-fill-muted"
          role="progressbar"
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-label={account.screeningsLabel}
        >
          <div className="h-full rounded-pill bg-blue" style={{ width: `${pct}%` }} />
        </div>
      )}
      {/* `PLAN_HREF`, not `/conta`. `lib/routes.ts` defines it as `/fundadores`
          precisely because billing does not open until M5 and "during
          founders week the honest upgrade path is the offer itself" — every
          "assinar" control must read that constant so F2 moves them all in
          one edit. This one was hard-coded to the account page.

          And the label switches on the **plan**, not on `signedIn`: a founder
          on `promocional` has Essencial's entitlements already
          (`0002_plan_limits.sql`), so inviting them to "conhecer o Essencial"
          is selling somebody what they bought this morning. */}
      <Button
        variant="link"
        href={summary.signedIn ? PLAN_HREF : accountHref('/radar')}
        className="px-0"
        iconEnd="arrowRight"
      >
        {!summary.signedIn ? copy.signIn : PAID_PLANS.has(summary.plan) ? account.plans : copy.upgrade}
      </Button>
    </div>
  )
}
