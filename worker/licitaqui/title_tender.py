"""``title_tender`` — write one tender's short title, and the sweep that enqueues it.

:mod:`licitaqui.titles` decides *what* the title is and never touches a
database. This module is the other half: it reads the inputs, runs the breaker
and the queue discipline around the call, and writes the `short_title*` columns
added by `db/migrations/0005_tender_short_title.sql`.

Spec §3: PNCP and OpenRouter are never called inside a web request. A title is
produced here, by a job, and the web only ever reads the column.

## Idempotency (§7.2)

The handler re-reads the staleness predicate under the row it is about to write
and returns early when the row is already current, so a job that arrives twice
— a consumer that died after the write but before marking the row — does
nothing the second time and costs nothing.

## The 429, and why it is not a failure

The free OpenRouter pool rate-limits: 7 of 50 calls in the design probe came
back `429 … limit_source: upstream_provider_shared_pool`.
:func:`licitaqui.titles.model_title` already retries with backoff. When it still
comes back rate-limited this handler raises :class:`RateLimited`, which means:

* **nothing is written** — a rate-limited tender keeps `short_title is null` and
  is picked up again, rather than being recorded as titled with the unfit
  deterministic string frozen onto it;
* **the queue retries** it on its own backoff (§7.2: 2, 8, 30 min);
* **the breaker is not touched**. A 429 is the provider answering, and answering
  usefully. Counting two of them as the consecutive failures that open the
  circuit would stop titling for 15 minutes exactly when a backfill is working
  hardest, and would leave a slice of the Radar untitled for no reason.

A 5xx or a connection error *is* a breaker failure, and is recorded as one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import psycopg

from . import queue, titles
from .breaker import CircuitOpen, get_breaker
from .registry import REGISTRY, JobContext

#: The job kind. One tender per job, keyed by its id.
KIND = "title_tender"

#: The sweep that finds work for it. A *scheduled* sweep rather than a
#: follow-up hung off `sync_open_tenders`, because a title also goes stale when
#: the **items** change — `sync_items` runs on its own 12 h TTL and a
#: tender-level follow-up would never see it. The staleness test reads the
#: current item set, so one periodic sweep covers both causes and the backfill
#: with the same query.
SWEEP_KIND = "sweep_titles"

#: How many tenders one sweep may queue. The backfill is a script, not this —
#: this is sized so a sweep cannot flood the queue ahead of the collectors.
SWEEP_LIMIT = 500

#: Priority: below the collectors that keep the Radar's facts fresh, above
#: nothing in particular. A missing title degrades a card; a missing tender
#: loses it.
PRIORITY = 7


class RateLimited(RuntimeError):
    """The provider rate-limited us. Retry on the queue's backoff, write nothing."""

    def __init__(self, tender_id: str) -> None:
        super().__init__(f"openrouter rate-limited while titling {tender_id}")
        self.tender_id = tender_id


READ_SQL = f"""
select t.object, {titles.BASIS_SQL} as basis, {titles.STALE_SQL} as stale
  from tenders t
 where t.id = %(tender_id)s
"""

#: The same read without the staleness test — which is the only part that
#: mentions the `short_title*` columns. It is what lets the backfill measure a
#: dry run against a database migration 0005 has not been applied to yet.
READ_SQL_NO_STALE = f"""
select t.object, {titles.BASIS_SQL} as basis, true as stale
  from tenders t
 where t.id = %(tender_id)s
"""

ITEMS_SQL = """
select description, quantity, unit
  from tender_items
 where tender_id = %(tender_id)s
 order by total_value desc nulls last, number
 limit %(limit)s
"""

WRITE_SQL = """
update tenders
   set short_title              = %(title)s,
       short_title_source       = %(source)s,
       short_title_rules_version = %(rules_version)s,
       short_title_prompt_version = %(prompt_version)s,
       short_title_basis        = %(basis)s,
       short_title_at           = now()
 where id = %(tender_id)s
"""

#: The sweep. Ordered so the never-titled rows go first: during the backfill
#: that is every row, and afterwards it is the handful PNCP published today.
PENDING_SQL = f"""
select t.id
  from tenders t
 where {titles.STALE_SQL}
 order by (t.short_title is not null), t.proposals_close_at desc nulls last
 limit %(limit)s
"""


@dataclass(frozen=True, slots=True)
class Inputs:
    """What a title is built from, plus the digest that dates it."""

    object_text: str
    items: list[dict[str, Any]]
    basis: str
    stale: bool


def read_inputs(
    conn: psycopg.Connection, tender_id: str, *, check_stale: bool = True
) -> Inputs | None:
    """The objeto, the top items by value, and the basis digest. ``None`` if gone.

    ``check_stale=False`` reports every row as stale and never mentions the
    `short_title*` columns, so a dry run can be measured before migration 0005
    has been applied.
    """
    params = {
        "tender_id": tender_id,
        "rules_version": titles.RULES_VERSION,
        "prompt_version": titles.PROMPT_VERSION,
    }
    with conn.cursor() as cur:
        cur.execute(READ_SQL if check_stale else READ_SQL_NO_STALE, params)
        row = cur.fetchone()
        if row is None:
            return None
        object_text, basis, stale = row
        cur.execute(ITEMS_SQL, {"tender_id": tender_id, "limit": titles.MAX_ITEMS})
        items = [{"description": d, "quantity": q, "unit": u} for d, q, u in cur.fetchall()]
    return Inputs(object_text or "", items, basis, bool(stale))


def write_title(conn: psycopg.Connection, tender_id: str, title: titles.Title, basis: str) -> None:
    """Store the title and its provenance."""
    with conn.cursor() as cur:
        cur.execute(
            WRITE_SQL,
            {
                "tender_id": tender_id,
                "title": title.text,
                "source": title.source,
                "rules_version": title.rules_version,
                "prompt_version": title.prompt_version,
                "basis": basis,
            },
        )


def build_for(inputs: Inputs, *, key: str | None) -> titles.Title | None:
    """Run the two branches under the OpenRouter breaker.

    The breaker is only consulted when the model is actually going to be asked,
    so a tender the deterministic branch can title is titled even while the
    circuit is open — which is the point of having a free branch at all.
    """
    free = titles.deterministic_title(inputs.object_text)
    if not titles.needs_model(free):
        return titles.Title(free, titles.SOURCE_DETERMINISTIC)

    breaker = get_breaker(titles.ai_tender.BREAKER_NAME)
    if not breaker.allow():
        raise CircuitOpen(titles.ai_tender.BREAKER_NAME, breaker.snapshot()["retry_in_s"])

    result = titles.build(inputs.object_text, inputs.items, key=key)

    if result is None:  # rate-limited: the provider answered, so neither outcome
        return None
    if (result.rejected or "").startswith("http_"):
        breaker.record_failure()
    else:
        breaker.record_success()
    return result


@REGISTRY.job(KIND)
def title_tender(ctx: JobContext) -> None:
    """Title one tender. Idempotent, and cheap when the row is already current."""
    tender_id = str(ctx.payload.get("tender_id") or ctx.job.key)
    inputs = read_inputs(ctx.conn, tender_id)
    if inputs is None:
        ctx.log.info("tender gone", extra={"tender_id": tender_id})
        return
    if not inputs.stale:
        ctx.log.debug("title already current", extra={"tender_id": tender_id})
        return

    key = titles.ai_tender.api_key()
    result = build_for(inputs, key=key)
    if result is None:
        raise RateLimited(tender_id)

    write_title(ctx.conn, tender_id, result, inputs.basis)
    # LGPD (§12) and the same discipline as ai_tender: the objeto and the title
    # are business data, but there is no reason to copy them into every log
    # line. The id, the branch and the cost are what an operator needs.
    ctx.log.info(
        "titled",
        extra={
            "tender_id": tender_id,
            "source": result.source,
            "rejected": result.rejected,
            "input_tokens": result.input_tokens,
            "output_tokens": result.output_tokens,
            "cost_brl": round(result.cost_brl, 8),
        },
    )


def pending(conn: psycopg.Connection, *, limit: int = 500) -> list[str]:
    """Tenders whose title is missing or stale, neediest first."""
    with conn.cursor() as cur:
        cur.execute(
            PENDING_SQL,
            {
                "rules_version": titles.RULES_VERSION,
                "prompt_version": titles.PROMPT_VERSION,
                "limit": limit,
            },
        )
        return [row[0] for row in cur.fetchall()]


@REGISTRY.job(SWEEP_KIND)
def sweep_titles(ctx: JobContext) -> None:
    """Queue a `title_tender` for every tender lacking a current title."""
    queued = enqueue_pending(ctx.conn, limit=int(ctx.payload.get("limit") or SWEEP_LIMIT))
    ctx.log.info("titles swept", extra={"queued": queued})


def enqueue_pending(conn: psycopg.Connection, *, limit: int = SWEEP_LIMIT) -> int:
    """Enqueue a `title_tender` job for every tender lacking a current title.

    Returns how many were actually queued. :func:`licitaqui.queue.enqueue`
    dedupes against an identical queued or running job, so running this sweep
    twice does not double the work — and neither does running it while the
    backfill is still draining.
    """
    queued = 0
    for tender_id in pending(conn, limit=limit):
        if queue.enqueue(
            conn, KIND, tender_id, priority=PRIORITY, payload={"tender_id": tender_id}
        ):
            queued += 1
    return queued
