'use client'

import { useId, useState } from 'react'
import { Card } from '@/components'
import { format, messages } from '@/lib/messages'
import { moneyExactNonZero } from '@/lib/radar/format'
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
/**
 * The margin the field is expressing, or `null` when it is expressing none.
 *
 * `null` for empty, for whitespace, for "abc", and for anything outside 0–99
 * — a 100% margin implies a supplier cost of zero and a negative one is not a
 * question this screen answers. The caller renders the figure as unavailable
 * rather than computing one from a number the person did not type.
 */
export function parseMargin(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0 || value >= 100) return null
  return value
}

export function MarginCeiling({ band }: { band: PriceBand }) {
  /**
   * The **raw field text**, not a number.
   *
   * `Number('')` is `0` and finite, so holding a number meant that clearing the
   * field snapped the margin to zero — the headline figure jumped to the full
   * median under a label reading *"Teto para manter a margem que você
   * informou"*, and you could not backspace-then-retype. A wrong figure
   * substituted for a blank one, on the one control this screen has.
   */
  const [marginText, setMarginText] = useState(String(DEFAULT_MARGIN_PCT))
  const fieldId = useId()

  /** `null` while the field is empty or unparseable — never silently zero. */
  const marginPct = parseMargin(marginText)
  const ceiling = marginPct === null ? null : targetPurchasePrice(band, marginPct)
  // **This comment used to be wrong, and the code with it.** It claimed
  // `moneyExact` "returns null" at a high margin on a low-value item. It does
  // not: `notAPrice` guards `=== 0` exactly, so median R$ 0,40 at 99% gives
  // R$ 0,004 and renders as **`R$ 0,00`** — a fabricated price at 30px, under
  // a label promising the reader's own margin. 376 awards sit under R$ 1,00
  // and the margin is the reader's, so this is reachable, not theoretical.
  // `moneyExactNonZero` is the function the old comment described.
  const money = ceiling === null ? null : moneyExactNonZero(String(ceiling))

  return (
    <Card accent className="flex flex-col gap-2.5">
      <div className="text-body font-medium text-blue">{page.maxTitle}</div>

      <div className="flex items-center gap-2.5">
        <span className="font-display text-[30px] leading-none font-semibold text-muted">R$</span>
        <strong className="font-display text-[30px] leading-none font-semibold tabular-nums">
          {money === null ? page.noEstimate : money.replace(/^R\$\s*/, '')}
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
          value={marginText}
          onChange={(event) => setMarginText(event.target.value)}
          onBlur={() => {
            // Committed on blur, not on every keystroke: clamping as you type
            // fights the typist, and an empty field mid-edit is a normal state
            // rather than a margin of zero.
            if (marginPct === null) setMarginText(String(DEFAULT_MARGIN_PCT))
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
