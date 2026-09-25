/**
 * The Google Ads conversion signal for the founders list.
 *
 * Sci created the conversion action **"Lead · Lista de fundadores"** (lead
 * form, counted once per click, value R$ 26) on 2026-09-25. Tag Manager is
 * already on the page (`app/layout.tsx`, container `GTM-5V6M75R7`), but it had
 * nothing to detect: **the signup is a dialog, so a successful submit changes
 * no URL** and the usual thank-you-page trigger cannot exist. That is the same
 * property that made the modal-vs-page question worth asking in the first
 * place — it is not only a UX choice, it decides what marketing can measure.
 *
 * So the page says so explicitly, by pushing one event to `dataLayer`.
 *
 * **After the server confirms, never on the click.** A push on submit would
 * count people whose signup then failed validation, was rate-limited, or hit a
 * network error, and Google Ads would bid on all of them.
 *
 * **A repeat submission is not a lead.** `already_registered` means the row
 * already existed — no new seat, no new job, nobody new on the list — so it
 * pushes nothing. Google's "count once per click" would hide some of this
 * within a single click, but not the same person returning days later from a
 * second paid click, which is exactly the case that would inflate the bid.
 */

import type { SignupOk } from './contract'

/** The `event` name the GTM trigger listens for. Agreed with Sci, verbatim. */
export const FOUNDERS_LEAD_EVENT = 'fundador_lead'

/** Statuses that mean somebody new is on the list. */
const COUNTS_AS_LEAD: ReadonlySet<SignupOk['status']> = new Set(['seated', 'waitlisted'])

type DataLayerHost = { dataLayer?: unknown[] }

/**
 * Push the lead event if this response created a new entry.
 *
 * `host` exists so this is testable: `vitest.config.ts` runs `environment:
 * 'node'`, where there is no `window` at all, and a function that can only be
 * exercised in a browser is a function nothing checks.
 *
 * @returns whether an event was pushed — so a test can assert the negative
 * cases are genuinely negative rather than merely not throwing.
 */
export function pushFoundersLead(
  status: SignupOk['status'],
  host: DataLayerHost | undefined = typeof window === 'undefined'
    ? undefined
    : (window as unknown as DataLayerHost),
): boolean {
  if (!host || !COUNTS_AS_LEAD.has(status)) return false

  // GTM's own snippet creates this before it loads, but an ad blocker or a
  // failed script leaves it undefined — in which case pushing into an array
  // nobody reads is harmless, and cheaper than a branch that silently drops
  // the event if the container is slow.
  host.dataLayer = host.dataLayer ?? []
  host.dataLayer.push({ event: FOUNDERS_LEAD_EVENT })
  return true
}
