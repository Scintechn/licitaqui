"""``title_tender`` against the real database, with the model served from memory.

Skipped when TEST_DATABASE_URL is not configured. Every tender written here
belongs to the fictitious agency `conftest.TITLE_CNPJ`, which carries the
per-run id, and is deleted before and after each test; `tender_items` follows
through the cascade.

Needs `db/migrations/0005_tender_short_title.sql`. That migration ships in its
own pull request (CLAUDE.md), so until it has been applied these tests fail
rather than skip — which is the intended signal, not a flake.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from licitaqui import breaker as breaker_module
from licitaqui import title_tender, titles
from licitaqui.queue import Job
from licitaqui.registry import REGISTRY, JobContext
from tests.conftest import TITLE_CNPJ

BOILERPLATE = (
    "CONTRATAÇÃO DE EMPRESAS PARA FORNECIMENTO DE MATERIAIS PERMANENTES, "
    "para Secretaria de Saúde, conforme descrito no Anexo I – Termo de Referência"
)
ALREADY_SHORT = "Aquisição de Equipamentos e materiais de roçagem"


@pytest.fixture(autouse=True)
def _fresh_breakers():
    breaker_module.reset_all()
    yield
    breaker_module.reset_all()


def tender_id(seq: int) -> str:
    return f"{TITLE_CNPJ}-1-{seq:06d}/2026"


def insert_tender(
    conn: psycopg.Connection,
    seq: int,
    objeto: str,
    *,
    items: list[tuple[int, str, float]] | None = None,
    pncp_updated_at: datetime | None = None,
) -> str:
    tid = tender_id(seq)
    conn.execute(
        """
        insert into tenders (id, agency_cnpj, year, sequence, object, pncp_updated_at)
        values (%s, %s, 2026, %s, %s, %s)
        on conflict (id) do update
           set object = excluded.object,
               pncp_updated_at = excluded.pncp_updated_at
        """,
        (tid, TITLE_CNPJ, seq, objeto, pncp_updated_at),
    )
    for number, description, total in items or []:
        conn.execute(
            """
            insert into tender_items (tender_id, number, description, total_value)
            values (%s, %s, %s, %s)
            on conflict (tender_id, number) do update
               set description = excluded.description, total_value = excluded.total_value
            """,
            (tid, number, description, total),
        )
    return tid


def stored(conn: psycopg.Connection, tid: str) -> dict:
    row = conn.execute(
        """
        select short_title, short_title_source, short_title_rules_version,
               short_title_prompt_version, short_title_basis, short_title_at
          from tenders where id = %s
        """,
        (tid,),
    ).fetchone()
    keys = ("title", "source", "rules_version", "prompt_version", "basis", "at")
    return dict(zip(keys, row, strict=True))


def run_job(conn: psycopg.Connection, tid: str) -> None:
    handler = REGISTRY.get(title_tender.KIND)
    job = Job(
        id=1,
        kind=title_tender.KIND,
        key=tid,
        payload={"tender_id": tid},
        priority=7,
        attempts=0,
    )
    handler(
        JobContext(job=job, conn=conn, connect=lambda: conn, log=logging.getLogger("test.title"))
    )


def serve(monkeypatch: pytest.MonkeyPatch, title: str | None, **kwargs) -> None:
    monkeypatch.setattr(titles, "model_title", lambda *a, **k: titles.ModelAnswer(title, **kwargs))
    monkeypatch.setattr(titles.ai_tender, "api_key", lambda: "test-key")


# -- The free branch -------------------------------------------------------


def test_a_short_objeto_is_titled_without_the_model(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    def explode(*args, **kwargs):  # pragma: no cover - the point is it is not called
        raise AssertionError("the model must not be asked about a short objeto")

    monkeypatch.setattr(titles, "model_title", explode)
    monkeypatch.setattr(titles.ai_tender, "api_key", lambda: "test-key")

    tid = insert_tender(title_conn, 1, ALREADY_SHORT, items=[(1, "roçadeira costal", 5000.0)])
    run_job(title_conn, tid)

    row = stored(title_conn, tid)
    assert row["title"] == ALREADY_SHORT
    assert row["source"] == titles.SOURCE_DETERMINISTIC
    assert row["rules_version"] == titles.RULES_VERSION
    assert row["prompt_version"] is None
    assert row["basis"] and row["at"] is not None


# -- The model branch ------------------------------------------------------


def test_boilerplate_goes_to_the_model_and_is_stored(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    serve(
        monkeypatch,
        "Fornecimento de materiais permanentes",
        input_tokens=400,
        output_tokens=16,
        cost_brl=0.0001,
    )
    tid = insert_tender(title_conn, 2, BOILERPLATE)
    run_job(title_conn, tid)

    row = stored(title_conn, tid)
    assert row["title"] == "Fornecimento de materiais permanentes"
    assert row["source"] == titles.SOURCE_AI
    assert row["prompt_version"] == titles.PROMPT_VERSION


def test_a_fabricated_title_is_rejected_and_the_free_one_stored(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The validator, end to end: nothing claiming "para MEI" reaches a column."""
    serve(monkeypatch, "Fornecimento de materiais permanentes para MEI")
    tid = insert_tender(title_conn, 3, BOILERPLATE)
    run_job(title_conn, tid)

    row = stored(title_conn, tid)
    assert "MEI" not in row["title"]
    assert row["title"] == titles.deterministic_title(BOILERPLATE)
    assert row["source"] == titles.SOURCE_AI_FALLBACK
    assert row["prompt_version"] == titles.PROMPT_VERSION


# -- The 429 ---------------------------------------------------------------


def test_a_rate_limit_writes_nothing_and_leaves_the_row_pending(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    serve(monkeypatch, None, rate_limited=True)
    tid = insert_tender(title_conn, 4, BOILERPLATE)

    with pytest.raises(title_tender.RateLimited):
        run_job(title_conn, tid)

    assert stored(title_conn, tid)["title"] is None
    assert tid in title_tender.pending(title_conn, limit=500)


def test_a_rate_limit_does_not_open_the_circuit(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two 429s in a row must not stop titling for fifteen minutes (§7.2)."""
    serve(monkeypatch, None, rate_limited=True)
    for seq in (5, 6):
        tid = insert_tender(title_conn, seq, BOILERPLATE)
        with pytest.raises(title_tender.RateLimited):
            run_job(title_conn, tid)

    breaker = breaker_module.get_breaker(titles.ai_tender.BREAKER_NAME)
    assert breaker.state == "closed"


def test_a_5xx_does_count_against_the_circuit(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    serve(monkeypatch, None, error="http_503")
    for seq in (7, 8):
        tid = insert_tender(title_conn, seq, BOILERPLATE)
        run_job(title_conn, tid)

    breaker = breaker_module.get_breaker(titles.ai_tender.BREAKER_NAME)
    assert breaker.state == "open"


# -- Idempotency and staleness --------------------------------------------


def test_running_twice_does_not_ask_the_model_twice(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[int] = []

    def once(*args, **kwargs):
        calls.append(1)
        return titles.ModelAnswer("Fornecimento de materiais permanentes")

    monkeypatch.setattr(titles, "model_title", once)
    monkeypatch.setattr(titles.ai_tender, "api_key", lambda: "test-key")

    tid = insert_tender(title_conn, 9, BOILERPLATE)
    run_job(title_conn, tid)
    run_job(title_conn, tid)
    assert len(calls) == 1


def test_a_new_pncp_revision_invalidates_the_title(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    serve(monkeypatch, "Fornecimento de materiais permanentes")
    now = datetime.now(UTC)
    tid = insert_tender(title_conn, 10, BOILERPLATE, pncp_updated_at=now)
    run_job(title_conn, tid)
    assert tid not in title_tender.pending(title_conn, limit=500)

    title_conn.execute(
        "update tenders set pncp_updated_at = %s where id = %s",
        (now + timedelta(hours=1), tid),
    )
    assert tid in title_tender.pending(title_conn, limit=500)


def test_a_changed_item_set_invalidates_the_title(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The items feed the model, so changing them can change the right answer."""
    serve(monkeypatch, "Fornecimento de materiais permanentes")
    tid = insert_tender(title_conn, 11, BOILERPLATE, items=[(1, "cadeira", 100.0)])
    run_job(title_conn, tid)
    assert tid not in title_tender.pending(title_conn, limit=500)

    title_conn.execute(
        "insert into tender_items (tender_id, number, description, total_value)"
        " values (%s, 2, 'mesa', 200.0)",
        (tid,),
    )
    assert tid in title_tender.pending(title_conn, limit=500)


def test_rewriting_an_item_unchanged_does_not_invalidate(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every items sync re-writes rows; that must not re-pay for the corpus."""
    serve(monkeypatch, "Fornecimento de materiais permanentes")
    tid = insert_tender(title_conn, 12, BOILERPLATE, items=[(1, "cadeira", 100.0)])
    run_job(title_conn, tid)

    title_conn.execute("update tender_items set updated_at = now() where tender_id = %s", (tid,))
    assert tid not in title_tender.pending(title_conn, limit=500)


def test_a_rules_bump_invalidates_every_row(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    serve(monkeypatch, "Fornecimento de materiais permanentes")
    free = insert_tender(title_conn, 13, ALREADY_SHORT)
    paid = insert_tender(title_conn, 14, BOILERPLATE)
    run_job(title_conn, free)
    run_job(title_conn, paid)

    monkeypatch.setattr(titles, "RULES_VERSION", titles.RULES_VERSION + 1)
    pending = title_tender.pending(title_conn, limit=500)
    assert free in pending and paid in pending


def test_a_prompt_bump_spares_the_deterministic_rows(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The model never saw them; re-titling would re-pay to reach the same string."""
    serve(monkeypatch, "Fornecimento de materiais permanentes")
    free = insert_tender(title_conn, 15, ALREADY_SHORT)
    paid = insert_tender(title_conn, 16, BOILERPLATE)
    run_job(title_conn, free)
    run_job(title_conn, paid)

    monkeypatch.setattr(titles, "PROMPT_VERSION", "t2")
    pending = title_tender.pending(title_conn, limit=500)
    assert free not in pending
    assert paid in pending


# -- The sweep -------------------------------------------------------------


def test_the_sweep_enqueues_once_per_tender(
    title_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    tid = insert_tender(title_conn, 17, BOILERPLATE)
    first = title_tender.enqueue_pending(title_conn, limit=500)
    assert first >= 1

    queued = title_conn.execute(
        "select count(*) from jobs where kind = %s and key = %s",
        (title_tender.KIND, tid),
    ).fetchone()[0]
    assert queued == 1

    # Running the sweep again while the first job is still queued must not
    # double the work — `queue.enqueue` dedupes.
    title_tender.enqueue_pending(title_conn, limit=500)
    again = title_conn.execute(
        "select count(*) from jobs where kind = %s and key = %s",
        (title_tender.KIND, tid),
    ).fetchone()[0]
    assert again == 1


def test_the_kind_is_registered() -> None:
    from licitaqui import handlers

    assert title_tender.KIND in handlers.registered_kinds()


def test_the_sweep_kind_queues_the_per_tender_jobs(
    title_conn: psycopg.Connection,
) -> None:
    """`sweep_titles` is what makes the work happen at all."""
    tid = insert_tender(title_conn, 18, BOILERPLATE)
    handler = REGISTRY.get(title_tender.SWEEP_KIND)
    job = Job(
        id=2,
        kind=title_tender.SWEEP_KIND,
        key="sweep",
        payload={"limit": 500},
        priority=8,
        attempts=0,
    )
    handler(
        JobContext(
            job=job,
            conn=title_conn,
            connect=lambda: title_conn,
            log=logging.getLogger("test.title"),
        )
    )
    queued = title_conn.execute(
        "select count(*) from jobs where kind = %s and key = %s",
        (title_tender.KIND, tid),
    ).fetchone()[0]
    assert queued == 1


def test_the_sweep_is_scheduled() -> None:
    """Registering the kind is not enough — something has to run it."""
    from licitaqui.scheduler import DEFAULT_SCHEDULE

    entry = next(e for e in DEFAULT_SCHEDULE if e.kind == title_tender.SWEEP_KIND)
    assert entry.every_seconds == 60 * 60
