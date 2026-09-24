import { describe, expect, it, afterAll } from 'vitest'
import { closeDb, db } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { FEATURES, readLimit } from './quota'

/**
 * The entitlements a sales page is allowed to describe.
 *
 * `0002_plan_limits` gave `alert` a row for `basico` alone. `readLimit`'s rule
 * is deliberate and right — *"No row: the plan does not include the feature.
 * Not 'unlimited'."* — so `promocional`, `essencial` and `pro` resolved to
 * **zero alerts**, and somebody paying R$ 57 a month was entitled to fewer
 * than somebody paying nothing.
 *
 * It stayed invisible because nothing in the web read the row: `FEATURES` had
 * no `alert` key until canvas 09's plan strip needed one, and the strip
 * immediately printed "sem alertas neste plano" for a paid plan. Meanwhile
 * `/fundadores` advertised *"todo dia no Essencial"* — a cadence with no job
 * behind it, on a plan with no entitlement behind it.
 *
 * `0006_alert_limits` fixes the entitlement. This pins it, and pins the shape
 * the copy is allowed to claim: **weekly**, because `scheduler.py` runs
 * exactly one digest and it is `weekly_digest` at Monday 07:00 BRT.
 *
 * If a faster cadence is ever built, this test goes red — and the copy guard
 * in `lib/messages.test.ts` goes red with it. That pairing is the point:
 * neither the promise nor the entitlement can move without the other.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_B2') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip
if (url) process.env.DATABASE_URL = url

afterAll(async () => {
  if (url) await closeDb()
})

/** Every plan that can be paid for. `visitor` and `basico` are free. */
const PAID = ['promocional', 'essencial', 'pro'] as const

suite('plan_limits · alerts', () => {
  it('gives every paid plan at least what the free one gets', async () => {
    const free = await readLimit('basico', FEATURES.alert, db())
    expect(free.quantity, 'basico lost its alert row').toBe(1)

    for (const plan of PAID) {
      const paid = await readLimit(plan, FEATURES.alert, db())
      expect(paid.quantity, `${plan} has no alert entitlement`).not.toBe(0)
      expect(paid.quantity ?? Infinity, `${plan} gets fewer alerts than basico`).toBeGreaterThanOrEqual(
        free.quantity ?? 0,
      )
    }
  })

  it('is weekly on every plan, because weekly is the only digest that runs', async () => {
    // `worker/licitaqui/scheduler.py` holds one digest entry:
    //   ScheduleEntry(kind="weekly_digest", daily_at="07:00", weekday=0)
    // Change that and this is the test that tells you the copy is now wrong.
    for (const plan of ['basico', ...PAID]) {
      const limit = await readLimit(plan, FEATURES.alert, db())
      expect(limit.period, `${plan} promises a cadence the worker does not run`).toBe('week')
    }
  })
})
