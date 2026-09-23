# Job payload contracts

The `jobs` table is the seam between the two halves of this product: TypeScript
on Vercel writes rows, Python on EC2 reads them. Nothing type-checks across that
line. `apps/web/lib/jobs/index.ts` already says so about the *keys*:

> a key that drifts does not fail loudly; it quietly puts two live jobs on the
> queue for one CNPJ

The **payload** had the same exposure and no such guard, and on 2026-09-23 it
cost the product every Telegram confirmation it had ever tried to send. The web
enqueued `{template, userId, chatId}`; the worker reads `user_id` / `chat_id`;
every reply died on

```
ValueError: send_telegram payload needs a 'user_id' or a 'chat_id'
```

and retried until its four attempts were gone. A person tapped `/start`, the
site said "Telegram conectado", and the bot said nothing — for weeks, in
production, with no alert, because a job that fails its attempts is just a row.

## What a file here is

One JSON file per job kind that the **web** enqueues, naming the exact wire
spelling of every payload field. It is data, not code, so both languages can
read it, and it is checked in next to neither of them so neither owns it.

* `apps/web/lib/jobs/contract.test.ts` asserts the producer emits exactly these
  fields — building real payloads through the real builder, never a literal.
* `worker/tests/test_job_contracts.py` asserts the consumer accepts a payload
  built from this file, **and rejects the camelCase spelling of it**. Both
  directions, because only checking the happy one would have passed on
  2026-09-23 too.

Either side renaming a field in its own code, and not here, turns red. That is
the whole point: the drift is what has to be expensive, not the fix.

## Fields

* `required` — must be present on every payload of this kind.
* `one_of` — exactly one of these must be present.
* `optional` — may be present.
* Nothing outside those three lists may appear in a payload.

## Adding a kind

Add the JSON file, then add it to the `KINDS` list in both test files. A kind
with no contract file is not an error today — the queue carries several kinds
the worker enqueues for itself, which never cross a language boundary and are
not what this directory is for.
