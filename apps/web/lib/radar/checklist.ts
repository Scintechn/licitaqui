import {
  CHECKLIST_KEYS,
  type Checklist,
  type ChecklistKey,
  type ChecklistRow,
  type ChecklistSource,
  type TenderDetail,
} from './contract'
import type { Finding, ScreeningModel } from './screening-result'

/**
 * The same checklist, before and after a triagem (D26).
 *
 * ## What it is for
 *
 * Canvas 11 draws *"N de M conferidos"* on the tender screen, and it is the
 * only artefact in the product that shows a reader what their triagem bought.
 * Before this, the screen had `reasons()` — a variable-length `string[]` of
 * positives with no per-row verdict, no denominator, no page and no way to say
 * *"we did not read this"*. The findings on the triagem screen had all of
 * those and no connection to it. **The two halves existed and the join did
 * not**, which is this card.
 *
 * ## Why the denominator does not move
 *
 * Sci ruled on 2026-10-01: every key is present at every moment, and a triagem
 * turns `unknown` rows into answers. Canvas 11 drew it the other way — "3 de
 * 4" before, "5 de 7" after — and a growing denominator hides the thing worth
 * showing. A reader deciding whether to spend a triagem should be able to see
 * **what they would be buying**: seven rows that currently say nothing.
 *
 * ## Which source answers what
 *
 * Three rows come from PNCP's structured fields and cost nothing. The other
 * seven need the edital read. The row carries which, because a value from a
 * structured field and a sentence pulled out of a PDF are not the same kind of
 * true, and one fraction across both would assert that they are.
 *
 * ## `blocker` is declared and not yet produced — deliberately, and carded
 *
 * Sci's ruling, 2026-10-01, was that `blocker` must come from the blockers
 * list and nowhere else: a row that merely *demands* something — an atestado
 * is required, a guarantee is 5% — is **answered**, not barred, because the
 * fraction counts *conferidos*, not *passed*.
 *
 * That join needs the worker to say which condition each barrier is about, and
 * `bloqueadores_pequena_empresa` is `[{ponto, pagina}]` — free text, joinable
 * to nothing. Adding a key to the prompt was tried and **measured**: over nine
 * live evaluation runs the untouched prompt scored 96.6 / 96.6 / 98.3 and
 * never missed the 95% gate, while two shapes of the change scored
 * 94.8 / 96.6 / 93.1 and 81.0 / 96.6 / 96.6 and failed it in three of six. The
 * baseline's worst run beats either variant's mean, so the change does not
 * ship. **D35** carries it.
 *
 * Matching a barrier to a row by its cited page is the tempting shortcut and
 * is not sound: several rows routinely cite the same page.
 *
 * So today every answered row is `ok`. The state stays in the union because it
 * is what the block means and D27 draws against it; a test pins that nothing
 * emits it yet, so "no blockers" cannot quietly become "we stopped looking".
 */
export function tenderChecklist(
  tender: TenderDetail,
  screening: ScreeningModel | null,
  viewer: ChecklistViewer = {},
): Checklist {
  const findings = new Map<string, Finding>()
  for (const finding of [...(screening?.qualification ?? []), ...(screening?.requirements ?? [])]) {
    findings.set(finding.id, finding)
  }

  // §3.2 shares a reading across users and §10 allocates it per user, so a
  // tender somebody else paid to read is **not** read for this viewer. D27's
  // card states the rule — "gate on `spent`, not `ready`" — and it belongs
  // here rather than in the screen, or every caller re-implements it.
  const bought = viewer.spent === true
  const rows = CHECKLIST_KEYS.map((key) => row(key, tender, bought ? findings : EMPTY, viewer))
  return {
    rows,
    checked: rows.filter((r) => r.state !== 'unknown').length,
    total: rows.length,
  }
}

/**
 * What this checklist knows about the person looking at it.
 *
 * Both fields default to the cautious answer, so a caller that forgets them
 * gets *"nobody checked"* rather than a confident row.
 */
export type ChecklistViewer = {
  /**
   * Whether **this** viewer has paid for the reading, not whether one exists.
   *
   * The analysis is shared (§3.2) and the allowance is per user (§10), so a
   * tender read by somebody else is unread for this person — and the page
   * numbers in it were bought with somebody else's triagem.
   */
  spent?: boolean
  /**
   * Whether a company's CNAE was compared against this tender at all.
   *
   * `matchedSegments` being empty means one of two opposite things: no company
   * was searched, or a company was and its activities do not cover this
   * tender. The second is an **answer** — it is why the Radar has a `keyword`
   * group — and reporting it as "não conferido" would be this block telling
   * someone we did not look when we did.
   */
  hasCompany?: boolean
}

/** No reading, for a viewer who has not bought one. */
const EMPTY: Map<string, Finding> = new Map()

/** Which rows PNCP answers on its own, before anybody pays for a reading. */
const SOURCE: Record<ChecklistKey, ChecklistSource> = {
  cnae: 'pncp',
  meEpp: 'pncp',
  deadline: 'pncp',
  technicalCertificate: 'ai',
  minimumCapital: 'ai',
  guarantee: 'ai',
  sample: 'ai',
  siteVisit: 'ai',
  consortium: 'ai',
  deliveryPlace: 'ai',
}

function row(
  key: ChecklistKey,
  tender: TenderDetail,
  findings: Map<string, Finding>,
  viewer: ChecklistViewer,
): ChecklistRow {
  const source = SOURCE[key]
  if (source === 'pncp') {
    const state = fromPncp(key, tender, viewer)
    // `meEpp` is the one row either source can answer, and PNCP is silent on
    // **31.6%** of the corpus (15 189 of 47 991 tenders, measured 2026-10-01).
    // Where it says nothing the triagem does answer, with a page — so the row
    // falls through to the reading rather than reporting for ever that nobody
    // checked something the reader paid to have checked.
    if (state === 'unknown' && key === 'meEpp') {
      const finding = findings.get('meEpp')
      if (finding !== undefined && finding.known) {
        return { key, state: 'ok', source: 'ai', page: finding.page, pageUnverified: finding.pageUnverified }
      }
    }
    return { key, state, source, page: null, pageUnverified: false }
  }

  const finding = findings.get(key)
  // No reading yet, no row in it, or a row the model could not answer: all
  // three are the same statement — nobody has checked this — and `unknown` is
  // what stops a two-colour meter turning that into "fine".
  if (finding === undefined || !finding.known) {
    return { key, state: 'unknown', source, page: null, pageUnverified: false }
  }
  return {
    key,
    // `ok` means *answered*, never *passed* — see the note above on `blocker`.
    state: 'ok',
    source,
    page: finding.page,
    pageUnverified: finding.pageUnverified,
  }
}

/**
 * The three rows PNCP answers.
 *
 * None of them can be a `blocker`. PNCP states facts about the tender; it does
 * not assert that any of them bars a small company, and inferring that here
 * would be this product putting words in the edital's mouth. A PNCP row is
 * answered or it is not.
 *
 * **`meEpp` is read from the structured field and not from the AI's
 * `beneficio_me_epp`**, even after a triagem. Both answer it, and the
 * structured one is available before paying — so taking the AI's would make a
 * triagem appear to buy a row the reader already had, which is the opposite of
 * what this block is for. The AI's reading still renders on the triagem
 * screen, where it carries its page.
 */
function fromPncp(
  key: ChecklistKey,
  tender: TenderDetail,
  viewer: ChecklistViewer,
): 'ok' | 'unknown' {
  switch (key) {
    case 'cnae':
      // **Answered is not the same as matched.** An empty `matchedSegments`
      // means either that no company was searched — nothing was compared, so
      // `unknown` — or that one was and its activities do not cover this
      // tender, which is precisely the `keyword` group and is an answer. The
      // first version read the empty list as "unknown" in both cases, so
      // every tender opened from Palavras-chave reported that we had not
      // checked a CNAE we had checked and rejected.
      return tender.matchedSegments.length > 0 || viewer.hasCompany === true ? 'ok' : 'unknown'
    case 'meEpp':
      return tender.meEppSummary === null ? 'unknown' : 'ok'
    case 'deadline':
      // The date alone, never whether there is "still time" — that is a claim
      // about the clock and legal brief §2.2 rule 6 governs it elsewhere.
      return tender.proposalsCloseAt === null ? 'unknown' : 'ok'
    default:
      return 'unknown'
  }
}
