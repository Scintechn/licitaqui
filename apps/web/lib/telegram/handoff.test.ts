import { describe, expect, it } from 'vitest'
import { TOKEN_TTL_SECONDS } from './config'
import {
  botHandle,
  HANDOFF_MINUTES,
  linkPhase,
  startCommand,
} from './handoff'
import { mintToken } from './token'

/**
 * The hand-off state machine (task E3).
 *
 * `linkPhase` is the answer to "what should `/conta/alertas` be showing", and
 * it is pure on purpose: three booleans-and-a-string in, one phase out, no
 * cookie jar and no database. The cases below are the ones that were
 * indistinguishable before E3 — *waiting* and *failed* both looked exactly like
 * *never tried*, which is how a link that died in the hand-off left the screen
 * still offering "Conectar o Telegram".
 */

const env = { TELEGRAM_LINK_SECRET: 'handoff-test-secret-long-enough' }

function token(options: { now?: Date } = {}): string {
  return mintToken({ env, ...options }).token
}

describe('linked wins over everything', () => {
  it('is linked even with a live token still in the cookie', () => {
    // The attempt that succeeded leaves its cookie behind: the webhook links
    // the account, it does not reach into this browser. Showing "keep waiting"
    // to somebody who is connected is the exact bug E3 exists to remove.
    const phase = linkPhase({ linked: true, pending: false, handoffToken: token(), env })
    expect(phase.phase).toBe('linked')
  })

  it('is linked even while the database still shows a token outstanding', () => {
    const phase = linkPhase({ linked: true, pending: true, handoffToken: null, env })
    expect(phase.phase).toBe('linked')
  })
})

describe('waiting', () => {
  it('carries the deep link and the command to send by hand', () => {
    const value = token()
    const phase = linkPhase({ linked: false, pending: true, handoffToken: value, env })
    expect(phase.phase).toBe('waiting')
    if (phase.phase !== 'waiting') return

    expect(phase.url).toBe(`https://t.me/LicitaQuiBot?start=${value}`)
    // Exactly what Telegram itself would have sent: `readUpdate` parses one
    // grammar, and a friendlier variation would link nothing.
    expect(phase.command).toBe(`/start ${value}`)
    expect(phase.token).toBe(value)
  })

  it('reports the token’s own expiry rather than a second clock', () => {
    const now = new Date('2026-09-22T09:00:00.000Z')
    const phase = linkPhase({
      linked: false,
      pending: true,
      handoffToken: token({ now }),
      env,
      now,
    })
    if (phase.phase !== 'waiting') throw new Error('expected waiting')
    expect(phase.expiresAt.getTime()).toBe(now.getTime() + TOKEN_TTL_SECONDS * 1000)
  })

  it('waits on the cookie even when the row says nothing is outstanding', () => {
    // The race the other way round: the webhook has spent the token and
    // cleared `start_token`, but `linked` has not been read yet. A live token
    // in this browser is still an attempt in progress.
    const phase = linkPhase({ linked: false, pending: false, handoffToken: token(), env })
    expect(phase.phase).toBe('waiting')
  })
})

describe('failed — the state that did not exist', () => {
  it('fails an expired token instead of offering a link that cannot work', () => {
    const issued = new Date('2026-09-22T09:00:00.000Z')
    const later = new Date(issued.getTime() + (TOKEN_TTL_SECONDS + 1) * 1000)
    const phase = linkPhase({
      linked: false,
      pending: true,
      handoffToken: token({ now: issued }),
      env,
      now: later,
    })
    expect(phase.phase).toBe('failed')
  })

  it('fails a token that is not ours', () => {
    const phase = linkPhase({
      linked: false,
      pending: true,
      handoffToken: 'not-a-token-we-ever-issued-aaaaaaaaaaaaaaa',
      env,
    })
    expect(phase.phase).toBe('failed')
  })

  it('fails when the account has a token outstanding and this browser has none', () => {
    // Connected from the phone, came back on the laptop. The laptop cannot
    // finish that attempt, so it says so and offers another link.
    const phase = linkPhase({ linked: false, pending: true, handoffToken: null, env })
    expect(phase.phase).toBe('failed')
  })
})

describe('idle', () => {
  it('is idle when nothing has ever been attempted', () => {
    const phase = linkPhase({ linked: false, pending: false, handoffToken: null, env })
    expect(phase.phase).toBe('idle')
  })
})

describe('the copy’s numbers come from the TTL', () => {
  it('derives the minutes rather than typing them', () => {
    expect(HANDOFF_MINUTES).toBe(Math.round(TOKEN_TTL_SECONDS / 60))
  })

  it('names the bot the deep link opens', () => {
    expect(botHandle({})).toBe('@LicitaQuiBot')
    expect(botHandle({ TELEGRAM_BOT_USERNAME: 'OutroBot' })).toBe('@OutroBot')
  })

  it('builds the command Telegram would have sent', () => {
    expect(startCommand('abc')).toBe('/start abc')
  })
})
