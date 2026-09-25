"""`send_email` against real `founders_list` rows and a real delivery log.

These run on ``TEST_DATABASE_URL_E2`` — the same database `test_integration_
whatsapp.py` uses (see `conftest.py`'s "E2: founders sends" section) — and skip
without it. **Resend is never called:** the kill switch is off for the whole
suite (`_email_delivery_off` in `conftest.py`), and the two tests that turn it
on are bolted to an `httpx.MockTransport`.

Every founder written here is waitlisted (`seat is null`) and carries this
run's id in its e-mail, the same reasoning `test_integration_whatsapp.py`'s
own module docstring gives.
"""

from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest

from licitaqui import breaker, email, queue, resend, templates
from licitaqui.consumer import Consumer
from licitaqui.queue import Job
from licitaqui.resend import DELIVERY_SEND, DELIVERY_VAR, ResendClient
from licitaqui.templates import TemplateNotApproved
from tests.conftest import e2_email, e2_whatsapp

FIXTURES = Path(__file__).parent / "fixtures" / "resend"
RECORDED_200 = json.loads((FIXTURES / "send_200.json").read_text())

FOUNDER_NAME = "Maria Aparecida Zzyzx"


@pytest.fixture(autouse=True)
def _fresh_breaker() -> None:
    breaker.reset_all()


@pytest.fixture
def synthetic_templates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A stand-in `founders-welcome` + `partial-footer`, footer-TODO-free.

    The real files are blocked (E6's own reported gap: `partial-footer.md` is
    `status: draft` with a `TODO(Sci):` in its body). This is what proves the
    gates → render → send → delivery-log pipeline actually works, ahead of
    that copy landing — the same technique `tests/test_selfcheck.py` already
    uses to point `templates.TEMPLATES_DIR` at a temporary tree.
    """
    email_dir = tmp_path / "email"
    email_dir.mkdir()
    (email_dir / "founders-welcome.md").write_text(
        "---\n"
        "id: founders-welcome\n"
        "channel: email\n"
        'subject: "Sua vaga de fundador é a numero {{numero_vaga}}"\n'
        "status: approved\n"
        "placeholders: [nome, numero_vaga, data_abertura, email_contato]\n"
        "partials: [partial-footer]\n"
        "---\n\n"
        "Oi, {{nome}}. Vaga {{numero_vaga}}. Abertura em {{data_abertura}}. "
        "Fale: {{email_contato}}\n",
        encoding="utf-8",
    )
    (email_dir / "partial-footer.md").write_text(
        "---\nid: partial-footer\nchannel: email\nstatus: approved\n"
        "placeholders: [email_contato]\n---\n\nRodape: {{email_contato}}\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(templates, "TEMPLATES_DIR", tmp_path)
    templates.cache_clear()
    yield
    templates.cache_clear()


def insert_founder(
    conn: psycopg.Connection,
    label: str,
    *,
    consent: bool = True,
    address: str | None = None,
    name: str = FOUNDER_NAME,
) -> int:
    """One waitlisted founder. Returns the id. See the module docstring on seats."""
    row = conn.execute(
        "insert into founders_list (name, email, whatsapp, contact_consent, seat)"
        " values (%s, %s, %s, %s, null) returning id",
        (
            name,
            address or e2_email(label),
            e2_whatsapp(abs(hash(label)) % 1000),
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
            " where starts_with(name, 'email.') and props ->> 'founders_list_id' = %s"
            " order by id",
            (str(founders_list_id),),
        ).fetchall()
    ]


def mock_client(status: int = 200, body: Any = RECORDED_200) -> tuple[ResendClient, list[Any]]:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json=body)

    client = ResendClient(
        api_key="not-a-real-key",
        from_address="LicitaQui <founders@licitaquiapp.com.br>",
        transport=httpx.MockTransport(handle),
    )
    return client, seen


def run_one(conn: psycopg.Connection, founders_list_id: int) -> str:
    return _run(conn, email.JOB_KIND, email.job_key(founders_list_id))


def _run(conn: psycopg.Connection, kind: str, key: str) -> str:
    """Claim *this* row the way the queue would, then run it. Mirrors
    `test_integration_whatsapp.py`'s own helper of the same name."""
    row = conn.execute(
        "update jobs set status = 'running', attempts = attempts + 1, updated_at = now()"
        " where kind = %s and key = %s"
        " returning id, kind, key, priority, payload, attempts",
        (kind, key),
    ).fetchone()
    assert row is not None, f"no job {kind} / {key}"
    job = Job(id=row[0], kind=row[1], key=row[2], priority=row[3], payload=row[4], attempts=row[5])
    return Consumer(lambda: _NullCtx(conn), name="e2-email-test").execute(conn, job)


class _NullCtx:
    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def __enter__(self) -> psycopg.Connection:
        return self._conn

    def __exit__(self, *exc: object) -> None:
        return None


# -- the guarantee, with copy that exists ------------------------------------


def test_with_the_kill_switch_off_the_whole_job_runs_and_no_socket_is_opened(
    synthetic_templates: None, e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The one Sci needs: this is safe to merge because it cannot send anything.

    Uses `synthetic_templates` rather than the real files: the real ones are
    blocked by the unapproved footer (see below), and *that* is exactly the
    thing this suite must not depend on being fixed to prove the pipeline
    itself works.
    """
    founder = insert_founder(e2_conn, "killswitch")
    email.enqueue(e2_conn, founder, "founders-welcome", numero_vaga=7)

    attempts: list[Any] = []

    def forbidden(*args: Any, **kwargs: Any) -> Any:
        attempts.append(args)
        raise AssertionError("a network connection was attempted with the kill switch off")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(httpx.Client, "send", forbidden)
    monkeypatch.setattr(httpx.Client, "request", forbidden)

    assert resend.delivery_mode() == "dry_run"
    status = run_one(e2_conn, founder)

    assert status == "done"
    assert attempts == []
    assert [name for name, _ in log_rows(e2_conn, founder)] == ["email.dry_run"]


def test_the_message_that_would_be_sent_is_the_synthetic_copy(
    synthetic_templates: None, e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With the switch on and a recorded response: exactly what reaches the wire."""
    monkeypatch.setenv(DELIVERY_VAR, DELIVERY_SEND)
    founder = insert_founder(e2_conn, "wire")
    client, seen = mock_client()

    delivery = email.send(
        e2_conn,
        founders_list_id=founder,
        template="founders-welcome",
        payload={"numero_vaga": 12},
        client=client,
    )

    assert delivery.outcome == "sent"
    assert delivery.message_id == "re_1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"
    body = json.loads(seen[0].content)
    assert body["to"] == [e2_email("wire")]
    assert "numero 12" in body["subject"]
    assert body["text"].startswith("Oi, Maria.")
    assert "Rodape:" in body["text"]  # the footer partial is appended

    assert [name for name, _ in log_rows(e2_conn, founder)] == ["email.sent"]


def test_a_message_is_not_sent_twice(
    synthetic_templates: None, e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(DELIVERY_VAR, DELIVERY_SEND)
    founder = insert_founder(e2_conn, "twice")
    client, seen = mock_client()
    kwargs: dict[str, Any] = {
        "founders_list_id": founder,
        "template": "founders-welcome",
        "payload": {"numero_vaga": 4},
        "client": client,
    }

    assert email.send(e2_conn, **kwargs).outcome == "sent"
    second = email.send(e2_conn, **kwargs)

    assert second.reason == email.SKIP_ALREADY_SENT
    assert len(seen) == 1


def test_a_retryable_failure_goes_back_on_the_queue_with_a_backoff(
    synthetic_templates: None, e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(DELIVERY_VAR, DELIVERY_SEND)
    founder = insert_founder(e2_conn, "retry")
    client, _ = mock_client(503, body={"message": "upstream"})
    monkeypatch.setattr(email, "default_client", lambda: client)

    email.enqueue(e2_conn, founder, "founders-welcome", numero_vaga=5)
    status = run_one(e2_conn, founder)

    assert status == "queued"
    row = e2_conn.execute(
        "select status, run_after > now() + interval '1 minute' from jobs"
        " where kind = %s and key = %s",
        (email.JOB_KIND, email.job_key(founder)),
    ).fetchone()
    assert row is not None
    assert row[0] == "queued" and row[1] is True
    assert [name for name, _ in log_rows(e2_conn, founder)] == ["email.failed"]


def test_a_permanent_failure_is_recorded_and_not_retried(
    synthetic_templates: None, e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(DELIVERY_VAR, DELIVERY_SEND)
    founder = insert_founder(e2_conn, "permanent")
    client, _ = mock_client(401, body={"message": "unauthorized"})

    delivery = email.send(
        e2_conn,
        founders_list_id=founder,
        template="founders-welcome",
        payload={"numero_vaga": 6},
        client=client,
    )

    assert delivery.outcome == "failed"
    name, props = log_rows(e2_conn, founder)[0]
    assert name == "email.failed"
    assert props["reason"] == "unauthorised" and props["status"] == 401


# -- gates --------------------------------------------------------------------


def test_a_founder_without_consent_is_never_messaged(e2_conn: psycopg.Connection) -> None:
    founder = insert_founder(e2_conn, "noconsent", consent=False)
    client, seen = mock_client()

    delivery = email.send(
        e2_conn,
        founders_list_id=founder,
        template="founders-welcome",
        payload={"numero_vaga": 3},
        client=client,
    )

    assert delivery.reason == email.SKIP_NO_CONSENT
    assert seen == [], "a message was built for someone who did not consent"


#: `founders_list.email` is `citext not null`, so a *real* no-email row cannot
#: exist without altering the schema — not something a test in a database
#: other suites share should ever do, even temporarily. `SKIP_NO_EMAIL` is
#: defence in depth against exactly that column ever changing; it is tested
#: purely, with a stub connection, in `test_email.py`.


def test_an_unknown_founder_is_skipped_rather_than_crashing(e2_conn: psycopg.Connection) -> None:
    delivery = email.send(
        e2_conn, founders_list_id=-1, template="founders-welcome", payload={"numero_vaga": 1}
    )

    assert delivery.reason == email.SKIP_NO_RECIPIENT


# -- what actually blocks a real send today (E6) -----------------------------


def test_the_real_founders_welcome_email_fails_loudly_rather_than_skipping_silently(
    e2_conn: psycopg.Connection,
) -> None:
    """The E6 tripwire, from the job's own path (mirrors `whatsapp.send()`'s
    reasoning for a template fault: "it is our bug, not the recipient's, and
    it should be a visible failed job rather than a silently skipped
    founder"). No delivery-log row is written — the raise happens before any
    `_record` call, exactly where `send()`'s docstring says it does.
    """
    founder = insert_founder(e2_conn, "blocked")
    email.enqueue(e2_conn, founder, "founders-welcome", numero_vaga=1)

    status = run_one(e2_conn, founder)

    assert status == "queued", "a template fault must not be a silent 'done'"
    error = e2_conn.execute(
        "select error from jobs where kind = %s and key = %s",
        (email.JOB_KIND, email.job_key(founder)),
    ).fetchone()
    assert error is not None and "TemplateNotApproved" in error[0]
    assert log_rows(e2_conn, founder) == []


def test_render_email_raises_directly_against_the_real_footer(e2_conn: psycopg.Connection) -> None:
    """Same fact, asserted without going through the queue at all."""
    founder = insert_founder(e2_conn, "blocked-direct")
    context = email.build_context(
        name=FOUNDER_NAME, payload={"numero_vaga": 1}, template_id="founders-welcome"
    )

    with pytest.raises(TemplateNotApproved):
        email.render_email("founders-welcome", context)

    assert log_rows(e2_conn, founder) == []


# -- LGPD (§12) ---------------------------------------------------------------


def test_the_delivery_log_carries_no_personal_data(
    synthetic_templates: None, e2_conn: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(DELIVERY_VAR, DELIVERY_SEND)
    address = e2_email("lgpd")
    founder = insert_founder(e2_conn, "lgpd", address=address)
    client, _ = mock_client()

    email.send(
        e2_conn,
        founders_list_id=founder,
        template="founders-welcome",
        payload={"numero_vaga": 8},
        client=client,
    )

    written = json.dumps(log_rows(e2_conn, founder), ensure_ascii=False)
    for secret in (FOUNDER_NAME, FOUNDER_NAME.split()[0], address):
        assert secret not in written, f"{secret!r} reached the delivery log"
    assert "Oi, Maria" not in written, "the rendered body reached the delivery log"


# -- the contract with F1 ------------------------------------------------------


def test_f1s_payload_is_consumed_exactly_as_written(
    synthetic_templates: None, e2_conn: psycopg.Connection
) -> None:
    """The kind, key and payload F1 (`apps/web/lib/founders/signup.ts`) is
    expected to write, once it enqueues `send_email` beside `send_whatsapp`.

    Written as raw SQL in F1's own shape rather than through `email.enqueue`,
    so this fails if either side changes the contract — the same reasoning
    `test_integration_whatsapp.py`'s own version of this test gives.
    """
    founder = insert_founder(e2_conn, "contract")
    queue.enqueue(
        e2_conn,
        "send_email",
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
    assert [name for name, _ in log_rows(e2_conn, founder)] == ["email.dry_run"]


def test_send_whatsapp_and_send_email_share_a_key_without_colliding(
    synthetic_templates: None, e2_conn: psycopg.Connection
) -> None:
    """The two kinds F1 will enqueue in the same statement, under the same
    `founders:<id>` key — `jobs_dedupe` is unique on (kind, key), so this
    must hold for both to ever coexist."""
    from licitaqui import whatsapp

    founder = insert_founder(e2_conn, "shared-key")
    whatsapp.enqueue(e2_conn, founder, "founders-welcome", numero_vaga=1)
    email.enqueue(e2_conn, founder, "founders-welcome", numero_vaga=1)

    kinds = {
        row[0]
        for row in e2_conn.execute(
            "select kind from jobs where key = %s", (f"founders:{founder}",)
        ).fetchall()
    }
    assert kinds == {"send_whatsapp", "send_email"}
