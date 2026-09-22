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
from .pncp import PncpClient, PncpError
from .registry import REGISTRY, JobContext
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
