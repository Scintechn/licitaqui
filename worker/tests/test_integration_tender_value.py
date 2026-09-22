"""Giving a search-sourced tender a value, against a real database.

The production shape this reproduces, measured 2026-09-22: 5,080 of 5,965
tenders carried a search-index payload, no `estimated_value`, no
`price_registration` and a `confidential_budget` of `false` that nobody had
checked — and 4,444 of them had items that summed to the number PNCP's own page
shows.

Nothing here reaches PNCP: the Consulta detail endpoint is served from memory by
an `httpx.MockTransport`. The database is real, and every row belongs to the
fictitious agency `conftest.EV_CNPJ`, which carries the per-run id and is
deleted before and after each test.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import psycopg
import pytest

from licitaqui import breaker as breaker_module
from licitaqui import sync_items as sync_items_module
from licitaqui import tender_value as tender_value_module
from licitaqui.items import EPP_REVENUE_CAP, classify_all, roll_up, upsert_items
from licitaqui.pncp import CONTRATACAO_PATH, PncpClient
from licitaqui.queue import Job
from licitaqui.registry import JobContext
from licitaqui.tender_value import (
    GONE_BACKOFF_HOURS,
    REFRESH_TTL_HOURS,
    UPGRADE_TTL_HOURS,
    VALUE_SOURCE_CONSULTA,
    VALUE_SOURCE_GONE,
    VALUE_SOURCE_ITEMS,
    VALUE_SOURCE_NONE,
    due_tenders,
    mark,
    read_state,
    refresh_one,
    refresh_tender_value,
    sweep_tender_values,
    value_event_name,
)
from licitaqui.tenders import from_search, upsert_tenders
from tests.conftest import EV_CNPJ, ev_tender_id

LOG = logging.getLogger("licitaqui.evtest")


@pytest.fixture(autouse=True)
def _fresh_breakers():
    breaker_module.reset_all()
    yield
    breaker_module.reset_all()


# -- fixtures in the production shape --------------------------------------


def given_search_tender(conn: psycopg.Connection, seq: int) -> str:
    """A tender exactly as ADR-0001's fallback leaves it: no value, no srp.

    Built through `from_search` rather than by hand, so if the mapping ever
    starts filling these columns this suite's premise fails loudly instead of
    silently testing nothing.
    """
    tid = ev_tender_id(seq)
    upsert_tenders(
        conn,
        [
            from_search(
                {
                    "numero_controle_pncp": tid,
                    "description": "AQUISIÇÃO DE MATERIAL DE CONSUMO PARA A SECRETARIA",
                    "orgao_nome": "ÓRGÃO DE TESTE EV",
                    "uf": "MT",
                    "municipio_nome": "Cuiabá",
                    "modalidade_licitacao_id": 6,
                    "data_atualizacao_pncp": "2026-09-20T04:00:00",
                }
            )
        ],
    )
    row = conn.execute(
        "select estimated_value, price_registration, confidential_budget from tenders where id=%s",
        (tid,),
    ).fetchone()
    assert row == (None, None, None), f"premise broken: the fallback now fills {row}"
    return tid


def given_items(conn: psycopg.Connection, tid: str, totals: list[str]) -> None:
    records = [
        {
            "numeroItem": n,
            "descricao": f"Item {n} — material de consumo",
            "materialOuServico": "M",
            "quantidade": 1,
            "valorUnitarioEstimado": float(total),
            "valorTotal": float(total),
        }
        for n, total in enumerate(totals, start=1)
    ]
    upsert_items(conn, tid, classify_all(tid, records))


def detail(tid: str, **overrides: Any) -> dict[str, Any]:
    record = {
        "numeroControlePNCP": tid,
        "objetoCompra": "AQUISIÇÃO DE MATERIAL DE CONSUMO PARA A SECRETARIA",
        "valorTotalEstimado": 271350.31,
        "srp": True,
        "orcamentoSigilosoCodigo": 1,
        "situacaoCompraNome": "Divulgada no PNCP",
        "linkSistemaOrigem": "https://exemplo.gov.br/pregao/958",
        "dataAtualizacaoGlobal": "2026-09-21T04:00:00",
    }
    return record | overrides


def consulta_client(tid: str, *, status: int = 200, body: dict | None = None):
    """A client factory serving one tender's Consulta detail from memory."""
    _, rest = tid.split("-1-", 1)
    sequence, year = rest.split("/")
    wanted = CONTRATACAO_PATH.format(cnpj=EV_CNPJ, year=year, sequence=int(sequence))
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path != wanted:
            return httpx.Response(404, text='{"message":"unmapped path in the test"}')
        if status == 200:
            return httpx.Response(200, json=body if body is not None else detail(tid))
        return httpx.Response(status, text=f'{{"status":"{status}"}}')

    def factory() -> PncpClient:
        return PncpClient(transport=httpx.MockTransport(handler), rate_limit=0.0, page_delay=0.0)

    factory.calls = calls  # type: ignore[attr-defined]
    return factory


def value_of(conn: psycopg.Connection, tid: str):
    return conn.execute(
        "select estimated_value, price_registration, confidential_budget, status,"
        "       bidding_system_url, next_refresh_at"
        "  from tenders where id = %s",
        (tid,),
    ).fetchone()


def run_job(monkeypatch, conn, factory, tid: str, **payload) -> None:
    monkeypatch.setattr(tender_value_module, "build_client", factory)
    job = Job(
        id=-1,
        kind="refresh_tender_value",
        key=tid,
        priority=9,
        payload={"tender_id": tid, **payload},
        attempts=1,
    )
    refresh_tender_value(JobContext(job=job, conn=conn, connect=lambda: conn, log=LOG))


# -- the authoritative path ------------------------------------------------


class TestConsultaIsAuthoritative:
    def test_it_fills_the_three_columns_the_search_index_cannot(self, ev_conn):
        tid = given_search_tender(ev_conn, 1)
        with consulta_client(tid)() as client:
            outcome = refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))

        assert outcome.source == VALUE_SOURCE_CONSULTA
        value, srp, sigiloso, status, url, _ = value_of(ev_conn, tid)
        assert value == Decimal("271350.31")
        assert srp is True
        assert sigiloso is False
        assert status == "Divulgada no PNCP"
        assert url == "https://exemplo.gov.br/pregao/958"

    def test_it_beats_the_item_sum_even_when_the_items_say_more(self, ev_conn):
        # Sci's rule: the number we show is PNCP's own. Production has 41
        # tenders where the item sum over-counts, one of them by 13.3x.
        tid = given_search_tender(ev_conn, 2)
        given_items(ev_conn, tid, ["999999.99"])
        with consulta_client(tid)() as client:
            outcome = refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))

        assert outcome.source == VALUE_SOURCE_CONSULTA
        assert outcome.agrees is False
        assert value_of(ev_conn, tid)[0] == Decimal("271350.31")

    def test_it_records_agreement_when_the_two_match_to_the_cent(self, ev_conn):
        tid = given_search_tender(ev_conn, 3)
        given_items(ev_conn, tid, ["271000.31", "350.00"])
        with consulta_client(tid)() as client:
            outcome = refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))
        assert outcome.agrees is True

    def test_it_does_not_grow_raw(self, ev_conn):
        # Merging the detail payload into `raw` would add ~2,822 bytes to each
        # of 5,373 rows — about 14 MB against 15.3 MB of headroom. The columns
        # are the fix; the payload is not.
        tid = given_search_tender(ev_conn, 4)
        before = ev_conn.execute(
            "select pg_column_size(raw), raw ? 'numero_controle_pncp' from tenders where id=%s",
            (tid,),
        ).fetchone()
        with consulta_client(tid)() as client:
            refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))
        after = ev_conn.execute(
            "select pg_column_size(raw), raw ? 'valorTotalEstimado' from tenders where id=%s",
            (tid,),
        ).fetchone()
        assert after[0] == before[0], "raw grew; the payload was merged in"
        assert after[1] is False, "the consulta payload leaked into raw"

    def test_it_never_walks_pncp_updated_at_backwards(self, ev_conn):
        # `pncp_updated_at` is B2's change trigger. A detail record older than
        # what the sweep stored must not make B3/B4 re-read the tender forever.
        tid = given_search_tender(ev_conn, 5)
        ev_conn.execute(
            "update tenders set pncp_updated_at = %s where id = %s",
            (datetime(2026, 9, 25, tzinfo=UTC), tid),
        )
        with consulta_client(tid)() as client:
            refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))
        stored = ev_conn.execute(
            "select pncp_updated_at from tenders where id=%s", (tid,)
        ).fetchone()[0]
        assert stored == datetime(2026, 9, 25, tzinfo=UTC)


# -- the fallback ----------------------------------------------------------


class TestItemSumFallback:
    def test_it_values_a_tender_consulta_cannot_answer_for(self, ev_conn):
        # This is the mode the whole corpus is in while /api/consulta is down,
        # which it was for the entire span of this work.
        tid = given_search_tender(ev_conn, 6)
        given_items(ev_conn, tid, ["1282029.16"])
        with consulta_client(tid, status=500)() as client:
            outcome = refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))

        assert outcome.source == VALUE_SOURCE_ITEMS
        assert value_of(ev_conn, tid)[0] == Decimal("1282029.16")
        # Nothing was compared, so nothing is counted either way.
        assert outcome.agrees is None

    def test_it_needs_no_pncp_call_at_all(self, ev_conn):
        tid = given_search_tender(ev_conn, 7)
        given_items(ev_conn, tid, ["100.00", "171350.31", "99900.00"])
        outcome = refresh_one(ev_conn, None, tid, read_state(ev_conn, tid))
        assert outcome.source == VALUE_SOURCE_ITEMS
        assert value_of(ev_conn, tid)[0] == Decimal("271350.31")

    def test_a_confidential_budget_sums_to_zero_and_stays_unvalued(self, ev_conn):
        # Every sigiloso item reports 0. Showing "R$ 0,00" would read as free.
        tid = given_search_tender(ev_conn, 8)
        given_items(ev_conn, tid, ["0", "0"])
        outcome = refresh_one(ev_conn, None, tid, read_state(ev_conn, tid))
        assert outcome.source == VALUE_SOURCE_NONE
        assert value_of(ev_conn, tid)[0] is None

    def test_it_cannot_overwrite_a_value_consulta_gave_us(self, ev_conn):
        # The guard is in the statement, so no ordering mistake upstream can
        # let the item sum win.
        tid = given_search_tender(ev_conn, 9)
        given_items(ev_conn, tid, ["999999.99"])
        ev_conn.execute(
            "update tenders set estimated_value = 271350.31 where id = %s", (tid,)
        )
        ev_conn.execute(
            tender_value_module.APPLY_ITEM_SUM_SQL,
            {"tender_id": tid, "estimated_value": Decimal("999999.99")},
        )
        assert value_of(ev_conn, tid)[0] == Decimal("271350.31")

    def test_a_published_zero_is_never_replaced_by_our_arithmetic(self, ev_conn):
        # 108 production rows hold 0.00 because PNCP published that. It is a
        # figure, not an empty cell, and the rule is that the number we show is
        # PNCP's — so the item sum must not paper over it. These rows are
        # resolved by the detail fetch instead (`confidential_budget`), because
        # the /atualizacao record that wrote them carries no sigiloso code.
        tid = given_search_tender(ev_conn, 10)
        given_items(ev_conn, tid, ["42000.00"])
        ev_conn.execute("update tenders set estimated_value = 0 where id = %s", (tid,))
        outcome = refresh_one(ev_conn, None, tid, read_state(ev_conn, tid))
        assert outcome.source == VALUE_SOURCE_NONE
        assert value_of(ev_conn, tid)[0] == Decimal("0")

    def test_a_published_zero_still_gets_its_sigiloso_flag_from_the_detail(self, ev_conn):
        # The /atualizacao period record has no `orcamentoSigilosoCodigo` at
        # all; the detail endpoint does. That is how a "R$ 0,00" card becomes an
        # honest "orçamento sigiloso" one.
        tid = given_search_tender(ev_conn, 31)
        ev_conn.execute("update tenders set estimated_value = 0 where id = %s", (tid,))
        body = detail(tid, valorTotalEstimado=0, orcamentoSigilosoCodigo=3)
        with consulta_client(tid, body=body)() as client:
            refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))
        value, _, sigiloso, *_ = value_of(ev_conn, tid)
        assert sigiloso is True
        assert value == Decimal("0")


class TestConsultaWithoutANumber:
    def test_it_keeps_srp_and_the_real_flag_and_still_takes_the_item_sum(self, ev_conn):
        # A sigiloso header answers 200 with `valorTotalEstimado: 0`. Everything
        # else it carries is still worth having.
        tid = given_search_tender(ev_conn, 11)
        given_items(ev_conn, tid, ["42000.00"])
        body = detail(tid, valorTotalEstimado=0, orcamentoSigilosoCodigo=3, srp=False)
        with consulta_client(tid, body=body)() as client:
            outcome = refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))

        assert outcome.source == VALUE_SOURCE_ITEMS
        value, srp, sigiloso, *_ = value_of(ev_conn, tid)
        assert value == Decimal("42000.00")
        assert srp is False
        assert sigiloso is True


# -- withdrawn tenders -----------------------------------------------------


class TestGone:
    def test_a_410_parks_the_tender_instead_of_retrying_it_forever(self, ev_conn):
        tid = given_search_tender(ev_conn, 12)
        with consulta_client(tid, status=410)() as client:
            outcome = refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))

        assert outcome.source == VALUE_SOURCE_GONE
        next_refresh = value_of(ev_conn, tid)[5]
        assert next_refresh > datetime.now(UTC) + timedelta(hours=GONE_BACKOFF_HOURS - 1)
        # And it is out of the sweep's way.
        assert tid not in due_tenders(ev_conn, limit=500)

    def test_a_410_does_not_open_the_consulta_circuit(self, ev_conn):
        # A withdrawn tender must not stop the sweep for every other one.
        tid = given_search_tender(ev_conn, 13)
        factory = consulta_client(tid, status=410)
        with factory() as client:
            for _ in range(4):
                refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))
            assert client.consulta_breaker.state != "open"


# -- the backoff that keeps the sweep from spinning ------------------------


class TestBackoff:
    def test_an_unvaluable_tender_is_parked_for_the_header_ttl(self, ev_conn):
        tid = given_search_tender(ev_conn, 14)
        refresh_one(ev_conn, None, tid, read_state(ev_conn, tid))
        next_refresh = value_of(ev_conn, tid)[5]
        assert next_refresh is not None
        assert next_refresh > datetime.now(UTC) + timedelta(hours=REFRESH_TTL_HOURS - 1)
        assert tid not in due_tenders(ev_conn, limit=500)

    def test_it_comes_back_once_the_ttl_has_passed(self, ev_conn):
        tid = given_search_tender(ev_conn, 15)
        refresh_one(ev_conn, None, tid, read_state(ev_conn, tid))
        ev_conn.execute(
            "update tenders set next_refresh_at = now() - interval '1 minute' where id = %s",
            (tid,),
        )
        assert tid in due_tenders(ev_conn, limit=500)

    def test_a_consulta_valued_tender_is_never_offered_again(self, ev_conn):
        tid = given_search_tender(ev_conn, 16)
        given_items(ev_conn, tid, ["42000.00"])
        with consulta_client(tid)() as client:
            outcome = refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))
        mark(ev_conn, outcome)
        ev_conn.execute("update tenders set next_refresh_at = null where id = %s", (tid,))
        assert tid not in due_tenders(ev_conn, limit=500)

    def test_an_item_sum_valued_tender_comes_back_for_the_real_number(self, ev_conn):
        # Sci's rule is that the number we show is PNCP's own. A row that took
        # the fallback while consulta was down has a value, so the "no value"
        # condition stops matching — without the marker check it would hold an
        # over-counting item sum for ever.
        tid = given_search_tender(ev_conn, 29)
        given_items(ev_conn, tid, ["42000.00"])
        with consulta_client(tid, status=500)() as client:
            outcome = refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))
        mark(ev_conn, outcome)
        assert outcome.source == VALUE_SOURCE_ITEMS

        ev_conn.execute(
            "update tenders set next_refresh_at = now() - interval '1 minute' where id = %s",
            (tid,),
        )
        assert tid in due_tenders(ev_conn, limit=500)

        # …and once consulta answers, it stops being offered.
        with consulta_client(tid)() as client:
            second = refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))
        mark(ev_conn, second)
        assert second.source == VALUE_SOURCE_CONSULTA
        assert value_of(ev_conn, tid)[0] == Decimal("271350.31")
        ev_conn.execute(
            "update tenders set next_refresh_at = now() - interval '1 minute' where id = %s",
            (tid,),
        )
        assert tid not in due_tenders(ev_conn, limit=500)

    def test_a_re_offered_row_always_advances_its_clock(self, ev_conn):
        # The two value writes are conditional, so neither runs on a row that
        # already has a value. If the clock lived in them, such a row would be
        # re-offered on every cycle for ever.
        tid = given_search_tender(ev_conn, 30)
        given_items(ev_conn, tid, ["42000.00"])
        with consulta_client(tid, status=500)() as client:
            mark(ev_conn, refresh_one(ev_conn, client, tid, read_state(ev_conn, tid)))
        ev_conn.execute(
            "update tenders set next_refresh_at = now() - interval '1 minute' where id = %s",
            (tid,),
        )
        with consulta_client(tid, status=500)() as client:
            refresh_one(ev_conn, client, tid, read_state(ev_conn, tid))

        assert value_of(ev_conn, tid)[5] > datetime.now(UTC) + timedelta(
            hours=UPGRADE_TTL_HOURS - 1
        )
        assert tid not in due_tenders(ev_conn, limit=500)

    def test_a_tender_showing_a_number_waits_far_longer_than_one_showing_none(self, ev_conn):
        # §14.1: every rewritten row costs storage twice on Neon, and parking
        # rewrites the row on every visit. A tender already showing a number is
        # not urgent; one showing "Valor não informado" is.
        unvalued = given_search_tender(ev_conn, 32)
        valued = given_search_tender(ev_conn, 33)
        given_items(ev_conn, valued, ["42000.00"])
        refresh_one(ev_conn, None, unvalued, read_state(ev_conn, unvalued))
        refresh_one(ev_conn, None, valued, read_state(ev_conn, valued))

        soon = value_of(ev_conn, unvalued)[5]
        later = value_of(ev_conn, valued)[5]
        assert soon < later
        assert soon < datetime.now(UTC) + timedelta(hours=REFRESH_TTL_HOURS + 1)
        assert later > datetime.now(UTC) + timedelta(hours=UPGRADE_TTL_HOURS - 1)


# -- the job and the sweep -------------------------------------------------


class TestTheJob:
    def test_it_writes_the_marker_that_makes_provenance_queryable(self, ev_conn, monkeypatch):
        # There is no column for provenance and a column is a migration, which
        # is its own PR. This is the precedent B3 and B4 set.
        tid = given_search_tender(ev_conn, 17)
        given_items(ev_conn, tid, ["42000.00"])
        run_job(monkeypatch, ev_conn, consulta_client(tid, status=500), tid)

        props = ev_conn.execute(
            "select props from events where name = %s", (value_event_name(tid),)
        ).fetchone()[0]
        assert props["value_source"] == VALUE_SOURCE_ITEMS
        assert props["value"] == "42000.00"
        assert props["items"] == 1

    def test_the_marker_is_rewritten_not_appended(self, ev_conn, monkeypatch):
        tid = given_search_tender(ev_conn, 18)
        given_items(ev_conn, tid, ["42000.00"])
        for _ in range(3):
            run_job(monkeypatch, ev_conn, consulta_client(tid, status=500), tid, force=True)
        count = ev_conn.execute(
            "select count(*) from events where name = %s", (value_event_name(tid),)
        ).fetchone()[0]
        assert count == 1

    def test_an_already_valued_tender_costs_no_pncp_call(self, ev_conn, monkeypatch):
        tid = given_search_tender(ev_conn, 19)
        ev_conn.execute("update tenders set estimated_value = 42000 where id = %s", (tid,))
        factory = consulta_client(tid)
        run_job(monkeypatch, ev_conn, factory, tid)
        assert factory.calls == []

    def test_items_only_makes_no_pncp_call(self, ev_conn, monkeypatch):
        tid = given_search_tender(ev_conn, 20)
        given_items(ev_conn, tid, ["42000.00"])
        factory = consulta_client(tid)
        run_job(monkeypatch, ev_conn, factory, tid, items_only=True)
        assert factory.calls == []
        assert value_of(ev_conn, tid)[0] == Decimal("42000.00")

    def test_an_unknown_tender_does_not_fail_the_job(self, ev_conn, monkeypatch):
        # Enqueued by id, so this means the row went away in between. Failing
        # would retry four times over forty minutes against nothing.
        missing = ev_tender_id(999)
        factory = consulta_client(missing)
        run_job(monkeypatch, ev_conn, factory, missing)
        assert factory.calls == [], "asked PNCP about a tender we do not have"

    def test_the_job_is_idempotent(self, ev_conn, monkeypatch):
        tid = given_search_tender(ev_conn, 21)
        given_items(ev_conn, tid, ["42000.00"])
        for _ in range(3):
            run_job(monkeypatch, ev_conn, consulta_client(tid), tid, force=True)
        assert value_of(ev_conn, tid)[0] == Decimal("271350.31")


class TestTheSweep:
    def test_it_enqueues_only_unvalued_tenders(self, ev_conn):
        unvalued = given_search_tender(ev_conn, 22)
        valued = given_search_tender(ev_conn, 23)
        ev_conn.execute("update tenders set estimated_value = 1 where id = %s", (valued,))

        job = Job(id=-1, kind="sweep_tender_values", key="k", priority=9, payload={}, attempts=1)
        sweep_tender_values(JobContext(job=job, conn=ev_conn, connect=lambda: ev_conn, log=LOG))

        queued = {
            row[0]
            for row in ev_conn.execute(
                "select key from jobs where kind = 'refresh_tender_value'"
                " and starts_with(key, %s)",
                (f"{EV_CNPJ}-",),
            ).fetchall()
        }
        assert unvalued in queued
        assert valued not in queued

    def test_a_second_tick_does_not_duplicate_a_live_job(self, ev_conn):
        given_search_tender(ev_conn, 24)
        job = Job(id=-1, kind="sweep_tender_values", key="k", priority=9, payload={}, attempts=1)
        ctx = JobContext(job=job, conn=ev_conn, connect=lambda: ev_conn, log=LOG)
        sweep_tender_values(ctx)
        sweep_tender_values(ctx)
        count = ev_conn.execute(
            "select count(*) from jobs where kind = 'refresh_tender_value'"
            " and starts_with(key, %s)",
            (f"{EV_CNPJ}-",),
        ).fetchone()[0]
        assert count == 1


# -- the ingest path that stops the gap reopening --------------------------


class TestRollUpPersistsTheValue:
    def test_syncing_items_now_leaves_the_tender_valued(self, ev_conn):
        # The roll-up already computed this number to decide `favored_treatment`
        # and threw it away. That is the other half of the bug.
        tid = given_search_tender(ev_conn, 25)
        records = [
            {
                "numeroItem": 1,
                "descricao": "Arroz branco tipo 1",
                "materialOuServico": "M",
                "valorTotal": 2988571.02,
            }
        ]
        items = classify_all(tid, records)
        upsert_items(ev_conn, tid, items)
        summary = roll_up(ev_conn, tid, items, estimated_value=None, object_text="x")

        # Sci's second worked tender, whose portal figure is R$ 2.988.571,02.
        assert value_of(ev_conn, tid)[0] == Decimal("2988571.02")
        # And the ME/EPP claim beside it comes from that same number: under the
        # R$ 4.8M EPP cap, so the legal preference applies.
        assert summary["favored_treatment"] is True

    def test_the_value_and_the_me_epp_claim_cannot_disagree(self, ev_conn):
        # The card asserts a *legal* preference next to the value. Both must be
        # derived from the one number, on either side of the cap.
        tid = given_search_tender(ev_conn, 28)
        over = float(EPP_REVENUE_CAP + Decimal("1"))
        items = classify_all(tid, [{"numeroItem": 1, "descricao": "x", "valorTotal": over}])
        upsert_items(ev_conn, tid, items)
        summary = roll_up(ev_conn, tid, items, estimated_value=None, object_text="x")

        assert value_of(ev_conn, tid)[0] > EPP_REVENUE_CAP
        assert summary["favored_treatment"] is False

    def test_it_does_not_overwrite_a_header_value(self, ev_conn):
        tid = given_search_tender(ev_conn, 26)
        ev_conn.execute("update tenders set estimated_value = 100 where id = %s", (tid,))
        records = [{"numeroItem": 1, "descricao": "x", "valorTotal": 999999.0}]
        items = classify_all(tid, records)
        upsert_items(ev_conn, tid, items)
        roll_up(ev_conn, tid, items, estimated_value=Decimal("100"), object_text="x")
        assert value_of(ev_conn, tid)[0] == Decimal("100")

    def test_sync_items_still_reports_its_summary(self, ev_conn):
        # `_summary_extra` reads three keys off the roll-up's return value.
        tid = given_search_tender(ev_conn, 27)
        items = classify_all(tid, [{"numeroItem": 1, "descricao": "x", "valorTotal": 10.0}])
        summary = roll_up(ev_conn, tid, items, estimated_value=None, object_text="x")
        assert set(sync_items_module._summary_extra(summary)) == {
            "me_epp_summary",
            "favored_treatment",
            "segments",
        }
