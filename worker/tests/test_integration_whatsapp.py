"""`send_whatsapp` against real `founders_list` rows and a real delivery log.

These run on ``TEST_DATABASE_URL_E2`` — E2's own already-migrated database — and
skip without it. **Evolution is never called:** the kill switch is off for the
whole suite (`_whatsapp_delivery_off` in `conftest.py`), and the two tests that
turn it on are bolted to an `httpx.MockTransport` replaying the recorded
responses in `tests/fixtures/evolution/`.

Every founder written here is waitlisted (`seat is null`) and carries this
**run's** id in its e-mail: there are only 48 seats and they are globally
unique, so a test that took one would collide with a concurrent run of this
same suite and, if it crashed, leave a seat permanently spent.
"""

from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest

from licitaqui import breaker, evolution, queue, whatsapp
from licitaqui.consumer import Consumer
from licitaqui.evolution import DELIVERY_SEND, DELIVERY_VAR, EvolutionClient
from licitaqui.queue import Job
from tests.conftest import e2_email, e2_whatsapp

FIXTURES = Path(__file__).parent / "fixtures" / "evolution"
RECORDED_200 = json.loads((FIXTURES / "send_text_200.json").read_text())

#: Distinctive enough that a grep over the delivery log proves it is not there.
FOUNDER_NAME = "Maria Aparecida Zzyzx"


@pytest.fixture(autouse=True)
def _fresh_breaker() -> None:
    breaker.reset_all()


def insert_founder(
    conn: psycopg.Connection,
    label: str,
    *,
    consent: bool = True,
    number: str | None = None,
    name: str = FOUNDER_NAME,
) -> int:
    """One waitlisted founder. Returns the id. See the module docstring on seats."""
    row = conn.execute(
        "insert into founders_list (name, email, whatsapp, contact_consent, seat)"
        " values (%s, %s, %s, %s, null) returning id",
        (
            name,
            e2_email(label),
            e2_whatsapp(abs(hash(label)) % 1000) if number is None else number,
            consent,
        ),
    ).fetchone()
    assert row is not None
    return int(row[0])


def log_rows(conn: psycopg.Connection, founders_list_id: int) -> list[tuple[str, dict[str, Any]]]:
    """This founder's delivery log, oldest first."""
    return [
        (row[0], row[1])
        for row in conn.execute(
            "select name, props from events"
            " where starts_with(name, 'whatsapp.') and props ->> 'founders_list_id' = %s"
            " order by id",
            (str(founders_list_id),),
        ).fetchall()
    ]


def mock_client(status: int = 200, body: Any = RECORDED_200) -> tuple[EvolutionClient, list[Any]]:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json=body)

    client = EvolutionClient(
        base_url="https://evolutiondev.example.invalid",
        api_key="not-a-real-key",
        instance="licitaqui-test",
        transport=httpx.MockTransport(handle),
    )
    return client, seen


# -- the guarantee ---------------------------------------------------------


def test_with_the_kill_switch_off_the_whole_job_runs_and_no_socket_is_opened(
    e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The one Sci needs: this is safe to merge because it cannot send anything.

    The database connection is already open when the guards go in, so the
    queries below still work while *any new* connection — by httpx, by urllib,
    by anything — raises. The job then runs end to end: gates, render, delivery
    log, `done`. Nothing leaves the process.
    """
    founder = insert_founder(e2_conn, "killswitch")
    whatsapp.enqueue(e2_conn, founder, "founders-welcome", numero_vaga=7)

    attempts: list[Any] = []

    def forbidden(*args: Any, **kwargs: Any) -> Any:
        attempts.append(args)
        raise AssertionError("a network connection was attempted with the kill switch off")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(httpx.Client, "send", forbidden)
    monkeypatch.setattr(httpx.Client, "request", forbidden)

    assert evolution.delivery_mode() == "dry_run"
    status = run_one(e2_conn, founder)

    assert status == "done"
    assert attempts == []
    assert [name for name, _ in log_rows(e2_conn, founder)] == ["whatsapp.dry_run"]


def run_one(conn: psycopg.Connection, founders_list_id: int) -> str:
    """Run this founder's queued job through the real consumer path.

    The row is looked up by key rather than claimed off the queue: the claim
    statement takes the highest-priority due job of that kind, which in a
    database shared with a concurrent run of this same suite may not be ours.
    Everything after the claim — registry lookup, `JobContext`, `mark_done` /
    `mark_failed` and the backoff — is the production path.
    """
    return _run(conn, whatsapp.JOB_KIND, whatsapp.job_key(founders_list_id))


def _run(conn: psycopg.Connection, kind: str, key: str) -> str:
    """Claim *this* row the way the queue would, then run it."""
    row = conn.execute(
        "update jobs set status = 'running', attempts = attempts + 1, updated_at = now()"
        " where kind = %s and key = %s"
        " returning id, kind, key, priority, payload, attempts",
        (kind, key),
    ).fetchone()
    assert row is not None, f"no job {kind} / {key}"
    job = Job(id=row[0], kind=row[1], key=row[2], priority=row[3], payload=row[4], attempts=row[5])
    return Consumer(lambda: _NullCtx(conn), name="e2-test").execute(conn, job)


class _NullCtx:
    """A connection factory that hands back the test's own connection."""

    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def __enter__(self) -> psycopg.Connection:
        return self._conn

    def __exit__(self, *exc: object) -> None:
        return None


# -- consent (§12) ---------------------------------------------------------


def test_a_founder_without_consent_is_never_messaged(e2_conn: psycopg.Connection) -> None:
    """LGPD §12: consent is mandatory before any contact."""
    founder = insert_founder(e2_conn, "noconsent", consent=False)
    client, seen = mock_client()

    delivery = whatsapp.send(
        e2_conn,
        founders_list_id=founder,
        template="founders-welcome",
        payload={"numero_vaga": 3},
        client=client,
    )

    assert delivery.outcome == "skipped"
    assert delivery.reason == whatsapp.SKIP_NO_CONSENT
    assert seen == [], "a message was built for someone who did not consent"
    assert log_rows(e2_conn, founder) == [
        (
            "whatsapp.skipped",
            {"founders_list_id": founder, "template": "founders-welcome", "reason": "no_consent"},
        ),
    ]


def test_refusing_for_lack_of_consent_does_not_retry(e2_conn: psycopg.Connection) -> None:
    """A refusal is a decision, not a transient failure: four retries change nothing."""
    founder = insert_founder(e2_conn, "noconsent-job", consent=False)
    whatsapp.enqueue(e2_conn, founder, "founders-welcome", numero_vaga=3)

    assert run_one(e2_conn, founder) == "done"

    status = e2_conn.execute(
        "select status from jobs where kind = %s and key = %s",
        (whatsapp.JOB_KIND, whatsapp.job_key(founder)),
    ).fetchone()
    assert status is not None and status[0] == "done"


def test_a_founder_with_no_number_is_skipped(e2_conn: psycopg.Connection) -> None:
    founder = insert_founder(e2_conn, "nonumber", number="")
    e2_conn.execute("update founders_list set whatsapp = null where id = %s", (founder,))

    delivery = whatsapp.send(
        e2_conn,
        founders_list_id=founder,
        template="founders-welcome",
        payload={"numero_vaga": 1},
    )

    assert delivery.reason == whatsapp.SKIP_NO_NUMBER


def test_an_unknown_founder_is_skipped_rather_than_crashing(
    e2_conn: psycopg.Connection,
) -> None:
    delivery = whatsapp.send(
        e2_conn, founders_list_id=-1, template="founders-welcome", payload={"numero_vaga": 1}
    )

    assert delivery.reason == whatsapp.SKIP_NO_RECIPIENT


# -- SAIR ------------------------------------------------------------------


def test_sair_stops_every_further_message(e2_conn: psycopg.Connection) -> None:
    """The whole point of the opt-out: after this, nothing more goes out."""
    founder = insert_founder(e2_conn, "sair")
    client, seen = mock_client()

    whatsapp.enqueue_inbound(e2_conn, text="SAIR", founders_list_id=founder, message_id="m1")
    assert run_inbound(e2_conn, founder, "m1") == "done"

    assert whatsapp.has_opted_out(e2_conn, founder)

    delivery = whatsapp.send(
        e2_conn,
        founders_list_id=founder,
        template="founders-welcome",
        payload={"numero_vaga": 9},
        client=client,
    )

    assert delivery.reason == whatsapp.SKIP_OPTED_OUT
    assert seen == []


def test_a_chatty_reply_does_not_unsubscribe_anybody(e2_conn: psycopg.Connection) -> None:
    founder = insert_founder(e2_conn, "chatty")
    whatsapp.enqueue_inbound(
        e2_conn,
        text="vou sair de viagem, mando o CNPJ depois",
        founders_list_id=founder,
        message_id="m2",
    )

    assert run_inbound(e2_conn, founder, "m2") == "done"
    assert not whatsapp.has_opted_out(e2_conn, founder)


def test_an_inbound_reply_is_matched_to_a_founder_by_number(
    e2_conn: psycopg.Connection,
) -> None:
    number = e2_whatsapp(77)
    founder = insert_founder(e2_conn, "bynumber", number=number)

    # Evolution reports the sender as bare digits, not as F1 stores it.
    assert whatsapp.resolve_number(e2_conn, number.replace("+", "").replace(" ", "")) == founder
    assert whatsapp.resolve_number(e2_conn, "5511900000000") is None


def test_the_queue_never_holds_a_phone_number(e2_conn: psycopg.Connection) -> None:
    """§12. The number is resolved at enqueue time so the `jobs` row is clean."""
    number = e2_whatsapp(78)
    founder = insert_founder(e2_conn, "nophone", number=number)

    whatsapp.enqueue_inbound(e2_conn, text="SAIR", number=number, message_id="m3")

    payload = e2_conn.execute(
        "select payload::text from jobs where kind = %s and starts_with(key, %s)",
        (whatsapp.INBOUND_JOB_KIND, f"inbound:{founder}:"),
    ).fetchone()
    assert payload is not None
    digits = "".join(ch for ch in number if ch.isdigit())
    assert digits not in payload[0]
    assert str(founder) in payload[0]


def test_a_reply_from_an_unknown_number_is_dropped(e2_conn: psycopg.Connection) -> None:
    """Nothing to unsubscribe, and no reason to put the number in the queue."""
    assert whatsapp.enqueue_inbound(e2_conn, text="SAIR", number="5511900000001") is None


def run_inbound(conn: psycopg.Connection, founders_list_id: int, message_id: str) -> str:
    return _run(conn, whatsapp.INBOUND_JOB_KIND, f"inbound:{founders_list_id}:{message_id}")


# -- delivery ---------------------------------------------------------------


def test_the_message_that_would_be_sent_is_the_approved_copy(
    e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With the switch on and a recorded response: exactly what reaches the wire.

    This is as close to a live send as E2 gets. No LicitaQui Evolution instance
    exists yet, so the only thing that has ever seen this request is
    `httpx.MockTransport`.
    """
    monkeypatch.setenv(DELIVERY_VAR, DELIVERY_SEND)
    founder = insert_founder(e2_conn, "wire")
    client, seen = mock_client()
    slept: list[float] = []

    delivery = whatsapp.send(
        e2_conn,
        founders_list_id=founder,
        template="founders-welcome",
        payload={"numero_vaga": 12},
        client=client,
        sleep=slept.append,
    )

    assert delivery.outcome == "sent"
    assert delivery.message_id == "3EB0F3C9A1B2C3D4E5F6"
    body = json.loads(seen[0].content)
    assert body["text"].startswith("Oi, Maria! Aqui é a LicitaQui.")
    # See test_templates: the denominator was dropped on 2026-09-24.
    assert "número 12" in body["text"]
    assert "de 48" not in body["text"]
    assert body["text"].endswith("Para não receber mais mensagens, responda SAIR.")
    assert seen[0].headers["user-agent"] == evolution.USER_AGENT

    names = [name for name, _ in log_rows(e2_conn, founder)]
    assert names == ["whatsapp.sent"]


def test_a_message_is_not_sent_twice(
    e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§7.2: a job can run twice. A founder must not be welcomed twice."""
    monkeypatch.setenv(DELIVERY_VAR, DELIVERY_SEND)
    founder = insert_founder(e2_conn, "twice")
    client, seen = mock_client()
    kwargs: dict[str, Any] = {
        "founders_list_id": founder,
        "template": "founders-welcome",
        "payload": {"numero_vaga": 4},
        "client": client,
        "sleep": lambda _s: None,
    }

    assert whatsapp.send(e2_conn, **kwargs).outcome == "sent"
    second = whatsapp.send(e2_conn, **kwargs)

    assert second.reason == whatsapp.SKIP_ALREADY_SENT
    assert len(seen) == 1


def test_pacing_is_consulted_before_a_real_send(
    e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§9: ≈ 1 message every 20–30 s, measured from the delivery log."""
    monkeypatch.setenv(DELIVERY_VAR, DELIVERY_SEND)
    first = insert_founder(e2_conn, "pace-a")
    second = insert_founder(e2_conn, "pace-b")
    client, _ = mock_client()
    slept: list[float] = []

    whatsapp.send(
        e2_conn,
        founders_list_id=first,
        template="founders-welcome",
        payload={"numero_vaga": 1},
        client=client,
        sleep=slept.append,
    )
    whatsapp.send(
        e2_conn,
        founders_list_id=second,
        template="founders-welcome",
        payload={"numero_vaga": 2},
        client=client,
        sleep=slept.append,
    )

    assert slept, "the second send did not wait"
    assert whatsapp.MIN_INTERVAL_SECONDS - 1 <= slept[-1] <= whatsapp.MAX_WAIT_SECONDS


def test_a_retryable_failure_goes_back_on_the_queue_with_a_backoff(
    e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(DELIVERY_VAR, DELIVERY_SEND)
    founder = insert_founder(e2_conn, "retry")
    client, _ = mock_client(503, body={"error": "upstream"})
    monkeypatch.setattr(whatsapp, "wait_for_slot", lambda *a, **k: 0.0)
    monkeypatch.setattr(whatsapp, "default_client", lambda: client)

    whatsapp.enqueue(e2_conn, founder, "founders-welcome", numero_vaga=5)
    status = run_one(e2_conn, founder)

    assert status == "queued"
    row = e2_conn.execute(
        "select status, run_after > now() + interval '1 minute', error from jobs"
        " where kind = %s and key = %s",
        (whatsapp.JOB_KIND, whatsapp.job_key(founder)),
    ).fetchone()
    assert row is not None
    assert row[0] == "queued" and row[1] is True
    assert [name for name, _ in log_rows(e2_conn, founder)] == ["whatsapp.failed"]


def test_a_permanent_failure_is_recorded_and_not_retried(
    e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§7.2: stop on 401/402/404. Forty minutes of retries will not fix a wrong key."""
    monkeypatch.setenv(DELIVERY_VAR, DELIVERY_SEND)
    founder = insert_founder(e2_conn, "permanent")
    client, _ = mock_client(401, body={"message": "unauthorized"})

    delivery = whatsapp.send(
        e2_conn,
        founders_list_id=founder,
        template="founders-welcome",
        payload={"numero_vaga": 6},
        client=client,
        sleep=lambda _s: None,
    )

    assert delivery.outcome == "failed"
    name, props = log_rows(e2_conn, founder)[0]
    assert name == "whatsapp.failed"
    assert props["reason"] == "unauthorised" and props["status"] == 401


# -- LGPD (§12) ------------------------------------------------------------


def test_the_delivery_log_carries_no_personal_data(
    e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Name, e-mail, number and the rendered body: none of them, anywhere."""
    monkeypatch.setenv(DELIVERY_VAR, DELIVERY_SEND)
    number = e2_whatsapp(91)
    email = e2_email("lgpd")
    founder = insert_founder(e2_conn, "lgpd", number=number)
    client, _ = mock_client()

    whatsapp.send(
        e2_conn,
        founders_list_id=founder,
        template="founders-welcome",
        payload={"numero_vaga": 8},
        client=client,
        sleep=lambda _s: None,
    )
    whatsapp.record_optout(e2_conn, founder)

    written = json.dumps(log_rows(e2_conn, founder), ensure_ascii=False)
    for secret in (
        FOUNDER_NAME,
        FOUNDER_NAME.split()[0],
        email,
        number,
        "".join(ch for ch in number if ch.isdigit()),
    ):
        assert secret not in written, f"{secret!r} reached the delivery log"
    assert "Aqui é a LicitaQui" not in written, "the rendered body reached the delivery log"


def test_the_delivery_log_still_answers_a_support_question(
    e2_conn: psycopg.Connection,
) -> None:
    """Debuggable without carrying personal data: that is the whole design."""
    founder = insert_founder(e2_conn, "support")
    whatsapp.enqueue(e2_conn, founder, "founders-welcome", numero_vaga=2)
    run_one(e2_conn, founder)

    name, props = log_rows(e2_conn, founder)[0]

    assert name == "whatsapp.dry_run"
    assert props["founders_list_id"] == founder
    assert props["template"] == "founders-welcome"
    assert props["job_id"] > 0
    assert props["attempt"] >= 1


# -- the contract with F1 --------------------------------------------------


def test_f1s_payload_is_consumed_exactly_as_written(e2_conn: psycopg.Connection) -> None:
    """The kind, key and payload `apps/web/lib/founders/signup.ts` writes.

    Written here as raw SQL in F1's own shape rather than through
    `whatsapp.enqueue`, so this fails if either side changes the contract.
    """
    founder = insert_founder(e2_conn, "contract")
    queue.enqueue(
        e2_conn,
        "send_whatsapp",
        f"founders:{founder}",
        priority=3,
        payload={
            "template": "founders-welcome",
            "founders_list_id": founder,
            "numero_vaga": 31,
            "posicao_espera": None,
        },
    )

    assert run_one(e2_conn, founder) == "done"
    assert [name for name, _ in log_rows(e2_conn, founder)] == ["whatsapp.dry_run"]


def test_the_waitlist_payload_also_runs(e2_conn: psycopg.Connection) -> None:
    founder = insert_founder(e2_conn, "waitlist")
    queue.enqueue(
        e2_conn,
        "send_whatsapp",
        f"founders:{founder}",
        priority=3,
        payload={
            "template": "founders-waitlist",
            "founders_list_id": founder,
            "numero_vaga": None,
            "posicao_espera": 51,
        },
    )

    assert run_one(e2_conn, founder) == "done"
    assert [name for name, _ in log_rows(e2_conn, founder)] == ["whatsapp.dry_run"]
