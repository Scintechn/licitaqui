import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { HUPE_DIVULGADA, HUPE_SUSPENDED } from './hupe.fixture'
import {
  DIVULGADA,
  isFinalStatus,
  mayShowUrgency,
  statusChipLabel,
  statusNotice,
  tenderStatusKind,
} from './tender-status'

const copy = messages.radar.status

/** Only `status` and `pncpUpdatedAt` matter here; the rest is scaffolding. */
function tender(status: string | null, pncpUpdatedAt: string | null = null) {
  return { status, pncpUpdatedAt }
}

describe('tenderStatusKind', () => {
  it('reads PNCP’s four values', () => {
    expect(tenderStatusKind('Divulgada no PNCP')).toBe('divulgada')
    expect(tenderStatusKind('Suspensa')).toBe('suspensa')
    expect(tenderStatusKind('Revogada')).toBe('revogada')
    expect(tenderStatusKind('Anulada')).toBe('anulada')
  })

  it('survives case and accents, because the value is agency-entered text', () => {
    expect(tenderStatusKind('SUSPENSA')).toBe('suspensa')
    expect(tenderStatusKind('  divulgada no pncp  ')).toBe('divulgada')
    expect(tenderStatusKind('Anulada')).toBe(tenderStatusKind('ANULADA'))
  })

  it('returns null for anything outside the domain table', () => {
    expect(tenderStatusKind(null)).toBeNull()
    expect(tenderStatusKind('')).toBeNull()
    // The string the opportunity-view fixture used to carry. It looks like a
    // status and is not one.
    expect(tenderStatusKind('Recebendo propostas')).toBeNull()
  })

  it('agrees with the constant the list’s sort key compares against', () => {
    expect(tenderStatusKind(DIVULGADA)).toBe('divulgada')
  })
})

describe('mayShowUrgency — the gate', () => {
  it('allows urgency only on a Divulgada tender', () => {
    expect(mayShowUrgency(tender(DIVULGADA))).toBe(true)
    expect(mayShowUrgency(tender('Suspensa'))).toBe(false)
    expect(mayShowUrgency(tender('Revogada'))).toBe(false)
    expect(mayShowUrgency(tender('Anulada'))).toBe(false)
  })

  it('forbids urgency on a status it cannot classify', () => {
    // Legal brief §2.2 rule 6 is an allow-list: *only* 1 permits urgency. A
    // fifth value PNCP invents, or a column we failed to populate, must cost a
    // countdown rather than produce a false claim about the world.
    expect(mayShowUrgency(tender(null))).toBe(false)
    expect(mayShowUrgency(tender('Em análise'))).toBe(false)
  })

  it('is false on the real HUPE-RJ tender and true on its control', () => {
    expect(mayShowUrgency(HUPE_SUSPENDED)).toBe(false)
    expect(mayShowUrgency(HUPE_DIVULGADA)).toBe(true)
  })
})

describe('isFinalStatus', () => {
  it('separates the final states from a suspension', () => {
    expect(isFinalStatus('revogada')).toBe(true)
    expect(isFinalStatus('anulada')).toBe(true)
    // The distinction the copy must never blur: a suspended tender may resume
    // with new dates, so it is not cancelled.
    expect(isFinalStatus('suspensa')).toBe(false)
    expect(isFinalStatus('divulgada')).toBe(false)
    expect(isFinalStatus(null)).toBe(false)
  })
})

describe('statusNotice', () => {
  it('says nothing on a Divulgada tender', () => {
    expect(statusNotice(tender(DIVULGADA))).toBeNull()
    expect(statusNotice(HUPE_DIVULGADA)).toBeNull()
  })

  it('cites the agency’s own update date, not our sweep’s', () => {
    const notice = statusNotice(HUPE_SUSPENDED)
    expect(notice?.title).toBe('Edital SUSPENSO pelo órgão em 21/09/2026')
  })

  it('drops the date clause rather than inventing one', () => {
    const notice = statusNotice(tender('Suspensa', null))
    expect(notice?.title).toBe(copy.bannerNoDate.suspensa)
    expect(notice?.title).not.toMatch(/\{data\}|undefined|null/)
  })

  it('never words a suspension as a cancellation', () => {
    const notice = statusNotice(tender('Suspensa', '2026-09-21T18:08:20.474Z'))
    const text = `${notice?.title} ${notice?.body}`
    expect(text).not.toMatch(/cancelad/i)
    expect(text).not.toMatch(/revogad/i)
    expect(text).not.toMatch(/anulad/i)
    expect(text).not.toMatch(/encerrou/i)
    // …and it says so positively: the órgão may resume it.
    expect(notice?.body).toMatch(/retomar/i)
    expect(notice?.final).toBe(false)
  })

  it('says the agency closed the process for the two final states', () => {
    for (const status of ['Revogada', 'Anulada']) {
      const notice = statusNotice(tender(status, '2026-09-21T18:08:20.474Z'))
      expect(notice?.body).toMatch(/encerrou este processo/i)
      expect(notice?.final).toBe(true)
    }
  })

  it('labels the deadline block without implying the clock is running', () => {
    expect(statusNotice(tender('Suspensa'))?.deadlineLabel).toBe('Prazo suspenso')
    expect(statusNotice(tender('Revogada'))?.deadlineLabel).toBe('Processo encerrado')
    expect(statusNotice(tender('Anulada'))?.deadlineLabel).toBe('Processo encerrado')
  })

  it('attributes the claim to the PNCP, which may lag the origin portal', () => {
    expect(statusNotice(tender('Suspensa'))?.source).toMatch(/PNCP/)
  })
})

describe('statusChipLabel', () => {
  it('uses PNCP’s own vocabulary, so a user can cross-check the portal', () => {
    expect(statusChipLabel(tender('Suspensa'))).toBe('Suspensa')
    expect(statusChipLabel(tender('Revogada'))).toBe('Revogada')
    expect(statusChipLabel(tender('Anulada'))).toBe('Anulada')
  })

  it('shows no chip on the normal state', () => {
    // 4 708 of 4 919 production rows are Divulgada. A chip on all of them is
    // not a signal, it is wallpaper.
    expect(statusChipLabel(tender(DIVULGADA))).toBeNull()
    expect(statusChipLabel(tender(null))).toBeNull()
  })
})
