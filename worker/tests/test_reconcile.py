"""B17's partition planner: the sweep must know it can finish before it starts.

No database and no network — these drive `plan_partitions` against a fake
client, because the property under test is arithmetic about PNCP's paging
window and nothing else.
"""

from __future__ import annotations

import psycopg
import pytest
from psycopg.types.json import Jsonb

from licitaqui.observability import get_logger
from licitaqui.pncp import SEARCH_WINDOW_CAP
from licitaqui.search_vector import UPDATE_SEARCH_SQL
from licitaqui.sync_tenders import (
    CYCLE_EVENT,
    PARTITION_SPLIT_RATIO,
    RECONCILE_EVENT,
    UFS,
    PartitionTooLarge,
    backfill_missing_search,
    plan_partitions,
    read_watermark,
    scope_key,
)

from .conftest import CROSS_RUN_SWEEP_HOURS, RUN_ID

MODALITIES = (6, 8, 4)


class FakeClient:
    """Answers `search_page` from a table of totals, and counts the asking."""

    def __init__(self, totals: dict[tuple[str, tuple[int, ...]], int], default: int = 10):
        self.totals = totals
        self.default = default
        self.calls: list[tuple[str, tuple[int, ...]]] = []

    def search_page(self, *, uf, modalities, page=1, page_size=1, status="recebendo_proposta"):
        key = (uf, tuple(modalities))
        self.calls.append(key)
        return {"total": self.totals.get(key, self.default), "items": []}


def test_every_uf_is_swept():
    """Completeness is the whole point of this card, so no UF may be skipped.

    Measured 2026-09-28, the 27 UF totals sum to exactly the unpartitioned
    national total (26 036 both ways), which is what makes UF a partition that
    loses nothing rather than merely a convenient one.
    """
    client = FakeClient({})
    partitions, _, _ = plan_partitions(client, MODALITIES, window_cap=SEARCH_WINDOW_CAP)

    assert [uf for uf, _ in partitions] == list(UFS)
    assert len(UFS) == 27


def test_a_comfortable_uf_is_swept_whole():
    """Splitting every UF by modality would triple the request count to buy
    headroom nothing needs. SP is the largest real partition at ~52% of the
    window, measured 2026-09-28."""
    client = FakeClient({("SP", MODALITIES): 5_227})
    partitions, _, largest = plan_partitions(client, MODALITIES, window_cap=SEARCH_WINDOW_CAP)

    assert ("SP", MODALITIES) in partitions
    assert ("SP", (6,)) not in partitions
    assert largest == 5_227


def test_a_uf_near_the_window_is_split_by_modality():
    over = int(SEARCH_WINDOW_CAP * PARTITION_SPLIT_RATIO) + 1
    client = FakeClient(
        {
            ("SP", MODALITIES): over,
            ("SP", (6,)): 4_000,
            ("SP", (8,)): 1_500,
            ("SP", (4,)): 1_000,
        }
    )
    partitions, _, largest = plan_partitions(client, MODALITIES, window_cap=SEARCH_WINDOW_CAP)

    assert ("SP", MODALITIES) not in partitions
    for modality in MODALITIES:
        assert ("SP", (modality,)) in partitions
    # The largest partition is now the biggest *slice*, not the whole UF.
    assert largest == 4_000
    # Every other UF is untouched by one UF splitting.
    assert ("MG", MODALITIES) in partitions


def test_a_partition_that_cannot_be_paged_raises_rather_than_truncating():
    """**The point of the card, restated as a test.**

    Past the window PNCP does not error — it stops answering, so a sweep that
    runs into it returns fewer editais than exist and has no way to know. A
    warning here would let the cycle record itself as complete while holding an
    incomplete set, which is the defect B17 exists to remove, reintroduced with
    a smaller blast radius. The acceptance criterion says *asserted, not
    logged*.
    """
    # Past the *sweep's* limit, not merely past the raw window: a slice checked
    # against the bare 10 000 has no room to grow between the count and page 20.
    over_limit = int(SEARCH_WINDOW_CAP * PARTITION_SPLIT_RATIO) + 1
    client = FakeClient(
        {
            ("SP", MODALITIES): SEARCH_WINDOW_CAP * 2,
            ("SP", (6,)): over_limit,
        }
    )
    with pytest.raises(PartitionTooLarge) as caught:
        plan_partitions(client, MODALITIES, window_cap=SEARCH_WINDOW_CAP)

    message = str(caught.value)
    assert "SP" in message
    assert "B20" in message, "the message should name the card that owns a narrower partition"


def test_the_expected_total_is_the_sum_of_the_partitions():
    """`expected` is what the coverage figure is measured against, so it has to
    be the count PNCP reported rather than the count we managed to store."""
    totals = {(uf, MODALITIES): index * 100 for index, uf in enumerate(UFS)}
    client = FakeClient(totals, default=0)
    _, expected, _ = plan_partitions(client, MODALITIES, window_cap=SEARCH_WINDOW_CAP)

    assert expected == sum(totals.values())


def test_the_planner_asks_once_per_partition():
    """One record per count, one count per partition. The planner runs before
    every sweep, so an extra request here is 27 extra requests a day."""
    client = FakeClient({})
    plan_partitions(client, MODALITIES, window_cap=SEARCH_WINDOW_CAP)

    assert len(client.calls) == len(UFS)
    assert client.calls == [(uf, MODALITIES) for uf in UFS]


# -- the backfill, against a real database ---------------------------------
#
# `plan_partitions` above is arithmetic and needs no database. This does: it is
# the **only** thing that makes the card's own acceptance criterion reachable —
# *"a tender ingested with zero items is findable by a word in its objeto"* —
# and the first version of this change shipped it with no test at all. The
# vector write in `UPSERT_SQL` cannot close that criterion by itself: its
# `ON CONFLICT` branch is governed by the guard that makes a rerun a no-op, so
# a row already stored whose PNCP timestamp has not moved is never rewritten
# and its `search` stays null however many cycles pass over it.

CB_CNPJ = f"95{int(RUN_ID, 16):012d}"[:14]


def _tender(conn, sequence: int, objeto: str, *, search: bool = False) -> str:
    tender_id = f"{CB_CNPJ}-1-{sequence:06d}/2026"
    conn.execute(
        "insert into tenders (id, agency_cnpj, year, sequence, object) values (%s, %s, %s, %s, %s)",
        (tender_id, CB_CNPJ, 2026, sequence, objeto),
    )
    if search:
        conn.execute(UPDATE_SEARCH_SQL, (tender_id,))
    return tender_id


def _matches(conn, tender_id: str, word: str) -> bool:
    row = conn.execute(
        "select search @@ websearch_to_tsquery('pt_unaccent', %s) from tenders where id = %s",
        (word, tender_id),
    ).fetchone()
    return bool(row and row[0])


@pytest.fixture
def bf_conn(test_dsn: str):
    """This suite's own rows, swept before and after — `clean_dsn` deletes jobs.

    `95` rather than `99`: this shares the general `TEST_DATABASE_URL`, where a
    different leading pair is what keeps each block out of the others'
    cross-run sweeps (`conftest.py`, `TITLE_CNPJ`).
    """

    def sweep(conn):
        conn.execute("delete from tenders where agency_cnpj = %s", (CB_CNPJ,))
        conn.execute(
            "delete from tenders where agency_cnpj ~ '^95[0-9]{12}$'"
            f"  and updated_at < now() - interval '{CROSS_RUN_SWEEP_HOURS} hours'"
        )

    with psycopg.connect(test_dsn, autocommit=True) as conn:
        sweep(conn)
        try:
            yield conn
        finally:
            sweep(conn)


def test_a_zero_item_tender_becomes_findable_by_a_word_in_its_objeto(bf_conn) -> None:
    """The card's acceptance criterion, as a test.

    Measured 2026-09-28: 8,905 of 29,089 production rows had no vector, and
    **every one had zero items** — an exact correlation, because the only
    writer was `sync_items`' roll-up. Such a tender matches nothing in the
    Radar, whatever its objeto says.
    """
    tender_id = _tender(bf_conn, 1, "CONTRATACAO DE SOLUCAO SAAS DE GESTAO GEOESPACIAL")
    assert not _matches(bf_conn, tender_id, "geoespacial"), "fixture should start unfindable"

    assert backfill_missing_search(bf_conn, limit=500) >= 1
    assert _matches(bf_conn, tender_id, "geoespacial")


def test_the_backfill_extinguishes_itself(bf_conn) -> None:
    """`to_tsvector(coalesce(...))` is never null, so a row it touches never
    matches `search is null` again. Without that the daily cycle would rewrite
    the same rows forever."""
    _tender(bf_conn, 2, "AQUISICAO DE EQUIPAMENTO TOPOGRAFICO")
    backfill_missing_search(bf_conn, limit=500)

    before = bf_conn.execute(
        "select count(*) from tenders where agency_cnpj = %s and search is null", (CB_CNPJ,)
    ).fetchone()[0]
    assert before == 0


def test_the_backfill_never_narrows_a_vector_that_already_has_items(bf_conn) -> None:
    """**The trap `search_vector` warns about.**

    A tender whose items have been synced has their words in its vector.
    Recomputing from the objeto alone would silently remove them — the tender
    stops matching a word printed on its own card, and nothing fails.

    **What actually protects it is the expression, not the `search is null`
    gate**, and the difference was found by mutation: removing the gate so the
    backfill touches every row leaves this green, because the expression
    recomputes objeto *and* items either way. Narrowing the expression to the
    objeto alone is what reddens it. Worth stating, because the first version
    of this docstring credited the gate — a test that passes for a reason other
    than the one it claims is how a guard quietly stops guarding.
    """
    tender_id = _tender(bf_conn, 3, "AQUISICAO DE MATERIAL")
    bf_conn.execute(
        "insert into tender_items (tender_id, number, description) values (%s, %s, %s)",
        (tender_id, 1, "licenca de software cartografico"),
    )
    bf_conn.execute(UPDATE_SEARCH_SQL, (tender_id,))
    assert _matches(bf_conn, tender_id, "cartografico")

    backfill_missing_search(bf_conn, limit=500)

    assert _matches(bf_conn, tender_id, "cartografico"), "the item's words were dropped"
    assert _matches(bf_conn, tender_id, "material")


def test_a_reconcile_cycle_leaves_the_change_feeds_watermark_untouched(bf_conn) -> None:
    """The card names this as acceptance, and it holds by construction — which
    is exactly why it needs pinning. `read_watermark` filters on `CYCLE_EVENT`;
    the reconcile writes `RECONCILE_EVENT`. Nothing stops a later tidy-up from
    "unifying" the two names, and nothing would fail if it did."""
    assert RECONCILE_EVENT != CYCLE_EVENT

    scope = scope_key(None, (6, 8, 4))
    before = read_watermark(bf_conn, scope)
    bf_conn.execute(
        "insert into events (name, props) values (%s, %s)",
        (RECONCILE_EVENT, Jsonb({"scope": scope, "complete": True, "window_end": "2099-01-01"})),
    )
    try:
        assert read_watermark(bf_conn, scope) == before
    finally:
        bf_conn.execute("delete from events where name = %s", (RECONCILE_EVENT,))


# -- the job itself, end to end --------------------------------------------
#
# Everything above tests a part. This drives `reconcile_open_tenders` through
# its own registered handler against a real database, with PNCP faked at the
# client boundary — because the card's whole subject is a **cycle**, and until
# now nothing executed one. A suite can be green, long and database-backed and
# still never invoke the function the card is about; ours was.


class FakeSweepClient(FakeClient):
    """A `PncpClient` stand-in that also walks pages."""

    def __init__(self, totals, items_by_partition, default=0):
        super().__init__(totals, default=default)
        self.items = items_by_partition
        self.walked: list[tuple[str, tuple[int, ...]]] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def iter_search(self, *, uf=None, modalities=(), status="recebendo_proposta", stop_at=None):
        assert stop_at is None, "the inventory sweep must not window on a watermark"
        self.walked.append((uf, tuple(modalities)))
        yield from self.items.get((uf, tuple(modalities)), ())


def _search_item(cnpj: str, sequence: int, objeto: str) -> dict:
    """The shape `from_search` maps, as the index publishes it."""
    return {
        "numero_controle_pncp": f"{cnpj}-1-{sequence:06d}/2026",
        "orgao_cnpj": cnpj,
        "ano": 2026,
        "numero_sequencial": sequence,
        "description": objeto,
        "modalidade_licitacao_id": 6,
        "data_atualizacao_pncp": "2026-09-28T00:00:00",
    }


def _run_cycle(conn, monkeypatch, client, payload: dict) -> dict:
    """Invoke the registered handler and return the cycle's event props."""
    from licitaqui import sync_tenders
    from licitaqui.queue import Job
    from licitaqui.registry import REGISTRY, JobContext

    monkeypatch.setattr(sync_tenders, "build_client", lambda: client)
    job = Job(id=0, kind="reconcile_open_tenders", key="t", priority=9, payload=payload, attempts=1)
    ctx = JobContext(job=job, conn=conn, connect=lambda: conn, log=get_logger("test"))
    REGISTRY.get("reconcile_open_tenders")(ctx)

    row = conn.execute(
        "select props from events where name = %s order by id desc limit 1", (RECONCILE_EVENT,)
    ).fetchone()
    assert row, "a cycle must always leave a record of itself"
    return row[0]


def test_a_cycle_stores_what_pncp_calls_open_and_records_itself(bf_conn, monkeypatch) -> None:
    items = [
        _search_item(CB_CNPJ, 100 + n, f"AQUISICAO DE MATERIAL ESCOLAR LOTE {n}") for n in range(3)
    ]
    client = FakeSweepClient({("RR", (6, 8, 4)): 3}, {("RR", (6, 8, 4)): items})

    props = _run_cycle(bf_conn, monkeypatch, client, {"ufs": ["RR"]})

    stored = bf_conn.execute(
        "select count(*) from tenders where agency_cnpj = %s", (CB_CNPJ,)
    ).fetchone()[0]
    assert stored == 3
    assert props["records"] == 3
    assert props["inserted"] == 3
    # A deliberate one-UF rerun is never a complete national cycle, and its
    # `expected` is that UF's own total — not the country's.
    assert props["partial"] is True
    assert props["complete"] is False
    assert props["expected"] == 3
    assert client.calls == [("RR", (6, 8, 4))], "one count request, not 27"


def test_a_cycle_leaves_the_change_feeds_watermark_alone(bf_conn, monkeypatch) -> None:
    """The card's acceptance criterion, driven through a real cycle rather than
    asserted about two constants."""
    scope = scope_key(None, (6, 8, 4))
    before = read_watermark(bf_conn, scope)

    client = FakeSweepClient(
        {("RR", (6, 8, 4)): 1},
        {("RR", (6, 8, 4)): [_search_item(CB_CNPJ, 200, "AQUISICAO DE COMBUSTIVEL")]},
    )
    _run_cycle(bf_conn, monkeypatch, client, {"ufs": ["RR"]})

    assert read_watermark(bf_conn, scope) == before


def test_a_cycle_that_sweeps_nothing_does_not_call_itself_complete(bf_conn, monkeypatch) -> None:
    """**The defect shape this card exists to remove, as a test.**

    PNCP answering 204 for a stretch makes `search_page` return `{}`, so every
    `total` reads 0 and every walk yields nothing — with no exception raised.
    The first version of `complete` was "nothing raised", so it recorded
    `partitions_done: 27, records: 0, complete: true`: an incomplete sweep
    certifying itself, with both revealing numbers zeroed by the same fault.
    """
    client = FakeSweepClient({}, {}, default=0)

    props = _run_cycle(bf_conn, monkeypatch, client, {})

    assert props["expected"] == 0
    assert props["records"] == 0
    assert props["partitions_done"] == len(UFS)
    assert props["partitions_failed"] == []
    assert props["complete"] is False, "a sweep that stored nothing is not a complete cycle"


def test_an_unknown_uf_is_refused_rather_than_sweeping_nothing(bf_conn, monkeypatch) -> None:
    """`{"ufs": ["Sao Paulo"]}` used to plan nothing, sweep nothing and return
    `done` — a hand rerun that did nothing, reported as a success."""
    client = FakeSweepClient({}, {})
    with pytest.raises(ValueError, match="unknown uf"):
        _run_cycle(bf_conn, monkeypatch, client, {"ufs": ["Sao Paulo"]})
