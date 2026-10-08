"""Billing's two daily sweeps and the message they send — cards **F4** and **D8**.

Three handlers, none of which talks to Asaas. Everything that calls Asaas is in
`apps/web/lib/asaas/client.ts`: the web creates the subscription inside the
request that hands the founder a payment page (spec §8), and the webhook is a
web route. What is left for the worker is the work that is *dated* rather than
requested — a reminder three days before a charge, and the downgrade on the day
a cancelled subscription's paid period runs out.

## `expire_subscriptions` — the other half of a one-click cancel

`db/migrations/0004_subscription_refunds.sql` added `subscriptions.ends_on`
with the sentence *"the downgrade job reads this every day"*, and no such job
existed. Without it, cancelling writes a date nothing acts on and a cancelled
subscriber keeps a paid plan for ever — a column nothing reads, which is the
shape `CLAUDE.md` names five worked examples of.

Terms §8 is the Prime model: cancelling switches off auto-renewal and paid
access runs to the last day already paid for. `billing.cancel.untilWhen` is the
approved sentence that says so. This job is the day after that day.

## `charge_reminder` — the sweep, and `send_billing_email` — the message

Spec §10: *"Asaas charges per customer notification, so customer notifications
are disabled in the account. Every billing message … is sent by our own
`charge_reminder` / billing jobs … The reminder goes 3 days before each charge,
states the date and the amount that will be charged, is idempotent per
(subscription, due date), and is never sent for a cancelled subscription."*

Each of those four clauses is a line of code below, and the idempotency is the
`billing_reminders` primary key rather than a check: the sweep inserts the row
and enqueues **only if the insert created it**, so two ticks on one day — two
scheduler instances during a deploy, a retried container — send one e-mail.

**No consent gate**, unlike `send_email`'s founders messages. A charge reminder
is a term of the contract the subscriber accepted, not marketing:
`notifications.billingHelp` tells them these cannot be switched off, and terms
§7 obliges us to send them. The LGPD basis is performance of the contract, not
consent, so there is no checkbox to re-check.

## **It cannot send anything yet, and it says so loudly**

There is no `worker/templates/email/charge-reminder.md` body. Writing one would
be writing user-facing copy, which is Sci's alone (legal brief §5), so the file
exists with front matter and a single `TODO(Sci):` naming the two sentences
needed — exactly the state `partial-footer.md` was in until Sci wrote it.

`Template.ready_to_send` is false while that marker is in the body, so the
**sweep checks it before writing anything**. A blocked sweep:

  * inserts no `billing_reminders` row, so nothing is recorded as sent and the
    reminder is not lost — the day the copy lands, that day's charges are still
    swept;
  * enqueues no job, so the queue does not fill with rows that fail four times
    over forty minutes;
  * writes a `billing.reminder_blocked` event **with the number of subscribers
    it would have written to**, and logs at ERROR.

That last point is the whole design. B32's lesson is that *a feed which never
enqueues also never fails, which is precisely why it was invisible*; a run that
produced no result has to say so loudly rather than exit green.

## The clocks (CLAUDE.md)

Every date compared here is computed `at time zone 'America/Sao_Paulo'`,
because `next_charge_on` and `ends_on` are dates a person reads and
`subscriptions.updated_at` is UTC. A `date.today()` on this process would be
the container's clock, which is neither.
"""

from __future__ import annotations

from dataclasses import dataclass
from logging import Logger
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from . import config, product, queue, resend, templates
from .breaker import CircuitOpen
from .email import CHANNEL as EMAIL_CHANNEL
from .email import EVENT_DRY_RUN, EVENT_FAILED, EVENT_SENT, EVENT_SKIPPED
from .observability import get_logger
from .registry import REGISTRY, JobContext
from .resend import ResendClient, ResendError

#: The daily sweeps, enqueued by `scheduler.py`, and the per-subscriber send.
REMINDER_SWEEP_KIND = "charge_reminder"
EXPIRE_KIND = "expire_subscriptions"
SEND_KIND = "send_billing_email"

#: `billing_reminders.kind`. The other two values the column allows —
#: `payment_failed` and `suspension` — are the rest of F4 and nothing writes
#: them; see the card, not this comment.
REMINDER_ROW_KIND = "charge_reminder"

#: The template Sci has to write. `worker/templates/email/charge-reminder.md`.
REMINDER_TEMPLATE = "charge-reminder"

#: Events. The delivery log reuses `email.py`'s names on purpose, so one query
#: answers "what e-mail reached this person?" across every sender.
EVENT_REMINDER_BLOCKED = "billing.reminder_blocked"
EVENT_REMINDER_QUEUED = "billing.reminder_queued"
EVENT_EXPIRED = "billing.expired"

#: Why a send did not happen. Stable strings: they reach the log and
#: `events.props`, and a dashboard groups by them.
SKIP_NO_SUBSCRIPTION = "no_subscription"
SKIP_CANCELLED = "cancelled"
SKIP_NO_EMAIL = "no_email"
SKIP_TEMPLATE_BLOCKED = "template_blocked"

#: Statuses a reminder is owed for. Not `canceled` — spec §10 says so outright
#: — and not `pending`, which has never been paid, so "a cobrança de sempre"
#: would be its first.
REMINDABLE = ("active", "overdue")

_log = get_logger("billing")

DUE_SQL = """
select s.asaas_subscription_id,
       s.user_id,
       s.plan,
       s.amount,
       s.next_charge_on,
       u.email,
       u.name
  from subscriptions s
  join users u on u.id = s.user_id
 where s.status = any(%(statuses)s)
   and s.ends_on is null
   and s.next_charge_on = (
         (now() at time zone 'America/Sao_Paulo')::date
         + make_interval(days => %(days)s)
       )::date
 order by s.asaas_subscription_id
"""

CLAIM_REMINDER_SQL = """
insert into billing_reminders (asaas_subscription_id, due_on, kind)
values (%(subscription)s, %(due_on)s, %(kind)s)
on conflict (asaas_subscription_id, due_on, kind) do nothing
returning asaas_subscription_id
"""

ATTACH_JOB_SQL = """
update billing_reminders
   set job_id = %(job_id)s
 where asaas_subscription_id = %(subscription)s
   and due_on = %(due_on)s
   and kind = %(kind)s
"""

RELEASE_REMINDER_SQL = """
delete from billing_reminders
 where asaas_subscription_id = %(subscription)s
   and due_on = %(due_on)s
   and kind = %(kind)s
"""

REMINDER_ROW_SQL = """
select s.asaas_subscription_id,
       s.plan,
       s.amount,
       s.next_charge_on,
       u.email,
       u.name,
       s.status,
       -- What Asaas will actually take on that date, when it has already told
       -- us. `subscriptions.amount` is what we asked for at checkout and goes
       -- stale the moment F3 changes the Asaas value or an overdue re-charge
       -- carries interest. Spec §10: the reminder states the amount.
       (select p.value
          from subscription_payments p
         where p.asaas_subscription_id = s.asaas_subscription_id
           and p.due_on = s.next_charge_on
         order by p.created_at desc
         limit 1) as charge_value
  from subscriptions s
  join users u on u.id = s.user_id
 where s.user_id = %(user_id)s
   and s.asaas_subscription_id = %(subscription)s
"""

ALREADY_SENT_SQL = """
select exists (
  select 1 from events
   where name = %(event)s
     and props ->> 'subscription' = %(subscription)s
     and props ->> 'due_on' = %(due_on)s
     and props ->> 'template' = %(template)s
)
"""

#: The downgrade. Scoped to accounts with **no other** live subscription, so
#: somebody who cancelled and subscribed again is not dropped to Básico by the
#: expiry of the row they replaced.
EXPIRE_SQL = """
update users u
   set plan = 'basico'
  from subscriptions s
 where s.user_id = u.id
   and s.status = 'canceled'
   and s.ends_on is not null
   and s.ends_on < (now() at time zone 'America/Sao_Paulo')::date
   and u.plan <> 'basico'
   and not exists (
         select 1 from subscriptions live
          where live.user_id = u.id
            and live.status in ('pending', 'active', 'overdue', 'suspended')
       )
returning u.id, s.asaas_subscription_id, s.ends_on
"""


@dataclass(frozen=True, slots=True)
class Sweep:
    """What one sweep did. Carries no personal data."""

    due: int = 0
    queued: int = 0
    blocked: bool = False


@dataclass(frozen=True, slots=True)
class Delivery:
    """The outcome of one ``send_billing_email`` job. No personal data."""

    outcome: str
    template: str
    reason: str | None = None
    message_id: str | None = None


def default_client() -> ResendClient:
    """A seam, so a test can replace the transport. Resolves no credentials."""
    return ResendClient()


def reminder_job_key(subscription_id: str, due_on: str) -> str:
    """One send per (subscription, due date) — the same pair as the row.

    `jobs_dedupe` is unique on ``(kind, key)`` while a job is queued or
    running, so a sweep that somehow ran twice in the same second dedupes here
    too, behind the primary key that already stopped it.
    """
    return f"reminder:{subscription_id}:{due_on}"


# -- the reminder sweep -------------------------------------------------------


@REGISTRY.job(REMINDER_SWEEP_KIND)
def charge_reminder(ctx: JobContext) -> None:
    """Queue one reminder per charge falling due in `chargeReminderDays`."""
    sweep(ctx.conn, log=ctx.log)


def sweep(conn: psycopg.Connection, *, log: Logger | None = None) -> Sweep:
    """Find the charges due, claim each one, enqueue its message."""
    log = log or _log
    with conn.cursor() as cur:
        cur.execute(
            DUE_SQL,
            {"statuses": list(REMINDABLE), "days": product.CHARGE_REMINDER_DAYS},
        )
        rows = cur.fetchall()
        columns = [column.name for column in cur.description or ()]
    due = [dict(zip(columns, row, strict=True)) for row in rows]

    if not template_ready():
        # Loud, and **before** anything is claimed: a claimed row would record
        # a reminder as handled on a day nothing could be sent, and the charge
        # would arrive with no warning. See the module docstring.
        _record(
            conn,
            EVENT_REMINDER_BLOCKED,
            None,
            {
                "template": REMINDER_TEMPLATE,
                "reason": SKIP_TEMPLATE_BLOCKED,
                "subscribers": len(due),
            },
        )
        log.error(
            "charge_reminder blocked: template not ready to send",
            extra={"template": REMINDER_TEMPLATE, "subscribers": len(due)},
        )
        return Sweep(due=len(due), queued=0, blocked=True)

    queued = 0
    for row in due:
        subscription = str(row["asaas_subscription_id"])
        due_on = str(row["next_charge_on"])
        with conn.cursor() as cur:
            cur.execute(
                CLAIM_REMINDER_SQL,
                {"subscription": subscription, "due_on": due_on, "kind": REMINDER_ROW_KIND},
            )
            claimed = cur.fetchone() is not None
        if not claimed:
            continue

        # **The claim is committed before the enqueue, so a failed enqueue has
        # to give it back.** ``ctx.conn`` is autocommit (``registry.py``), so
        # the row above is already durable; if ``queue.enqueue`` raises, the
        # primary key makes tomorrow's sweep skip this charge and it arrives
        # with no warning — the exact outcome this module exists to prevent.
        # ``RELEASE_REMINDER_SQL`` was written for this and was called from
        # nowhere until review said so, which is the dead-constant shape
        # CLAUDE.md names five worked examples of.
        try:
            job_id = queue.enqueue(
                conn,
                SEND_KIND,
                reminder_job_key(subscription, due_on),
                priority=4,
                payload={
                    "template": REMINDER_TEMPLATE,
                    "user_id": int(row["user_id"]),
                    "subscription": subscription,
                    "due_on": due_on,
                },
            )
        except Exception:
            with conn.cursor() as cur:
                cur.execute(
                    RELEASE_REMINDER_SQL,
                    {
                        "subscription": subscription,
                        "due_on": due_on,
                        "kind": REMINDER_ROW_KIND,
                    },
                )
            log.exception(
                "charge_reminder could not enqueue; claim released",
                extra={"subscription": subscription, "due_on": due_on},
            )
            raise
        if job_id is None:
            # The claim succeeded and the enqueue deduped, which means a live
            # job for this pair already exists. Leave the row; it is the record
            # of *this* charge's reminder either way.
            queued += 1
            continue
        with conn.cursor() as cur:
            cur.execute(
                ATTACH_JOB_SQL,
                {
                    "job_id": job_id,
                    "subscription": subscription,
                    "due_on": due_on,
                    "kind": REMINDER_ROW_KIND,
                },
            )
        queued += 1

    _record(conn, EVENT_REMINDER_QUEUED, None, {"due": len(due), "queued": queued})
    log.info("charge_reminder swept", extra={"due": len(due), "queued": queued})
    return Sweep(due=len(due), queued=queued)


def template_ready() -> bool:
    """Whether the reminder template exists and can render **a whole e-mail**.

    Separate from the render itself so the sweep can refuse *before* it claims
    anything. A missing file and an unresolved ``TODO(Sci):`` are the same
    answer here: there is no message to send.

    **It also requires a subject**, which ``Template.ready_to_send`` does not —
    that property is only ``TODO_MARKER not in body``. ``charge-reminder.md``
    has no ``subject:``, so the day Sci writes the body and removes the marker
    without adding one, the sweep would pass, claim a ``billing_reminders``
    row, enqueue, and ``render_subject`` would raise: the job fails, the claim
    survives the retry, and tomorrow's sweep looks for ``next_charge_on =
    today + 3`` and never sees that charge again. **One cohort of reminders,
    lost silently, on the day the copy landed.** Found by review.
    """
    try:
        template = templates.load(EMAIL_CHANNEL, REMINDER_TEMPLATE)
    except templates.TemplateError:
        return False
    return template.ready_to_send and bool(template.subject)


# -- the message --------------------------------------------------------------


@REGISTRY.job(SEND_KIND)
def send_billing_email(ctx: JobContext) -> None:
    """Render and send one billing message. Idempotent (§7.2)."""
    payload = ctx.payload
    required = ("template", "user_id", "subscription", "due_on")
    missing = [key for key in required if not payload.get(key)]
    if missing:
        # Our own caller wrote a bad row: a visible failure, not a silent skip.
        raise ValueError(f"send_billing_email payload needs {', '.join(missing)}")
    send(
        ctx.conn,
        template=str(payload["template"]),
        user_id=int(payload["user_id"]),
        subscription_id=str(payload["subscription"]),
        due_on=str(payload["due_on"]),
        job_id=ctx.job.id,
        attempt=ctx.job.attempts,
        log=ctx.log,
    )


def send(
    conn: psycopg.Connection,
    *,
    template: str,
    user_id: int,
    subscription_id: str,
    due_on: str,
    client: ResendClient | None = None,
    job_id: int | None = None,
    attempt: int | None = None,
    log: Logger | None = None,
) -> Delivery:
    """Gate, render, send, log. Raises only for a retryable fault."""
    log = log or _log
    client = client or default_client()
    common: dict[str, Any] = {
        "template": template,
        "subscription": subscription_id,
        "due_on": due_on,
    }

    with conn.cursor() as cur:
        cur.execute(REMINDER_ROW_SQL, {"user_id": user_id, "subscription": subscription_id})
        row = cur.fetchone()
        columns = [column.name for column in cur.description or ()]
    if row is None:
        return _skip(conn, log, user_id, common, SKIP_NO_SUBSCRIPTION, job_id, attempt)
    found = dict(zip(columns, row, strict=True))

    # Spec §10: *"never sent for a cancelled subscription"*. Re-checked here
    # rather than trusted from the sweep — the cancel can land in the minutes
    # between the two, and that is exactly the message a cancelled subscriber
    # must not receive.
    if str(found["status"]) not in REMINDABLE:
        return _skip(conn, log, user_id, common, SKIP_CANCELLED, job_id, attempt, level="warning")
    address = found.get("email")
    if not address:
        return _skip(conn, log, user_id, common, SKIP_NO_EMAIL, job_id, attempt, level="warning")
    if _already_sent(conn, template, subscription_id, due_on):
        # §7.2: a job can run twice. Per-recipient, per-event evidence is
        # `events`, not `billing_reminders` — E4's lesson, where `jobs.status =
        # 'done'` said a message had been sent for days while the transport was
        # off.
        return Delivery(outcome="skipped", reason="already_sent", template=template)

    # A template fault raises out of here on purpose: it is our bug, not the
    # recipient's, and a visible failed job is better than a silently skipped
    # subscriber. The sweep's `template_ready()` means this is unreachable for
    # the ordinary case.
    context = build_context(found)
    loaded = templates.load(EMAIL_CHANNEL, template)
    subject = loaded.render_subject(context)
    body = loaded.render(context)
    for partial_id in loaded.partials:
        body = f"{body}\n\n{templates.load(EMAIL_CHANNEL, partial_id).render(context)}"

    try:
        result = client.send(to=str(address), subject=subject, text=body)
    except CircuitOpen as exc:
        _record(conn, EVENT_FAILED, user_id, {**common, "reason": exc.name, "job_id": job_id})
        log.warning("billing e-mail skipped: circuit open", extra={**common, "reason": exc.name})
        raise
    except ResendError as exc:
        _record(
            conn,
            EVENT_FAILED,
            user_id,
            {**common, "reason": exc.reason, "status": exc.status, "job_id": job_id},
        )
        log.warning(
            "billing e-mail failed",
            extra={**common, "reason": exc.reason, "retryable": exc.retryable},
        )
        if exc.retryable:
            raise
        # 400/401/403/404/422: retrying fails identically (§7.2). The job is
        # done; the delivery log says it was not delivered and why.
        #
        # Spec §10's own clause for this: *"e-mail failure is logged and does
        # not block the charge"*. The charge is Asaas's and we never touched it.
        return Delivery(outcome="failed", reason=exc.reason, template=template)

    name = EVENT_SENT if result.delivered else EVENT_DRY_RUN
    _record(
        conn,
        name,
        user_id,
        {**common, "message_id": result.message_id, "status": result.status_code, "job_id": job_id},
    )
    log.info(
        "billing e-mail sent" if result.delivered else "billing e-mail not sent (dry run)",
        extra={**common, "outcome": result.status, "delivery_mode": resend.delivery_mode()},
    )
    return Delivery(outcome=result.status, message_id=result.message_id, template=template)


def build_context(row: dict[str, Any]) -> dict[str, Any]:
    """The render context for a billing message.

    Every product number comes from :mod:`licitaqui.product` through
    ``template_context()``, so a price here cannot disagree with the price on
    the screen or in the terms. The two values this adds are per-subscriber
    facts, not product facts: **the date of the charge and the amount**, which
    spec §10 requires the reminder to state.
    """
    # **The amount that will be charged, exactly, and preferring the charge
    # itself.** Spec §10 requires the reminder to state it.
    #
    # Two corrections from review. `subscription_payments.value` is what Asaas
    # will take — our `subscriptions.amount` is what we asked for at checkout,
    # and the two diverge the moment F3 changes the Asaas value, or an overdue
    # re-charge carries interest. And the first version went through
    # `int(round(float(amount)))`, which silently rounds a non-whole value to
    # the nearest real: a reminder saying R$ 58,00 for a charge of R$ 57,50.
    #
    # `numeric(10,2)` arrives as a Decimal and formats exactly, so the format
    # is done here rather than through `product.brl_exact`, which takes whole
    # reais only. `test_billing.py` asserts the two agree on the whole case so
    # they cannot drift into two spellings of one price.
    amount = row.get("charge_value") or row.get("amount")
    charged = f"R$ {amount:.2f}".replace(".", ",") if amount is not None else ""
    return {
        **product.template_context(),
        "nome": row.get("name") or "",
        "data_cobranca": _brt_date(row.get("next_charge_on")),
        "valor_cobranca": charged,
        "nome_plano": str(row.get("plan") or "").capitalize(),
        "email_contato": "contato@licitaquiapp.com.br",
        "link_assinatura": f"{config.app_base_url()}/conta/plano",
        "link_privacidade": f"{config.app_base_url()}/privacidade",
    }


def _brt_date(value: Any) -> str:
    """``date(2026, 11, 17)`` → ``"17/11/2026"``.

    Reordered, never converted: the column is a `date`, written at
    America/Sao_Paulo, and treating it as an instant would print the day before
    for every reader in Brazil.
    """
    if value is None:
        return ""
    text = str(value)[:10]
    parts = text.split("-")
    return f"{parts[2]}/{parts[1]}/{parts[0]}" if len(parts) == 3 else text


# -- the downgrade sweep ------------------------------------------------------


@REGISTRY.job(EXPIRE_KIND)
def expire_subscriptions(ctx: JobContext) -> None:
    """Drop to Básico the accounts whose paid period has run out."""
    expire(ctx.conn, log=ctx.log)


def expire(conn: psycopg.Connection, *, log: Logger | None = None) -> int:
    """Return how many accounts were downgraded."""
    log = log or _log
    with conn.cursor() as cur:
        cur.execute(EXPIRE_SQL)
        rows = cur.fetchall()
    for user_id, subscription_id, ends_on in rows:
        _record(
            conn,
            EVENT_EXPIRED,
            int(user_id),
            {"subscription": str(subscription_id), "ends_on": str(ends_on)},
        )
    if rows:
        log.info("expired cancelled subscriptions", extra={"accounts": len(rows)})
    return len(rows)


# -- the delivery log ---------------------------------------------------------


def _already_sent(
    conn: psycopg.Connection, template: str, subscription_id: str, due_on: str
) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            ALREADY_SENT_SQL,
            {
                "event": EVENT_SENT,
                "subscription": subscription_id,
                "due_on": due_on,
                "template": template,
            },
        )
        row = cur.fetchone()
    return bool(row and row[0])


def _record(
    conn: psycopg.Connection, name: str, user_id: int | None, props: dict[str, Any]
) -> None:
    """One log row.

    `events.user_id` is a real column with a foreign key, and the worker's
    older senders put the id in `props` instead — so any per-user aggregation
    over `events.user_id` misses every billing row. This fills the column.
    """
    with conn.cursor() as cur:
        cur.execute(
            "insert into events (user_id, name, props) values (%s, %s, %s)",
            (user_id, name, Jsonb({k: v for k, v in props.items() if v is not None})),
        )


def _skip(
    conn: psycopg.Connection,
    log: Logger,
    user_id: int | None,
    common: dict[str, Any],
    reason: str,
    job_id: int | None,
    attempt: int | None,
    *,
    level: str = "info",
) -> Delivery:
    props = {**common, "reason": reason, "job_id": job_id, "attempt": attempt}
    _record(conn, EVENT_SKIPPED, user_id, props)
    getattr(log, level)(f"billing e-mail skipped: {reason}", extra={**common, "reason": reason})
    return Delivery(outcome="skipped", reason=reason, template=str(common["template"]))
