#!/usr/bin/env python3
"""Backfill the awards price base, through the same code the scheduler runs.

Card B8 asks for ≥ 5,000 awarded items stored. Nothing in the nightly job can
produce that on its own, because it can only ask about tenders that are already
in `tenders` with their items classified — and the collector has been sweeping
*open* tenders (B2 windows on `recebendo_proposta`). Awards live on **closed**
ones. So this script does the three steps in order, for a past publication
window:

1. sweep `/contratacoes/publicacao` for the window and upsert the headers
   (B2's :func:`licitaqui.tenders.from_consulta`);
2. fetch and classify each tender's items (B3's
   :func:`licitaqui.items.classify_all`), which is what produces both
   ``has_award`` and the segment the targeting reads;
3. run B8's own ``sync_tender_awards`` handler over each tender.

Step 3 is the real handler, not a copy of it: the masking, the *permanent once
awarded* rule and the segment filter are whatever production does, because they
**are** production. A backfill that reimplemented the write path would prove
nothing about the write path.

## What it costs

One request per tender for step 2, one per awarded item in a segment of
interest for step 3, plus one per 50 tenders for step 1. Everything goes
through one :class:`licitaqui.pncp.PncpClient`, so §7.2's 4 req/s and the
breakers apply to the whole run: it cannot go faster than the collector is
allowed to, by construction. `--report-every` prints the running cost.

## Where it writes

Whatever ``--dsn-var`` names, default ``TEST_DATABASE_URL_B8`` — B8's own
isolated database. **Never** the production one without saying so explicitly:
a backfill is a bulk write and the first run of one should not land on the
database the product reads.

    python3 scripts/backfill_awards.py --target 5000 --from 2026-05-01 --to 2026-07-31
"""

from __future__ import annotations

import argparse
import logging
import queue
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

# Allow `python3 scripts/backfill_awards.py` from the worker directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import psycopg  # noqa: E402

from licitaqui import config, db  # noqa: E402
from licitaqui import sync_awards as sync_awards_module  # noqa: E402
from licitaqui.breaker import CircuitOpen  # noqa: E402
from licitaqui.items import classify_all, roll_up, upsert_items  # noqa: E402
from licitaqui.pncp import PncpClient, PncpError  # noqa: E402
from licitaqui.queue import Job  # noqa: E402
from licitaqui.registry import JobContext  # noqa: E402
from licitaqui.sync_awards import (  # noqa: E402
    DEFAULT_SEGMENTS,
    FOLLOWUP_KIND,
    probed_at,
    sync_tender_awards,
)
from licitaqui.tenders import (  # noqa: E402
    DEFAULT_MODALITIES,
    from_consulta,
    from_search,
    split_control_number,
    upsert_tenders,
)

LOG = logging.getLogger("backfill_awards")


class KeepAlive(PncpClient):
    """One client for the whole run, so the 4 req/s throttle is global.

    The handler opens its client in a ``with`` block, which would otherwise
    close a shared one after the first tender. Production is right to build one
    per job — a job is a connection budget — but a backfill is a single long
    job wearing a thousand hats, and letting each tender reset the throttle
    would turn a paced run into a thousand small bursts.
    """

    def close(self) -> None:  # pragma: no cover - exercised only by this script
        pass

    def shutdown(self) -> None:
        super().close()


def resolve_dsn(var: str) -> str:
    """The same resolution `db/migrate.py` and the tests use. Never printed."""
    roots = [config.ROOT]
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=config.ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout.strip()
        if common:
            roots.append(Path(common).parent)
    except (OSError, subprocess.SubprocessError):
        pass
    for root in roots:
        dsn = config.resolve_secret(var, root=root)
        if dsn:
            return dsn
    raise SystemExit(f"{var} is not configured")


def _records(
    client: PncpClient,
    source: str,
    *,
    day_from: date,
    day_to: date,
    modality: int,
    uf: str | None,
) -> Iterator[tuple[dict, bool]]:
    """`(record, is_consulta_shape)` from whichever source was asked for.

    ``publicacao``
        the Consulta API windowed on publication date — the richer record (it
        carries ``valorTotalEstimado`` and ``srp``), and ADR-0001's primary
        path.
    ``search``
        the search index with ``status=encerradas``, which is **POC 3's own
        source** for this exact job ("Buscando ENCERRADAS"). Poorer per record,
        but it is a different service behind a different breaker, and it also
        carries ``tem_resultado`` — a tender-level flag that lets the backfill
        skip tenders with nothing to award before spending an items request on
        them.

    Why both: the Consulta host timed out on every attempt while this was being
    written (the ADR's measured failure mode, and the reason the fallback
    exists at all). A backfill that could only run when the flakier of two
    services is up is a backfill that does not run.
    """
    if source == "publicacao":
        for record in client.iter_publicacao(day_from, day_to, modality, uf=uf):
            yield record, True
        return
    for item in client.iter_search(uf=uf, modalities=(modality,), status="encerradas"):
        # POC 3's filter, kept: `tem_resultado is not False` — absent means
        # unknown and is worth a look; an explicit False is a wasted request.
        if item.get("tem_resultado") is False:
            continue
        yield item, False


def sweep_tenders(
    client: PncpClient,
    conn: psycopg.Connection,
    *,
    source: str,
    day_from: date,
    day_to: date,
    modalities: tuple[int, ...],
    ufs: tuple[str, ...],
) -> Iterator[str]:
    """Closed tenders, upserted in batches of 50 as they arrive.

    A failure on one (uf, modality) pair logs and moves to the next rather than
    ending the run. That is not the queue's job talking — this is an operator
    script, and everything it writes is idempotent, so the cost of losing a
    slice is one re-run and the cost of aborting is the whole collection.
    """
    for uf in ufs or (None,):
        for modality in modalities:
            LOG.info("sweep source=%s uf=%s modality=%s", source, uf or "all", modality)
            batch: list = []
            try:
                for record, consulta in _records(
                    client,
                    source,
                    day_from=day_from,
                    day_to=day_to,
                    modality=modality,
                    uf=uf,
                ):
                    try:
                        batch.append(from_consulta(record) if consulta else from_search(record))
                    except ValueError:
                        continue
                    if len(batch) >= 50:
                        upsert_tenders(conn, batch)
                        yield from (tender.id for tender in batch)
                        batch = []
            except (PncpError, CircuitOpen) as exc:
                LOG.warning("sweep failed for uf=%s modality=%s: %s", uf or "all", modality, exc)
            if batch:
                upsert_tenders(conn, batch)
                yield from (tender.id for tender in batch)


def sync_one_tenders_items(client: PncpClient, conn: psycopg.Connection, tender_id: str) -> int:
    """B3's step, inline: fetch, classify, upsert, roll up. Returns awarded items."""
    cnpj, year, sequence = split_control_number(tender_id)
    records = list(client.iter_items(cnpj, year, sequence))
    items = classify_all(tender_id, records)
    upsert_items(conn, tender_id, items)
    row = conn.execute("select estimated_value, object from tenders where id = %s", (tender_id,))
    found = row.fetchone()
    roll_up(
        conn,
        tender_id,
        items,
        estimated_value=found[0] if found else None,
        object_text=found[1] if found else None,
    )
    return sum(1 for item in items if item.has_award)


def stored_awards(conn: psycopg.Connection) -> int:
    return int(conn.execute("select count(*) from awards").fetchone()[0])


def one_tender(
    client: PncpClient,
    conn: psycopg.Connection,
    tender_id: str,
    *,
    segments: list[str],
    items_cap: int,
    skip_probed: bool,
) -> int:
    """Items then awards for one tender. Returns awarded items seen; raises on PNCP.

    ``skip_probed`` makes a re-run cheap. A tender that already carries a probe
    marker was finished by an earlier slice, and re-reading its items would
    spend a request to rediscover that every awarded item is settled. One
    indexed `events` lookup replaces one HTTP call.
    """
    if skip_probed and probed_at(conn, tender_id) is not None:
        return 0
    awarded = sync_one_tenders_items(client, conn, tender_id)
    if not awarded:
        return 0
    job = Job(
        id=-1,
        kind=FOLLOWUP_KIND,
        key=tender_id,
        priority=9,
        payload={
            "tender_id": tender_id,
            "segments": segments,
            "items": items_cap,
            # The backfill re-probes on purpose: it is the run that *creates*
            # the history, so a marker left by an earlier slice must not make
            # this one a no-op. `force` never overrides "permanent once
            # awarded" — settled items are still skipped by their award row.
            "force": True,
        },
        attempts=1,
    )
    sync_tender_awards(JobContext(job=job, conn=conn, connect=lambda: conn, log=LOG))
    return awarded


def wait_out(exc: CircuitOpen, stop: threading.Event) -> bool:
    """Sleep until an open circuit is due to close. False if the run is stopping.

    Measured the hard way, on the first full run of this script: with ten
    threads sharing one breaker, two consecutive timeouts on `/itens` opened
    the circuit for the spec's 900 s (§7.2) — and the workers then drained the
    sweep at full speed, failing every tender instantly and **discarding** it.
    Forty tenders vanished in seconds. The queue is what normally protects
    against that (a failed job is retried at 2, 8 and 30 minutes); a script has
    to do it itself, and the honest way is to stop taking work rather than to
    keep pulling it and drop it.

    Waking every few seconds rather than sleeping the whole 900 s so that
    Ctrl-C still lands.
    """
    deadline = time.monotonic() + exc.retry_in + 2
    LOG.warning("circuit '%s' open; pausing %.0f s", exc.name, exc.retry_in)
    while time.monotonic() < deadline:
        if stop.wait(5):
            return False
    return True


@dataclass
class Totals:
    """What the run has done so far, guarded by its own lock."""

    lock: threading.Lock = field(default_factory=threading.Lock)
    tenders: int = 0
    awarded_seen: int = 0
    failed: int = 0

    def add(self, *, awarded: int, failed: int) -> int:
        with self.lock:
            self.tenders += 1
            self.awarded_seen += awarded
            self.failed += failed
            return self.tenders


def worker(
    name: str,
    client: PncpClient,
    dsn: str,
    work: queue.Queue,
    totals: Totals,
    stop: threading.Event,
    *,
    segments: list[str],
    items_cap: int,
    attempts: int,
    skip_probed: bool,
) -> None:
    """One thread, one database connection, the shared rate-limited client.

    Concurrency here buys nothing against PNCP — the throttle is global and
    holds the whole run to `--rate` requests a second whatever the thread count
    — and everything against **Neon**. Measured single-threaded: 5.7 s per
    tender, of which about 0.4 s was HTTP. The rest was round trips to São
    Paulo, and they overlap.
    """
    with db.connect(dsn, application_name=f"licitaqui-b8-backfill-{name}") as conn:
        while not stop.is_set():
            try:
                tender_id = work.get(timeout=5)
            except queue.Empty:
                continue
            try:
                _run_with_retries(
                    client,
                    conn,
                    tender_id,
                    totals,
                    stop,
                    segments=segments,
                    items_cap=items_cap,
                    attempts=attempts,
                    skip_probed=skip_probed,
                )
            except Exception:  # pragma: no cover - a backfill must not die on one row
                LOG.exception("unhandled error on %s", tender_id)
                totals.add(awarded=0, failed=1)
            finally:
                work.task_done()


def _run_with_retries(
    client: PncpClient,
    conn: psycopg.Connection,
    tender_id: str,
    totals: Totals,
    stop: threading.Event,
    *,
    segments: list[str],
    items_cap: int,
    attempts: int,
    skip_probed: bool,
) -> None:
    """The queue's retry policy (§7.2), scaled down to a script.

    Everything a retry re-reads is idempotent and everything already stored is
    excluded by the `not exists (…awards…)` predicate, so a second attempt
    costs only the requests the first one did not get to.
    """
    for attempt in range(1, attempts + 1):
        try:
            awarded = one_tender(
                client,
                conn,
                tender_id,
                segments=segments,
                items_cap=items_cap,
                skip_probed=skip_probed,
            )
        except CircuitOpen as exc:
            if not wait_out(exc, stop):
                totals.add(awarded=0, failed=1)
                return
            continue
        except PncpError as exc:
            LOG.warning("attempt %d failed for %s: %s", attempt, tender_id, exc)
            if attempt == attempts or stop.wait(2):
                totals.add(awarded=0, failed=1)
                return
            continue
        totals.add(awarded=awarded, failed=0)
        return
    totals.add(awarded=0, failed=1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn-var", default="TEST_DATABASE_URL_B8")
    ap.add_argument("--source", choices=["search", "publicacao"], default="search")
    ap.add_argument("--from", dest="day_from", default="2026-05-01")
    ap.add_argument("--to", dest="day_to", default="2026-07-31")
    ap.add_argument("--modalities", nargs="*", type=int, default=list(DEFAULT_MODALITIES))
    ap.add_argument("--ufs", nargs="*", default=[])
    ap.add_argument("--segments", nargs="*", default=list(DEFAULT_SEGMENTS))
    ap.add_argument("--target", type=int, default=5000, help="stop once this many rows are stored")
    ap.add_argument("--max-tenders", type=int, default=1_000_000)
    ap.add_argument("--items-per-tender", type=int, default=200)
    ap.add_argument("--report-every", type=int, default=60, help="seconds between progress lines")
    ap.add_argument("--rate", type=float, default=4.0, help="requests per second (§7.2)")
    ap.add_argument("--workers", type=int, default=6, help="threads hiding database latency")
    ap.add_argument("--attempts", type=int, default=3, help="tries per tender before giving up")
    ap.add_argument(
        "--reprobe",
        action="store_true",
        help="re-read tenders an earlier run already finished (default: skip them)",
    )
    ap.add_argument("--quiet-httpx", action="store_true", default=True)
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    if args.quiet_httpx:
        logging.getLogger("httpx").setLevel(logging.WARNING)
    day_from = datetime.strptime(args.day_from, "%Y-%m-%d").date()
    day_to = datetime.strptime(args.day_to, "%Y-%m-%d").date()

    client = KeepAlive(rate_limit=args.rate)
    sync_awards_module.build_client = lambda: client  # type: ignore[assignment]

    dsn = resolve_dsn(args.dsn_var)
    started = time.monotonic()
    totals = Totals()
    work: queue.Queue = queue.Queue(maxsize=args.workers * 4)
    stop = threading.Event()

    threads = [
        threading.Thread(
            target=worker,
            args=(str(n), client, dsn, work, totals, stop),
            kwargs={
                "segments": list(args.segments),
                "items_cap": args.items_per_tender,
                "attempts": args.attempts,
                "skip_probed": not args.reprobe,
            },
            daemon=True,
            name=f"backfill-{n}",
        )
        for n in range(args.workers)
    ]
    for thread in threads:
        thread.start()

    with db.connect(dsn, application_name="licitaqui-b8-backfill") as conn:
        base = stored_awards(conn)
        LOG.info("starting with %d award rows already stored", base)
        last_report = started
        total = base
        try:
            for tender_id in sweep_tenders(
                client,
                conn,
                source=args.source,
                day_from=day_from,
                day_to=day_to,
                modalities=tuple(args.modalities),
                ufs=tuple(args.ufs),
            ):
                while not stop.is_set():
                    try:
                        work.put(tender_id, timeout=5)
                        break
                    except queue.Full:
                        continue
                if time.monotonic() - last_report >= args.report_every:
                    last_report = time.monotonic()
                    total = stored_awards(conn)
                    elapsed = (time.monotonic() - started) / 60
                    LOG.info(
                        "tenders=%d awarded_items_seen=%d stored=%d (+%d) failed=%d "
                        "%.1f min (%.0f rows/min)",
                        totals.tenders,
                        totals.awarded_seen,
                        total,
                        total - base,
                        totals.failed,
                        elapsed,
                        (total - base) / elapsed if elapsed else 0,
                    )
                    if total - base >= args.target or totals.tenders >= args.max_tenders:
                        LOG.info("target reached")
                        break
        except KeyboardInterrupt:
            LOG.warning("interrupted")
        stop.set()
        for thread in threads:
            thread.join(timeout=60)
        total = stored_awards(conn)

    client.shutdown()
    LOG.info(
        "DONE tenders=%d awarded_items_seen=%d failed=%d rows_before=%d rows_after=%d "
        "added=%d in %.1f min",
        totals.tenders,
        totals.awarded_seen,
        totals.failed,
        base,
        total,
        total - base,
        (time.monotonic() - started) / 60,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
