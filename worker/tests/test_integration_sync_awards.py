"""``sync_awards`` against the real database, with PNCP served from memory.

Needs `TEST_DATABASE_URL_B8` (see `worker/README.md`); skips without it, and CI
fails a skip. Every tender these tests write belongs to the fictitious agency
`conftest.B8_CNPJ`, which carries the per-run id. `awards` has no foreign key
to `tenders` and no timestamp of its own, so the cleanup in `conftest` deletes
award rows explicitly rather than leaning on a cascade or an age predicate.

The acceptance criterion of card B8 — *CPF masked on write* — is
:func:`test_a_natural_person_leaves_no_cpf_and_no_full_name_in_the_table`, the
first test below. It runs a natural-person award through the handler the
scheduler runs, against the real table, and then reads **every column of every
row back as text** — `raw` included — and insists the CPF and the name are not
in any of it. Masking a column and storing the untouched payload beside it
would pass a narrower assertion and would still be a breach.
"""

from __future__ import annotations

import json
import logging
from datetime import date
from decimal import Decimal
from typing import Any

import httpx
import psycopg
import pytest

from licitaqui import breaker as breaker_module
from licitaqui import sync_awards as sync_awards_module
from licitaqui.awards import QUALITY_CANCELLED, QUALITY_CONFIDENTIAL, QUALITY_OK
from licitaqui.items import TenderItem, upsert_items
from licitaqui.pncp import RESULTS_PATH, PncpClient, PncpError
from licitaqui.queue import Job
from licitaqui.registry import JobContext
from licitaqui.sync_awards import (
    FOLLOWUP_KIND,
    PROBE_COOLDOWN_HOURS,
    pending_items,
    probe_event_name,
    sync_awards,
    sync_tender_awards,
)
from licitaqui.tenders import from_consulta, upsert_tenders

from .conftest import B8_AGENCY_NAME, B8_CNPJ, b8_tender_id

LOG = logging.getLogger("licitaqui.b8test")

#: Personal-data fixtures use a CPF the check-digit algorithm rejects, so the
#: value cannot belong to anybody.
FAKE_CPF = "11111111111"
FAKE_NAME = "Joao da Silva Souza"
FAKE_CNPJ = "68117429000105"

OFFICE = "Gráfico / Escritório"
FURNITURE = "Mobiliário"


@pytest.fixture(autouse=True)
def _fresh_breakers():
    breaker_module.reset_all()
    yield
    breaker_module.reset_all()


# -- fixtures in the PNCP shape --------------------------------------------


def award_record(**overrides: Any) -> dict[str, Any]:
    """One record in the shape `/…/itens/{n}/resultados` really answers with."""
    record: dict[str, Any] = {
        "indicadorSubcontratacao": False,
        "dataInclusao": "2026-09-14T12:23:16",
        "numeroItem": 1,
        "niFornecedor": FAKE_CNPJ,
        "dataCancelamento": None,
        "dataAtualizacao": "2026-09-14T12:23:16",
        "tipoPessoa": "PJ",
        "nomeRazaoSocialFornecedor": "PAPELARIA CENTRAL LTDA",
        "valorTotalHomologado": 850.0,
        "reservaRemanescente": {"codigo": 1, "nome": "Não se aplica"},
        "codigoPais": "BRA",
        "porteFornecedorId": 1,
        "quantidadeHomologada": 10.0,
        "valorUnitarioHomologado": 85.0,
        "dataResultado": "2026-09-14",
        "motivoCancelamento": None,
        "porteFornecedorNome": "ME",
        "situacaoCompraItemResultadoNome": "Informado",
        "sequencialResultado": 1,
        "aplicacaoBeneficioMeEpp": True,
    }
    record.update(overrides)
    return record


def person_record(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "tipoPessoa": "PF",
        "niFornecedor": FAKE_CPF,
        "nomeRazaoSocialFornecedor": FAKE_NAME,
        "porteFornecedorNome": "Não Informado",
        # The name and the document also turn up in free text, which is how a
        # real payload leaks them past a field-by-field mask.
        "motivoCancelamento": f"Recurso de {FAKE_NAME}, CPF {FAKE_CPF}",
    }
    base.update(overrides)
    return award_record(**base)


def given_tender(conn: psycopg.Connection, sequence: int = 1) -> str:
    tid = b8_tender_id(sequence)
    upsert_tenders(
        conn,
        [
            from_consulta(
                {
                    "numeroControlePNCP": tid,
                    "objetoCompra": "Aquisição de papel A4",
                    "orgaoEntidade": {"cnpj": B8_CNPJ, "razaoSocial": B8_AGENCY_NAME},
                    "unidadeOrgao": {"ufSigla": "SP", "municipioNome": "São Paulo"},
                    "modalidadeId": 6,
                    "dataAtualizacaoGlobal": "2026-09-10T10:00:00",
                    "dataEncerramentoProposta": "2026-09-12T09:00:00",
                    "valorTotalEstimado": 10000.0,
                }
            )
        ],
    )
    return tid


def given_items(
    conn: psycopg.Connection,
    tid: str,
    spec: list[tuple[int, str, bool, Decimal | None]],
) -> None:
    """`(number, segment, has_award, unit_estimated_value)` rows, written straight.

    Written as `TenderItem` values rather than through the classifier, because
    what this suite needs to control is exactly the three columns the awards
    selection reads — and B3 already owns whether the classifier produces them.
    """
    upsert_items(
        conn,
        tid,
        [
            TenderItem(
                tender_id=tid,
                number=number,
                description=f"Item {number}",
                segment=segment,
                has_award=has_award,
                unit_estimated_value=estimated,
                quantity=Decimal("10"),
            )
            for number, segment, has_award, estimated in spec
        ],
    )


def client_factory(routes: dict[int, Any]):
    """A `PncpClient` serving `routes` (item number -> payload, or an exception).

    Records every path it is asked for, which is how "one request per item, and
    only for the segments of interest" is asserted rather than assumed.
    """
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        item = int(request.url.path.rstrip("/").split("/")[-2])
        payload = routes.get(item, [])
        if isinstance(payload, Exception):
            raise payload
        if not payload:
            return httpx.Response(204)
        return httpx.Response(200, json=payload)

    def factory() -> PncpClient:
        return PncpClient(transport=httpx.MockTransport(handler), rate_limit=0.0, page_delay=0.0)

    factory.calls = calls  # type: ignore[attr-defined]
    return factory


def run_tender_job(monkeypatch, conn: psycopg.Connection, factory, payload: dict) -> None:
    monkeypatch.setattr(sync_awards_module, "build_client", factory)
    job = Job(
        id=-1,
        kind=FOLLOWUP_KIND,
        key=str(payload.get("tender_id", "")),
        priority=9,
        payload=payload,
        attempts=1,
    )
    sync_tender_awards(JobContext(job=job, conn=conn, connect=lambda: conn, log=LOG))


def run_sweep(conn: psycopg.Connection, payload: dict) -> None:
    job = Job(id=-1, kind="sync_awards", key="tick", priority=9, payload=payload, attempts=1)
    sync_awards(JobContext(job=job, conn=conn, connect=lambda: conn, log=LOG))


def award_rows(conn: psycopg.Connection, tid: str) -> list[tuple]:
    return conn.execute(
        "select item_number, sequence, supplier_doc, supplier_name, person_type,"
        "       company_size, unit_awarded_value, awarded_quantity, discount_pct,"
        "       awarded_on, quality"
        "  from awards where tender_id = %s order by item_number, sequence",
        (tid,),
    ).fetchall()


def whole_rows_as_text(conn: psycopg.Connection, tid: str) -> str:
    """Every column of every award row, `raw` included, as one string.

    `a::text` on the row type is the widest net available: it renders every
    column the table has, so a column added later is covered without this test
    being updated.
    """
    rows = conn.execute("select a::text from awards a where tender_id = %s", (tid,)).fetchall()
    return "\n".join(row[0] for row in rows)


# -- the acceptance criterion: CPF masked on write -------------------------


def test_a_natural_person_leaves_no_cpf_and_no_full_name_in_the_table(
    b8_conn: psycopg.Connection, monkeypatch
):
    """Card B8's acceptance criterion, through the handler the scheduler runs.

    Spec §12: *PNCP awards may include the CPF of individual winners: mask on
    write, show only CNPJ.* Masking on read would not do — a raw CPF in the
    table is a breach whatever a query hides, and it is in the backups by the
    time anyone notices.
    """
    tid = given_tender(b8_conn)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("100"))])
    factory = client_factory({1: [person_record()]})

    run_tender_job(monkeypatch, b8_conn, factory, {"tender_id": tid, "segments": [OFFICE]})

    stored = whole_rows_as_text(b8_conn, tid)
    assert stored, "the award was not stored at all, so this test proves nothing"

    # The document, in every spelling PNCP uses for it.
    assert FAKE_CPF not in stored
    assert "111.111.111-11" not in stored
    # The name, whole and in parts. The surnames matter as much as the string:
    # "J. da Silva S." would satisfy a naive check and is still identifying.
    assert FAKE_NAME not in stored
    for part in ("Joao", "Silva", "Souza"):
        assert part not in stored, f"{part!r} survived into the row"

    (row,) = award_rows(b8_conn, tid)
    assert row[2] == "***.111.111-**"  # supplier_doc, §6.1's shape
    assert row[3] == "J. S. S."  # supplier_name, initials only
    assert row[4] == "PF"


def test_the_masking_test_above_can_actually_fail(b8_conn: psycopg.Connection, monkeypatch):
    """A guard for the guard.

    If `whole_rows_as_text` did not really read `raw`, the assertions above
    would pass on an empty string and prove nothing. This stores a *company*
    award — whose CNPJ and razão social are public and deliberately kept — and
    insists both are visible through exactly the same query.
    """
    tid = given_tender(b8_conn, 2)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("100"))])
    run_tender_job(
        monkeypatch,
        b8_conn,
        client_factory({1: [award_record()]}),
        {"tender_id": tid, "segments": [OFFICE]},
    )

    stored = whole_rows_as_text(b8_conn, tid)
    assert FAKE_CNPJ in stored
    assert "PAPELARIA CENTRAL LTDA" in stored


def test_a_company_keeps_its_cnpj_and_razao_social(b8_conn: psycopg.Connection, monkeypatch):
    tid = given_tender(b8_conn, 3)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("100"))])
    run_tender_job(
        monkeypatch,
        b8_conn,
        client_factory({1: [award_record()]}),
        {"tender_id": tid, "segments": [OFFICE]},
    )

    (row,) = award_rows(b8_conn, tid)
    assert row[2] == FAKE_CNPJ
    assert row[3] == "PAPELARIA CENTRAL LTDA"
    assert row[4] == "PJ"
    assert row[5] == "ME"


def test_a_person_hiding_behind_a_pj_flag_is_still_masked(b8_conn: psycopg.Connection, monkeypatch):
    """Fail closed, through the real write. An 11-digit document is a CPF
    whatever `tipoPessoa` claims."""
    tid = given_tender(b8_conn, 4)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("100"))])
    record = award_record(
        tipoPessoa="PJ", niFornecedor=FAKE_CPF, nomeRazaoSocialFornecedor=FAKE_NAME
    )
    run_tender_job(
        monkeypatch,
        b8_conn,
        client_factory({1: [record]}),
        {"tender_id": tid, "segments": [OFFICE]},
    )

    stored = whole_rows_as_text(b8_conn, tid)
    assert FAKE_CPF not in stored
    assert "Silva" not in stored


# -- one call per item, only for the segments of interest ------------------


def test_only_items_in_the_segments_of_interest_are_asked_about(
    b8_conn: psycopg.Connection, monkeypatch
):
    """§3.2: *1 call per item: only for segments of interest*. The filter is in
    the SQL that picks the work, so an out-of-segment item costs no request at
    all — not a request whose answer is discarded."""
    tid = given_tender(b8_conn, 5)
    given_items(
        b8_conn,
        tid,
        [
            (1, OFFICE, True, Decimal("100")),
            (2, FURNITURE, True, Decimal("100")),
            (3, OFFICE, False, Decimal("100")),  # no result published
        ],
    )
    factory = client_factory({1: [award_record()], 2: [award_record(numeroItem=2)]})

    run_tender_job(monkeypatch, b8_conn, factory, {"tender_id": tid, "segments": [OFFICE]})

    assert factory.calls == [RESULTS_PATH.format(cnpj=B8_CNPJ, year=2026, sequence=5, item=1)]
    assert [row[0] for row in award_rows(b8_conn, tid)] == [1]


def test_every_awarded_item_is_one_request_and_no_more(b8_conn: psycopg.Connection, monkeypatch):
    tid = given_tender(b8_conn, 6)
    given_items(b8_conn, tid, [(n, OFFICE, True, Decimal("100")) for n in (1, 2, 3)])
    factory = client_factory({n: [award_record(numeroItem=n)] for n in (1, 2, 3)})

    run_tender_job(monkeypatch, b8_conn, factory, {"tender_id": tid, "segments": [OFFICE]})

    assert len(factory.calls) == 3
    assert len(award_rows(b8_conn, tid)) == 3


def test_the_per_tender_request_cap_holds(b8_conn: psycopg.Connection, monkeypatch):
    tid = given_tender(b8_conn, 7)
    given_items(b8_conn, tid, [(n, OFFICE, True, Decimal("100")) for n in range(1, 11)])
    factory = client_factory({n: [award_record(numeroItem=n)] for n in range(1, 11)})

    run_tender_job(
        monkeypatch, b8_conn, factory, {"tender_id": tid, "segments": [OFFICE], "items": 4}
    )

    assert len(factory.calls) == 4
    assert len(award_rows(b8_conn, tid)) == 4


# -- permanent once awarded (§3.2) -----------------------------------------


def test_a_settled_item_is_never_asked_about_again(b8_conn: psycopg.Connection, monkeypatch):
    """§3.2: *permanent once awarded*. Not a long TTL — no expiry at all."""
    tid = given_tender(b8_conn, 8)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("100"))])
    first = client_factory({1: [award_record()]})
    run_tender_job(monkeypatch, b8_conn, first, {"tender_id": tid, "segments": [OFFICE]})
    assert len(first.calls) == 1

    second = client_factory({1: [award_record()]})
    # `force` skips the cooldown, so nothing but the award row itself can be
    # what stops the second call.
    run_tender_job(
        monkeypatch, b8_conn, second, {"tender_id": tid, "segments": [OFFICE], "force": True}
    )

    assert second.calls == []
    assert len(award_rows(b8_conn, tid)) == 1


def test_running_the_same_job_twice_stores_the_same_single_row(
    b8_conn: psycopg.Connection, monkeypatch
):
    """§7.2 idempotency, and the reason the primary key is the natural one."""
    tid = given_tender(b8_conn, 9)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("100"))])
    payload = {"tender_id": tid, "segments": [OFFICE], "force": True}
    run_tender_job(monkeypatch, b8_conn, client_factory({1: [award_record()]}), payload)
    b8_conn.execute("delete from events where name = %s", (probe_event_name(tid),))
    b8_conn.execute("delete from awards where tender_id = %s", (tid,))
    run_tender_job(monkeypatch, b8_conn, client_factory({1: [award_record()]}), payload)
    run_tender_job(monkeypatch, b8_conn, client_factory({1: [award_record()]}), payload)

    assert len(award_rows(b8_conn, tid)) == 1


def test_two_results_for_one_item_are_two_rows(b8_conn: psycopg.Connection, monkeypatch):
    """A Registro de Preços runner-up: `sequencialResultado` 2 alongside 1."""
    tid = given_tender(b8_conn, 10)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("100"))])
    records = [
        award_record(),
        award_record(sequencialResultado=2, valorUnitarioHomologado=90.0, ordemClassificacaoSrp=2),
    ]
    run_tender_job(
        monkeypatch,
        b8_conn,
        client_factory({1: records}),
        {"tender_id": tid, "segments": [OFFICE]},
    )

    assert [(row[0], row[1]) for row in award_rows(b8_conn, tid)] == [(1, 1), (1, 2)]


def test_an_item_with_no_published_result_is_left_alone_for_the_cooldown(
    b8_conn: psycopg.Connection, monkeypatch
):
    """PNCP sets `temResultado` before the result is published often enough
    that re-asking every night would be free money spent on 204s."""
    tid = given_tender(b8_conn, 11)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("100"))])
    first = client_factory({1: []})
    run_tender_job(monkeypatch, b8_conn, first, {"tender_id": tid, "segments": [OFFICE]})
    assert len(first.calls) == 1
    assert award_rows(b8_conn, tid) == []

    second = client_factory({1: [award_record()]})
    run_tender_job(monkeypatch, b8_conn, second, {"tender_id": tid, "segments": [OFFICE]})
    assert second.calls == [], "the cooldown did not hold"

    third = client_factory({1: [award_record()]})
    run_tender_job(
        monkeypatch, b8_conn, third, {"tender_id": tid, "segments": [OFFICE], "force": True}
    )
    assert len(third.calls) == 1
    assert len(award_rows(b8_conn, tid)) == 1


# -- an endpoint that is down ----------------------------------------------


def test_an_outage_half_way_through_keeps_what_it_already_read(
    b8_conn: psycopg.Connection, monkeypatch
):
    """The upsert is per item, so item 3 failing does not throw away 1 and 2 —
    and the retry resumes for free, because the `not exists` predicate now
    excludes them."""
    tid = given_tender(b8_conn, 12)
    given_items(b8_conn, tid, [(n, OFFICE, True, Decimal("100")) for n in (1, 2, 3, 4)])
    routes: dict[int, Any] = {
        1: [award_record(numeroItem=1)],
        2: [award_record(numeroItem=2)],
        3: httpx.ReadTimeout("PNCP timed out"),
        4: [award_record(numeroItem=4)],
    }
    failing = client_factory(routes)

    with pytest.raises(PncpError):
        run_tender_job(monkeypatch, b8_conn, failing, {"tender_id": tid, "segments": [OFFICE]})

    assert [row[0] for row in award_rows(b8_conn, tid)] == [1, 2]
    # No marker was written, so nothing is on cooldown and the retry is free to
    # run — which is the behaviour a failed job needs.
    assert (
        b8_conn.execute(
            "select count(*) from events where name = %s", (probe_event_name(tid),)
        ).fetchone()[0]
        == 0
    )

    routes[3] = [award_record(numeroItem=3)]
    retry = client_factory(routes)
    run_tender_job(monkeypatch, b8_conn, retry, {"tender_id": tid, "segments": [OFFICE]})

    assert len(retry.calls) == 2, "the retry re-asked about items it had already stored"
    assert [row[0] for row in award_rows(b8_conn, tid)] == [1, 2, 3, 4]


# -- POC 3's bands, through the real columns -------------------------------


def test_the_discount_and_quality_reach_the_columns(b8_conn: psycopg.Connection, monkeypatch):
    tid = given_tender(b8_conn, 13)
    given_items(
        b8_conn,
        tid,
        [
            (1, OFFICE, True, Decimal("100")),  # 85 awarded -> 15%
            (2, OFFICE, True, Decimal("0")),  # sigiloso: estimate reported as 0
            (3, OFFICE, True, Decimal("100")),  # cancelled
        ],
    )
    routes = {
        1: [award_record(numeroItem=1)],
        2: [award_record(numeroItem=2)],
        3: [award_record(numeroItem=3, dataCancelamento="2026-09-15T10:00:00")],
    }
    run_tender_job(
        monkeypatch,
        b8_conn,
        client_factory(routes),
        {"tender_id": tid, "segments": [OFFICE]},
    )

    by_item = {row[0]: row for row in award_rows(b8_conn, tid)}
    assert by_item[1][8] == Decimal("15.00")
    assert by_item[1][10] == QUALITY_OK
    assert by_item[2][8] is None
    assert by_item[2][10] == QUALITY_CONFIDENTIAL
    assert by_item[3][10] == QUALITY_CANCELLED


def test_a_late_evening_result_keeps_its_brasilia_day_in_the_date_column(
    b8_conn: psycopg.Connection, monkeypatch
):
    """The trap, proven where it would actually bite: `awarded_on` is a `date`
    and the worker's session TimeZone is UTC, so 23:30 BRT would otherwise be
    stored as the following day."""
    tid = given_tender(b8_conn, 14)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("100"))])
    run_tender_job(
        monkeypatch,
        b8_conn,
        client_factory({1: [award_record(dataResultado="2026-09-17T23:30:00")]}),
        {"tender_id": tid, "segments": [OFFICE]},
    )

    (row,) = award_rows(b8_conn, tid)
    assert row[9] == date(2026, 9, 17)


def test_the_stored_payload_is_json_the_price_queries_can_read(
    b8_conn: psycopg.Connection, monkeypatch
):
    tid = given_tender(b8_conn, 15)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("100"))])
    run_tender_job(
        monkeypatch,
        b8_conn,
        client_factory({1: [award_record()]}),
        {"tender_id": tid, "segments": [OFFICE]},
    )

    (raw,) = b8_conn.execute("select raw from awards where tender_id = %s", (tid,)).fetchone()
    assert json.loads(json.dumps(raw))["porteFornecedorNome"] == "ME"


# -- the nightly sweep -----------------------------------------------------


def test_the_sweep_queues_one_job_per_tender_with_pending_awarded_items(
    b8_conn: psycopg.Connection,
):
    wanted = given_tender(b8_conn, 20)
    given_items(b8_conn, wanted, [(1, OFFICE, True, Decimal("100"))])
    wrong_segment = given_tender(b8_conn, 21)
    given_items(b8_conn, wrong_segment, [(1, FURNITURE, True, Decimal("100"))])
    no_result = given_tender(b8_conn, 22)
    given_items(b8_conn, no_result, [(1, OFFICE, False, Decimal("100"))])

    run_sweep(b8_conn, {"segments": [OFFICE], "tenders": 50})

    queued = [
        row[0]
        for row in b8_conn.execute(
            "select key from jobs where kind = %s and key like %s order by key",
            (FOLLOWUP_KIND, f"{B8_CNPJ}-%"),
        ).fetchall()
    ]
    assert queued == [wanted]


def test_the_sweep_skips_a_tender_probed_inside_the_cooldown(
    b8_conn: psycopg.Connection, monkeypatch
):
    tid = given_tender(b8_conn, 23)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("100"))])
    # Probed just now, and the item came back empty, so it is still pending.
    run_tender_job(
        monkeypatch,
        b8_conn,
        client_factory({1: []}),
        {"tender_id": tid, "segments": [OFFICE]},
    )

    run_sweep(b8_conn, {"segments": [OFFICE], "tenders": 50})
    assert _queued_keys(b8_conn) == []

    run_sweep(b8_conn, {"segments": [OFFICE], "tenders": 50, "cooldown_hours": 0})
    assert _queued_keys(b8_conn) == [tid]


def test_the_sweep_does_not_queue_a_tender_whose_items_are_all_settled(
    b8_conn: psycopg.Connection, monkeypatch
):
    tid = given_tender(b8_conn, 24)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("100"))])
    run_tender_job(
        monkeypatch,
        b8_conn,
        client_factory({1: [award_record()]}),
        {"tender_id": tid, "segments": [OFFICE]},
    )

    run_sweep(b8_conn, {"segments": [OFFICE], "tenders": 50, "cooldown_hours": 0})
    assert _queued_keys(b8_conn) == []


def _queued_keys(conn: psycopg.Connection) -> list[str]:
    return [
        row[0]
        for row in conn.execute(
            "select key from jobs where kind = %s and key like %s order by key",
            (FOLLOWUP_KIND, f"{B8_CNPJ}-%"),
        ).fetchall()
    ]


# -- the selection itself --------------------------------------------------


def test_pending_items_carries_the_estimate_the_discount_needs(
    b8_conn: psycopg.Connection,
):
    tid = given_tender(b8_conn, 30)
    given_items(b8_conn, tid, [(1, OFFICE, True, Decimal("12.3400"))])

    (item,) = pending_items(b8_conn, tid, segments=[OFFICE])
    assert item.number == 1
    assert item.unit_estimated_value == Decimal("12.3400")


def test_an_empty_segment_list_means_every_segment(b8_conn: psycopg.Connection, monkeypatch):
    """The unbounded sweep is reachable on purpose for an operator, and is
    never what a default run does."""
    tid = given_tender(b8_conn, 31)
    given_items(
        b8_conn,
        tid,
        [(1, OFFICE, True, Decimal("100")), (2, FURNITURE, True, Decimal("100"))],
    )
    factory = client_factory({1: [award_record(numeroItem=1)], 2: [award_record(numeroItem=2)]})

    run_tender_job(monkeypatch, b8_conn, factory, {"tender_id": tid, "segments": []})

    assert len(factory.calls) == 2


def test_the_cooldown_default_is_a_week(b8_conn: psycopg.Connection):
    """Pinned because it is the only thing standing between "an item PNCP has
    not published yet" and a nightly request for it forever."""
    assert PROBE_COOLDOWN_HOURS == 168
