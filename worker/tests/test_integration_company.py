"""``company_lookup`` against the real `companies` table.

These run on ``TEST_DATABASE_URL_B5`` — B5's own already-migrated database — and
skip without it. BrasilAPI is **never** called: every test substitutes
``brasilapi.lookup``, so the suite stays offline and deterministic. The live
check is ``worker/scripts/check_company_lookup_live.py``.

The CNPJs below are synthetic (a 999 root nobody is registered under) with valid
check digits, and only those exact rows are deleted — the database is shared
with other tasks' runs, so nothing here truncates anything.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path

import psycopg
import pytest

from licitaqui import breaker, company, db, queue
from licitaqui.brasilapi import BrasilApiError
from licitaqui.company import STATUS_FAILED, STATUS_NOT_FOUND
from licitaqui.consumer import Consumer
from licitaqui.registry import REGISTRY

FIXTURES = Path(__file__).parent / "fixtures" / "brasilapi"

RESOLVED = "99900001000150"
FALLBACK = "99900002000102"
THIRD = "99900003000149"
FOURTH = "99900004000193"
FIFTH = "99900005000138"
SIXTH = "99900006000182"
TEST_CNPJS = (RESOLVED, FALLBACK, THIRD, FOURTH, FIFTH, SIXTH)

TEST_KEYS = tuple(company.job_key(c) for c in TEST_CNPJS)


def record(name: str = "micro_mei", cnpj: str = RESOLVED):
    from licitaqui import brasilapi

    return brasilapi.parse(cnpj, json.loads((FIXTURES / f"{name}.json").read_text()))


@pytest.fixture(scope="session")
def _b5_session_conn(b5_dsn: str) -> Iterator[psycopg.Connection]:
    """One connection for the whole module: Neon charges for wake-ups, not rows."""
    with db.factory(b5_dsn, application_name="licitaqui-test-b5")() as conn:
        yield conn


@pytest.fixture
def b5_conn(_b5_session_conn: psycopg.Connection) -> Iterator[psycopg.Connection]:
    _clean(_b5_session_conn)
    breaker.reset_all()
    try:
        yield _b5_session_conn
    finally:
        _clean(_b5_session_conn)
        breaker.reset_all()


def _clean(conn: psycopg.Connection) -> None:
    """Delete only this module's own rows; the database is shared with other runs."""
    conn.execute("delete from companies where cnpj = any(%s)", (list(TEST_CNPJS),))
    conn.execute("delete from jobs where key = any(%s)", (list(TEST_KEYS),))


def row(conn: psycopg.Connection, cnpj: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            "select cnpj, legal_name, trade_name, main_cnae, secondary_cnaes, size,"
            " is_mei, state, city, registration_status, segments, updated_at"
            " from companies where cnpj = %s",
            (cnpj,),
        )
        got = cur.fetchone()
        if got is None:
            return None
        return dict(zip([d.name for d in cur.description], got, strict=True))


def age(conn: psycopg.Connection, cnpj: str, delta: timedelta) -> None:
    """Backdate a row so a TTL boundary can be tested without waiting."""
    conn.execute(
        "update companies set updated_at = now() - make_interval(secs => %s) where cnpj = %s",
        (delta.total_seconds(), cnpj),
    )


class FakeApi:
    """Stands in for ``brasilapi.lookup``; counts the calls it would have made."""

    def __init__(self, *outcomes) -> None:
        self.outcomes = list(outcomes)
        self.calls = 0

    def __call__(self, cnpj: str, **kwargs):
        self.calls += 1
        outcome = self.outcomes[min(self.calls - 1, len(self.outcomes) - 1)]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


@pytest.fixture
def api(monkeypatch):
    def install(*outcomes):
        fake = FakeApi(*outcomes)
        monkeypatch.setattr(company.brasilapi, "lookup", fake)
        return fake

    return install


# -- the happy path -------------------------------------------------------


def test_a_successful_lookup_writes_every_column_we_have(b5_conn, api):
    api(record("micro_mei"))

    assert company.lookup(b5_conn, RESOLVED).status == "resolved"

    got = row(b5_conn, RESOLVED)
    assert got["main_cnae"] == "8219999"
    assert got["secondary_cnaes"] == ["1732000", "4761003"]
    assert got["size"] == "ME"
    assert got["is_mei"] is True
    assert got["state"] == "PR"
    assert got["city"] == "CURITIBA"
    assert got["registration_status"] == "ATIVA"


def test_a_null_mei_flag_is_stored_as_unknown_not_as_false(b5_conn, api):
    api(record("demais_null_flags", FALLBACK))

    company.lookup(b5_conn, FALLBACK)

    got = row(b5_conn, FALLBACK)
    assert got["main_cnae"] is not None, "resolved, so this is not the manual path"
    assert got["is_mei"] is None, "no Simples/MEI record is unknown, never 'not a MEI'"


def test_running_the_same_lookup_twice_leaves_one_row(b5_conn, api):
    fake = api(record("micro_mei"))

    company.lookup(b5_conn, RESOLVED)
    company.lookup(b5_conn, RESOLVED, force=True)

    assert fake.calls == 2
    with b5_conn.cursor() as cur:
        cur.execute("select count(*) from companies where cnpj = %s", (RESOLVED,))
        assert cur.fetchone()[0] == 1


# -- the 30-day cache -----------------------------------------------------


def test_a_fresh_row_never_reaches_the_api(b5_conn, api):
    fake = api(record("micro_mei"))
    company.lookup(b5_conn, RESOLVED)

    assert company.lookup(b5_conn, RESOLVED).status == "cached"
    assert fake.calls == 1


def test_the_ttl_is_thirty_days(b5_conn, api):
    fake = api(record("micro_mei"))
    company.lookup(b5_conn, RESOLVED)

    age(b5_conn, RESOLVED, timedelta(days=29))
    assert company.lookup(b5_conn, RESOLVED).status == "cached"
    assert fake.calls == 1

    age(b5_conn, RESOLVED, timedelta(days=31))
    assert company.lookup(b5_conn, RESOLVED).status == "resolved"
    assert fake.calls == 2


def test_force_bypasses_a_fresh_row(b5_conn, api):
    fake = api(record("micro_mei"))
    company.lookup(b5_conn, RESOLVED)

    assert company.lookup(b5_conn, RESOLVED, force=True).status == "resolved"
    assert fake.calls == 2


def test_a_refresh_does_not_wipe_the_segments_b6_wrote(b5_conn, api):
    api(record("micro_mei"))
    company.lookup(b5_conn, RESOLVED)
    b5_conn.execute("update companies set segments = %s where cnpj = %s", (["papelaria"], RESOLVED))

    company.lookup(b5_conn, RESOLVED, force=True)

    assert row(b5_conn, RESOLVED)["segments"] == ["papelaria"]


# -- the manual CNAE path -------------------------------------------------


def test_a_failed_lookup_surfaces_the_manual_path_instead_of_only_logging(b5_conn, api):
    api(BrasilApiError("timeout"))

    result = company.lookup(b5_conn, FALLBACK)

    assert result.manual_cnae
    got = row(b5_conn, FALLBACK)
    assert got is not None, "a row must exist, otherwise nothing is queryable"
    assert got["main_cnae"] is None
    assert got["registration_status"] == STATUS_FAILED


def test_the_manual_path_is_queryable_with_the_exported_predicate(b5_conn, api):
    api(BrasilApiError("timeout"))
    company.lookup(b5_conn, FALLBACK)

    with b5_conn.cursor() as cur:
        cur.execute(
            f"select cnpj from companies where {company.MANUAL_CNAE_PREDICATE} and cnpj = any(%s)",
            (list(TEST_CNPJS),),
        )
        assert [r[0] for r in cur.fetchall()] == [FALLBACK]


def test_a_failed_lookup_does_not_fail_the_job(b5_conn, api):
    """ADR-0002 item 5: one attempt, then the form. No retry in front of a user."""
    api(BrasilApiError("timeout"))
    company.lookup(b5_conn, FALLBACK)  # must not raise


def test_an_unknown_cnpj_says_so_rather_than_blaming_brasilapi(b5_conn, api):
    api(BrasilApiError("not_found", status=404, not_found=True))

    assert company.lookup(b5_conn, THIRD).manual_cnae
    assert row(b5_conn, THIRD)["registration_status"] == STATUS_NOT_FOUND


def test_a_typo_is_caught_before_a_request_is_spent(b5_conn, api):
    fake = api(record("micro_mei"))
    typo = "99900001000151"  # RESOLVED with a broken check digit

    try:
        assert company.lookup(b5_conn, typo).manual_cnae
        assert fake.calls == 0
        assert row(b5_conn, typo)["registration_status"] == STATUS_NOT_FOUND
    finally:
        b5_conn.execute("delete from companies where cnpj = %s", (typo,))


def test_a_failed_lookup_never_overwrites_cnaes_we_already_have(b5_conn, api):
    fake = api(record("micro_mei"), BrasilApiError("timeout"))
    company.lookup(b5_conn, RESOLVED)
    age(b5_conn, RESOLVED, timedelta(days=40))
    before = row(b5_conn, RESOLVED)

    result = company.lookup(b5_conn, RESOLVED)

    assert fake.calls == 2
    assert result.status == "stale_kept"
    after = row(b5_conn, RESOLVED)
    assert after["main_cnae"] == before["main_cnae"]
    assert after["registration_status"] == "ATIVA"
    assert after["updated_at"] == before["updated_at"], "a failure must not fake freshness"


def test_a_fallback_row_expires_sooner_than_thirty_days(b5_conn, api):
    fake = api(BrasilApiError("timeout"), record("demais_null_flags", FALLBACK))
    company.lookup(b5_conn, FALLBACK)

    age(b5_conn, FALLBACK, company.FALLBACK_TTL / 2)
    assert company.lookup(b5_conn, FALLBACK).manual_cnae
    assert fake.calls == 1, "still inside the fallback TTL"

    age(b5_conn, FALLBACK, company.FALLBACK_TTL + timedelta(minutes=1))
    assert company.lookup(b5_conn, FALLBACK).status == "resolved"
    assert fake.calls == 2, "an outage must not pin a user to the form for 30 days"


def test_a_fallback_row_is_replaced_by_real_data_when_the_api_recovers(b5_conn, api):
    api(BrasilApiError("timeout"), record("demais_null_flags", FALLBACK))
    company.lookup(b5_conn, FALLBACK)

    company.lookup(b5_conn, FALLBACK, force=True)

    got = row(b5_conn, FALLBACK)
    assert got["main_cnae"] == "4649408"
    assert got["registration_status"] == "ATIVA"


# -- the circuit breaker --------------------------------------------------


def test_two_failures_open_the_circuit_and_the_third_lookup_skips_the_call(b5_conn, api):
    fake = api(BrasilApiError("timeout"))

    company.lookup(b5_conn, FOURTH)
    company.lookup(b5_conn, FIFTH)
    assert get_state() == "open"

    assert company.lookup(b5_conn, SIXTH).manual_cnae
    assert fake.calls == 2, "the open circuit must not spend another timeout budget"
    assert row(b5_conn, SIXTH)["registration_status"] == STATUS_FAILED


def test_an_unknown_cnpj_does_not_open_the_circuit_for_everyone(b5_conn, api):
    """A 404 is the endpoint working. Two typos must not blind the worker."""
    api(BrasilApiError("not_found", status=404, not_found=True))

    company.lookup(b5_conn, FOURTH)
    company.lookup(b5_conn, FIFTH)

    assert get_state() == "closed"


def get_state() -> str:
    from licitaqui import brasilapi

    return breaker.get_breaker(brasilapi.BREAKER_NAME).state


# -- end to end through B1's consumer -------------------------------------


def test_the_handler_is_registered_and_runs_through_the_queue(b5_dsn, b5_conn, api):
    api(record("micro_mei"))
    assert company.JOB_KIND in REGISTRY.kinds()

    job_id = company.enqueue(b5_conn, RESOLVED)
    assert job_id is not None

    consumer = Consumer(
        db.factory(b5_dsn, application_name="licitaqui-test-b5"),
        name="b5",
        kinds=[company.JOB_KIND],
    )
    assert consumer.drain() >= 1

    with b5_conn.cursor() as cur:
        cur.execute("select status from jobs where id = %s", (job_id,))
        assert cur.fetchone()[0] == "done"
    assert row(b5_conn, RESOLVED)["main_cnae"] == "8219999"


def test_the_queue_row_carries_no_cnpj_in_the_column_the_consumer_logs(b5_conn, api):
    api(record("micro_mei"))
    job_id = company.enqueue(b5_conn, RESOLVED)

    with b5_conn.cursor() as cur:
        cur.execute("select key, payload from jobs where id = %s", (job_id,))
        key, payload = cur.fetchone()
    # B1's consumer logs `key` on every line (§12: never log the CNPJ).
    assert RESOLVED not in key
    assert key == f"company:{company.cnpj_ref(RESOLVED)}"
    assert payload["cnpj"] == RESOLVED


def test_a_second_enqueue_for_the_same_cnpj_is_deduplicated(b5_conn):
    assert company.enqueue(b5_conn, RESOLVED) is not None
    assert company.enqueue(b5_conn, RESOLVED) is None


def test_a_payload_without_a_cnpj_is_a_bug_and_does_fail_the_job(b5_conn, api):
    api(record("micro_mei"))
    job_id = queue.enqueue(b5_conn, company.JOB_KIND, company.job_key(SIXTH), payload={})
    job = queue.claim(b5_conn, kinds=[company.JOB_KIND])

    consumer = Consumer(lambda: None, name="b5")
    assert consumer.execute(b5_conn, job) == "queued"

    with b5_conn.cursor() as cur:
        cur.execute("select error from jobs where id = %s", (job_id,))
        assert "cnpj" in cur.fetchone()[0]
