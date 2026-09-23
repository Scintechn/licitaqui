import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sendTelegramPayload, type TelegramReply } from '@/lib/jobs'

/**
 * The producer half of `contracts/jobs/` (2026-09-23).
 *
 * `jobs.payload` crosses a language boundary with no shared types: this app
 * writes the row and `worker/licitaqui/telegram_alerts.py` reads it. They
 * disagreed about the spelling of every field in a `send_telegram` payload —
 * `userId`/`chatId` written, `user_id`/`chat_id` read — so every Telegram
 * confirmation the product had ever tried to send died on
 *
 *     ValueError: send_telegram payload needs a 'user_id' or a 'chat_id'
 *
 * and retried until its four attempts were gone. Production had two such jobs
 * sitting in `queued` with `attempts` spent, and the only symptom anyone could
 * see was a bot that never answered `/start` while the site said "Telegram
 * conectado".
 *
 * `worker/tests/test_job_contracts.py` reads the same file from the other side.
 * Rename a field in either language without renaming it in the JSON, and one of
 * the two suites goes red.
 */

type Contract = {
  kind: string
  required: string[]
  one_of: string[]
  optional: string[]
  fields: Record<string, string>
}

// apps/web/lib/jobs/contract.test.ts -> … -> repository root
function contract(kind: string): Contract {
  const path = fileURLToPath(new URL(`../../../../contracts/jobs/${kind}.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as Contract
}

const SEND_TELEGRAM = contract('send_telegram')

/** Every reply shape `app/api/telegram/webhook/route.ts` can produce. */
const REPLIES: TelegramReply[] = [
  { template: 'start-linked', userId: 5 },
  { template: 'start-already-linked', userId: 5 },
  { template: 'stop', userId: 5 },
  { template: 'help', userId: 5 },
  { template: 'help', chatId: 958_000_000 },
  { template: 'start-no-token', chatId: 958_000_000 },
  { template: 'start-token-invalid', chatId: 958_000_000 },
]

describe('the send_telegram payload contract', () => {
  it('describes the kind the web actually enqueues', () => {
    expect(SEND_TELEGRAM.kind).toBe('send_telegram')
  })

  it.each(REPLIES)('emits only contract fields for %o', (reply) => {
    const payload = sendTelegramPayload(reply)
    const allowed = new Set([
      ...SEND_TELEGRAM.required,
      ...SEND_TELEGRAM.one_of,
      ...SEND_TELEGRAM.optional,
    ])

    for (const key of Object.keys(payload)) {
      expect(allowed.has(key), `'${key}' is not in contracts/jobs/send_telegram.json`).toBe(true)
    }
    for (const key of SEND_TELEGRAM.required) {
      expect(payload[key], `'${key}' is required`).toBeDefined()
    }
    const present = SEND_TELEGRAM.one_of.filter((key) => payload[key] !== undefined)
    expect(present, `exactly one of ${SEND_TELEGRAM.one_of.join(', ')}`).toHaveLength(1)
  })

  it('writes snake_case, which is what the worker reads', () => {
    expect(sendTelegramPayload({ template: 'start-linked', userId: 5 })).toEqual({
      template: 'start-linked',
      user_id: 5,
    })
    expect(sendTelegramPayload({ template: 'start-no-token', chatId: 958 })).toEqual({
      template: 'start-no-token',
      chat_id: 958,
    })
  })

  it('never emits the camelCase spelling that caused the defect', () => {
    // The literal regression. The route used to pass its internal object
    // straight through, and `userId` is unreadable to the worker.
    for (const reply of REPLIES) {
      const payload = sendTelegramPayload(reply)
      expect(payload).not.toHaveProperty('userId')
      expect(payload).not.toHaveProperty('chatId')
    }
  })

  it('omits the recipient it was not given rather than sending an undefined one', () => {
    // `{user_id: undefined}` serialises to `{}` through JSON.stringify, which
    // would reach the worker as a payload with no recipient at all — the same
    // ValueError by a longer route.
    const payload = sendTelegramPayload({ template: 'help', chatId: 958 })
    expect(Object.keys(payload).sort()).toEqual(['chat_id', 'template'])
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it('documents every field it lists, and lists every field it documents', () => {
    const listed = [
      ...SEND_TELEGRAM.required,
      ...SEND_TELEGRAM.one_of,
      ...SEND_TELEGRAM.optional,
    ].sort()
    expect(listed).toEqual(Object.keys(SEND_TELEGRAM.fields).sort())
  })
})
