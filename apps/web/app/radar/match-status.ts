import type { CompanyView } from '@/lib/radar/contract'
import type { RadarStatus } from './radar-view'

/**
 * The "could we match you at all" half of the Radar's status, from what
 * `POST /api/radar/cnpj` said about the CNPJ in the URL.
 *
 * One function because **two** places have to ask it, and only one used to.
 * The first load decided `manualCnae` / `noSegments` / `ready` inline; the
 * background refresh of a restored list (`revalidate`) never asked at all, so a
 * list saved while the CNPJ could not be read kept saying so for the whole
 * 30-minute life of its snapshot — after the worker had read the company and
 * while the refreshed editais were drawn right beneath it. That stayed invisible
 * while the card hid itself whenever there were editais; it became visible the
 * moment the card started drawing above a list.
 *
 * The two outcomes below only apply when the CNPJ is what we searched by: with
 * a keyword, the words found what the CNAEs could not, and that is a normal
 * result — except for `manualCnae`, which the screen keeps showing above the
 * keyword's editais, because "these come only from your words" is the thing
 * the reader needs to know about them.
 */
export function matchStatus(
  company: Pick<CompanyView, 'segments'> | null,
  read: { manualCnae: boolean; cnpjNotFound?: boolean },
  q: string | null,
): RadarStatus {
  if (read.manualCnae) {
    // `=== true`: an answer from a build before the field existed, or a
    // snapshot from one, is "could not read", which is what it used to say.
    return { kind: 'manualCnae', cnpjNotFound: read.cnpjNotFound === true }
  }
  if (company && company.segments.length === 0 && !q) return { kind: 'noSegments' }
  return { kind: 'ready' }
}
