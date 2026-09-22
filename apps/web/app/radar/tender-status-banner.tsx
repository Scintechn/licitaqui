import { Icon } from '@/components'
import type { TenderCard } from '@/lib/radar/contract'
import { statusNotice } from '@/lib/radar/tender-status'

/**
 * "Edital SUSPENSO pelo órgão em 21/09/2026" — above the title, on every
 * screen that shows this tender.
 *
 * ## Why one component and not a block per screen
 *
 * `TENDER_STATUS_AND_WATCH.md` §3.5 puts the same banner on the Opportunity
 * screen and on every AI result screen for the same tender, and the defect it
 * answers was four screens each deciding for themselves what to do about the
 * status. A second copy of this markup is a second chance to word a suspension
 * as a cancellation, so there is one: Opportunity, Triagem and Preço all render
 * this, and a screen added later gets it by importing rather than by
 * remembering.
 *
 * Returning `null` for a Divulgada tender is the point — the caller renders it
 * unconditionally and the gate decides, so no screen carries an `if` about
 * status of its own.
 *
 * ## Attention, not error
 *
 * `--color-attention` on `--color-attention-soft` measures **5.30:1**, the pair
 * `styles/contrast.test.ts` already pins. Red would read as *our* failure; this
 * is a fact about the órgão, and the reader has to act on it (re-check the
 * portal), not be alarmed by it. Revogada and Anulada share the colour and are
 * separated by their words — colour is never the only signal in this system.
 *
 * `role="status"` rather than `alert`: it is part of the page a reader lands
 * on, not an interruption, so it is announced in turn instead of pre-empting
 * whatever the screen reader was saying.
 */
export function TenderStatusBanner({
  tender,
}: {
  tender: Pick<TenderCard, 'status' | 'pncpUpdatedAt'>
}) {
  const notice = statusNotice(tender)
  if (notice === null) return null

  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-[10px] bg-attention-soft px-3 py-2.5 text-attention"
    >
      <Icon name="alert" size={18} className="mt-px shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="m-0 text-meta font-semibold">{notice.title}</p>
        <p className="m-0 text-meta leading-relaxed">{notice.body}</p>
        {/* No `opacity` to quiet this line: `--color-attention` on
            `--color-attention-soft` is 5.30:1, and 90% opacity blends it to
            **4.37:1** — under the 4.5 AA needs, on 11px text. The hierarchy is
            carried by size and weight instead, which cost no contrast. */}
        <p className="m-0 text-caption leading-relaxed">{notice.source}</p>
      </div>
    </div>
  )
}
