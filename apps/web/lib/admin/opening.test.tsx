import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OpeningCard } from '@/app/admin/opening-card'
import { OPENING_THRESHOLD_HOURS, readOpening, type OpeningState } from './opening'

/**
 * The opening-broadcast watchdog — card **E20**.
 *
 * ## What these tests are for
 *
 * The defect this card exists against is not a wrong number, it is **a silence
 * read as health**. On 2026-10-03 the one `jobs` row the founders opening
 * depends on was deleted; two days passed and nothing noticed, because nothing
 * the worker ran on its own asserted that row existed. The audit found it by
 * querying `jobs` by hand.
 *
 * So the assertions that matter are the ones about absence, and about the
 * **difference between two absences**:
 *
 * - no reading at all is `never`, not healthy;
 * - no **recent** reading is `stale`, and `stale` must not read like `missing` —
 *   the first says *we do not know whether the row is there*, the second says
 *   *it is not there*, and collapsing them is exactly how B32 lasted two days;
 * - a state this build has no sentence for is `unknown`, never the healthy arm
 *   of a switch.
 *
 * ## Which test does which (`CLAUDE.md` §4c)
 *
 * The **mechanism** — the staleness decision, the unknown-state guard, the
 * shape guards — is here, with a fake executor and no database. The **SQL** is
 * in `opening.db.test.ts`, because `feeds.db.test.ts` exists for the reason that
 * a mutation to B37's query left all ten of its fake-executor tests green: they
 * never execute the statement. The **state machine itself** is on the worker
 * side, in `worker/tests/test_opening_check.py`, and is deliberately not
 * duplicated here — a second copy of it would be the two-thresholds defect D29
 * came from.
 *
 * The **rendering** is here too, through `renderToStaticMarkup`, this repo's
 * component-test idiom (`vitest.config.mts` has no jsdom).
 *
 * What none of them covers: the card in a browser. `/admin` needs Postgres and
 * HTTP Basic and the Playwright `journeys` project is hermetic by design, so
 * there is no e2e for `/admin` at all — not for this card and not for the four
 * beside it. The card is a server component with no effects and no breakpoint
 * above 720px inside a shell, which is the pair §4c says the node environment
 * cannot see, so the exposure is stated rather than papered over.
 */

const NOW = new Date('2026-10-09T12:00:00Z')

/** 17/10 12:00 BRT = 15:00 UTC. Written out, never computed from the code. */
const DUE = '2026-10-17T15:00:00+00:00'

type Row = Record<string, unknown>

function executor(rows: Row[]) {
  return { execute: async () => ({ rows }) } as never
}

const failing = {
  execute: async () => {
    throw new Error('boom')
  },
} as never

/** A reading as `opening_check.py` writes one. */
function reading(props: Row = {}, checkedAt = '2026-10-09T09:00:00+00:00'): Row {
  return {
    created_at: checkedAt,
    props: {
      state: 'queued',
      alarm: false,
      expected_key: 'founders-opening-broadcast:2026-10-17',
      opening_date: '2026-10-17',
      due_at: DUE,
      due_at_brt: '2026-10-17T12:00:00-03:00',
      checked_at: checkedAt,
      hours_to_due: 198,
      product_opening_date: '2026-10-17',
      date_matches_product: true,
      broadcast_hour_brt: '12:00',
      whatsapp_delivery: 'send',
      email_delivery: 'send',
      delivery_ready: true,
      job_id: 103288,
      job_status: 'queued',
      job_run_after: DUE,
      seated: 2,
      waitlisted: 0,
      ...props,
    },
  }
}

describe('readOpening', () => {
  it('reports a healthy queued row as current and not an alarm', async () => {
    const found = await readOpening(executor([reading()]), NOW)
    expect(found.watch.kind).toBe('current')
    if (found.watch.kind !== 'current') throw new Error('unreachable')
    expect(found.watch.reading.state).toBe('queued')
    expect(found.watch.reading.alarm).toBe(false)
    expect(found.watch.reading.jobId).toBe(103288)
    expect(found.watch.reading.dueAt.toISOString()).toBe('2026-10-17T15:00:00.000Z')
  })

  it('is never, not healthy, when nothing has ever checked', async () => {
    /**
     * The whole card in one assertion. An empty `events` table means the
     * watchdog has never run, which is **less** evidence than a bad reading,
     * and a card that rendered it as blank-but-fine would be B32 again.
     */
    const found = await readOpening(executor([]), NOW)
    expect(found.watch.kind).toBe('never')
  })

  it('is stale, not missing, when the last check is older than the threshold', async () => {
    /**
     * The distinction the card is for. *The row is gone* is a fact about the
     * queue; *nobody has looked* is a fact about the watchdog, and reporting
     * the second as the first would send somebody to re-queue a row that is
     * already there — while reporting it as healthy is how 2026-10-03 lasted
     * two days.
     */
    const old = new Date(NOW.getTime() - (OPENING_THRESHOLD_HOURS + 1) * 3_600_000)
    const found = await readOpening(executor([reading({}, old.toISOString())]), NOW)
    expect(found.watch.kind).toBe('stale')
    if (found.watch.kind !== 'stale') throw new Error('unreachable')
    // The last reading travels with it, so the card can say what it was.
    expect(found.watch.reading.state).toBe('queued')
    expect(found.watch.reading.hours).toBeGreaterThan(OPENING_THRESHOLD_HOURS)
  })

  it('tolerates one missed run and refuses a whole day of silence', async () => {
    /**
     * The threshold's arithmetic, asserted rather than commented. The two
     * schedule entries are 09:00 and 15:00 BRT, so the longest gap is 18 h and
     * one missed run leaves the previous reading 24 h old. A day of silence is
     * 48 h and must alarm. `worker/tests/test_opening_check.py` pins the same
     * 18 h on the worker side.
     */
    const at = (hours: number) =>
      new Date(NOW.getTime() - hours * 3_600_000).toISOString()
    expect((await readOpening(executor([reading({}, at(24))]), NOW)).watch.kind).toBe('current')
    expect((await readOpening(executor([reading({}, at(48))]), NOW)).watch.kind).toBe('stale')
    expect(OPENING_THRESHOLD_HOURS).toBeGreaterThan(24)
    expect(OPENING_THRESHOLD_HOURS).toBeLessThan(48)
  })

  it('carries the worker verdict rather than deciding the alarm itself', async () => {
    /**
     * The worker holds the row, the configured instant and the database clock
     * at one moment, so it decides. This file re-derives nothing — no second
     * copy of the one-minute tolerance, no second conversion of 12:00 BRT. D29
     * is what two numbers chosen in different places cost.
     */
    const found = await readOpening(
      executor([reading({ state: 'missing', alarm: true, job_id: null, job_status: null })]),
      NOW,
    )
    if (found.watch.kind !== 'current') throw new Error('unreachable')
    expect(found.watch.reading.state).toBe('missing')
    expect(found.watch.reading.alarm).toBe(true)
    expect(found.watch.reading.jobId).toBeNull()
  })

  it('reports a state it does not know as unknown, never as healthy', async () => {
    /**
     * A new state added to `opening_check.STATES` without a sentence here must
     * be loud. Falling through a `switch` into the positive arm is how a card
     * on the one screen whose purpose is to be believed starts lying.
     */
    const found = await readOpening(executor([reading({ state: 'reticulating' })]), NOW)
    expect(found.watch.kind).toBe('unknown')
    if (found.watch.kind !== 'unknown') throw new Error('unreachable')
    expect(found.watch.reading.state).toBe('reticulating')
  })

  it('calls a row that is not a reading unreadable, never "never checked"', async () => {
    /**
     * No `state`, no `due_at`: not a reading, and defaulting either would put a
     * verdict on the card that no check produced.
     *
     * **It used to report `never`**, and that sentence — *"nunca conferiu"* —
     * is false over a table full of rows, and false in the quiet direction: a
     * key renamed on the worker side would have turned the card grey and said
     * nothing had ever looked. Found by this PR's second review.
     */
    expect((await readOpening(executor([{ created_at: DUE, props: {} }]), NOW)).watch.kind).toBe(
      'unreadable',
    )
    expect((await readOpening(executor([reading({ due_at: undefined })]), NOW)).watch.kind).toBe(
      'unreadable',
    )
    // And a genuinely empty table is still `never` — the two must not merge.
    expect((await readOpening(executor([]), NOW)).watch.kind).toBe('never')
  })

  it('draws the strongest absence loudly, not greyly', async () => {
    /**
     * `never` was `tone="muted"` while the *less* bad `stale` was
     * `tone="attention"`, so a worker whose deploy lost the handler left the
     * card grey forever — the alarm getting quieter as the problem got older,
     * which is the B32 shape `opening.ts`'s own comment warns against.
     */
    const html = renderToStaticMarkup(
      <OpeningCard opening={await readOpening(executor([]), NOW)} />,
    )
    expect(html).toContain('nunca conferiu')
    expect(html).toContain('o scheduler não subiu')
    expect(html).not.toContain('border-blue-line')
    // **The tone, as a class**, not just the words. `Tag tone="muted"` renders
    // `bg-fill-muted text-muted` and `tone="attention"` renders
    // `bg-attention-soft text-attention`; asserting only the sentence let a
    // mutation back to grey pass, which is the exact defect — the strongest
    // absence drawn as the quietest thing on the card.
    expect(html).toContain('bg-attention-soft')
    expect(html).not.toContain('bg-fill-muted')
    const unreadable = renderToStaticMarkup(
      <OpeningCard opening={await readOpening(executor([{ created_at: DUE, props: {} }]), NOW)} />,
    )
    expect(unreadable).toContain('leitura ilegível')
    // The *summary* line must not claim nothing ever looked — a row exists.
    // Asserted on that line specifically, because the note below it quotes the
    // phrase in order to say it would be false. This assertion is what found
    // `beside()` still printing "e nunca conferiu" for this state.
    expect(unreadable).toContain('há linha gravada e nenhuma leitura')
    expect(unreadable).not.toContain('e nunca conferiu')
  })

  it('treats a missing date_matches_product as agreement, not as a mismatch', async () => {
    /**
     * A row written before that field existed must not raise an alarm about
     * nothing. `!== false` rather than `=== true`, deliberately: the alarm
     * belongs to a check that actually compared the two.
     */
    const found = await readOpening(
      executor([reading({ date_matches_product: undefined })]),
      NOW,
    )
    if (found.watch.kind !== 'current') throw new Error('unreachable')
    expect(found.watch.reading.dateMatchesProduct).toBe(true)
  })

  it('never defaults hours_to_due to zero, which would read as due now', async () => {
    const found = await readOpening(executor([reading({ hours_to_due: undefined })]), NOW)
    if (found.watch.kind !== 'current') throw new Error('unreachable')
    // Recomputed from the two instants the worker used, not zeroed.
    expect(found.watch.reading.hoursToDue).toBeCloseTo(198, 0)
  })

  it('is an error state, never a throw, when the query fails', async () => {
    const found = await readOpening(failing, NOW)
    expect(found.watch.kind).toBe('error')
  })
})

describe('OpeningCard', () => {
  async function render(rows: Row[], now = NOW): Promise<string> {
    return renderToStaticMarkup(<OpeningCard opening={await readOpening(executor(rows), now)} />)
  }

  it('says the row is not in the queue, and what to run', async () => {
    const html = await render([reading({ state: 'missing', alarm: true, job_id: null })])
    expect(html).toContain('não está na fila')
    expect(html).toContain('schedule_founders_opening.py --commit')
    // The incident, named on the card, because a date makes it checkable.
    expect(html).toContain('03/10/2026')
  })

  it('does not call a sent job per-recipient proof', async () => {
    /**
     * `docs/CLAIMS.md`'s worked example: `jobs.status = 'done'` said the
     * founders welcome had been sent for days while `WHATSAPP_DELIVERY` was
     * off, because a dry run and a real send differ only by an event name. A
     * green badge that implied delivery would re-make that mistake on the one
     * screen somebody checks on the day.
     */
    const html = await render([reading({ state: 'sent', alarm: false })])
    expect(html).toContain('disparado')
    expect(html).toContain('não é prova por destinatário')
    expect(html).toContain('preview_founders_opening.py')
  })

  it('prints both clocks for every instant it shows', async () => {
    /**
     * CLAUDE.md's clocks table: the product is BRT, the database is UTC, and a
     * worker was declared stalled for an hour on exactly that confusion. 17/10
     * 12:00 BRT is 15:00 UTC and the card must show both, labelled.
     */
    const html = await render([reading()])
    expect(html).toContain('BRT')
    expect(html).toContain('UTC')
    expect(html).toContain('12:00')
    expect(html).toContain('15:00')
  })

  it('alarms on an env override that disagrees with product.json', async () => {
    /**
     * E5 recorded this as unverifiable from a laptop. This is where it stops
     * being so — and it is the quietest failure available, because
     * `FOUNDERS_OPENING_DATE` is read by the worker and by nothing else, so the
     * scheduling script and the check agree with each other and are wrong
     * together.
     *
     * **This test used to assert three substrings and nothing else**, and that
     * was the hole: `dateMatchesProduct` was printed in a detail row and gated
     * nothing, so a worker dated 24/10 rendered a blue card reading *na fila*
     * while nothing would fire on the 17th. Found by this PR's second review.
     * The accent assertion below is the part that could not have passed before.
     */
    const off = reading({
      opening_date: '2026-10-24',
      product_opening_date: '2026-10-17',
      date_matches_product: false,
    })
    const watch = await readOpening(executor([off]), NOW)
    if (watch.watch.kind !== 'current') throw new Error('unreachable')
    expect(watch.watch.reading.dateMatchesProduct).toBe(false)
    // The row itself is still fine, which is exactly the trap.
    expect(watch.watch.reading.state).toBe('queued')
    expect(watch.watch.reading.alarm).toBe(false)

    const html = renderToStaticMarkup(<OpeningCard opening={watch} />)
    expect(html).toContain('FOUNDERS_OPENING_DATE')
    expect(html).toContain('2026-10-24')
    expect(html).toContain('2026-10-17')
    // The warning, by a phrase that exists nowhere else on the card.
    expect(html).toContain('Nada dispara no dia certo')
    // **And the detail row too**, which names the file the comparison is
    // against. Two independent places say it on purpose — the paragraph is the
    // alarm, the row is the evidence — and asserting only one of them let a
    // mutation that deleted the row pass.
    expect(html).toContain('(product.json)')
    // And no blue accent, with a healthy control so this cannot pass by the
    // accent never rendering at all.
    expect(html).not.toContain('border-blue-line')
    const ok = renderToStaticMarkup(
      <OpeningCard opening={await readOpening(executor([reading()]), NOW)} />,
    )
    expect(ok).toContain('border-blue-line')
  })

  it('alarms when a kill switch is off, even with the row perfectly queued', async () => {
    /**
     * The second dimension, and the failure E20's card is named for: *nothing
     * happening on the day while every signal stays green*. The row here is
     * `queued` for the right instant and `alarm` is false — the only thing
     * wrong is that a message cannot leave the process.
     *
     * This is also the one production fact no other surface can report.
     * `preview_founders_opening.py` prints both switches, but from whatever
     * process runs it, which from a laptop is the laptop; the check runs on the
     * worker.
     */
    const dead = reading({ delivery_ready: false, email_delivery: 'dry_run' })
    const watch = await readOpening(executor([dead]), NOW)
    if (watch.watch.kind !== 'current') throw new Error('unreachable')

    // The reader first, because `props->>` turns a JSON `false` into the string
    // "false", which is truthy — the one field whose round trip could invert
    // this whole alarm. `opening.db.test.ts` asserts the same against a real row.
    expect(watch.watch.reading.deliveryReady).toBe(false)
    expect(watch.watch.reading.emailDelivery).toBe('dry_run')
    expect(watch.watch.reading.whatsappDelivery).toBe('send')
    expect(watch.watch.reading.alarm).toBe(false)

    const html = renderToStaticMarkup(<OpeningCard opening={watch} />)
    // The warning itself, by a phrase that exists nowhere else on the card.
    expect(html).toContain('Uma das chaves de envio está desligada no worker')
    expect(html).toContain('EMAIL_DELIVERY=dry_run')
    expect(html).toContain('WHATSAPP_DELIVERY=send')
    // **The accent must be off.** `Card` renders `accent` as `border-blue-line`,
    // and a blue-edged card over a dead switch is the failure this card is
    // named for: nothing happening on the day while every signal stays green.
    expect(html).not.toContain('border-blue-line')
    // And not folded into the state: the row is still correctly queued, because
    // the two need different fixes — a command against an env change.
    expect(html).toContain('na fila')
    // …but not as good news: the tag may not be greener than the card (#272's
    // §4b review found a positive *na fila* beside this very warning).
    expect(html).not.toContain('bg-success-soft')

    // The control, so the assertion above is not passing because the accent is
    // never rendered at all.
    const ok = renderToStaticMarkup(
      <OpeningCard opening={await readOpening(executor([reading()]), NOW)} />,
    )
    expect(ok).toContain('border-blue-line')
    expect(ok).toContain('bg-success-soft')
  })

  it('counts the waitlist the broadcast does not reach', async () => {
    // E5's open decision: both waitlist templates promise these people a
    // message when the product opens, and no opening-day template exists.
    const html = await render([reading({ waitlisted: 3 })])
    expect(html).toContain('na espera')
  })

  it('says we do not know when the check is stale, and does not say the row is gone', async () => {
    const old = new Date(NOW.getTime() - 60 * 3_600_000).toISOString()
    const html = await render([reading({}, old)])
    expect(html).toContain('sem conferência recente')
    expect(html).toContain('aqui não sabemos')
    expect(html).not.toContain('não está na fila')
  })

  it('renders every declared state without falling through the switch', async () => {
    /**
     * Enumerated, so a state the worker can produce can never reach this card
     * with no sentence. The worker's own suite asserts the same list is exactly
     * what its machine can reach, so the two ends meet.
     */
    const states: OpeningState[] = [
      'queued',
      'sent',
      'missing',
      'misdated',
      'late',
      'fired_early',
      'failed',
    ]
    for (const state of states) {
      const html = await render([reading({ state, alarm: state !== 'queued' && state !== 'sent' })])
      expect(html, state).toContain('Disparo da abertura')
      expect(html, state).toContain('chave procurada')
    }
  })

  it('renders without a reading at all, and says so', async () => {
    const html = await render([])
    expect(html).toContain('nunca conferiu')
    const broken = renderToStaticMarkup(
      <OpeningCard opening={await readOpening(failing, NOW)} />,
    )
    expect(broken).toContain('query_failed')
    expect(broken).toContain('O silêncio não é prova de saúde')
  })
})
