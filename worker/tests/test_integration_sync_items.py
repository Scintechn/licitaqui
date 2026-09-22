"""``sync_items`` against the real database, with PNCP served from memory.

Skipped when TEST_DATABASE_URL_B3 is not configured. Every tender these tests
write belongs to the fictitious agency `conftest.B3_CNPJ`, which carries the
per-run id, and is deleted before and after each test; `tender_items` follows it
through the cascade.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import psycopg
import pytest

from licitaqui import breaker as breaker_module
from licitaqui import sync_items as sync_items_module
from licitaqui.pncp import ITEMS_PATH, PncpClient, PncpError
from licitaqui.queue import Job
from licitaqui.registry import REGISTRY, JobContext
from licitaqui.sync_items import ITEMS_TTL_HOURS, read_state, sync_items
from licitaqui.tenders import from_consulta, upsert_tenders
from tests.conftest import B3_CNPJ

BRT = ZoneInfo("America/Sao_Paulo")
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "poc1"
TENDERS = {
    t.get("note") or t["me_epp_summary"]: t
    for t in json.loads((FIXTURES / "tenders.json").read_text(encoding="utf-8"))["tenders"]
}


@pytest.fixture(autouse=True)
def _fresh_breakers():
    breaker_module.reset_all()
    yield
    breaker_module.reset_all()


def tender_id(seq: int = 1) -> str:
    return f"{B3_CNPJ}-1-{seq:06d}/2026"


def given_tender(
    conn: psycopg.Connection,
    seq: int = 1,
    *,
    objeto: str = "Aquisição de equipamentos de informática",
    valor: float | None = 50_000.0,
    updated: str = "2026-09-17T10:00:00",
) -> str:
    upsert_tenders(
        conn,
        [
            from_consulta(
                {
                    "numeroControlePNCP": tender_id(seq),
                    "objetoCompra": objeto,
                    "orgaoEntidade": {"cnpj": B3_CNPJ, "razaoSocial": "ÓRGÃO DE TESTE B3"},
                    "unidadeOrgao": {"ufSigla": "SP", "municipioNome": "São Paulo"},
                    "modalidadeId": 6,
                    "valorTotalEstimado": valor,
                    "dataAtualizacaoGlobal": updated,
                }
            )
        ],
    )
    return tender_id(seq)


def serving(pages: dict[str, list], *, status: int = 200) -> callable:
    """A client factory answering the items endpoint from memory.

    Keyed by `cnpj/year/sequence` so one transport can serve several tenders.
    """
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        for key, body in pages.items():
            cnpj, year, sequence = key.split("/")
            if request.url.path == ITEMS_PATH.format(cnpj=cnpj, year=year, sequence=sequence):
                if status != 200:
                    return httpx.Response(status)
                return httpx.Response(200, json=body)
        return httpx.Response(404, text="not found")

    def factory() -> PncpClient:
        return PncpClient(transport=httpx.MockTransport(handler), rate_limit=0.0, page_delay=0.0)

    factory.calls = calls  # type: ignore[attr-defined]
    return factory


def run_job(monkeypatch, conn: psycopg.Connection, factory, payload: dict) -> None:
    monkeypatch.setattr(sync_items_module, "build_client", factory)
    job = Job(
        id=-1,
        kind="sync_items",
        key=str(payload.get("tender_id", "")),
        priority=5,
        payload=payload,
        attempts=1,
    )
    sync_items(
        JobContext(
            job=job, conn=conn, connect=lambda: conn, log=logging.getLogger("licitaqui.b3test")
        )
    )


def items_key(seq: int = 1) -> str:
    return f"{B3_CNPJ}/2026/{seq}"


def rows(conn: psycopg.Connection, tid: str) -> list[tuple]:
    return conn.execute(
        "select number, description, segment, relevance, benefit_id, total_value"
        "  from tender_items where tender_id = %s order by number",
        (tid,),
    ).fetchall()


def tender_row(conn: psycopg.Connection, tid: str) -> tuple:
    return conn.execute(
        "select me_epp_summary, favored_treatment, segments from tenders where id = %s", (tid,)
    ).fetchone()


# -- the handler end to end ------------------------------------------------


def test_the_kind_is_registered() -> None:
    """Which is also what switches B2's follow-up enqueue on."""
    assert "sync_items" in REGISTRY.kinds()


def test_it_stores_classifies_and_rolls_up(b3_conn: psycopg.Connection, monkeypatch) -> None:
    tid = given_tender(b3_conn, valor=134188.4)
    payload = TENDERS["quota"]["itens"]

    run_job(monkeypatch, b3_conn, serving({items_key(): payload}), {"tender_id": tid})

    stored = rows(b3_conn, tid)
    assert len(stored) == len(payload)
    assert [r[0] for r in stored] == [1, 2, 3, 4]
    assert {r[4] for r in stored} == {4, 3}
    assert tender_row(b3_conn, tid)[:2] == ("quota", True)


def test_a_real_tender_gets_its_segments_and_relevance(
    b3_conn: psycopg.Connection, monkeypatch
) -> None:
    tid = given_tender(b3_conn, seq=2, objeto="Aquisição de papel sulfite", valor=574517.0)

    run_job(
        monkeypatch,
        b3_conn,
        serving({items_key(2): TENDERS["mixed"]["itens"]}),
        {"tender_id": tid},
    )

    stored = rows(b3_conn, tid)
    # Paper "COMPATÍVEL COM IMPRESSORAS A LASER" lands in Informática / TI, not
    # Gráfico / Escritório: "impressora" is an IT keyword and POC 1's list order
    # is priority. Reproducing the POC means reproducing this too — it is the
    # kind of case B6's CNAE map and the AI layer are there to refine later.
    assert {r[2] for r in stored} == {"Informática / TI"}
    assert {r[3] for r in stored} == {"medium"}  # by keyword, not by NCM
    summary, favored, segments = tender_row(b3_conn, tid)
    assert (summary, favored, segments) == ("mixed", True, ["Informática / TI"])


def test_the_segments_array_is_ranked_by_value(b3_conn: psycopg.Connection, monkeypatch) -> None:
    tid = given_tender(b3_conn, seq=3)
    payload = [
        {"numeroItem": 1, "descricao": "Notebook", "materialOuServico": "M", "valorTotal": 100.0},
        {
            "numeroItem": 2,
            "descricao": "Detergente neutro",
            "materialOuServico": "M",
            "valorTotal": 900.0,
        },
    ]

    run_job(monkeypatch, b3_conn, serving({items_key(3): payload}), {"tender_id": tid})

    assert tender_row(b3_conn, tid)[2] == ["Limpeza / Higiene", "Informática / TI"]


def test_an_above_cap_tender_is_not_favored(b3_conn: psycopg.Connection, monkeypatch) -> None:
    tid = given_tender(b3_conn, seq=4, valor=9_983_669.03)

    run_job(
        monkeypatch,
        b3_conn,
        serving({items_key(4): TENDERS["above_epp_cap"]["itens"]}),
        {"tender_id": tid},
    )

    assert tender_row(b3_conn, tid)[1] is False


def test_a_confidential_budget_leaves_favored_treatment_unknown(
    b3_conn: psycopg.Connection, monkeypatch
) -> None:
    tid = given_tender(b3_conn, seq=5, valor=0.0)

    run_job(
        monkeypatch,
        b3_conn,
        serving({items_key(5): TENDERS["confidential_budget"]["itens"]}),
        {"tender_id": tid},
    )

    assert tender_row(b3_conn, tid)[1] is None


# -- the search vector -----------------------------------------------------


def matches(conn: psycopg.Connection, tid: str, query: str) -> bool:
    row = conn.execute(
        "select search @@ plainto_tsquery('pt_unaccent', %s) from tenders where id = %s",
        (query, tid),
    ).fetchone()
    return bool(row[0])


def test_the_search_vector_spans_the_object_and_every_item(
    b3_conn: psycopg.Connection, monkeypatch
) -> None:
    tid = given_tender(b3_conn, seq=6, objeto="Aquisição de material hospitalar")
    payload = [
        {"numeroItem": 1, "descricao": "Seringa descartável 10ml", "materialOuServico": "M"},
        {"numeroItem": 2, "descricao": "Luva de procedimento", "materialOuServico": "M"},
    ]

    run_job(monkeypatch, b3_conn, serving({items_key(6): payload}), {"tender_id": tid})

    assert matches(b3_conn, tid, "hospitalar")  # from the object
    assert matches(b3_conn, tid, "seringa")  # from an item
    assert matches(b3_conn, tid, "luva")  # from another item
    assert matches(b3_conn, tid, "descartavel")  # pt_unaccent: no accent needed
    assert not matches(b3_conn, tid, "notebook")


def test_the_search_expression_is_the_one_in_db_seed() -> None:
    """Keep them consistent: the seeded fixtures and the synced rows must agree."""
    from licitaqui.items import SEARCH_SQL

    seed = (Path(__file__).resolve().parents[2] / "db" / "seed.py").read_text(encoding="utf-8")
    expression = "to_tsvector('pt_unaccent',\n          coalesce(t.object,'') || ' ' ||"
    assert expression in seed
    assert " ".join(expression.split()) in " ".join(SEARCH_SQL.split())
    assert "string_agg(i.description, ' ')" in SEARCH_SQL


# -- idempotency, the TTL and pruning --------------------------------------


def test_running_twice_changes_nothing(b3_conn: psycopg.Connection, monkeypatch) -> None:
    """§7.2: every job can run twice without duplicating."""
    tid = given_tender(b3_conn, seq=7)
    factory = serving({items_key(7): TENDERS["quota"]["itens"]})

    run_job(monkeypatch, b3_conn, factory, {"tender_id": tid})
    before = rows(b3_conn, tid)
    run_job(monkeypatch, b3_conn, factory, {"tender_id": tid, "force": True})

    assert rows(b3_conn, tid) == before


def test_fresh_items_are_not_fetched_again(b3_conn: psycopg.Connection, monkeypatch) -> None:
    """§3.2 gives items a 12 h TTL; a duplicate job inside it costs no request."""
    tid = given_tender(b3_conn, seq=8)
    factory = serving({items_key(8): TENDERS["quota"]["itens"]})

    run_job(monkeypatch, b3_conn, factory, {"tender_id": tid})
    calls_after_first = len(factory.calls)
    run_job(monkeypatch, b3_conn, factory, {"tender_id": tid})

    assert len(factory.calls) == calls_after_first
    assert read_state(b3_conn, tid).reason == "fresh"


def test_expired_items_are_fetched_again(b3_conn: psycopg.Connection, monkeypatch) -> None:
    tid = given_tender(b3_conn, seq=9)
    factory = serving({items_key(9): TENDERS["quota"]["itens"]})
    run_job(monkeypatch, b3_conn, factory, {"tender_id": tid})

    b3_conn.execute(
        "update tender_items set updated_at = now() - make_interval(hours => %s)"
        " where tender_id = %s",
        (ITEMS_TTL_HOURS + 1, tid),
    )

    assert read_state(b3_conn, tid).reason == "ttl"
    run_job(monkeypatch, b3_conn, factory, {"tender_id": tid})
    assert len(factory.calls) == 2


def test_a_tender_that_changed_is_fetched_again_inside_the_ttl(
    b3_conn: psycopg.Connection, monkeypatch
) -> None:
    """B2 enqueues on a moved `dataAtualizacaoGlobal`; the TTL must not block it."""
    tid = given_tender(b3_conn, seq=10)
    factory = serving({items_key(10): TENDERS["quota"]["itens"]})
    run_job(monkeypatch, b3_conn, factory, {"tender_id": tid})

    later = datetime.now(BRT) + timedelta(minutes=5)
    b3_conn.execute("update tenders set pncp_updated_at = %s where id = %s", (later, tid))

    assert read_state(b3_conn, tid).reason == "tender_changed"


def test_a_withdrawn_item_is_deleted(b3_conn: psycopg.Connection, monkeypatch) -> None:
    """An amendment can cancel a lot; the card must stop showing it."""
    tid = given_tender(b3_conn, seq=11)
    full = TENDERS["quota"]["itens"]
    run_job(monkeypatch, b3_conn, serving({items_key(11): full}), {"tender_id": tid})
    assert len(rows(b3_conn, tid)) == 4

    remaining = [i for i in full if i["numeroItem"] != 2]
    run_job(
        monkeypatch,
        b3_conn,
        serving({items_key(11): remaining}),
        {"tender_id": tid, "force": True},
    )

    assert [r[0] for r in rows(b3_conn, tid)] == [1, 3, 4]


def test_only_this_tenders_items_are_pruned(b3_conn: psycopg.Connection, monkeypatch) -> None:
    first = given_tender(b3_conn, seq=12)
    second = given_tender(b3_conn, seq=13)
    payload = TENDERS["quota"]["itens"]
    run_job(monkeypatch, b3_conn, serving({items_key(12): payload}), {"tender_id": first})
    run_job(monkeypatch, b3_conn, serving({items_key(13): payload}), {"tender_id": second})

    run_job(
        monkeypatch,
        b3_conn,
        serving({items_key(12): payload[:1]}),
        {"tender_id": first, "force": True},
    )

    assert len(rows(b3_conn, first)) == 1
    assert len(rows(b3_conn, second)) == 4


# -- failure ---------------------------------------------------------------


def test_a_failing_endpoint_raises_and_deletes_nothing(
    b3_conn: psycopg.Connection, monkeypatch
) -> None:
    """A 500 is an outage, not "this tender has no items any more".

    (The docstring said 404 until 2026-09-22; the test always served a 500.
    A 404 is a different question now — see `test_integration_pncp_404.py`,
    where the same guarantee is asserted for it.)
    """
    tid = given_tender(b3_conn, seq=14)
    run_job(
        monkeypatch,
        b3_conn,
        serving({items_key(14): TENDERS["quota"]["itens"]}),
        {"tender_id": tid},
    )

    with pytest.raises(PncpError):
        run_job(
            monkeypatch,
            b3_conn,
            serving({items_key(14): []}, status=500),
            {"tender_id": tid, "force": True},
        )

    assert len(rows(b3_conn, tid)) == 4


def test_a_genuinely_empty_item_list_is_stored_as_empty(
    b3_conn: psycopg.Connection, monkeypatch
) -> None:
    tid = given_tender(b3_conn, seq=15)

    run_job(monkeypatch, b3_conn, serving({items_key(15): []}), {"tender_id": tid})

    assert rows(b3_conn, tid) == []
    assert tender_row(b3_conn, tid)[0] is None  # unknown, not "none"


def test_an_unknown_tender_is_not_an_error(b3_conn: psycopg.Connection, monkeypatch) -> None:
    """The row can be gone by the time the follow-up runs; retrying would not help."""
    factory = serving({})

    run_job(monkeypatch, b3_conn, factory, {"tender_id": tender_id(99)})

    assert factory.calls == []
