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

## The copy landed on 2026-10-12, and the gate stayed

Sci approved the subject and the body on 2026-10-12 (**F24**), so
`worker/templates/email/charge-reminder.md` is no longer a draft and the sweep
no longer blocks. The gate below is kept exactly as it was, because what it
guards is not *"has Sci written it yet"* but *"can this render a whole
e-mail"*, and the answer can go back to no — a renamed placeholder, a footer
that grows a fourth one, a file moved in a refactor.

## **Two channels, and only one of them is promised**

Terms §7: *"Avisamos você **por e-mail** 3 (três) dias antes de cada cobrança,
informando a data e o valor… Se você tiver informado um celular com WhatsApp,
avisamos também por lá"*, and §12 makes e-mail *"o canal oficial"*. So the
e-mail is the obligation and the WhatsApp copy is **additive**:
:func:`send_charge_notice_whatsapp` runs after the e-mail is recorded, never
raises, and every refusal is a logged outcome rather than a failure. A Pix
subscriber gets one `type: "url"` button to the Asaas invoice; a card
subscriber gets no button, because the card charges itself.

## **What this still cannot do truthfully, and it is not the copy — F22**

`build_context` binds ``data_cobranca`` from ``subscriptions.next_charge_on``,
and **F22 measured that column holding the day the subscription was *paid***
rather than the next due date — Asaas's own `GET /v3/subscriptions` returned
`nextDueDate` a full cycle later for the same row. Terms §7 requires this
notice to state *"a data e o valor que será cobrado"*, so until F22 lands the
date in the sentence is the column's, and the column is wrong on the path F22
describes. This module is deliberately built **against the column as the source
of truth** rather than recomputing the date here: two derivations of one fact is
how the defect started. The sweep's own predicate limits the damage in the
meantime — ``next_charge_on = today + 3`` cannot match a date in the past, so a
row still carrying the paid day is swept into nothing rather than into a wrong
e-mail — but that is a mitigation, not the fix.

A blocked sweep (whatever blocks it):

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

import time
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, timedelta
from logging import Logger
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from . import config, evolution, product, queue, resend, templates, whatsapp
from .breaker import CircuitOpen
from .email import CHANNEL as EMAIL_CHANNEL
from .email import EVENT_DRY_RUN, EVENT_FAILED, EVENT_SENT, EVENT_SKIPPED
from .evolution import EvolutionClient, EvolutionError
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

#: The reminder's copy, approved by Sci on 2026-10-12.
#: `worker/templates/email/charge-reminder.md`, and the WhatsApp copy of the
#: same notice under the same id in `worker/templates/whatsapp/`.
REMINDER_TEMPLATE = "charge-reminder"

#: The button's label, as it was sent to Sci's handset and approved on
#: 2026-10-12. One button, `type: "url"`, to the Asaas invoice — see
#: :data:`licitaqui.evolution.BUTTON_TYPE_URL` for why there is no second one
#: and why `pix` is not an option.
WHATSAPP_BUTTON_TEXT = "💳 Pagar agora"

#: The button message's footer. The brand name, which `CLAUDE.md` fixes, and
#: not a sentence — a sentence would be copy, and copy is Sci's (brief §5).
WHATSAPP_FOOTER = "LicitaQui"

#: Asaas's `billingType` for the method that does **not** charge itself. Terms
#: §7's notice goes to everybody by e-mail; the *"Pagar agora"* button only
#: makes sense to somebody who has to pay it by hand.
BILLING_TYPE_PIX = "PIX"

#: Events. The delivery log reuses `email.py`'s names on purpose, so one query
#: answers "what e-mail reached this person?" across every sender.
EVENT_REMINDER_BLOCKED = "billing.reminder_blocked"
EVENT_REMINDER_QUEUED = "billing.reminder_queued"
#: One row per subscriber whose notice could not be **filled in** — a binding
#: the template needs that this row cannot supply, which `template_ready()`
#: cannot see because it is per subscriber and not per template. Nothing is
#: claimed for them, and this is the loud half of that. See **F29**.
EVENT_REMINDER_UNRENDERABLE = "billing.reminder_unrenderable"
EVENT_EXPIRED = "billing.expired"

#: **The counter that makes a silent degradation visible.** One row per message
#: that went out as plain text because Evolution refused the button payload —
#: `rpatinacao`'s 2026-06-09 incident recorded `status: "sent"` for exactly
#: that and nobody saw it for days. The `whatsapp.sent` row beside it also
#: carries `fallback: true`, so a count and a per-recipient answer are both one
#: query, but this name exists so the count needs no `props` filter at all.
EVENT_WHATSAPP_FALLBACK = "billing.whatsapp_fallback"

#: Why the additive WhatsApp copy did not go. The e-mail is the channel the
#: contract names (terms §7, §12), so none of these is a failure of the notice.
SKIP_NO_WHATSAPP = "no_whatsapp"
SKIP_OPTED_OUT = "opted_out"
#: **We cannot honour an opt-out for this number, so we do not message it.**
#: See :func:`_optout_is_enforceable`. Distinct from ``opted_out``: that one
#: means somebody asked us to stop, this one means we could not hear them ask.
SKIP_NO_OPTOUT_PATH = "no_optout_path"
SKIP_NO_PAYMENT_LINK = "no_payment_link"
SKIP_AMBIGUOUS_LINK = "ambiguous_payment_link"
SKIP_NOT_PIX = "charges_itself"
SKIP_UNKNOWN_METHOD = "unknown_method"
SKIP_CHARGE_SETTLED = "charge_settled"
SKIP_WHATSAPP_SENT = "already_sent"
SKIP_EMAIL_NOT_SENT = "email_not_sent"

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
       -- **`users.name` is nullable and the body opens `Olá, {{nome}}!`.**
       -- `0001_initial.sql:156` allows null and `lib/auth/adapter.ts` writes
       -- `user.name ?? null`, which is what the Resend magic-link provider
       -- supplies — no name at all. `templates.py` refuses to render a *blank*
       -- value as hard as a missing one, so that subscriber's notice raises.
       -- The founders list has the name they typed, under the same e-mail, so
       -- it is recovered here rather than guessed at. Found by review; the
       -- residual (no name in either table) is **F29** and the sweep below
       -- refuses to claim it rather than burning the reminder on it.
       coalesce(u.name, f.name) as name
  from subscriptions s
  join users u on u.id = s.user_id
  left join founders_list f on f.email = u.email
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
       -- The Asaas `invoiceUrl` of the charge that is payable, kept pointed at
       -- it by the webhook (`lib/asaas/entitlement.ts`, `refreshCheckoutUrl`).
       -- It is `{{link_pagamento}}` and the WhatsApp button's destination.
       -- Personal data: it opens one named customer's invoice, so it is never
       -- logged and never put in `events.props` (§12).
       --
       -- **It is per *subscription*, not per charge**, which is the one thing
       -- to know about it: `refreshCheckoutUrl` overwrites it on every payment
       -- event whose status is payable, so it holds the invoice of the charge
       -- most recently announced as payable rather than of a named one. With a
       -- single payable charge the two are the same charge; with two — an
       -- overdue month beside the next one, which is terms §7's grace period —
       -- the last event wins and it may be the older charge. Hence
       -- `payable_charges` below. **F28** stores the per-charge URL.
       s.checkout_url,
       u.email,
       -- `users.name` is nullable; the founders list holds the name they
       -- typed, under the same e-mail. See `DUE_SQL`, and **F29**.
       coalesce(u.name, f.name) as name,
       -- The additive WhatsApp copy terms §7 allows. Never logged (§12).
       u.whatsapp,
       s.status,
       -- **The announced charge itself**, read once rather than three times.
       --
       -- `value` is what Asaas will actually take on that date, when it has
       -- already told us: `subscriptions.amount` is what we asked for at
       -- checkout and goes stale the moment F3 changes the Asaas value or an
       -- overdue re-charge carries interest. Spec §10: the reminder states the
       -- amount.
       --
       -- `billing_type` is how a Pix subscriber is told from a card one
       -- **without calling Asaas per sweep** — F24 asks for exactly that and
       -- F25 proposes a column for it, but the charge being announced already
       -- carries the answer, and this is the first branch to read a field
       -- F14 recorded as written-by-`upsertPayment`-and-read-by-nothing. A
       -- card charges itself, so a card subscriber gets no *"Pagar agora"*.
       --
       -- `status` is here so the button is offered only for a charge somebody
       -- still has to pay; a settled or refunded one is a receipt.
       charge.value        as charge_value,
       charge.billing_type as charge_billing_type,
       charge.status       as charge_status,
       -- **How many charges of this subscription somebody still has to pay.**
       --
       -- The one number that makes `checkout_url` attributable. It is written
       -- per subscription, so it only provably belongs to the charge this
       -- notice announces when that charge is the *only* payable one — and
       -- then it must, because the last payable event was its own. More than
       -- one and the link is a coin toss between a charge and its overdue
       -- predecessor, so the button is withheld rather than aimed at a guess
       -- (`SKIP_AMBIGUOUS_LINK`). The statuses are a parameter, from
       -- :func:`whatsapp_payable_statuses`, so this cannot acquire a second
       -- copy of the allow-list.
       (select count(*)
          from subscription_payments p
         where p.asaas_subscription_id = s.asaas_subscription_id
           and p.status = any(%(payable)s)) as payable_charges
  from subscriptions s
  join users u on u.id = s.user_id
  left join founders_list f on f.email = u.email
  left join lateral (
        select p.value, p.billing_type, p.status
          from subscription_payments p
         where p.asaas_subscription_id = s.asaas_subscription_id
           and p.due_on = s.next_charge_on
         order by p.created_at desc
         limit 1
       ) charge on true
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
    #: Subscribers whose notice could not be filled in, so **nothing was
    #: claimed** for them. Never zero quietly: the sweep logs each one at ERROR
    #: and writes `billing.reminder_unrenderable`.
    unrenderable: int = 0


@dataclass(frozen=True, slots=True)
class Delivery:
    """The outcome of one ``send_billing_email`` job. No personal data.

    ``whatsapp`` is the outcome of the **additive** copy terms §7 allows, or
    ``None`` when it was never reached. It is on the e-mail's own result rather
    than returned separately because the WhatsApp half must never change
    whether the job succeeded: e-mail is the contractual channel, and a caller
    that could confuse the two would be able to retry a sent e-mail because a
    WhatsApp message did not render a button.
    """

    outcome: str
    template: str
    reason: str | None = None
    message_id: str | None = None
    whatsapp: str | None = None


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
    unrenderable = 0
    for row in due:
        subscription = str(row["asaas_subscription_id"])
        due_on = str(row["next_charge_on"])

        # **Render before claiming.** The claim is committed and the sweep only
        # ever looks for `today + 3`, so a render that raises *after* the claim
        # loses that subscriber's notice for ever — and `template_ready()`
        # above cannot see it, because it is a per-subscriber fault rather than
        # a per-template one.
        #
        # Review found the live instance: `users.name` is nullable, the body
        # opens `Olá, {{nome}}!`, and `templates.py` refuses a blank value as
        # hard as a missing one. `coalesce(u.name, f.name)` in `DUE_SQL`
        # recovers the ordinary case; this is the structural half, and it holds
        # for **any** binding that can come back empty rather than only for
        # that one.
        #
        # Nothing is claimed, so the row is swept again tomorrow — and tomorrow
        # it is `today + 2` and will not match, which is why this is **loud**
        # rather than quiet. **F29** is the fix for the residual.
        problem = unrenderable_reason(row)
        if problem is not None:
            _record(
                conn,
                EVENT_REMINDER_UNRENDERABLE,
                int(row["user_id"]),
                {
                    "template": REMINDER_TEMPLATE,
                    "subscription": subscription,
                    "due_on": due_on,
                    "reason": problem,
                },
            )
            log.error(
                "charge_reminder cannot render this subscriber's notice; nothing claimed",
                extra={"subscription": subscription, "due_on": due_on, "reason": problem},
            )
            unrenderable += 1
            continue

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

    _record(
        conn,
        EVENT_REMINDER_QUEUED,
        None,
        {"due": len(due), "queued": queued, "unrenderable": unrenderable or None},
    )
    log.info(
        "charge_reminder swept",
        extra={"due": len(due), "queued": queued, "unrenderable": unrenderable},
    )
    return Sweep(due=len(due), queued=queued, unrenderable=unrenderable)


def unrenderable_reason(row: dict[str, Any]) -> str | None:
    """Why this subscriber's notice cannot be rendered, or ``None``.

    Renders the **whole e-mail** the sender would render — subject, body and
    every partial — from this row's own context, and returns the placeholder
    that refused. It is the per-subscriber half of :func:`template_ready`: that
    one asks *"is there a message at all"*, this one asks *"can it be filled in
    for this person"*, and only the second can see a null `users.name`.

    The reason is a **placeholder name**, never a value: the values are
    people's names (§12). A fault that is not a missing placeholder is reported
    by its exception class for the same reason.
    """
    context = build_context(row)
    try:
        loaded = templates.load(EMAIL_CHANNEL, REMINDER_TEMPLATE)
        loaded.render_subject(context)
        loaded.render(context)
        for partial_id in loaded.partials:
            templates.load(EMAIL_CHANNEL, partial_id).render(context)
    except templates.MissingPlaceholder as exc:
        return f"{exc.placeholder}:{exc.reason}"
    except templates.TemplateError as exc:
        return type(exc).__name__
    return None


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
        cur.execute(
            REMINDER_ROW_SQL,
            {
                "user_id": user_id,
                "subscription": subscription_id,
                "payable": sorted(whatsapp_payable_statuses()),
            },
        )
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

    # **Additive, and after the e-mail on purpose.** Terms §7: *"Avisamos você
    # por e-mail … Se você tiver informado um celular com WhatsApp, avisamos
    # também por lá"*, and §12 makes e-mail the official channel. So the
    # WhatsApp copy is a second delivery of a notice that has already been
    # sent, it is attempted only once the required one is recorded, and it
    # cannot fail this job — see the function's own docstring.
    whatsapp_outcome = send_charge_notice_whatsapp(
        conn,
        found=found,
        user_id=user_id,
        context=context,
        subscription_id=subscription_id,
        due_on=due_on,
        template=template,
        email_delivered=result.delivered,
        job_id=job_id,
        log=log,
    )
    return Delivery(
        outcome=result.status,
        message_id=result.message_id,
        template=template,
        whatsapp=whatsapp_outcome,
    )


# -- the additive WhatsApp copy (terms §7) ------------------------------------


def send_charge_notice_whatsapp(
    conn: psycopg.Connection,
    *,
    found: dict[str, Any],
    user_id: int,
    context: dict[str, Any],
    subscription_id: str,
    due_on: str,
    template: str,
    email_delivered: bool = True,
    client: EvolutionClient | None = None,
    job_id: int | None = None,
    sleep: Any = time.sleep,
    log: Logger | None = None,
) -> str:
    """The same notice on WhatsApp, as one ``url`` button. **Never raises.**

    Terms §7 promises the notice by e-mail and adds *"Se você tiver conectado
    WhatsApp ou Telegram, avisamos também por lá"*. So this is additive: the
    contractual delivery has already happened by the time it runs, and every
    outcome here — including a failure — is a line in the delivery log rather
    than an exception. Raising would retry a job whose e-mail is already sent,
    four times over forty minutes, for a message the contract treats as extra.

    **Who gets it, and why each refusal is a refusal.**

    * no number on `users` — nothing to dial;
    * the announced charge is not Pix — a card charges itself, so *"Pagar
      agora"* would be an instruction to do something unnecessary (**F24**);
    * we cannot see the announced charge at all, so we cannot tell which method
      it is — the allow-list fails safe, as `AWAITING` does on the web side;
    * the charge is already settled — the notice is still owed by e-mail, but
      there is nothing left to pay;
    * no `checkout_url` — there is no destination, and a button with no URL is
      precisely `rpatinacao`'s 06-09 incident wearing our own code;
    * more than one payable charge — `checkout_url` is per subscription, so it
      cannot be attributed to the charge this notice names (**F28**);
    * a recorded ``SAIR`` — spec §9. The e-mail still goes, because terms §7 is
      a term of the contract and `SAIR` is a WhatsApp instruction.

    The number is normalised, dialled and discarded inside
    :mod:`licitaqui.evolution`; it never reaches a log line or `events.props`,
    and neither does the invoice URL (§12).

    **Two consequences of never raising, stated rather than implied.** A
    transient WhatsApp fault is *not* retried — the job is done, because its
    e-mail is sent, and nothing re-attempts the additive copy. And the
    guarantee is "never raises for a transport, a copy or a dialling fault": a
    `psycopg` error from this function's own queries would propagate like any
    other database fault, which is correct, because at that point the delivery
    log itself is not working.
    """
    log = log or _log
    client = client or EvolutionClient()
    common = {"template": template, "subscription": subscription_id, "due_on": due_on}

    # **The additive channel may not deliver what the required one did not.**
    # The two kill switches are independent — `EMAIL_DELIVERY` and
    # `WHATSAPP_DELIVERY` — so a tree with Resend in dry run and Evolution live
    # would send the *extra* copy of a notice the **official** channel (terms
    # §12) never sent, which inverts the contract this function is built
    # around, and would be a real message to a real subscriber from a
    # half-configured environment. Found by review.
    #
    # Both off is the ordinary CI and laptop case and stays on the dry-run
    # path, so the whole thing is still exercised with no socket opened.
    if not email_delivered and evolution.sending_enabled():
        return _whatsapp_skip(conn, log, user_id, common, SKIP_EMAIL_NOT_SENT, level="warning")

    number = str(found.get("whatsapp") or "").strip()
    if not number:
        return _whatsapp_skip(conn, log, user_id, common, SKIP_NO_WHATSAPP)

    method = str(found.get("charge_billing_type") or "").strip().upper()
    if not method:
        return _whatsapp_skip(conn, log, user_id, common, SKIP_UNKNOWN_METHOD, level="warning")
    if method != BILLING_TYPE_PIX:
        return _whatsapp_skip(conn, log, user_id, common, SKIP_NOT_PIX)

    status = str(found.get("charge_status") or "").strip().upper()
    if status and status not in whatsapp_payable_statuses():
        return _whatsapp_skip(conn, log, user_id, common, SKIP_CHARGE_SETTLED)

    link = str(context.get("link_pagamento") or "").strip()
    if not link:
        return _whatsapp_skip(conn, log, user_id, common, SKIP_NO_PAYMENT_LINK, level="warning")

    # **The button is withheld rather than aimed at a guess** — and this gate
    # narrows the window without closing it, which review corrected an earlier
    # comment here for claiming.
    #
    # `subscriptions.checkout_url` is per subscription, not per charge. This
    # count is **current** state; the column is a **historical last write**, and
    # `refreshCheckoutUrl` writes *only* for a payable status — a
    # `PAYMENT_RECEIVED` returns early and never clears it. So: two payable
    # charges (this gate fires, correctly), the subscriber pays the older one,
    # and three days later exactly one charge is payable while the column still
    # holds the **settled** invoice. The same thing happens whenever a payload
    # arrives with no `invoiceUrl`, which Asaas's own docs warn about.
    #
    # It is still worth gating: it removes the case where the link is ambiguous
    # *at the moment of sending*. **F28** is the fix — the per-charge URL — and
    # it deletes this gate.
    if int(found.get("payable_charges") or 0) > 1:
        return _whatsapp_skip(conn, log, user_id, common, SKIP_AMBIGUOUS_LINK, level="warning")

    # **There is no consent gate here, and that is a decision with a date.**
    #
    # Between 2026-10-13 and this commit there was one: F31 made
    # ``users.whatsapp`` required, which ended the accident that had kept this
    # channel off (every account's number was null, so ``SKIP_NO_WHATSAPP``
    # stopped every send), and nothing recorded agreement. Sci then ruled that
    # no checkbox is needed and amended the documents instead, so the basis for
    # **this one message** is execution of contract rather than consent:
    #
    # * terms §7 — *"Avisamos você por e-mail 3 dias antes de cada cobrança…
    #   Se você tiver **informado um celular com WhatsApp**, avisamos também
    #   por lá"* (v1.3, 13/10/2026). The condition is now one the product can
    #   satisfy; it used to say *"conectado"*, which nothing could.
    # * `politica-de-privacidade.md` §5 and §6 (v1.4) — *"não dependem de
    #   consentimento: são obrigação nossa prevista nos termos de uso"*.
    #
    # **One thing that keeps load-bearing**, and one that turned out not to be
    # true when review checked it.
    #
    # The number must be the one the subscriber *informed when subscribing*,
    # which is `users.whatsapp` and why the query above reads it **bare** —
    # adding the `founders_list` fallback would message a number given for
    # *"o aviso de abertura das vagas"*, which the amendment does not cover.
    # That is **F36**, and it stays blocked.
    #
    # The comment here used to add *"and SAIR still stops the channel, below"*.
    # **It does not**, for anybody who was not on the founders list — the
    # opt-out is keyed on a `founders_list` id and nothing enqueues the inbound
    # job at all. That is :func:`_optout_is_enforceable` below and card
    # **F40**, and it is the reason the WhatsApp copy is withheld rather than
    # sent with a remedy nobody can use.
    if _opted_out(conn, number):
        return _whatsapp_skip(conn, log, user_id, common, SKIP_OPTED_OUT)

    # **The promise above has to be keepable before the message goes out.**
    if not _optout_is_enforceable(conn, number):
        return _whatsapp_skip(conn, log, user_id, common, SKIP_NO_OPTOUT_PATH, level="warning")

    # §7.2: a job can run twice. Per-recipient evidence is `events`, and the
    # row this reads is the one written below.
    if _already_sent_on_whatsapp(conn, template, subscription_id, due_on):
        return SKIP_WHATSAPP_SENT

    try:
        loaded = templates.load(whatsapp.CHANNEL, template)
        description = loaded.render(context)
        title = loaded.render_subject(context)
    except templates.TemplateError:
        # Our bug, not the recipient's, and the e-mail has already gone. Loud
        # in the log and in `events`, and not an exception, because the
        # contractual delivery must not be retried for this.
        _whatsapp_failure(conn, user_id, common, SKIP_TEMPLATE_BLOCKED, job_id)
        log.exception("whatsapp charge notice could not be rendered", extra=common)
        return "failed"

    if evolution.sending_enabled():
        # Spec §9's pacing, read from the same delivery log the founders sender
        # uses — which is why the row below is written under `whatsapp.sent`
        # rather than a billing-only name: one ledger, one number, one rate.
        whatsapp.wait_for_slot(conn, sleep=sleep, log=log)

    try:
        result = client.send_url_button(
            number,
            title=title,
            description=description,
            footer=WHATSAPP_FOOTER,
            button_text=WHATSAPP_BUTTON_TEXT,
            url=link,
        )
    except CircuitOpen as exc:
        _whatsapp_failure(conn, user_id, common, "circuit_open", job_id)
        log.warning(
            "whatsapp charge notice skipped: circuit open",
            extra={**common, "reason": exc.name},
        )
        return "failed"
    except EvolutionError as exc:
        _whatsapp_failure(conn, user_id, common, exc.reason, job_id, status=exc.status)
        log.warning("whatsapp charge notice failed", extra={**common, "reason": exc.reason})
        return "failed"
    except ValueError as exc:
        # A number the row holds but Evolution cannot dial. The message of the
        # ValueError never contains it (`evolution.normalise_number`).
        _whatsapp_failure(conn, user_id, common, whatsapp.SKIP_INVALID_NUMBER, job_id)
        log.warning("whatsapp number is unusable", extra={**common, "reason": str(exc)})
        return "failed"

    if result.fallback:
        # `messages: 2` because the fallback is **two requests** — the refused
        # `sendButtons` and the `sendText` that carried the URL — inside one
        # §9 pacing slot, while the ledger below records one delivery. Pacing
        # reads `max(created_at)`, so the *timing* is unaffected; what this
        # prop makes countable is the request count, which is the number that
        # matters on an unofficial instance. Review's finding; the alternative
        # was to sleep 20–30 s between the two, which delays a payment notice
        # for a message the reader is already owed.
        _record(
            conn,
            EVENT_WHATSAPP_FALLBACK,
            user_id,
            {**common, "reason": result.fallback_reason, "messages": 2, "job_id": job_id},
        )
        log.error(
            "whatsapp charge notice went out without its button; the URL is inlined",
            extra={**common, "reason": result.fallback_reason},
        )

    _record(
        conn,
        whatsapp.EVENT_SENT if result.delivered else whatsapp.EVENT_DRY_RUN,
        user_id,
        {
            **common,
            "message_id": result.message_id,
            "status": result.status_code,
            "duration_ms": result.duration_ms,
            "fallback": result.fallback or None,
            "job_id": job_id,
        },
    )
    log.info(
        "whatsapp charge notice sent" if result.delivered else "whatsapp charge notice (dry run)",
        extra={**common, "outcome": result.status, "delivery_mode": evolution.delivery_mode()},
    )
    return result.status


def whatsapp_payable_statuses() -> frozenset[str]:
    """Asaas statuses that mean *"somebody still has to pay this"*.

    The same allow-list as `lib/asaas/entitlement.ts`'s ``AWAITING``, and an
    allow-list for the same reason it is one there: a status we do not
    recognise must not become a *"Pagar agora"* button. Duplicated rather than
    imported because the two live in different languages; `test_billing.py`
    asserts the two spellings agree.
    """
    return frozenset({"PENDING", "OVERDUE", "AWAITING_RISK_ANALYSIS", "APPROVED_BY_RISK_ANALYSIS"})


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
    start, end = _cycle_window(row.get("next_charge_on"))
    return {
        **product.template_context(),
        "nome": row.get("name") or "",
        "data_cobranca": _brt_date(row.get("next_charge_on")),
        "valor_cobranca": charged,
        "nome_plano": str(row.get("plan") or "").capitalize(),
        # Sci, 2026-10-12: *"state the new cycle from-date to-date"*.
        "inicio_ciclo": start,
        "fim_ciclo": end,
        # **The Asaas invoice page for the charge being announced.**
        # `link_assinatura` below is `/conta/plano` and is *not* this: that is
        # our own screen, where a subscriber cancels. This is where the money
        # is paid, and it is the destination of the WhatsApp button.
        #
        # Blank when `subscriptions.checkout_url` is null, which is a state
        # rather than a fault — before the first charge exists there is nothing
        # to point at. No template declares it, so a blank never reaches
        # `templates.py`'s own refusal to render one; the WhatsApp notice gates
        # on it instead (:func:`send_charge_notice_whatsapp`).
        "link_pagamento": str(row.get("checkout_url") or ""),
        "email_contato": "contato@licitaquiapp.com.br",
        "link_assinatura": f"{config.app_base_url()}/conta/plano",
        "link_privacidade": f"{config.app_base_url()}/privacidade",
        # **`partial-footer` declares this and nothing here bound it**, which
        # is the defect `email.py:136` already records in full: approving that
        # footer did not break the founders e-mails, it *uncovered* that the
        # sender bound one of its three placeholders. Every billing e-mail
        # appends the same footer, so the day the reminder's copy landed — and
        # that is this change — `render` would have raised `MissingPlaceholder`
        # on the footer, the job would have failed, the `billing_reminders`
        # claim would have survived the retry, and tomorrow's sweep would look
        # for `today + 3` and never see that charge again: **one cohort of
        # reminders lost on the day the copy arrived**, which is the same
        # failure `template_ready()`'s docstring was written against.
        #
        # A subscriber is not a founder: they have an account, so the screen
        # where notifications are managed is one they can actually open, and
        # `email.py`'s `mailto:…?subject=SAIR` is the answer for somebody with
        # no login rather than the better one. The footer's sentence around it
        # is still wrong for a notice terms §7 obliges us to send and
        # `notifications.billingHelp` says cannot be switched off — that is
        # copy, so it is Sci's, and it is `TO_VALIDATE` **H**.
        "link_preferencias": f"{config.app_base_url()}/conta/alertas",
    }


def _cycle_window(value: Any) -> tuple[str, str]:
    """``{{inicio_ciclo}}`` and ``{{fim_ciclo}}``: the period one charge pays for.

    Monthly cycle, derived from the charge date, and the arithmetic is::

        inicio_ciclo = data_cobranca
        fim_ciclo    = (data_cobranca + 1 month, day clamped to that month's
                        length) − 1 day

    so 17/11/2026 → *17/11/2026 a 16/12/2026*, and the next cycle starts on the
    next charge rather than overlapping this one.

    **The clamp is Asaas's own.** A charge due 31/01 advances to 28/02, not to
    31/02, so clamping to the shorter month gives 28/02 − 1 day = 27/02 and the
    window still ends the day before the charge that follows it. Without the
    clamp this would raise.

    **No clock is read and no conversion is done.** ``next_charge_on`` is a
    `date` already written at ``America/Sao_Paulo`` (the product's clock), so
    this is calendar arithmetic on that date — never ``datetime.now()``, which
    would be the container's clock, and never a UTC instant, which on a
    UTC+1 laptop prints the day before for every reader in Brazil.
    """
    charge = _as_date(value)
    if charge is None:
        return "", ""
    year = charge.year + (1 if charge.month == 12 else 0)
    month = 1 if charge.month == 12 else charge.month + 1
    day = min(charge.day, monthrange(year, month)[1])
    end = date(year, month, day) - timedelta(days=1)
    return _brt_date(charge), _brt_date(end)


def _as_date(value: Any) -> date | None:
    """A `date` from what psycopg hands us, or from its text, or ``None``.

    Shares :func:`_brt_date`'s tolerance of a string, for the same reason: the
    column is a `date`, and a value that arrived as text must not be parsed as
    an instant.
    """
    if isinstance(value, date):
        return value
    if value is None:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


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


def _already_sent_on_whatsapp(
    conn: psycopg.Connection, template: str, subscription_id: str, due_on: str
) -> bool:
    """Has this notice already gone out on WhatsApp for this charge?

    The same query as :func:`_already_sent`, with ``whatsapp.sent`` in place of
    ``email.sent`` — two channels, one shape, so the second one cannot acquire
    its own subtly different idea of what "already sent" means.
    """
    with conn.cursor() as cur:
        cur.execute(
            ALREADY_SENT_SQL,
            {
                "event": whatsapp.EVENT_SENT,
                "subscription": subscription_id,
                "due_on": due_on,
                "template": template,
            },
        )
        row = cur.fetchone()
    return bool(row and row[0])


def _optout_is_enforceable(conn: psycopg.Connection, number: str) -> bool:
    """Whether a ``SAIR`` from **this** number could actually stop the channel.

    **False for everybody who is not on the founders list, which after F31 is
    most subscribers — found by review on 2026-10-13, and it is why this gate
    exists rather than a comment.**

    The policy amendment Sci approved that day promises the remedy in writing:
    `politica-de-privacidade.md` §6 — *"Você pode pedir para parar de
    recebê-los no WhatsApp respondendo **SAIR** — eles continuam chegando por
    e-mail"* — and terms §7 says the same. Two things make that promise
    undeliverable today, and both are measured rather than suspected:

    1. **The opt-out is keyed on a `founders_list` id, not on a number.**
       :func:`_opted_out` resolves through ``whatsapp.resolve_number``, whose
       ``RESOLVE_NUMBER_SQL`` is ``select id from founders_list where …``. A
       subscriber who filled F31's profile form and was never on that list
       resolves to ``None``, so ``_opted_out`` returns ``False`` **always** —
       and ``record_optout`` takes a ``founders_list_id``, so there is nowhere
       to record their refusal either.
    2. **Nothing enqueues the job that would record one.**
       ``whatsapp.INBOUND_JOB_KIND`` has a handler and a registration and **no
       producer**: there is no WhatsApp webhook route — ``apps/web/app/api/``
       holds ``asaas/webhook`` and ``telegram/webhook`` and nothing else. A
       reply of ``SAIR`` reaches no code at all.

    So until **F40** builds the inbound route and keys the opt-out on the
    number, a notice sent here could not be stopped by the person receiving
    it. Sending anyway would make §6 a sentence the product does not mean,
    which is what `docs/CLAIMS.md` exists to prevent — so the WhatsApp copy is
    withheld and the **e-mail still goes**, which is the channel terms §7
    actually obliges us to use.

    It is a function with one place to change, logged at ``warning`` and
    counted as :data:`SKIP_NO_OPTOUT_PATH` in the sweep, so the cost of the gap
    is visible rather than being a channel that is quietly off.
    """
    _ = (conn, number)
    return False


def _opted_out(conn: psycopg.Connection, number: str) -> bool:
    """Whether this number has ever replied ``SAIR`` (spec §9).

    The opt-out is recorded against a `founders_list` id, not a number, so the
    number is resolved first — by digits, so a row typed `+55 (11) 9…` and a
    WhatsApp JID of `5511 9…` are the same person. A subscriber who was never
    on the founders list resolves to nothing and has never opted out, which is
    the correct answer rather than a missing one.

    The number is a query parameter throughout and is never logged (§12).
    """
    try:
        founder = whatsapp.resolve_number(conn, number)
    except ValueError:
        return False
    return founder is not None and whatsapp.has_opted_out(conn, founder)


def _whatsapp_skip(
    conn: psycopg.Connection,
    log: Logger,
    user_id: int | None,
    common: dict[str, Any],
    reason: str,
    *,
    level: str = "info",
) -> str:
    _record(conn, whatsapp.EVENT_SKIPPED, user_id, {**common, "reason": reason})
    getattr(log, level)(
        f"whatsapp charge notice skipped: {reason}", extra={**common, "reason": reason}
    )
    return "skipped"


def _whatsapp_failure(
    conn: psycopg.Connection,
    user_id: int | None,
    common: dict[str, Any],
    reason: str,
    job_id: int | None,
    *,
    status: int | None = None,
) -> None:
    _record(
        conn,
        whatsapp.EVENT_FAILED,
        user_id,
        {**common, "reason": reason, "status": status, "job_id": job_id},
    )


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
