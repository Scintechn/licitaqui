"""Giving a tender the value PNCP's own page shows.

On 2026-09-22 the Radar said **"Valor não informado"** on 5,080 of 5,965
tenders while `pncp.gov.br` showed the number for the same contratação. The
cause is ADR-0001's fallback, and the correlation is exact:

| stored payload | rows | with `estimated_value` |
|---|---|---|
| search index (snake_case, the fallback) | 5,080 | **0** |
| Consulta detail (camelCase, the primary path) | 885 | 885 |

A tender ingested through the search sweep has no `valorTotalEstimado` —
the index simply does not publish one, nor `srp`, nor
`orcamentoSigilosoCodigo` — and **nothing ever went back for it**. B2 enqueues
`sync_items` and `sync_files` for a changed tender but never a header re-read,
so a row that entered degraded stayed degraded for as long as it existed. That
is the gap this module closes.

## Sci's rule decides the design

    "We must present like the PNCP portal showed. The same value shown on his
    site must be the same value we see here."

So the number displayed has to be **PNCP's own**, which makes re-fetching the
Consulta detail the primary fix rather than a nicety. Two sources, in strict
order:

1. **`valorTotalEstimado` from the Consulta detail** — authoritative, and the
   same field the portal renders as "VALOR TOTAL ESTIMADO DA COMPRA".
2. **the sum of `tender_items.total_value`** — POC 1's fallback, already
   computed at ingest by :func:`licitaqui.items.total_estimated_value` and
   already trusted enough to assert a *legal* ME/EPP preference on the card
   (`favored_treatment`). It was simply never persisted.

**They do not always agree, and the measurement matters.** Across the 777
production tenders holding both a positive header value and items summing above
zero: **736 agree to the cent (94.7 %)** and 41 do not. Of the 41, 19 are within
1 %, 17 between 1× and 2×, and 5 are 2× or more — the largest 13.3×. The item
sum is never *lower*; where they differ it over-counts, and the ≥2× cases are
tenders whose item list repeats a description (one has 283 items and 71 distinct
descriptions), i.e. grouped lots or an ME/EPP cota listed beside the item it is
carved out of. Summing those double-counts.

So the order above is not a preference, it is a correctness rule: **consulta
wins whenever it answers**, and the item sum is what a tender gets instead of
"Valor não informado" — right to the cent for ~95 % of them, and an over-estimate
for a minority we can name and re-fetch later. :data:`VALUE_SOURCE_ITEMS` is
recorded on every row that took the fallback so that minority stays findable.

## Why this writes columns and not `raw`

The obvious implementation — map the detail record with
:func:`licitaqui.tenders.from_consulta` and upsert it like any other — would
merge the whole detail payload into `tenders.raw`. Measured against production
with `pg_column_size`, that adds **2,822 bytes to every one of the 5,373
search-sourced rows: ~14 MB**, against **15.3 MB of headroom** on a Neon project
already at 496.7 of 512 MB. It would not fix the Radar, it would fill the disk.

So this module writes the four columns it came for and leaves `raw` alone.
`raw` keeps saying which sweep ingested the row, which is true and is the
diagnostic the whole investigation turned on; where the *value* came from is
recorded in an `events` marker instead, the precedent B3 and B4 already set for
per-tender state the worker may write without a migration.

## Not recurring

Three things, because the first two each have a hole the next one covers:

* **at the source** — the search fallback in :mod:`licitaqui.sync_tenders` now
  enqueues :func:`refresh_tender_value` for every tender it writes, so a row
  that enters degraded is upgraded as soon as Consulta is reachable. This is
  the root-cause fix, and on its own it is not enough: when the fallback fires
  it is *because* Consulta is down, so the follow-up job usually fails too.
* **a sweep** — :func:`sweep_tender_values` runs on the schedule and enqueues
  whatever still has no value, oldest first, capped per cycle. It is what
  actually drains the backlog once Consulta returns, and it is also the
  backfill: the same job, run repeatedly.
* **a backoff** — a tender that cannot be upgraded must not be retried every
  half hour forever. `tenders.next_refresh_at` — a column §6.1 already defines,
  indexed, and which nothing else reads today — holds when this tender may be
  looked at again, so the sweep walks past it instead of re-queueing it. §3.2's
  6 h header TTL is the interval for a tender we simply have not reached yet;
  a withdrawn one is parked for :data:`GONE_BACKOFF_HOURS`.

None of this calls PNCP inside a web request (§3): the web enqueues, the worker
fetches.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from . import queue
from .breaker import CircuitOpen
from .items import pick_total
from .pncp import PncpClient, PncpError, PncpGone, PncpNotFound
from .registry import REGISTRY, JobContext
from .tenders import Tender, from_consulta, split_control_number

#: Where a stored `estimated_value` came from. Recorded on the marker, never in
#: a column — adding one is a migration, and a migration is its own PR.
VALUE_SOURCE_CONSULTA = "consulta"
VALUE_SOURCE_ITEMS = "items"
VALUE_SOURCE_NONE = "none"

#: PNCP answered `410`: the contratação was excluded. Nothing to re-read.
VALUE_SOURCE_GONE = "gone"

#: §3.2's header TTL. How long before a tender we could not reach is tried again.
REFRESH_TTL_HOURS = 6

#: A withdrawn contratação is never coming back, but `410` is also what a
#: confused PNCP could answer, so this parks the row rather than retiring it.
GONE_BACKOFF_HOURS = 24 * 30

#: How many tenders one sweep may queue. The sweep runs on the same cadence as
#: `sync_open_tenders`, and a cap is what keeps a 5,000-row backlog from
#: becoming 5,000 queued jobs in one tick — it drains over consecutive cycles,
#: the same shape `MAX_WINDOW_DAYS` gives the sweep itself.
SWEEP_BATCH = 400

#: Behind everything a user is waiting for (§7.3).
REFRESH_PRIORITY = 9

#: `events.name` prefix for the per-tender marker, following
#: :func:`licitaqui.items.sync_event_name`.
VALUE_EVENT_PREFIX = "tender_value:"


def value_event_name(tender_id: str) -> str:
    return f"{VALUE_EVENT_PREFIX}{tender_id}"


# -- what the database already knows --------------------------------------


@dataclass(frozen=True, slots=True)
class ValueState:
    """This tender's value situation, read in one query."""

    exists: bool
    estimated_value: Decimal | None = None
    item_sum: Decimal | None = None
    item_count: int = 0

    @property
    def has_value(self) -> bool:
        """Whether the Radar can show a number today.

        A stored **zero** is not a value. 108 production rows hold ``0.00``
        because PNCP published `valorTotalEstimado: 0`, and a card reading
        "R$ 0,00" is a worse lie than "Valor não informado" — it looks like a
        free contract. :func:`licitaqui.items.total_estimated_value` has always
        treated a non-positive header this way; this agrees with it.
        """
        return self.estimated_value is not None and self.estimated_value > 0


STATE_SQL = """
select t.estimated_value,
       (select sum(i.total_value) from tender_items i where i.tender_id = t.id),
       (select count(*) from tender_items i where i.tender_id = t.id)
  from tenders t
 where t.id = %(tender_id)s
"""


def read_state(conn: psycopg.Connection, tender_id: str) -> ValueState:
    """What we hold for this tender: the stored value and the item sum."""
    row = conn.execute(STATE_SQL, {"tender_id": tender_id}).fetchone()
    if row is None:
        return ValueState(exists=False)
    estimated_value, item_sum, item_count = row
    return ValueState(
        exists=True,
        estimated_value=estimated_value,
        item_sum=item_sum,
        item_count=int(item_count or 0),
    )


# -- writing what we learned ----------------------------------------------

#: The authoritative write. Deliberately **not**
#: :data:`licitaqui.tenders.UPSERT_SQL`:
#:
#: * that statement is gated on ``pncp_updated_at`` having moved, and here it
#:   has not — we are re-reading a header we already hold, to fill columns the
#:   first read could not. The gate would skip every single row;
#: * it merges the whole payload into `raw`, which is the ~14 MB this module's
#:   docstring refuses to spend.
#:
#: `pncp_updated_at` moves only forwards: `greatest` ignores NULLs, so a detail
#: record older than what the sweep stored cannot walk the change-detection
#: clock backwards and make B3/B4 re-read the tender forever.
#: The cast on ``estimated_value`` is load-bearing, not decoration: it is the
#: only parameter here that appears outside a `coalesce`/`greatest` against its
#: own column, so Postgres has nothing to infer its type from and rejects the
#: statement with `AmbiguousParameter` the moment the value is NULL — which is
#: exactly the sigiloso case, where Consulta answers but carries no number.
APPLY_DETAIL_SQL = """
update tenders set
    estimated_value     = case when %(estimated_value)s::numeric is not null
                               then %(estimated_value)s::numeric else estimated_value end,
    price_registration  = coalesce(%(price_registration)s, price_registration),
    confidential_budget = coalesce(%(confidential_budget)s, confidential_budget),
    status              = coalesce(%(status)s, status),
    proposals_open_at   = coalesce(%(proposals_open_at)s, proposals_open_at),
    proposals_close_at  = coalesce(%(proposals_close_at)s, proposals_close_at),
    bidding_system_url  = coalesce(%(bidding_system_url)s, bidding_system_url),
    pncp_updated_at     = greatest(pncp_updated_at, %(pncp_updated_at)s),
    next_refresh_at     = %(next_refresh_at)s,
    updated_at          = now()
 where id = %(tender_id)s
"""

#: The fallback write. Only ever fills a gap — the `where` makes that a property
#: of the statement rather than of the caller, so no ordering mistake upstream
#: can let an item sum overwrite a value Consulta gave us.
APPLY_ITEM_SUM_SQL = """
update tenders
   set estimated_value = %(estimated_value)s,
       next_refresh_at = %(next_refresh_at)s,
       updated_at      = now()
 where id = %(tender_id)s
   and (estimated_value is null or estimated_value <= 0)
"""

PARK_SQL = """
update tenders set next_refresh_at = %(next_refresh_at)s, updated_at = now()
 where id = %(tender_id)s
"""


@dataclass(frozen=True, slots=True)
class Outcome:
    """What one tender's refresh achieved, for the marker and the log."""

    tender_id: str
    source: str
    value: Decimal | None = None
    header_value: Decimal | None = None
    item_sum: Decimal | None = None
    item_count: int = 0
    #: None when there was nothing to compare — only set when we hold both.
    agrees: bool | None = None

    @property
    def upgraded(self) -> bool:
        return self.source in (VALUE_SOURCE_CONSULTA, VALUE_SOURCE_ITEMS) and self.value is not None

    def log_fields(self) -> dict[str, Any]:
        return {
            "tender_id": self.tender_id,
            "value_source": self.source,
            "value": None if self.value is None else str(self.value),
            "header_value": None if self.header_value is None else str(self.header_value),
            "item_sum": None if self.item_sum is None else str(self.item_sum),
            "items": self.item_count,
            "agrees": self.agrees,
        }


def _agreement(header: Decimal | None, item_sum: Decimal | None) -> bool | None:
    """Whether the two independent figures match, to the cent.

    ``None`` unless we actually hold both, because "we could not compare" and
    "they disagree" are different findings and the reported rate must not blur
    them. The tolerance is one cent: 14 of the production mismatches differ by
    less than five *hundredths* of one, which is `numeric(16,2)` rounding across
    a few hundred item rows and not a disagreement about the number.
    """
    if header is None or item_sum is None or header <= 0 or item_sum <= 0:
        return None
    return abs(header - item_sum) < Decimal("0.01")


def mark(conn: psycopg.Connection, outcome: Outcome) -> None:
    """Record what this tender's value is and where it came from.

    Rewritten rather than appended — it is a marker, not a metric — exactly as
    :func:`licitaqui.items.mark_synced` does, and for the same reasons: there is
    no column for provenance, a column needs a migration, and a migration is its
    own PR. Nothing here is personal data (§12): a tender id and numbers.

    It is also what makes the consulta-vs-item-sum agreement rate *queryable*
    after a backfill rather than something to re-derive by hand.
    """
    name = value_event_name(outcome.tender_id)
    conn.execute("delete from events where name = %s", (name,))
    conn.execute(
        "insert into events (name, props) values (%s, %s)",
        (name, Jsonb(outcome.log_fields())),
    )


def _detail_params(tender: Tender, *, ttl_hours: int) -> dict[str, Any]:
    """The columns the Consulta detail can fill.

    Mapped by :func:`licitaqui.tenders.from_consulta` rather than by reading the
    payload again here, so there is exactly one place that knows what PNCP calls
    these fields and the two paths cannot drift apart. Everything `from_consulta`
    derives from the *natural key* is ignored — a detail re-read is not allowed
    to renumber a tender.
    """
    return {
        "tender_id": tender.id,
        "estimated_value": tender.estimated_value,
        "price_registration": tender.price_registration,
        "confidential_budget": tender.confidential_budget,
        "status": tender.status,
        "proposals_open_at": tender.proposals_open_at,
        "proposals_close_at": tender.proposals_close_at,
        "bidding_system_url": tender.bidding_system_url,
        "pncp_updated_at": tender.pncp_updated_at,
        "next_refresh_at": _in_hours(ttl_hours),
    }


def _in_hours(hours: int) -> datetime:
    return datetime.now(UTC) + timedelta(hours=hours)


def refresh_one(
    conn: psycopg.Connection,
    client: PncpClient | None,
    tender_id: str,
    state: ValueState,
) -> Outcome:
    """Give one tender a value: Consulta first, the item sum second.

    ``client`` may be ``None`` to run the item-sum path alone, which makes no
    HTTP call at all. That is not a test seam — it is the mode the backfill runs
    in while `/api/consulta` is down, and it is the only mode that can help at
    all when it is.

    Writes nothing and reports :data:`VALUE_SOURCE_NONE` when neither source
    has a positive number. A tender whose items are all sigiloso sums to zero,
    and zero is not a value (:attr:`ValueState.has_value`).
    """
    item_sum = state.item_sum if state.item_sum and state.item_sum > 0 else None
    header: Decimal | None = None

    if client is not None:
        cnpj, year, sequence = split_control_number(tender_id)
        try:
            record = client.fetch_contratacao(cnpj, year, sequence)
        except PncpGone:
            # The agency excluded it. Park it rather than retire it: `410` is
            # unambiguous today, but this module is not the place to decide what
            # a withdrawn tender looks like on the Radar — `absence.py` already
            # records that as Sci's call, not ours.
            conn.execute(
                PARK_SQL,
                {"tender_id": tender_id, "next_refresh_at": _in_hours(GONE_BACKOFF_HOURS)},
            )
            return Outcome(
                tender_id, VALUE_SOURCE_GONE, item_sum=item_sum, item_count=state.item_count
            )
        except (PncpNotFound, PncpError, CircuitOpen):
            # Down, circuit-broken, or no such path. The fallback below is
            # exactly what this situation is for; the tender is re-read when
            # `next_refresh_at` comes round.
            record = None

        if record is not None:
            tender = from_consulta(record)
            raw_header = tender.estimated_value
            header = None if raw_header is None else Decimal(str(raw_header))
            params = _detail_params(tender, ttl_hours=REFRESH_TTL_HOURS)
            if header is None or header <= 0:
                # The detail answered but carries no usable number — a sigiloso
                # or unfilled budget. Keep everything else it gave us (`srp`,
                # the real confidential flag, the dates) and still fall through
                # to the items for the value itself.
                params["estimated_value"] = None
            conn.execute(APPLY_DETAIL_SQL, params)

    agrees = _agreement(header, item_sum)
    # One expression decides which number wins, shared with the `favored_treatment`
    # the card prints beside it, so the value and the ME/EPP claim can never come
    # from different arithmetic.
    value = pick_total(header, item_sum)

    if value is None:
        conn.execute(
            PARK_SQL, {"tender_id": tender_id, "next_refresh_at": _in_hours(REFRESH_TTL_HOURS)}
        )
        return Outcome(
            tender_id,
            VALUE_SOURCE_NONE,
            header_value=header,
            item_sum=item_sum,
            item_count=state.item_count,
            agrees=agrees,
        )

    source = VALUE_SOURCE_CONSULTA if value == header else VALUE_SOURCE_ITEMS
    if source == VALUE_SOURCE_ITEMS:
        # `APPLY_DETAIL_SQL` has already run when Consulta answered without a
        # number, so this only ever fills the gap it left — and its own `where`
        # guarantees that independently of the order things happen here.
        conn.execute(
            APPLY_ITEM_SUM_SQL,
            {
                "tender_id": tender_id,
                "estimated_value": value,
                "next_refresh_at": _in_hours(REFRESH_TTL_HOURS),
            },
        )
    return Outcome(
        tender_id,
        source,
        value=value,
        header_value=header,
        item_sum=item_sum,
        item_count=state.item_count,
        agrees=agrees,
    )


# -- the per-tender job ----------------------------------------------------


def build_client() -> PncpClient:
    """The client one refresh uses. A seam, as in every other collector."""
    return PncpClient()


@REGISTRY.job("refresh_tender_value")
def refresh_tender_value(ctx: JobContext) -> None:
    """Fill one tender's `estimated_value` from PNCP's own header.

    Payload:

    ``tender_id``
        The `numeroControlePNCP`; defaults to the job's ``key``, which is what
        the sweep and the search fallback set it to.
    ``force``
        Refresh even when the tender already shows a value — for an operator
        re-reading a row by hand, and for the tests.
    ``items_only``
        Skip PNCP entirely and take the item sum. What the backfill uses while
        `/api/consulta` is down.
    """
    payload = ctx.payload
    tender_id = str(payload.get("tender_id") or ctx.job.key)
    force = bool(payload.get("force"))
    items_only = bool(payload.get("items_only"))

    state = read_state(ctx.conn, tender_id)
    if not state.exists:
        # Enqueued by id, so this means the row went away in between. Failing
        # would retry four times over forty minutes against nothing.
        ctx.log.warning(
            "refresh_tender_value: unknown tender", extra={"tender_id": tender_id}
        )
        return
    if state.has_value and not force:
        ctx.log.info(
            "refresh_tender_value: already valued",
            extra={"tender_id": tender_id, "value": str(state.estimated_value)},
        )
        return

    if items_only:
        outcome = refresh_one(ctx.conn, None, tender_id, state)
    else:
        with build_client() as client:
            outcome = refresh_one(ctx.conn, client, tender_id, state)
    mark(ctx.conn, outcome)

    if outcome.upgraded:
        ctx.log.info("refresh_tender_value finished", extra=outcome.log_fields())
    else:
        # Not a failure: PNCP being down is the normal case this exists for,
        # and the row is parked so the sweep does not spin on it.
        ctx.log.info("refresh_tender_value: no value available", extra=outcome.log_fields())


# -- the sweep that drains the backlog ------------------------------------

#: Oldest first, so a backlog drains in a stable order rather than re-offering
#: the same rows every cycle. `next_refresh_at is null` is every row that has
#: never been looked at, which after this ships is the whole 5,080.
DUE_SQL = """
select t.id
  from tenders t
 where (t.estimated_value is null or t.estimated_value <= 0)
   and (t.next_refresh_at is null or t.next_refresh_at <= now())
 order by t.next_refresh_at nulls first, t.proposals_close_at desc nulls last
 limit %(limit)s
"""


def due_tenders(conn: psycopg.Connection, limit: int = SWEEP_BATCH) -> list[str]:
    """Tenders with no value that may be looked at again now."""
    return [row[0] for row in conn.execute(DUE_SQL, {"limit": limit}).fetchall()]


@REGISTRY.job("sweep_tender_values")
def sweep_tender_values(ctx: JobContext) -> None:
    """Enqueue `refresh_tender_value` for tenders still showing no value.

    The safety net behind the fallback's own follow-up: when Consulta is down,
    that follow-up fails too, and this is what comes back for the row later. It
    is also the backfill — running it repeatedly is how 5,080 rows drain.

    Payload:

    ``limit``
        How many to queue this cycle (default :data:`SWEEP_BATCH`).
    ``items_only``
        Passed through to every job it creates.
    """
    limit = int(ctx.payload.get("limit") or SWEEP_BATCH)
    items_only = bool(ctx.payload.get("items_only"))
    tender_ids = due_tenders(ctx.conn, limit)
    created = enqueue_refreshes(ctx.conn, tender_ids, items_only=items_only)
    ctx.log.info(
        "sweep_tender_values finished",
        extra={"due": len(tender_ids), "enqueued": created, "items_only": items_only},
    )


def enqueue_refreshes(
    conn: psycopg.Connection, tender_ids: list[str] | tuple[str, ...], *, items_only: bool = False
) -> int:
    """Queue one refresh per tender, deduped on `(kind, key)` like every sweep."""
    created = 0
    for tender_id in tender_ids:
        payload: dict[str, Any] = {"tender_id": tender_id}
        if items_only:
            payload["items_only"] = True
        if queue.enqueue(
            conn, "refresh_tender_value", tender_id, priority=REFRESH_PRIORITY, payload=payload
        ):
            created += 1
    return created
