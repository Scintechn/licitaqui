"""``sync_awards`` — who won, for how much, and what that costs to find out.

This is the job that builds the price base v1's discount bands read from
(POC 3). It is also, by a wide margin, the most expensive collector we have,
and both halves of this module exist to keep that under control.

## One request per item, and only for items worth asking about

§3.2 is explicit: *award per item (winner) — 1 call per item: only for segments
of interest, permanent once awarded*. There is no bulk endpoint; asking who won
item 7 of a tender is one HTTP request, and a national sweep of everything with
a result would be hundreds of thousands of them against a host §7.2 already
calls unreliable and which was measured timing out for three straight hours on
2026-09-18. So every item this job asks about has to earn the request:

* **it has a result** — `tender_items.has_award`, PNCP's own ``temResultado``,
  written by B3. An item without one has nothing to return;
* **it is in a segment of interest** — :data:`DEFAULT_SEGMENTS`, B3's labels.
  This is the one line that separates a targeted collection from an unbounded
  sweep, and it is applied in the SQL that picks the work, not in a filter
  after the call;
* **it is not already settled** — §3.2's *permanent once awarded*. An item with
  a row in `awards` is never asked about again, by anything, ever. That is not
  a cache TTL that happens to be long; it is the absence of any expiry at all.

An item that has a result but returned nothing (PNCP publishes the flag before
the result often enough) would otherwise be re-asked on every run forever, so
the tender carries a **probe marker** and is left alone for
:data:`PROBE_COOLDOWN_HOURS` afterwards. Settled items are excluded by the
`awards` row regardless of the marker, so the cooldown can only ever delay
asking about something that was not there last time.

## Two kinds, the shape B2 established

``sync_awards``
    the scheduled daily sweep (§7.1: *daily, overnight*). It runs no HTTP at
    all: it picks the tenders with pending awarded items in the segments of
    interest and enqueues one follow-up each, exactly as
    :mod:`licitaqui.sync_tenders` enqueues `sync_items` and `sync_files`. A
    sweep that made the calls itself would be one job holding one connection
    for hours, with no way to retry a single tender and no way to spread the
    load.

``sync_tender_awards``
    one tender's pending awarded items, one request each, upserted as they
    arrive. Priority 9 (§7.3: sampling and cleanup) rather than 5: nothing is
    waiting on this, and it must never sit in front of a user's screening.

Both are idempotent (§7.2). The per-tender job upserts after every item, so an
outage half way through keeps what it already learned and the retry picks up
from there — the `not exists (…awards…)` predicate makes resuming free.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

import psycopg
from psycopg.types.json import Jsonb

from .awards import map_all, upsert_awards
from .breaker import CircuitOpen
from .pncp import PncpClient
from .queue import enqueue
from .registry import REGISTRY, JobContext
from .tenders import split_control_number

#: The segments the awards backfill collects for.
#:
#: **Assumption, and a placeholder for a decision that has not been made yet.**
#: The card says "concierge segments", and the 20 concierge founders are picked
#: in task S3 on 10-08 — after this was written. So the default is the six
#: segments B6's CNAE map covers most heavily (`db/reference/cnae_segments.csv`:
#: Alimentos 86 codes, Construção / Hidráulica 82, Saúde / Hospitalar 69,
#: Gráfico / Escritório 37, Veículos / Peças 35, Informática / TI 26), which is
#: the best available estimate of where the founders' CNAEs will land, and it
#: covers POC 3's own worked examples (notebook, papel A4).
#:
#: These are B3's **labels**, because that is what `tender_items.segment` holds.
#: Override with ``AWARDS_SEGMENTS`` (comma-separated) or per job with a
#: ``segments`` payload; an explicit empty list means every segment, which is
#: the unbounded sweep and is never the default.
DEFAULT_SEGMENTS: tuple[str, ...] = (
    "Alimentos",
    "Construção / Hidráulica",
    "Saúde / Hospitalar",
    "Gráfico / Escritório",
    "Veículos / Peças",
    "Informática / TI",
)

SEGMENTS_VAR = "AWARDS_SEGMENTS"

#: POC 3's ``--max-itens-edital`` default, kept: one tender with 400 awarded
#: items would otherwise be 400 requests in a single job and blow the timeout
#: budget. The rest are picked up on the next pass.
DEFAULT_MAX_ITEMS_PER_TENDER = 50

#: How many tenders one nightly sweep enqueues. At the cap above this is an
#: upper bound of 10,000 requests a night, which at the client's 4 req/s is
#: about 42 minutes of calling spread over however long the queue takes.
DEFAULT_SWEEP_TENDERS = 200

#: How long a tender is left alone after being probed. Only affects items that
#: returned *nothing*: a settled item is excluded by its `awards` row and is
#: never re-fetched whatever the marker says.
PROBE_COOLDOWN_HOURS = 168

#: §7.3: 9 is sampling and cleanup. Bulk award collection belongs there — it is
#: never what a user is waiting for.
AWARDS_PRIORITY = 9

FOLLOWUP_KIND = "sync_tender_awards"

#: Same reasoning as B4's marker (`licitaqui.files.sync_event_name`): `awards`
#: has no timestamp column at all (§6.1) and a migration is its own PR, so the
#: "we asked PNCP about this tender" marker lives in `events`, with the tender
#: id in `name` so the lookup is an exact hit on `events_name_created_idx`.
PROBE_EVENT_PREFIX = "sync_awards:"


def probe_event_name(tender_id: str) -> str:
    return f"{PROBE_EVENT_PREFIX}{tender_id}"


def configured_segments() -> tuple[str, ...]:
    """The segments of interest: ``AWARDS_SEGMENTS`` if set, else the default."""
    raw = os.environ.get(SEGMENTS_VAR)
    if raw is None:
        return DEFAULT_SEGMENTS
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _segments_param(payload_value: object) -> list[str] | None:
    """``None`` means "every segment"; a list narrows the selection.

    A payload that does not mention segments gets the configured ones. A
    payload that says ``"segments": []`` has asked for the unbounded sweep on
    purpose, which is allowed for an operator and never happens by default.
    """
    if payload_value is None:
        segments = configured_segments()
    elif isinstance(payload_value, (list, tuple)):
        segments = tuple(str(part) for part in payload_value)
    else:
        segments = (str(payload_value),)
    return list(segments) or None


def _int_option(payload: dict[str, object], key: str, default: int) -> int:
    """A numeric payload knob, where **0 is a value and not "unset"**.

    Written out rather than spelled ``int(payload.get(key) or default)``,
    which is the same bug twice over: ``cooldown_hours: 0`` — an operator
    saying *re-probe everything now* — reads as falsy and silently becomes the
    week-long default, and so does ``items: 0``.
    """
    value = payload.get(key)
    if value is None or value == "":
        return default
    return int(value)  # type: ignore[arg-type]


# -- what is still worth asking about --------------------------------------

#: Items with a published result, in the segments of interest, that nobody has
#: stored an award for. The `not exists` is §3.2's *permanent once awarded*.
PENDING_ITEMS_SQL = """
select i.number, i.unit_estimated_value
  from tender_items i
 where i.tender_id = %(tender_id)s
   and i.has_award is true
   and (%(segments)s::text[] is null or i.segment = any(%(segments)s))
   and not exists (select 1
                     from awards a
                    where a.tender_id = i.tender_id
                      and a.item_number = i.number)
 order by i.number
 limit %(limit)s
"""

#: Tenders with at least one such item, least recently closed last, skipping
#: anything probed inside the cooldown.
PENDING_TENDERS_SQL = """
select t.id
  from tenders t
 where exists (select 1
                 from tender_items i
                where i.tender_id = t.id
                  and i.has_award is true
                  and (%(segments)s::text[] is null or i.segment = any(%(segments)s))
                  and not exists (select 1
                                    from awards a
                                   where a.tender_id = i.tender_id
                                     and a.item_number = i.number))
   and not exists (select 1
                     from events e
                    where e.name = %(prefix)s || t.id
                      and e.created_at > now() - make_interval(hours => %(cooldown)s))
 order by t.proposals_close_at desc nulls last, t.id
 limit %(limit)s
"""

PROBED_AT_SQL = """
select max(created_at)
  from events
 where name = %s
"""


@dataclass(frozen=True, slots=True)
class PendingItem:
    """One item still to ask about, with the estimate the discount needs."""

    number: int
    unit_estimated_value: Decimal | None


def pending_items(
    conn: psycopg.Connection,
    tender_id: str,
    *,
    segments: list[str] | None,
    limit: int = DEFAULT_MAX_ITEMS_PER_TENDER,
) -> list[PendingItem]:
    rows = conn.execute(
        PENDING_ITEMS_SQL,
        {"tender_id": tender_id, "segments": segments, "limit": limit},
    ).fetchall()
    return [PendingItem(number=int(number), unit_estimated_value=value) for number, value in rows]


def pending_tenders(
    conn: psycopg.Connection,
    *,
    segments: list[str] | None,
    limit: int = DEFAULT_SWEEP_TENDERS,
    cooldown_hours: int = PROBE_COOLDOWN_HOURS,
) -> list[str]:
    rows = conn.execute(
        PENDING_TENDERS_SQL,
        {
            "segments": segments,
            "limit": limit,
            "cooldown": cooldown_hours,
            "prefix": PROBE_EVENT_PREFIX,
        },
    ).fetchall()
    return [str(row[0]) for row in rows]


def probed_at(conn: psycopg.Connection, tender_id: str) -> datetime | None:
    row = conn.execute(PROBED_AT_SQL, (probe_event_name(tender_id),)).fetchone()
    return row[0] if row else None


DELETE_MARKER_SQL = "delete from events where name = %s"
INSERT_MARKER_SQL = "insert into events (name, props) values (%s, %s)"


def mark_probed(conn: psycopg.Connection, tender_id: str, *, asked: int, stored: int) -> None:
    """Record that PNCP was asked about this tender's awarded items just now.

    Rewritten, not appended: one row per tender, the same shape B4's marker
    uses. Nothing personal is in it (§12) — a tender id and two counts.
    """
    name = probe_event_name(tender_id)
    conn.execute(DELETE_MARKER_SQL, (name,))
    conn.execute(
        INSERT_MARKER_SQL,
        (name, Jsonb({"tender_id": tender_id, "asked": asked, "stored": stored})),
    )


def build_client() -> PncpClient:
    """The client one run uses. A seam, exactly as in :mod:`licitaqui.sync_files`."""
    return PncpClient()


# -- the jobs --------------------------------------------------------------


@REGISTRY.job("sync_awards")
def sync_awards(ctx: JobContext) -> None:
    """The nightly sweep: find the tenders worth asking about and queue them.

    Makes no HTTP call of its own. Payload, all optional:

    ``segments``
        Override the segments of interest. ``[]`` means every segment.
    ``tenders``
        How many tenders to enqueue this run (default
        :data:`DEFAULT_SWEEP_TENDERS`).
    ``items``
        Passed through to each follow-up as its per-tender request cap.
    ``cooldown_hours``
        Override :data:`PROBE_COOLDOWN_HOURS`, for a backfill that wants to
        re-probe sooner.
    ``priority``
        Priority of the follow-ups (default :data:`AWARDS_PRIORITY`).
    """
    payload = ctx.payload
    segments = _segments_param(payload.get("segments"))
    limit = _int_option(payload, "tenders", DEFAULT_SWEEP_TENDERS)
    cooldown = _int_option(payload, "cooldown_hours", PROBE_COOLDOWN_HOURS)
    priority = _int_option(payload, "priority", AWARDS_PRIORITY)
    items_cap = payload.get("items")

    targets = pending_tenders(ctx.conn, segments=segments, limit=limit, cooldown_hours=cooldown)
    followup: dict[str, object] = {"segments": segments}
    if items_cap:
        followup["items"] = int(items_cap)

    queued = 0
    for tender_id in targets:
        job_id = enqueue(
            ctx.conn,
            FOLLOWUP_KIND,
            tender_id,
            priority=priority,
            payload={"tender_id": tender_id, **followup},
        )
        if job_id is not None:
            queued += 1

    ctx.log.info(
        "sync_awards swept",
        extra={
            "segments": segments,
            "candidates": len(targets),
            "queued": queued,
            "deduped": len(targets) - queued,
        },
    )


@REGISTRY.job(FOLLOWUP_KIND)
def sync_tender_awards(ctx: JobContext) -> None:
    """One tender's pending awarded items: one request each, upserted as they land.

    Payload:

    ``tender_id``
        The `numeroControlePNCP`. Defaults to the job's ``key``, which is what
        the sweep sets it to.
    ``segments``
        The segments of interest for this tender. ``[]`` means every segment.
    ``items``
        Per-tender request cap (default
        :data:`DEFAULT_MAX_ITEMS_PER_TENDER`).
    ``force``
        Ignore the probe cooldown. Never overrides *permanent once awarded*:
        an item with an award row is still not re-fetched, because there is
        nothing about it left to learn.
    """
    payload = ctx.payload
    tender_id = str(payload.get("tender_id") or ctx.job.key)
    segments = _segments_param(payload.get("segments"))
    limit = _int_option(payload, "items", DEFAULT_MAX_ITEMS_PER_TENDER)
    force = bool(payload.get("force"))
    cooldown = _int_option(payload, "cooldown_hours", PROBE_COOLDOWN_HOURS)

    if not force:
        last = probed_at(ctx.conn, tender_id)
        if last is not None:
            age_hours = (datetime.now(last.tzinfo) - last).total_seconds() / 3600
            if age_hours < cooldown:
                ctx.log.info(
                    "sync_tender_awards: probed recently, nothing to ask",
                    extra={"tender_id": tender_id, "hours_ago": round(age_hours, 1)},
                )
                return

    pending = pending_items(ctx.conn, tender_id, segments=segments, limit=limit)
    if not pending:
        # Not an error and not worth a retry: either the tender has no awarded
        # items in these segments, or every one of them is already settled.
        mark_probed(ctx.conn, tender_id, asked=0, stored=0)
        ctx.log.info(
            "sync_tender_awards: no pending awarded items",
            extra={"tender_id": tender_id, "segments": segments},
        )
        return

    cnpj, year, sequence = split_control_number(tender_id)
    asked = stored = empty = 0
    try:
        with build_client() as client:
            for item in pending:
                records = client.fetch_results(cnpj, year, sequence, item.number)
                asked += 1
                if not records:
                    empty += 1
                    continue
                # Upsert per item rather than per tender: an outage on item 30
                # of 50 must not throw away the 29 winners already read, and
                # the `not exists` predicate makes the retry resume for free.
                stored += upsert_awards(
                    ctx.conn,
                    map_all(
                        tender_id,
                        records,
                        item_number=item.number,
                        unit_estimated_value=item.unit_estimated_value,
                    ),
                )
    except CircuitOpen:
        # The endpoint is down and the breaker says so. Everything read before
        # this point is committed; the queue retries and resumes.
        ctx.log.warning(
            "sync_tender_awards: results endpoint circuit open",
            extra={"tender_id": tender_id, "asked": asked, "stored": stored},
        )
        raise

    mark_probed(ctx.conn, tender_id, asked=asked, stored=stored)
    ctx.log.info(
        "sync_tender_awards finished",
        extra={
            "tender_id": tender_id,
            "pending": len(pending),
            "asked": asked,
            "stored": stored,
            "empty": empty,
        },
    )
