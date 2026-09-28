"""``sync_open_tenders`` — the 30-minute incremental sweep (§7.1, ADR-0001).

Each cycle asks PNCP one question: *which contratações changed since the last
completed cycle?* It asks it of ``/v1/contratacoes/atualizacao``, which windows
server-side on ``dataAtualizacaoGlobal`` — the timestamp that moves when the
record **or any of its children** changes — and so catches an amended item or a
newly published edital file, not only a header edit.

Shape of a cycle:

1. Read the watermark (below) and build a day window ``[start, today]``.
2. For each modality in (6, 8, 4), page ``/atualizacao`` at 50 until PNCP says
   ``paginasRestantes = 0``.
3. Upsert each page on ``numeroControlePNCP``. The upsert writes only rows whose
   ``pncp_updated_at`` actually moved, so a rerun over the same window touches
   nothing (:mod:`licitaqui.tenders`).
4. Enqueue ``sync_items`` / ``sync_files`` for the tenders that were new or
   changed.
5. Only if every modality finished, advance the watermark.

**The watermark.** It is a row in `events`, not a new column or table: B2 is not
allowed a migration, `events` already exists, the worker's `app` role can write
it, and an append-only log of cycles is a more useful artefact than a single
mutable cell — ``select props from events where name = 'sync_open_tenders.cycle'
order by id desc`` is the sync's history. It stores the *window*, not a row-level
timestamp, exactly as ADR-0001 §2 requires: a partial cycle leaves the previous
window standing and is retried whole, and because the window is a date range the
retry returns the same set rather than skipping what it missed.

**When `/api/consulta` is down** — 17.4 % of requests during the ADR's
measurement window, and it was down again while B2 was being built — the breaker
opens and the cycle falls back to the search sweep (ADR-0001 §4). The fallback
keeps the product's data fresh, but it does **not** advance the watermark: the
cycle is recorded as degraded and the next consulta-backed cycle re-queries the
whole window rather than trusting a sweep that cannot see child changes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import psycopg
from psycopg.types.json import Jsonb

from . import queue
from .breaker import CircuitOpen
from .pncp import SEARCH_WINDOW_CAP, PncpClient, PncpError
from .registry import REGISTRY, JobContext
from .search_vector import search_vector_sql
from .tenders import DEFAULT_MODALITIES, Tender, UpsertResult, from_consulta, from_search
from .tenders import upsert_tenders as _upsert

BRT = ZoneInfo("America/Sao_Paulo")

#: The `events.name` the watermark is written under.
CYCLE_EVENT = "sync_open_tenders.cycle"

#: First run, or a watermark we cannot use: how far back to reach. One day, not
#: a backfill — the initial load by publication date is `/publicacao`'s job
#: (ADR-0001 §5), and a first cycle that tried to walk history would run for
#: hours behind a 30-minute schedule.
DEFAULT_LOOKBACK_DAYS = 1

#: A worker that was down for a fortnight must not try to sweep a fortnight in
#: one job. The window is clamped and the watermark advances by this much per
#: cycle, so the backlog drains over consecutive cycles instead of producing one
#: job that can never finish inside its retry budget.
MAX_WINDOW_DAYS = 7

#: Upsert in batches rather than one statement per record.
BATCH_SIZE = 200

#: Follow-up jobs for a new or changed tender (§7.1). They are enqueued only
#: once their handler exists — see :func:`_enqueue_followups`.
FOLLOWUP_KINDS = ("sync_items", "sync_files")
FOLLOWUP_PRIORITY = 5

#: The extra follow-up a **search-sourced** tender needs, and a consulta-sourced
#: one does not.
#:
#: The search index publishes no `valorTotalEstimado`, no `srp` and no
#: `orcamentoSigilosoCodigo`, so every row this fallback writes arrives with
#: three columns empty and B2 had nothing that ever went back for them. That is
#: the whole of the "Valor não informado" bug: not a mapping fault, an ingest
#: path with no follow-up. :mod:`licitaqui.tender_value` is the follow-up.
#:
#: It is queued from the fallback path alone. A consulta-sourced tender already
#: carries all three, and queueing 5,000 no-op jobs per healthy cycle to
#: discover that would cost more than the bug.
UPGRADE_KIND = "refresh_tender_value"


@dataclass
class CycleStats:
    """What one cycle did, for the log line, the event row and the tests."""

    window_start: date
    window_end: date
    source: str = "consulta"
    degraded: bool = False
    batches: int = 0
    records: int = 0
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    followups: int = 0
    #: `refresh_tender_value` jobs queued for rows the fallback wrote.
    upgrades: int = 0
    modalities_done: list[int] = field(default_factory=list)
    modalities_failed: list[int] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return not self.degraded and not self.modalities_failed

    def absorb(self, result: UpsertResult) -> None:
        self.inserted += len(result.inserted)
        self.updated += len(result.updated)
        self.unchanged += result.unchanged

    def as_props(self) -> dict[str, Any]:
        return {
            "scope": None,  # filled in by the caller
            "window_start": self.window_start.isoformat(),
            "window_end": self.window_end.isoformat(),
            "source": self.source,
            "degraded": self.degraded,
            "batches": self.batches,
            "records": self.records,
            "inserted": self.inserted,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "followups": self.followups,
            "upgrades": self.upgrades,
            "modalities_done": sorted(self.modalities_done),
            "modalities_failed": sorted(self.modalities_failed),
        }


# -- the watermark ---------------------------------------------------------


def scope_key(uf: str | None, modalities: tuple[int, ...]) -> str:
    """Identifies which sweep a watermark belongs to.

    Two schedule entries with different coverage must not share a watermark, or
    a narrow sweep would advance the window a wide one still needs.
    """
    where = (uf or "BR").upper()
    return f"{where}:{','.join(str(m) for m in sorted(modalities))}"


def read_watermark(conn: psycopg.Connection, scope: str) -> date | None:
    """The end of the last *completed* cycle for this scope, or None.

    Degraded cycles are written too, for the history, but are skipped here:
    their window was swept by the fallback, which cannot see child changes, so
    it must be swept again properly.
    """
    row = conn.execute(
        """
        select props ->> 'window_end'
          from events
         where name = %s
           and props ->> 'scope' = %s
           and coalesce((props ->> 'complete')::boolean, false)
         order by id desc
         limit 1
        """,
        (CYCLE_EVENT, scope),
    ).fetchone()
    if not row or not row[0]:
        return None
    try:
        return date.fromisoformat(row[0])
    except ValueError:
        return None


def write_watermark(conn: psycopg.Connection, scope: str, stats: CycleStats) -> None:
    """Append this cycle to the log. Only a complete one moves the watermark."""
    props = stats.as_props() | {"scope": scope, "complete": stats.complete}
    conn.execute(
        "insert into events (name, props) values (%s, %s)",
        (CYCLE_EVENT, Jsonb(props)),
    )


def plan_window(
    watermark: date | None,
    today: date,
    *,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    max_days: int = MAX_WINDOW_DAYS,
) -> tuple[date, date]:
    """The day range this cycle sweeps, inclusive at both ends.

    Starts at the last completed cycle's end — *not* the day after it, because
    that day was only swept up to the moment the cycle ran and PNCP kept
    updating records for the rest of it. Re-querying it is free: the upsert
    writes nothing for a record whose timestamp has not moved.
    """
    start = watermark if watermark is not None else today - timedelta(days=lookback_days)
    start = min(start, today)
    end = min(today, start + timedelta(days=max_days - 1))
    return start, end


# -- the handler -----------------------------------------------------------


def build_client() -> PncpClient:
    """The client one cycle uses. A seam, so a test can serve PNCP itself.

    ADR-0001 is explicit that "an untested fallback is worse than none", and the
    fallback only triggers when `/api/consulta` fails. Tests replace this with a
    factory bound to an :class:`httpx.MockTransport` that fails on demand.
    """
    return PncpClient()


@REGISTRY.job("sync_open_tenders")
def sync_open_tenders(ctx: JobContext) -> None:
    """Sweep PNCP for everything that changed since the last completed cycle.

    Payload (all optional, all for operators and tests — the scheduled job
    carries none of them):

    ``uf``
        Restrict the sweep to one state. Unset means the whole country, which
        is both cheaper and more complete than 27 per-state sweeps: the period
        endpoints have no 10,000-record window to partition around.
    ``modalities``
        Defaults to (6, 8, 4) — Pregão Eletrônico, Dispensa, Concorrência.
    ``window_start`` / ``window_end``
        ``YYYY-MM-DD``. Sweep this window instead of the watermark's, and do not
        move the watermark. For re-running a window by hand.
    ``lookback_days``
        How far back a first run reaches when there is no watermark yet.
    """
    payload = ctx.payload
    uf = (payload.get("uf") or None) or None
    modalities = tuple(int(m) for m in payload.get("modalities") or DEFAULT_MODALITIES)
    scope = scope_key(uf, modalities)
    today = datetime.now(BRT).date()

    explicit = payload.get("window_start") or payload.get("window_end")
    if explicit:
        raw_start, raw_end = payload.get("window_start"), payload.get("window_end")
        start = date.fromisoformat(raw_start) if raw_start else today
        end = date.fromisoformat(raw_end) if raw_end else today
    else:
        watermark = read_watermark(ctx.conn, scope)
        start, end = plan_window(
            watermark,
            today,
            lookback_days=int(payload.get("lookback_days") or DEFAULT_LOOKBACK_DAYS),
        )

    stats = CycleStats(window_start=start, window_end=end)
    ctx.log.info(
        "sync_open_tenders starting",
        extra={
            "scope": scope,
            "window_start": start.isoformat(),
            "window_end": end.isoformat(),
            "modalities": list(modalities),
        },
    )

    with build_client() as client:
        _sweep_consulta(ctx, client, stats, modalities, uf)
        if stats.modalities_failed:
            _sweep_search_fallback(ctx, client, stats, modalities, uf)

    if not explicit:
        write_watermark(ctx.conn, scope, stats)

    ctx.log.info(
        "sync_open_tenders finished",
        extra={
            "scope": scope,
            "watermark_advanced": stats.complete and not explicit,
            **stats.as_props(),
        },
    )
    if not stats.complete:
        # The cycle did useful work, so the job is not failed — retrying it in
        # two minutes would only hammer a service we already know is down. The
        # watermark did not move, so the next scheduled cycle re-sweeps this
        # window against the consulta endpoint.
        ctx.log.warning(
            "sync cycle incomplete; watermark held",
            extra={
                "scope": scope,
                "degraded": stats.degraded,
                "modalities_failed": sorted(stats.modalities_failed),
            },
        )


def _sweep_consulta(
    ctx: JobContext,
    client: PncpClient,
    stats: CycleStats,
    modalities: tuple[int, ...],
    uf: str | None,
) -> None:
    """The primary path: one paged walk of `/atualizacao` per modality."""
    for modality in modalities:
        batch: list[Tender] = []
        try:
            for record in client.iter_atualizacao(
                stats.window_start, stats.window_end, modality, uf=uf
            ):
                stats.records += 1
                try:
                    batch.append(from_consulta(record))
                except (ValueError, KeyError) as exc:
                    ctx.log.warning(
                        "skipping unmappable PNCP record",
                        extra={"modality": modality, "reason": str(exc)[:200]},
                    )
                    continue
                if len(batch) >= BATCH_SIZE:
                    _flush(ctx, stats, batch)
                    batch = []
        except (CircuitOpen, PncpError, OSError, TimeoutError) as exc:
            _flush(ctx, stats, batch)
            stats.modalities_failed.append(modality)
            ctx.log.warning(
                "consulta sweep failed for modality",
                extra={"modality": modality, "error": f"{type(exc).__name__}: {exc}"[:300]},
            )
            continue
        _flush(ctx, stats, batch)
        stats.modalities_done.append(modality)


def _sweep_search_fallback(
    ctx: JobContext,
    client: PncpClient,
    stats: CycleStats,
    modalities: tuple[int, ...],
    uf: str | None,
) -> None:
    """ADR-0001 §4: keep the data moving while `/api/consulta` is down.

    Marks the cycle degraded whatever the outcome, because even a complete
    search sweep is not a substitute: it windows on the index's
    `data_atualizacao_pncp`, which is why it cannot be trusted to close the
    window the consulta endpoint failed to sweep.
    """
    stats.degraded = True
    stats.source = "search-fallback"
    failed = tuple(stats.modalities_failed)
    ctx.log.info(
        "falling back to the search sweep",
        extra={"modalities_failed": sorted(failed), "uf": uf},
    )
    # The watermark is a date; the search index's stop value is a timestamp.
    # Start of the window's first day is the safe, over-inclusive choice.
    stop_at = stats.window_start.isoformat()
    batch: list[Tender] = []
    try:
        for item in client.iter_search(uf=uf, modalities=failed or modalities, stop_at=stop_at):
            stats.records += 1
            try:
                batch.append(from_search(item))
            except (ValueError, KeyError) as exc:
                ctx.log.warning("skipping unmappable search item", extra={"reason": str(exc)[:200]})
                continue
            if len(batch) >= BATCH_SIZE:
                _flush(ctx, stats, batch, upgrade=True)
                batch = []
        _flush(ctx, stats, batch, upgrade=True)
    except (CircuitOpen, PncpError, OSError, TimeoutError) as exc:
        _flush(ctx, stats, batch, upgrade=True)
        ctx.log.warning(
            "search fallback failed too",
            extra={"error": f"{type(exc).__name__}: {exc}"[:300]},
        )


def _flush(
    ctx: JobContext, stats: CycleStats, batch: list[Tender], *, upgrade: bool = False
) -> None:
    """Upsert one batch and enqueue follow-ups for whatever actually changed.

    ``upgrade`` marks a batch that came from the search fallback, whose rows are
    missing the three columns only the Consulta detail carries
    (:data:`UPGRADE_KIND`).
    """
    if not batch:
        return
    result = _upsert(ctx.conn, batch)
    stats.absorb(result)
    stats.batches += 1
    stats.followups += _enqueue_followups(ctx, result.changed)
    if upgrade:
        stats.upgrades += _enqueue_upgrades(ctx, result.changed)


def _enqueue_followups(ctx: JobContext, tender_ids: tuple[str, ...]) -> int:
    """Queue `sync_items` and `sync_files` for new or changed tenders (§7.1).

    Only for kinds that have a handler. B3 and B4 are separate cards, and
    enqueuing a kind nothing can run would fill the queue with rows that fail
    four times and land in `failed`. The moment those modules register
    themselves this starts working with no change here.
    """
    kinds = [kind for kind in FOLLOWUP_KINDS if kind in set(REGISTRY.kinds())]
    if not kinds or not tender_ids:
        return 0
    created = 0
    for tender_id in tender_ids:
        for kind in kinds:
            # One live job per (kind, key): a tender that changes twice between
            # two runs of the consumer produces one follow-up, not two.
            if queue.enqueue(
                ctx.conn,
                kind,
                tender_id,
                priority=FOLLOWUP_PRIORITY,
                payload={"tender_id": tender_id},
            ):
                created += 1
    return created


def _enqueue_upgrades(ctx: JobContext, tender_ids: tuple[str, ...]) -> int:
    """Queue the Consulta detail re-read for tenders the fallback just wrote.

    Registry-gated like :func:`_enqueue_followups`, for the same reason.

    This will often fail on its first attempt, and that is expected rather than
    broken: the fallback runs *because* `/api/consulta` is down, so the job it
    queues is aimed at a service we already know is not answering. It matters
    anyway — the queue's own backoff (2, 8, 30 min) covers a short outage, and
    `sweep_tender_values` comes back for anything a long one swallowed.
    """
    if not tender_ids or UPGRADE_KIND not in set(REGISTRY.kinds()):
        return 0
    from .tender_value import enqueue_refreshes

    return enqueue_refreshes(ctx.conn, tender_ids)


# -- B17: the reconcile sweep, keyed on what is open ------------------------
#
# `sync_open_tenders` above windows on `dataAtualizacaoGlobal`, because
# `/v1/contratacoes/atualizacao` is a **change feed**. An edital published once
# and left open for a month never changes, so it never re-enters the window and
# is never ingested. Measured 2026-09-27 for `q=saas, status=recebendo_proposta`:
# PNCP returned 137 and the Radar returned 57, and **54 of the 72 in-scope
# misses had never been updated after publication**. None was past due; 37
# closed within three days.
#
# So this asks a different question — *what is open right now* — and it is a
# second sweep rather than a replacement. ADR-0001 stands: `/atualizacao`
# remains the change feed, and it is the only thing that can see an amendment,
# a suspension or a new item. This can only see existence.

#: Its own `events.name`, **not** a scope suffix on `CYCLE_EVENT`.
#:
#: `read_watermark` filters on `name = CYCLE_EVENT`, so a distinct name makes it
#: impossible for a reconcile cycle to move the change feed's watermark — an
#: invariant a shared name with a different scope string would leave to
#: everyone remembering to pass the right scope forever.
RECONCILE_EVENT = "reconcile_open_tenders.cycle"

#: Every UF, because the point is completeness. The national open set exceeds
#: PNCP's 10,000-record window, so the sweep has to be partitioned, and UF is
#: the partition that provably loses nothing: measured 2026-09-28, the 27 UF
#: totals sum to 26,036 and the unpartitioned national total is also 26,036.
UFS: tuple[str, ...] = (
    "AC",
    "AL",
    "AP",
    "AM",
    "BA",
    "CE",
    "DF",
    "ES",
    "GO",
    "MA",
    "MT",
    "MS",
    "MG",
    "PA",
    "PB",
    "PR",
    "PE",
    "PI",
    "RJ",
    "RN",
    "RS",
    "RO",
    "RR",
    "SC",
    "SP",
    "SE",
    "TO",
)

#: Above this share of the window, a UF is swept one modality at a time.
#:
#: Not a guess at "big": the walk is ordered by update time and PNCP stops
#: answering past 10,000 records, so a partition that reaches the cap does not
#: fail — it silently returns fewer editais than exist, which is the exact bug
#: this card was written to fix, reintroduced with a smaller blast radius.
#: 0.6 leaves room for a partition to grow between the count and the walk.
#: Measured 2026-09-28: the largest UF is SP at 5,227 (52% of the window) and
#: its largest modality is Pregão Eletrônico at 3,909, so today nothing splits
#: and the headroom is real rather than theoretical.
PARTITION_SPLIT_RATIO = 0.6

#: Rows per cycle for the `search` backfill below. 9,000 is the whole backlog
#: today, so this drains in one night and then matches nothing.
SEARCH_BACKFILL_LIMIT = 10_000

#: Fill `search` where it was never written. `ctid` because the rows have no
#: other natural batching key and the predicate is the selective part.
BACKFILL_SEARCH_SQL = f"""
update tenders t set search = {search_vector_sql("t.object", "t.id")}
where t.ctid in (
    select ctid from tenders where search is null limit %(limit)s
)
"""


class PartitionTooLarge(RuntimeError):
    """A partition holds more open editais than PNCP will page through.

    Raised rather than logged. A warning here would mean the sweep quietly
    returned an incomplete set and the cycle still recorded itself as complete
    — the shape of the bug B17 exists to remove, which is why the card asks for
    this to be *asserted*.
    """


@dataclass
class ReconcileStats:
    """What one reconcile cycle did. Written to :data:`RECONCILE_EVENT`."""

    partitions_planned: int = 0
    partitions_done: int = 0
    partitions_failed: tuple[str, ...] = ()
    expected: int = 0
    records: int = 0
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    batches: int = 0
    followups: int = 0
    upgrades: int = 0
    largest_partition: int = 0
    search_backfilled: int = 0
    #: A deliberate one-UF rerun. Never recorded as a complete cycle: the
    #: coverage figure the card is measured against is national.
    partial: bool = False
    #: Set when the planning phase itself failed, so a cycle that swept nothing
    #: says why rather than looking like an empty country.
    plan_failed: str | None = None
    #: How close `records` has to come to `expected` before a cycle calls
    #: itself complete. PNCP's index moves under the sweep — an edital can open
    #: or close between the count and the walk — so exact equality would be red
    #: every day; 2% is far tighter than the 44% coverage this card exists to
    #: fix and far looser than the churn of one night.
    coverage_tolerance: float = 0.02

    @property
    def coverage(self) -> float:
        return (self.records / self.expected) if self.expected else 0.0

    @property
    def complete(self) -> bool:
        """Complete means *the country was swept*, not *nothing raised*.

        The first version returned ``bool(partitions_planned) and not
        partitions_failed`` — absence of exceptions. That is the card's own
        defect shape: if PNCP answers 204 for a stretch, `search_page` returns
        ``{}``, every `total` reads 0, every walk yields nothing, no exception
        is raised, and the cycle records ``partitions_done: 27, records: 0,
        complete: true``. Both numbers that would reveal it are zeroed by the
        same fault, so `complete` has to depend on them.
        """
        if self.partial or self.plan_failed or self.partitions_failed:
            return False
        if not self.partitions_planned or not self.expected:
            return False
        return self.coverage >= 1.0 - self.coverage_tolerance

    def absorb(self, result: UpsertResult) -> None:
        self.inserted += len(result.inserted)
        self.updated += len(result.updated)
        self.unchanged += result.unchanged

    def as_props(self) -> dict[str, Any]:
        return {
            "partitions_planned": self.partitions_planned,
            "partitions_done": self.partitions_done,
            "partitions_failed": sorted(self.partitions_failed),
            "expected": self.expected,
            "records": self.records,
            "inserted": self.inserted,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "batches": self.batches,
            "followups": self.followups,
            "upgrades": self.upgrades,
            "largest_partition": self.largest_partition,
            "search_backfilled": self.search_backfilled,
            "coverage": round(self.coverage, 4),
            "partial": self.partial,
            "plan_failed": self.plan_failed,
            "complete": self.complete,
        }


def partition_total(client: PncpClient, uf: str, modalities: tuple[int, ...]) -> int:
    """How many open editais this partition holds, from page 1's `total`.

    One record asked for, because only the count is wanted. This is the number
    the card requires the job to *read* rather than discover by running into
    the wall at page 20.
    """
    body = client.search_page(uf=uf, modalities=modalities, page=1, page_size=1)
    return int((body or {}).get("total") or 0)


def plan_partitions(
    client: PncpClient,
    modalities: tuple[int, ...],
    *,
    window_cap: int,
    ufs: tuple[str, ...] = UFS,
    split_ratio: float = PARTITION_SPLIT_RATIO,
) -> tuple[list[tuple[str, tuple[int, ...]]], int, int]:
    """Decide how to cut the country up, and refuse to sweep a partition that
    cannot be paged through.

    Returns the partitions, the total they expect to yield, and the largest one.

    A UF is swept whole while it fits comfortably; past ``split_ratio`` of the
    window it is swept one modality at a time. Splitting *every* UF by modality
    unconditionally would triple the request count against an endpoint this
    project has already watched return 429s, for headroom nothing currently
    needs.
    """
    limit = window_cap * split_ratio
    partitions: list[tuple[str, tuple[int, ...]]] = []
    expected = 0
    largest = 0
    for uf in ufs:
        total = partition_total(client, uf, modalities)
        expected += total
        if total <= limit:
            largest = max(largest, total)
            partitions.append((uf, modalities))
            continue
        for modality in modalities:
            one = (modality,)
            part_total = partition_total(client, uf, one)
            # The **same** limit as the UF check, not the bare cap. Checking a
            # slice against 10,000 with no headroom threw away the reason the
            # ratio exists: a slice at 9,999 passes, one edital is published
            # between the count and page 20, and `iter_search` returns short
            # with only a warning — the silent incompleteness this guard is
            # here to prevent, one level down.
            if part_total > limit:
                raise PartitionTooLarge(
                    f"{uf} modality {modality} holds {part_total} open editais,"
                    f" past the {limit:.0f} this sweep will page through"
                    f" (PNCP's window is {window_cap}). It cannot be swept"
                    " completely and needs a narrower partition than UF x"
                    " modality — see B20"
                )
            largest = max(largest, part_total)
            partitions.append((uf, one))
    return partitions, expected, largest


@REGISTRY.job("reconcile_open_tenders")
def reconcile_open_tenders(ctx: JobContext) -> None:
    """Store every edital PNCP currently calls open, partition by partition.

    Payload:

    ``modalities``
        Override the modality set. Defaults to :data:`DEFAULT_MODALITIES`.
    ``ufs``
        Sweep only these UFs. For re-running one partition by hand; a partial
        run is never recorded as complete.

    **No `stop_at`.** The change feed is incremental because it is a feed of
    changes; this is an inventory, and an inventory that stops early is just a
    smaller wrong answer. Rerunning it costs almost nothing: `UPSERT_SQL`'s
    `where` clause means a record whose `pncp_updated_at` has not moved is not
    written at all, so a second pass over the same set reports `unchanged` and
    leaves `updated_at` where it was.
    """
    modalities = tuple(ctx.payload.get("modalities") or DEFAULT_MODALITIES)
    only = tuple(str(u).upper() for u in (ctx.payload.get("ufs") or ()))
    ufs = tuple(uf for uf in UFS if uf in only) if only else UFS
    stats = ReconcileStats()
    stats.partial = bool(only)

    # Filtered **before** planning, not after. Filtering after made a one-UF
    # rerun ask for all 27 counts, inherit the national `expected` — so the
    # event row claimed 26,000 expected against 5,000 swept — and abort on an
    # oversized partition in a UF it was never going to touch.
    with build_client() as client:
        try:
            partitions, expected, largest = plan_partitions(
                client, modalities, ufs=ufs, window_cap=SEARCH_WINDOW_CAP
            )
        except (CircuitOpen, PncpError, OSError, TimeoutError) as exc:
            # Planning is a network phase like any other. Letting it escape
            # meant one bad count request aborted the cycle before any
            # partition was swept **and wrote no event at all**, so nothing
            # recorded that the day's reconcile had not happened.
            stats.plan_failed = f"{type(exc).__name__}: {exc}"[:300]
            _record_reconcile(ctx, stats)
            ctx.log.warning("reconcile could not plan", extra={"error": stats.plan_failed})
            return
        _run_reconcile(ctx, client, stats, partitions, expected, largest)


def _run_reconcile(ctx, client, stats, partitions, expected, largest) -> None:
    stats.partitions_planned = len(partitions)
    stats.expected = expected
    stats.largest_partition = largest
    ctx.log.info(
        "reconcile planned",
        extra={
            "partitions": len(partitions),
            "expected": expected,
            "largest_partition": largest,
            "window_cap": SEARCH_WINDOW_CAP,
        },
    )

    failed: list[str] = []
    for uf, part_modalities in partitions:
        try:
            _reconcile_partition(ctx, client, stats, uf, part_modalities)
            stats.partitions_done += 1
        except (CircuitOpen, PncpError, OSError, TimeoutError) as exc:
            failed.append(uf)
            ctx.log.warning(
                "reconcile partition failed",
                extra={
                    "uf": uf,
                    "modalities": sorted(part_modalities),
                    "error": f"{type(exc).__name__}: {exc}"[:300],
                },
            )
    stats.partitions_failed = tuple(failed)

    stats.search_backfilled = backfill_missing_search(ctx.conn)
    _record_reconcile(ctx, stats)
    ctx.log.info("reconcile finished", extra=stats.as_props())


def _record_reconcile(ctx: JobContext, stats: ReconcileStats) -> None:
    """Write the cycle row. Always — a cycle that failed to plan is the one
    most worth having a record of."""
    ctx.conn.execute(
        "insert into events (name, props) values (%s, %s)",
        (RECONCILE_EVENT, Jsonb(stats.as_props())),
    )


def backfill_missing_search(conn: psycopg.Connection, *, limit: int = SEARCH_BACKFILL_LIMIT) -> int:
    """Give a `search` vector to rows that never got one.

    **Why the upsert alone does not close this.** `UPSERT_SQL` writes `search`
    on insert and inside `ON CONFLICT DO UPDATE`, and that branch is governed
    by ``where tenders.pncp_updated_at is distinct from excluded...`` — the
    guard that makes a rerun a no-op. A tender already stored, whose PNCP
    timestamp has not moved, is therefore never rewritten, and its `search`
    stays null forever however many times the sweep passes over it.

    Measured 2026-09-28: **8 905 of 29 089 rows have no `search` vector, and
    every single one has zero items.** The correlation is exact because
    `refresh_search` is only reachable through the item roll-up, so a tender
    PNCP lists no items for is invisible to `t.search @@ websearch_to_tsquery`
    — the Radar's only text filter — no matter what its objeto says.

    Capped per cycle so the first run cannot become one statement over nine
    thousand rows, and self-extinguishing: once none are null this matches
    nothing and costs an index probe.
    """
    with conn.cursor() as cur:
        cur.execute(BACKFILL_SEARCH_SQL, {"limit": limit})
        return cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0


def _reconcile_partition(
    ctx: JobContext,
    client: PncpClient,
    stats: ReconcileStats,
    uf: str,
    modalities: tuple[int, ...],
) -> None:
    """Walk one partition to its end and upsert what it holds."""
    batch: list[Tender] = []
    for item in client.iter_search(uf=uf, modalities=modalities, stop_at=None):
        stats.records += 1
        try:
            batch.append(from_search(item))
        except (ValueError, KeyError) as exc:
            ctx.log.warning(
                "skipping unmappable search item",
                extra={"uf": uf, "reason": str(exc)[:200]},
            )
            continue
        if len(batch) >= BATCH_SIZE:
            _flush_reconcile(ctx, stats, batch)
            batch = []
    _flush_reconcile(ctx, stats, batch)


def _flush_reconcile(ctx: JobContext, stats: ReconcileStats, batch: list[Tender]) -> None:
    """Upsert a batch and queue the follow-ups a search-sourced row needs.

    Every row here comes from the search index, which publishes no
    `valorTotalEstimado`, `srp` or `orcamentoSigilosoCodigo` — so each one gets
    the same `refresh_tender_value` upgrade the fallback queues, for the same
    reason (:data:`UPGRADE_KIND`).
    """
    if not batch:
        return
    result = _upsert(ctx.conn, batch)
    stats.absorb(result)
    stats.batches += 1
    stats.followups += _enqueue_followups(ctx, result.changed)
    stats.upgrades += _enqueue_upgrades(ctx, result.changed)
