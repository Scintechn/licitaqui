'use client'

import { useId, useState } from 'react'
import { Card } from '@/components'
import { format, messages } from '@/lib/messages'
import { moneyExact } from '@/lib/radar/format'
import { targetPurchasePrice, type PriceBand } from '@/lib/radar/price-band'

const page = messages.radar.price

/**
 * A starting point, not a recommendation.
 *
 * `maxNote` has promised *"a margem que você escolher"* since before there was
 * a control to choose with, so the number must be the person's. It is
 * pre-filled rather than blank only so the ceiling has a value on first paint
 * — a blank field would show the promise and no answer, which is the state
 * this card exists to remove. The copy never calls 20% advisable.
 */
const DEFAULT_MARGIN_PCT = 20

/**
 * The purchase ceiling, and the one input the person gives us.
 *
 * **The only Client Component on this screen.** `price-view.tsx` is server
 * rendered and reads the `awards` table; this is the interactive island, so
 * the band arrives as a prop already computed and already *gated* — by the
 * time it is here, `lib/radar/price-band.ts` has decided the evidence supports
 * showing anything at all.
 *
 * It renders no locked value and no placeholder. If there were no band, the
 * parent renders the "no data yet" card instead and this never mounts.
 */
export function MarginCeiling({ band }: { band: PriceBand }) {
  const [marginPct, setMarginPct] = useState(DEFAULT_MARGIN_PCT)
  const fieldId = useId()
  const ceiling = targetPurchasePrice(band, marginPct)

  return (
    <Card accent className="flex flex-col gap-2.5">
      <div className="text-body font-medium text-blue">{page.maxTitle}</div>

      <div className="flex items-center gap-2.5">
        <span className="font-display text-[30px] leading-none font-semibold text-muted">R$</span>
        <strong className="font-display text-[30px] leading-none font-semibold tabular-nums">
          {ceiling === null ? page.noEstimate : (moneyExact(String(ceiling)) ?? '').replace(/^R\$\s*/, '')}
        </strong>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor={fieldId} className="text-meta text-muted">
          {page.marginLabel}
        </label>
        <input
          id={fieldId}
          type="number"
          inputMode="numeric"
          min={0}
          max={99}
          step={1}
          value={marginPct}
          onChange={(event) => {
            const next = Number(event.target.value)
            // Clamped here rather than trusted: `targetPurchasePrice` returns
            // null outside 0–99, which would blank the figure mid-typing and
            // read as a bug. The input's own min/max are not enforced by every
            // browser on every path.
            setMarginPct(Number.isFinite(next) ? Math.min(99, Math.max(0, next)) : 0)
          }}
          className="w-16 rounded-card border border-line bg-surface px-2 py-1 text-body tabular-nums"
          aria-describedby={`${fieldId}-inputs`}
        />
        <span className="text-meta text-muted">%</span>
      </div>

      {/* Framing rule 3 (legal brief §2.2): the ceiling is labelled and its
          inputs are visible rather than implied. `ceilingLabel` and
          `inputsLabel` were approved copy that rendered nowhere until now. */}
      <p className="m-0 text-meta leading-relaxed text-muted">{page.ceilingLabel}</p>
      <p id={`${fieldId}-inputs`} className="m-0 text-meta leading-relaxed text-muted">
        {page.inputsLabel} {format(page.bandSample, { count: band.sampleSize })} ·{' '}
        {page.bandEstimate}
      </p>
      <p className="m-0 text-meta leading-relaxed text-muted">{page.maxNote}</p>
    </Card>
  )
}
