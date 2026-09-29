import { Button, Card, CardRow } from '@/components'
import { format, messages } from '@/lib/messages'
import type { QuotaView } from '@/lib/radar/contract'
import { PLAN_HREF } from '@/lib/routes'
import { AccountChrome } from '../account-chrome'
import { screeningsLabel } from '../account-view'

/**
 * `/conta/plano` — what this plan includes and what is left of it (card
 * **D22**).
 *
 * `PLAN_PATH` has named this address since U1, reserved for **F2**'s checkout
 * and unbuilt until now. That is why the split lands here rather than
 * somewhere new: when billing opens on 10-29 it has a page to open onto, and
 * the menu entry that says "Plano e pagamento" already leads to it.
 *
 * **Every number comes from `plan_limits` and `usage`**, through `quota`.
 * Nothing is written in the markup: the legal brief §5's last bullet is
 * explicit that the limits are configurable without a deploy, so a component
 * printing "5" would be wrong the first time Sci changed a row.
 *
 * The heading is `radar.menu.billing` — the words the reader tapped.
 */

const copy = messages.account.screen

export function PlanView({
  plan,
  planName,
  quota,
  founderSeat,
  seatTotal,
}: {
  plan: string
  planName: string
  quota: QuotaView
  founderSeat: number | null
  /** The offer's size, from `docs/product.json` — never the column's bound. */
  seatTotal: number
}) {
  return (
    <AccountChrome plan={plan} planName={planName} title={messages.radar.menu.billing}>
      <Card padding="none">
        <div className="px-4 py-1">
          <CardRow label={copy.planLabel} value={planName || plan} last={!founderSeat} />
          <CardRow
            label={copy.screeningsLabel}
            value={screeningsLabel(quota)}
            last={!founderSeat}
          />
          {founderSeat ? (
            <CardRow
              label={copy.founderLabel}
              value={format(copy.founderSeat, { numero: founderSeat, total: seatTotal })}
              last
            />
          ) : null}
        </div>
      </Card>

      {founderSeat ? (
        <p className="text-meta leading-relaxed text-muted">{copy.founderNote}</p>
      ) : null}

      <div className="flex flex-col gap-2 pt-2 min-[560px]:flex-row">
        {/* `PLAN_HREF`, not `PLAN_PATH`: during founders week the honest
            upgrade path is the offer itself, and billing does not open until
            M5. The two names exist so this link can change the day F2 ships
            without anyone hunting for it. */}
        <Button href={PLAN_HREF} variant="secondary">
          {copy.plans}
        </Button>
      </div>
    </AccountChrome>
  )
}
