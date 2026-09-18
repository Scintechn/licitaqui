"""The ``send_whatsapp`` job: the founders welcome, and nothing without consent.

F1 already enqueues this. `apps/web/lib/founders/signup.ts` writes, inside the
same statement that hands out the seat::

    kind    = 'send_whatsapp'
    key     = 'founders:' || <founders_list id>
    payload = {template, founders_list_id, numero_vaga, posicao_espera}

That is the contract, consumed here as written — the payload deliberately
carries no phone number, so the queue never holds a second copy of one and a
correction to the `founders_list` row is picked up by the send.

## Four gates before a message

Spec §12 makes consent mandatory before any contact, and §9 adds that Evolution
is an unofficial API where misuse costs the number. So a send happens only when
**all four** of these hold, checked in this order and each one recorded:

1. :data:`SKIP_NO_RECIPIENT` — the row exists.
2. :data:`SKIP_NO_CONSENT` — ``founders_list.contact_consent`` is true. This is
   the LGPD gate. A refusal is final, not a temporary failure: the job finishes
   `done` rather than retrying four times against a decision that will not
   change, and the log line says so without naming the person.
3. :data:`SKIP_OPTED_OUT` — no ``SAIR`` reply has been recorded for this
   founder. See :func:`record_optout`.
4. :data:`SKIP_NO_NUMBER` — the row actually has a WhatsApp number.

And one more that is not a gate but an outcome: :data:`SKIP_ALREADY_SENT`. A job
can run twice (§7.2), so a template already delivered to this founder is not
delivered again.

Above all of them sits :data:`licitaqui.evolution.DELIVERY_VAR` — the kill
switch. With it off (the default) every one of these gates still runs, the
message is still rendered, the delivery is still logged, and nothing leaves the
process.

## The delivery log

`events`, not a new table: `db/migrations` changes belong in their own PR
(CLAUDE.md), and B4 and R1 are writing migrations in parallel. The rows are
namespaced ``whatsapp.*`` — the same shape B2 uses for ``sync_open_tenders.*``.

**Nothing in a delivery row identifies a person.** The columns are the
`founders_list` id, the template, the job and attempt, the outcome and, when
there is one, Evolution's message id and the round-trip time. No number, no
name, no e-mail, and no rendered message body: §12, and the body contains the
name. The id is a foreign key into a table that has the person, which is what
makes a support request answerable without the log itself carrying the data.

## Pacing

Spec §9: roughly one message every 20–30 s, no bulk blasts. The wait is
computed from the delivery log rather than from a counter in memory, so it
holds across consumer threads, containers and restarts — the thing an in-memory
rate limiter gets wrong the first time the worker is scaled to two. Only real
sends are recorded as sends, so a dry run never makes the next real message
wait.
"""

from __future__ import annotations

import os
import random
import re
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import UTC, date, datetime
from logging import Logger
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from . import evolution, queue, templates
from .breaker import CircuitOpen
from .evolution import EvolutionClient, EvolutionError, SendResult
from .observability import get_logger
from .registry import REGISTRY, JobContext

#: The kind F1 enqueues (`apps/web/lib/founders/signup.ts`, `WELCOME_JOB_KIND`).
JOB_KIND = "send_whatsapp"
#: An inbound reply, already resolved to a founder. See :func:`enqueue_inbound`.
INBOUND_JOB_KIND = "whatsapp_inbound"

CHANNEL = "whatsapp"

#: Delivery log, in `events` (see the module docstring).
EVENT_SENT = "whatsapp.sent"
EVENT_DRY_RUN = "whatsapp.dry_run"
EVENT_SKIPPED = "whatsapp.skipped"
EVENT_FAILED = "whatsapp.failed"
EVENT_OPTOUT = "whatsapp.optout"

#: Why a send did not happen. Stable strings: they end up in the log and in
#: `events.props`, and a dashboard will group by them.
SKIP_NO_RECIPIENT = "no_recipient"
SKIP_NO_CONSENT = "no_consent"
SKIP_OPTED_OUT = "opted_out"
SKIP_NO_NUMBER = "no_number"
SKIP_INVALID_NUMBER = "invalid_number"
SKIP_ALREADY_SENT = "already_sent"

#: Spec §9: ≈ 1 message every 20–30 s. Jittered so a burst of signups does not
#: produce a metronome, which is exactly what a spam heuristic looks for.
MIN_INTERVAL_SECONDS = 20.0
MAX_INTERVAL_SECONDS = 30.0
#: Never block a consumer thread longer than this, whatever the log says. A
#: clock skew between containers must not wedge the queue.
MAX_WAIT_SECONDS = 35.0

#: Opening day (`docs/DEVELOPMENT_PLAN.md` M3: 08/10 at 19:00), overridable so a
#: slipped date is an env change rather than a deploy. ``{{data_abertura}}``.
OPENING_DATE_VAR = "FOUNDERS_OPENING_DATE"
DEFAULT_OPENING_DATE = date(2026, 10, 8)

MONTHS_PT = (
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
)

#: The template a ``SAIR`` reply is answered with, and the only message the
#: worker may send to a number that has opted out (templates README §5).
OPTOUT_TEMPLATE = "optout-confirmation"

#: A reply counts as an opt-out when the whole message, normalised, is one of
#: these. Deliberately exact rather than "contains sair": a founder writing
#: "vou sair de viagem, mando depois" must not be silently unsubscribed, and
#: the copy only ever promises the bare word (templates README §4). Over-wide
#: matching and under-wide matching are both wrong; this errs towards the
#: promise the copy makes, and Sci reads the replies in the first week.
OPTOUT_PHRASES = frozenset(
    {
        "sair",
        "parar",
        "pare",
        "stop",
        "cancelar",
        "descadastrar",
        "remover",
        "quero sair",
        "nao quero mais",
        "nao quero mais receber",
        "sair da lista",
    }
)

_log = get_logger("whatsapp")

#: Only one thread of this process waits for a send slot at a time, so two
#: consumers cannot both decide the coast is clear. The cross-process half of
#: the same guarantee is the delivery-log read inside :func:`wait_for_slot`.
_SLOT_LOCK = threading.Lock()

RECIPIENT_SQL = """
select name, whatsapp, contact_consent
  from founders_list
 where id = %(id)s
"""

OPTED_OUT_SQL = """
select exists (
  select 1 from events
   where name = %(event)s
     and props ->> 'founders_list_id' = %(id)s
)
"""

ALREADY_SENT_SQL = """
select exists (
  select 1 from events
   where name = %(event)s
     and props ->> 'founders_list_id' = %(id)s
     and props ->> 'template' = %(template)s
)
"""

LAST_SENT_SQL = "select max(created_at) from events where name = %(event)s"

# The number is compared as digits so a row typed as `+55 (11) 9…` and an
# Evolution JID of `5511 9…` are the same person. `founders_list` is 48 rows at
# most, so the sequential scan this implies is not worth an index (and an index
# is a migration, which is not this PR's to write).
RESOLVE_NUMBER_SQL = """
select id
  from founders_list
 where regexp_replace(coalesce(whatsapp, ''), '\\D', '', 'g') = %(digits)s
    or regexp_replace(coalesce(whatsapp, ''), '\\D', '', 'g') = %(national)s
 order by id
 limit 1
"""


def default_client() -> EvolutionClient:
    """The client :func:`send` uses when the caller does not pass one.

    A seam, so a test can replace the transport without reaching into
    :class:`EvolutionClient` itself. Building one is free and resolves no
    credentials; see :mod:`licitaqui.evolution`.
    """
    return EvolutionClient()


@dataclass(frozen=True, slots=True)
class Delivery:
    """The outcome of one ``send_whatsapp`` job. Carries no personal data."""

    outcome: str
    founders_list_id: int
    template: str
    reason: str | None = None
    message_id: str | None = None
    duration_ms: int | None = None

    @property
    def delivered(self) -> bool:
        return self.outcome == "sent"


# -- context ---------------------------------------------------------------


def opening_date() -> date:
    raw = (os.environ.get(OPENING_DATE_VAR) or "").strip()
    return date.fromisoformat(raw) if raw else DEFAULT_OPENING_DATE


def format_date_pt(value: date) -> str:
    """``8 de outubro de 2026`` — the format templates README §3 expects."""
    return f"{value.day} de {MONTHS_PT[value.month - 1]} de {value.year}"


def first_name(full_name: str) -> str:
    """ "Oi, {{nome}}!" wants a first name, not a legal name.

    Never logged, never stored: this value only ever reaches the rendered
    message body, which is itself never persisted (§12).
    """
    parts = full_name.split()
    if not parts:
        raise ValueError("founder has no name")
    return parts[0]


def build_context(*, name: str, payload: dict[str, Any], template_id: str) -> dict[str, Any]:
    """The render context for a founders template.

    Only the keys the template declares are supplied; anything the template
    needs and this does not provide makes :meth:`Template.render` raise, which
    is the behaviour templates README §3 requires.
    """
    context: dict[str, Any] = {"nome": first_name(name)}
    if template_id == "founders-welcome":
        context["numero_vaga"] = payload.get("numero_vaga")
        context["data_abertura"] = format_date_pt(opening_date())
    elif template_id == "founders-waitlist":
        context["posicao_espera"] = payload.get("posicao_espera")
    return context


# -- pacing ----------------------------------------------------------------


def seconds_until_slot(
    conn: psycopg.Connection, *, interval: float, now: datetime | None = None
) -> float:
    """How long to wait before the next real send, from the delivery log."""
    with conn.cursor() as cur:
        cur.execute(LAST_SENT_SQL, {"event": EVENT_SENT})
        row = cur.fetchone()
    last = row[0] if row else None
    if last is None:
        return 0.0
    moment = now or datetime.now(UTC)
    if last.tzinfo is None:  # pragma: no cover - Neon returns timestamptz
        last = last.replace(tzinfo=UTC)
    return max(0.0, interval - (moment - last).total_seconds())


def wait_for_slot(
    conn: psycopg.Connection,
    *,
    sleep: Any = time.sleep,
    interval: float | None = None,
    log: Logger | None = None,
) -> float:
    """Hold until this process may send again (§9). Returns the seconds waited."""
    log = log or _log
    with _SLOT_LOCK:
        wanted = (
            interval
            if interval is not None
            else random.uniform(MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)
        )
        delay = min(seconds_until_slot(conn, interval=wanted), MAX_WAIT_SECONDS)
        if delay > 0:
            log.info("pacing whatsapp send", extra={"wait_s": round(delay, 1)})
            sleep(delay)
        return delay


# -- opt-out ---------------------------------------------------------------


def normalise_reply(text: str) -> str:
    """Casefold, strip accents and punctuation, collapse whitespace."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    cleaned = re.sub(r"[^\w\s]", " ", stripped, flags=re.UNICODE)
    return re.sub(r"\s+", " ", cleaned).strip().casefold()


def is_optout_reply(text: str) -> bool:
    """Whether an inbound message is a ``SAIR``. See :data:`OPTOUT_PHRASES`."""
    return normalise_reply(text) in OPTOUT_PHRASES


def has_opted_out(conn: psycopg.Connection, founders_list_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute(OPTED_OUT_SQL, {"event": EVENT_OPTOUT, "id": str(founders_list_id)})
        row = cur.fetchone()
    return bool(row and row[0])


def record_optout(
    conn: psycopg.Connection, founders_list_id: int, *, source: str = "reply"
) -> None:
    """Write the opt-out. Idempotent in effect: the check is ``exists``."""
    _record(conn, EVENT_OPTOUT, {"founders_list_id": founders_list_id, "source": source})


def resolve_number(conn: psycopg.Connection, number: str) -> int | None:
    """Which founder a number belongs to, or ``None``.

    The number is a parameter and is never interpolated, logged or returned.
    """
    digits = "".join(ch for ch in str(number) if ch.isdigit())
    national = digits[2:] if digits.startswith("55") else digits
    with conn.cursor() as cur:
        cur.execute(RESOLVE_NUMBER_SQL, {"digits": digits, "national": national})
        row = cur.fetchone()
    return None if row is None else int(row[0])


# -- enqueueing ------------------------------------------------------------


def job_key(founders_list_id: int) -> str:
    """The key F1 writes: `apps/web/lib/founders/signup.ts`. Safe to log."""
    return f"founders:{founders_list_id}"


def enqueue(
    conn: psycopg.Connection,
    founders_list_id: int,
    template: str,
    *,
    priority: int = 3,
    **payload: Any,
) -> int | None:
    """Queue a message. F1 does this inline in SQL; this is for O2 and tests."""
    return queue.enqueue(
        conn,
        JOB_KIND,
        job_key(founders_list_id),
        priority=priority,
        payload={"template": template, "founders_list_id": founders_list_id, **payload},
    )


def enqueue_inbound(
    conn: psycopg.Connection,
    *,
    text: str,
    number: str | None = None,
    founders_list_id: int | None = None,
    message_id: str | None = None,
    log: Logger | None = None,
) -> int | None:
    """Queue an inbound reply for processing.

    The **number is resolved here**, so the `jobs` row holds a `founders_list`
    id and never a phone number: the queue is readable by anything with the
    database, and §12 keeps personal data in the one table that needs it.
    Returns ``None`` when the number matches no founder — there is nothing to
    unsubscribe, and enqueueing the raw number to find that out is the mistake
    this function exists to avoid.
    """
    log = log or _log
    if founders_list_id is None:
        if number is None:
            raise ValueError("enqueue_inbound needs a number or a founders_list_id")
        founders_list_id = resolve_number(conn, number)
    if founders_list_id is None:
        log.warning("inbound whatsapp reply from an unknown number; dropped")
        return None
    key = f"inbound:{founders_list_id}:{message_id or int(time.time() * 1000)}"
    return queue.enqueue(
        conn,
        INBOUND_JOB_KIND,
        key,
        priority=2,
        payload={"founders_list_id": founders_list_id, "text": text},
    )


# -- sending ---------------------------------------------------------------


def send(
    conn: psycopg.Connection,
    *,
    founders_list_id: int,
    template: str,
    payload: dict[str, Any] | None = None,
    client: EvolutionClient | None = None,
    job_id: int | None = None,
    attempt: int | None = None,
    after_optout: bool = False,
    sleep: Any = time.sleep,
    log: Logger | None = None,
) -> Delivery:
    """Run the gates, render, pace, send, log. Raises only for a retryable fault.

    ``after_optout`` is for the one message templates README §5 allows after a
    ``SAIR``: the confirmation that the opt-out took effect. Everything else
    leaves that number alone forever.
    """
    log = log or _log
    payload = payload or {}
    client = client or default_client()
    common = {"founders_list_id": founders_list_id, "template": template}

    row = _recipient(conn, founders_list_id)
    if row is None:
        return _skip(conn, log, common, SKIP_NO_RECIPIENT, job_id, attempt)
    name, number, consent = row

    # LGPD (§12): consent is mandatory before any contact. Nothing below this
    # line runs without it, and the reason is logged without naming the person.
    if not consent:
        return _skip(conn, log, common, SKIP_NO_CONSENT, job_id, attempt, level="warning")
    if not after_optout and has_opted_out(conn, founders_list_id):
        return _skip(conn, log, common, SKIP_OPTED_OUT, job_id, attempt)
    if not number:
        return _skip(conn, log, common, SKIP_NO_NUMBER, job_id, attempt, level="warning")
    if _already_sent(conn, founders_list_id, template):
        return _skip(conn, log, common, SKIP_ALREADY_SENT, job_id, attempt)

    # A template fault (a missing placeholder, an unresolved TODO(Sci)) raises
    # out of here on purpose: it is our bug, not the recipient's, and it should
    # be a visible failed job rather than a silently skipped founder.
    text = templates.load(CHANNEL, template).render(
        build_context(name=name, payload=payload, template_id=template)
    )

    if evolution.sending_enabled():
        wait_for_slot(conn, sleep=sleep, log=log)

    try:
        result = client.send_text(number, text)
    except CircuitOpen as exc:
        # Two consecutive failures already opened the circuit (§7.2). Record it
        # and let the backoff retry rather than spending a timeout proving it.
        _record_failure(conn, common, "circuit_open", job_id, attempt)
        log.warning("whatsapp send skipped: circuit open", extra={**common, "reason": exc.name})
        raise
    except EvolutionError as exc:
        _record_failure(conn, common, exc.reason, job_id, attempt, status=exc.status)
        log.warning(
            "whatsapp send failed",
            extra={
                **common,
                "reason": exc.reason,
                "status": exc.status,
                "retryable": exc.retryable,
            },
        )
        if exc.retryable:
            raise
        # 401/403/404/422: retrying will fail identically (§7.2). The job is
        # done; the delivery log says it was not delivered and why.
        return Delivery(outcome="failed", reason=exc.reason, **common)
    except ValueError as exc:
        # A number the row holds but Evolution cannot dial. Not retryable, and
        # the message of the ValueError never contains the number.
        _record_failure(conn, common, SKIP_INVALID_NUMBER, job_id, attempt)
        log.warning("whatsapp number is unusable", extra={**common, "reason": str(exc)})
        return Delivery(outcome="failed", reason=SKIP_INVALID_NUMBER, **common)

    return _record_success(conn, log, common, result, job_id, attempt)


# -- handlers --------------------------------------------------------------


@REGISTRY.job(JOB_KIND)
def send_whatsapp(ctx: JobContext) -> None:
    """Handler for F1's enqueued welcome. Idempotent (§7.2)."""
    founders_list_id = ctx.payload.get("founders_list_id")
    template = ctx.payload.get("template")
    if not founders_list_id or not template:
        # Our own caller wrote a bad row: visible failure, not a silent skip.
        raise ValueError("send_whatsapp payload needs 'founders_list_id' and 'template'")
    send(
        ctx.conn,
        founders_list_id=int(founders_list_id),
        template=str(template),
        payload=ctx.payload,
        job_id=ctx.job.id,
        attempt=ctx.job.attempts,
        log=ctx.log,
    )


@REGISTRY.job(INBOUND_JOB_KIND)
def whatsapp_inbound(ctx: JobContext) -> None:
    """A reply from a founder. Today that means: is it ``SAIR``?

    The opt-out is recorded **before** the confirmation is attempted, and a
    confirmation that cannot be rendered is a warning, never a failure. The
    guarantee a person is owed when they write SAIR is that the messages stop;
    being told so is the courtesy on top, and it must not be able to undo it.
    """
    founders_list_id = ctx.payload.get("founders_list_id")
    text = ctx.payload.get("text") or ""
    if not founders_list_id:
        raise ValueError("whatsapp_inbound payload needs a 'founders_list_id'")
    founders_list_id = int(founders_list_id)

    if not is_optout_reply(text):
        ctx.log.info("inbound whatsapp reply ignored", extra={"founders_list_id": founders_list_id})
        return

    record_optout(ctx.conn, founders_list_id)
    ctx.log.info("whatsapp opt-out recorded", extra={"founders_list_id": founders_list_id})

    try:
        send(
            ctx.conn,
            founders_list_id=founders_list_id,
            template=OPTOUT_TEMPLATE,
            after_optout=True,
            job_id=ctx.job.id,
            attempt=ctx.job.attempts,
            log=ctx.log,
        )
    except templates.TemplateError as exc:
        # `whatsapp/optout-confirmation.md` still carries a TODO(Sci) and an
        # `{{email_contato}}` nobody has decided yet (templates README §7), so
        # today this is the branch that runs. The opt-out above already stands.
        ctx.log.warning(
            "opt-out recorded but not confirmed: the template is not ready",
            extra={"founders_list_id": founders_list_id, "reason": type(exc).__name__},
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
    getattr(log, level)(f"whatsapp send skipped: {reason}", extra={**common, "reason": reason})
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
        "whatsapp message sent" if result.delivered else "whatsapp message not sent (dry run)",
        extra={
            **common,
            "outcome": result.status,
            "duration_ms": result.duration_ms,
            "delivery_mode": evolution.delivery_mode(),
        },
    )
    return Delivery(
        outcome=result.status,
        message_id=result.message_id,
        duration_ms=result.duration_ms,
        **common,
    )
