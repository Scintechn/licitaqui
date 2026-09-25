"""The ``send_email`` job: the founders e-mails, and nothing without consent.

Mirrors :mod:`licitaqui.whatsapp` — read that module's docstring first for the
shape this follows (the payload contract, the gates, the delivery log living
in ``events``, the kill switch living in the transport rather than the job).
This module calls out only where e-mail differs.

## The payload

Same shape as ``send_whatsapp``'s, and deliberately: F1 (`apps/web/lib/founders
/signup.ts`) inserts both rows in the **same statement** that seats a founder,
so the two are never out of step with each other::

    kind    = 'send_email'
    key     = 'founders:' || <founders_list id>
    payload = {template, founders_list_id, numero_vaga, posicao_espera}

## Three gates, not four

WhatsApp has an opt-out reply (``SAIR``) because it is a two-way channel;
e-mail here is not — templates README defines no inbound e-mail handling, and
building one is not this card's to add. So the gates are:

1. :data:`SKIP_NO_RECIPIENT` — the row exists.
2. :data:`SKIP_NO_CONSENT` — ``founders_list.contact_consent``. The **same**
   checkbox ``send_whatsapp`` gates on: ``consent.founders`` promises "por
   e-mail e WhatsApp" behind one ``z.literal(true)``, not two, so there is only
   one fact in the database to check and this re-checks it independently
   rather than trusting the job was only ever enqueued when it held —
   defence in depth, the same reasoning `whatsapp.send()` applies to the
   number.
3. :data:`SKIP_NO_EMAIL` — ``founders_list.email`` is ``not null`` in the
   schema, so this exists for the same reason ``SKIP_NO_NUMBER`` exists on a
   column the application cannot currently leave blank: a defensive gate, not
   a case F1 can produce today.

And one more that is not a gate but an outcome: :data:`SKIP_ALREADY_SENT`, for
the same reason ``send_whatsapp`` has one — a job can run twice (§7.2).

## No pacing

Spec §9's ~20–30 s cadence exists because Evolution is an unofficial API where
a burst risks the number being banned. Resend is a transactional e-mail API
with no such constraint stated anywhere in the spec, so unlike
``whatsapp.send()`` this does not call anything like ``wait_for_slot`` — there
is not one to call.

## What actually blocks a real send today

Every one of the three approved templates in ``worker/templates/email/``
declares ``partials: [partial-footer]``, and ``partial-footer.md`` is
``status: draft`` with two literal ``TODO(Sci):`` lines **in its body**
(templates README §7 leaves those there on purpose — a question for Sci, not
copy). :func:`render_email` walks a template's declared partials and renders
each one, so a call for any of the three raises ``TemplateNotApproved`` from
the footer — not a bug here, the same rule `whatsapp.send()` already lives by
for ``optout-confirmation``. ``email/founders-opening.md`` carries a *second*,
independent ``TODO(Sci):`` of its own (about the subscription price on
08/10), so it is blocked twice over even once the footer is written.

Nobody may write that copy but Sci (legal brief §5), so this module is built
and proven against synthetic templates in the test suite: the gates, the
render pipeline (subject, body, footer) and the delivery log are all real and
tested ahead of the copy that unblocks a first real send.

## The delivery log

`events`, namespaced ``email.*`` — the same table and the same reasoning as
`whatsapp.py`'s own docstring, which applies here unchanged: a new table is a
migration, and migrations are their own PR. Carries no personal data.
"""

from __future__ import annotations

from dataclasses import dataclass
from logging import Logger
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from . import queue, resend, templates
from .breaker import CircuitOpen
from .observability import get_logger
from .registry import REGISTRY, JobContext
from .resend import ResendClient, ResendError, SendResult
from .whatsapp import build_context as _base_context

#: The kind F1 enqueues, mirroring `WELCOME_JOB_KIND` (`apps/web/lib/founders
#: /signup.ts`).
JOB_KIND = "send_email"

CHANNEL = "email"

#: Delivery log, in `events` (see the module docstring).
EVENT_SENT = "email.sent"
EVENT_DRY_RUN = "email.dry_run"
EVENT_SKIPPED = "email.skipped"
EVENT_FAILED = "email.failed"

#: Why a send did not happen. Stable strings: they end up in the log and in
#: `events.props`, and a dashboard will group by them. See `whatsapp.py` for
#: why each one names exactly one cause.
SKIP_NO_RECIPIENT = "no_recipient"
SKIP_NO_CONSENT = "no_consent"
SKIP_NO_EMAIL = "no_email"
SKIP_ALREADY_SENT = "already_sent"

#: `docs/legal/LEGAL_AND_BILLING_BRIEF.md` §1's published support address —
#: the same constant `telegram_alerts.py` already sends in its own templates.
#: Not a decision this task made.
CONTACT_EMAIL = "contato@licitaquiapp.com.br"

_log = get_logger("email")

RECIPIENT_SQL = """
select name, email, contact_consent
  from founders_list
 where id = %(id)s
"""

ALREADY_SENT_SQL = """
select exists (
  select 1 from events
   where name = %(event)s
     and props ->> 'founders_list_id' = %(id)s
     and props ->> 'template' = %(template)s
)
"""


def default_client() -> ResendClient:
    """The client :func:`send` uses when the caller does not pass one.

    A seam, so a test can replace the transport without reaching into
    :class:`ResendClient` itself. Building one is free and resolves no
    credentials; see :mod:`licitaqui.resend`.
    """
    return ResendClient()


@dataclass(frozen=True, slots=True)
class Delivery:
    """The outcome of one ``send_email`` job. Carries no personal data."""

    outcome: str
    founders_list_id: int
    template: str
    reason: str | None = None
    message_id: str | None = None
    duration_ms: int | None = None

    @property
    def delivered(self) -> bool:
        return self.outcome == "sent"


# -- enqueueing ----------------------------------------------------------------


def job_key(founders_list_id: int) -> str:
    """The key F1 writes, identical to `whatsapp.job_key`'s: `founders:<id>`.

    The two kinds sharing one key is deliberate, not a collision — `jobs_dedupe`
    is unique on ``(kind, key)``, so `send_whatsapp` and `send_email` each keep
    their own row under the same key without conflicting.
    """
    return f"founders:{founders_list_id}"


def enqueue(
    conn: psycopg.Connection,
    founders_list_id: int,
    template: str,
    *,
    priority: int = 3,
    **payload: Any,
) -> int | None:
    """Queue a message. F1 does this inline in SQL; this is for tests and any
    future caller that wants it, mirroring `whatsapp.enqueue`."""
    return queue.enqueue(
        conn,
        JOB_KIND,
        job_key(founders_list_id),
        priority=priority,
        payload={"template": template, "founders_list_id": founders_list_id, **payload},
    )


# -- context -----------------------------------------------------------------


def build_context(*, name: str, payload: dict[str, Any], template_id: str) -> dict[str, Any]:
    """The render context for a founders e-mail.

    Reuses `whatsapp.build_context` for everything channel-agnostic — the
    name, the seat, the waitlist position, the opening-day link — so the two
    channels can never quietly disagree about what ``{{numero_vaga}}`` or
    ``{{data_abertura}}`` means, and adds only what e-mail needs on top:
    ``email_contato``, which every one of the three approved bodies declares.
    """
    context = _base_context(name=name, payload=payload, template_id=template_id)
    context["email_contato"] = CONTACT_EMAIL
    return context


# -- rendering -----------------------------------------------------------------


def render_email(template_id: str, context: dict[str, Any]) -> tuple[str, str]:
    """The rendered ``(subject, body)`` for one e-mail template, footer included.

    Templates README §4: "every email ends with partial-footer" — a fixed
    channel rule, not a per-template choice — so this walks whatever the
    template declares in ``partials`` (today, always exactly that one) rather
    than hardcoding the id. A partial that cannot render raises out of here
    exactly the way the main template would; see the module docstring.
    """
    template = templates.load(CHANNEL, template_id)
    subject = template.render_subject(context)
    body = template.render(context)
    for partial_id in template.partials:
        body = f"{body}\n\n{templates.load(CHANNEL, partial_id).render(context)}"
    return subject, body


# -- sending -------------------------------------------------------------------


def send(
    conn: psycopg.Connection,
    *,
    founders_list_id: int,
    template: str,
    payload: dict[str, Any] | None = None,
    client: ResendClient | None = None,
    job_id: int | None = None,
    attempt: int | None = None,
    log: Logger | None = None,
) -> Delivery:
    """Run the gates, render, send, log. Raises only for a retryable fault."""
    log = log or _log
    payload = payload or {}
    client = client or default_client()
    common = {"founders_list_id": founders_list_id, "template": template}

    row = _recipient(conn, founders_list_id)
    if row is None:
        return _skip(conn, log, common, SKIP_NO_RECIPIENT, job_id, attempt)
    name, address, consent = row

    # LGPD (§12): consent is mandatory before any contact. Nothing below this
    # line runs without it.
    if not consent:
        return _skip(conn, log, common, SKIP_NO_CONSENT, job_id, attempt, level="warning")
    if not address:
        return _skip(conn, log, common, SKIP_NO_EMAIL, job_id, attempt, level="warning")
    if _already_sent(conn, founders_list_id, template):
        return _skip(conn, log, common, SKIP_ALREADY_SENT, job_id, attempt)

    # A template fault (a missing placeholder, an unresolved TODO(Sci)) raises
    # out of here on purpose: it is our bug, not the recipient's, and it should
    # be a visible failed job rather than a silently skipped founder. Today
    # this is where every one of the three approved templates stops — see the
    # module docstring.
    context = build_context(name=name, payload=payload, template_id=template)
    subject, body = render_email(template, context)

    try:
        result = client.send(to=address, subject=subject, text=body)
    except CircuitOpen as exc:
        _record_failure(conn, common, "circuit_open", job_id, attempt)
        log.warning("email send skipped: circuit open", extra={**common, "reason": exc.name})
        raise
    except ResendError as exc:
        _record_failure(conn, common, exc.reason, job_id, attempt, status=exc.status)
        log.warning(
            "email send failed",
            extra={
                **common,
                "reason": exc.reason,
                "status": exc.status,
                "retryable": exc.retryable,
            },
        )
        if exc.retryable:
            raise
        # 400/401/403/404/422: retrying will fail identically (§7.2). The job
        # is done; the delivery log says it was not delivered and why.
        return Delivery(outcome="failed", reason=exc.reason, **common)

    return _record_success(conn, log, common, result, job_id, attempt)


# -- handlers ------------------------------------------------------------------


@REGISTRY.job(JOB_KIND)
def send_email(ctx: JobContext) -> None:
    """Handler for F1's enqueued welcome/waitlist e-mail. Idempotent (§7.2)."""
    founders_list_id = ctx.payload.get("founders_list_id")
    template = ctx.payload.get("template")
    if not founders_list_id or not template:
        # Our own caller wrote a bad row: visible failure, not a silent skip.
        raise ValueError("send_email payload needs 'founders_list_id' and 'template'")
    send(
        ctx.conn,
        founders_list_id=int(founders_list_id),
        template=str(template),
        payload=ctx.payload,
        job_id=ctx.job.id,
        attempt=ctx.job.attempts,
        log=ctx.log,
    )


# -- delivery log ----------------------------------------------------------


def _recipient(conn: psycopg.Connection, founders_list_id: int) -> tuple[str, str, bool] | None:
    with conn.cursor() as cur:
        cur.execute(RECIPIENT_SQL, {"id": founders_list_id})
        return cur.fetchone()


def _already_sent(conn: psycopg.Connection, founders_list_id: int, template: str) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            ALREADY_SENT_SQL,
            {"event": EVENT_SENT, "id": str(founders_list_id), "template": template},
        )
        row = cur.fetchone()
    return bool(row and row[0])


def _record(conn: psycopg.Connection, name: str, props: dict[str, Any]) -> None:
    """One delivery-log row. Callers pass no personal data; see the docstring."""
    with conn.cursor() as cur:
        cur.execute(
            "insert into events (name, props) values (%s, %s)",
            (name, Jsonb({k: v for k, v in props.items() if v is not None})),
        )


def _skip(
    conn: psycopg.Connection,
    log: Logger,
    common: dict[str, Any],
    reason: str,
    job_id: int | None,
    attempt: int | None,
    *,
    level: str = "info",
) -> Delivery:
    _record(conn, EVENT_SKIPPED, {**common, "reason": reason, "job_id": job_id, "attempt": attempt})
    getattr(log, level)(f"email send skipped: {reason}", extra={**common, "reason": reason})
    return Delivery(outcome="skipped", reason=reason, **common)


def _record_failure(
    conn: psycopg.Connection,
    common: dict[str, Any],
    reason: str,
    job_id: int | None,
    attempt: int | None,
    *,
    status: int | None = None,
) -> None:
    _record(
        conn,
        EVENT_FAILED,
        {**common, "reason": reason, "status": status, "job_id": job_id, "attempt": attempt},
    )


def _record_success(
    conn: psycopg.Connection,
    log: Logger,
    common: dict[str, Any],
    result: SendResult,
    job_id: int | None,
    attempt: int | None,
) -> Delivery:
    name = EVENT_SENT if result.delivered else EVENT_DRY_RUN
    _record(
        conn,
        name,
        {
            **common,
            "message_id": result.message_id,
            "status": result.status_code,
            "duration_ms": result.duration_ms,
            "job_id": job_id,
            "attempt": attempt,
        },
    )
    log.info(
        "email sent" if result.delivered else "email not sent (dry run)",
        extra={
            **common,
            "outcome": result.status,
            "duration_ms": result.duration_ms,
            "delivery_mode": resend.delivery_mode(),
        },
    )
    return Delivery(
        outcome=result.status,
        message_id=result.message_id,
        duration_ms=result.duration_ms,
        **common,
    )
