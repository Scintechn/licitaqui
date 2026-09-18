"""`send_whatsapp`'s pure parts: the SAIR rule, the render context, the pacing.

The parts that need `founders_list` and the delivery log are in
`test_integration_whatsapp.py`. Nothing here touches the network or a database.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest

from licitaqui import whatsapp
from licitaqui.templates import MissingPlaceholder


class FakeCursor:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows
        self.statements: list[str] = []

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def execute(self, sql: str, params: Any = None) -> None:
        self.statements.append(sql)

    def fetchone(self) -> Any:
        return self._rows.pop(0) if self._rows else None


class FakeConn:
    """Just enough of a psycopg connection for the pacing queries."""

    def __init__(self, *rows: Any) -> None:
        self._rows = list(rows)

    def cursor(self) -> FakeCursor:
        return FakeCursor(self._rows)


# -- the SAIR rule ---------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "SAIR",
        "sair",
        " Sair ",
        "sair.",
        "SAIR!",
        "Sair!!!",
        "parar",
        "PARE",
        "stop",
        "cancelar",
        "descadastrar",
        "quero sair",
        "Não quero mais",
        "sair da lista",
    ],
)
def test_these_replies_are_opt_outs(text: str) -> None:
    assert whatsapp.is_optout_reply(text)


@pytest.mark.parametrize(
    "text",
    [
        "",
        "oi",
        "obrigado!",
        # The one that matters: a founder talking about their week, not leaving.
        "vou sair de viagem, mando o CNPJ depois",
        "não consigo sair da tela de cadastro",
        "quero saber mais",
        "pode parar de chover que eu agradeço",
    ],
)
def test_these_replies_are_not_opt_outs(text: str) -> None:
    """A false positive silently unsubscribes someone who asked a question."""
    assert not whatsapp.is_optout_reply(text)


def test_accents_and_punctuation_do_not_change_the_answer() -> None:
    assert whatsapp.normalise_reply("Não  quero   mais!!") == "nao quero mais"


# -- the render context ----------------------------------------------------


def test_format_date_pt() -> None:
    assert whatsapp.format_date_pt(date(2026, 10, 8)) == "8 de outubro de 2026"
    assert whatsapp.format_date_pt(date(2026, 3, 1)) == "1 de março de 2026"


def test_the_opening_date_can_be_moved_without_a_deploy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert whatsapp.opening_date() == whatsapp.DEFAULT_OPENING_DATE
    monkeypatch.setenv(whatsapp.OPENING_DATE_VAR, "2026-10-15")

    assert whatsapp.opening_date() == date(2026, 10, 15)


def test_the_welcome_renders_from_the_job_payload() -> None:
    """The payload is F1's, byte for byte (`apps/web/lib/founders/signup.ts`)."""
    from licitaqui import templates

    payload = {
        "template": "founders-welcome",
        "founders_list_id": 12,
        "numero_vaga": 7,
        "posicao_espera": None,
    }
    context = whatsapp.build_context(
        name="Maria Aparecida da Silva", payload=payload, template_id="founders-welcome"
    )

    text = templates.render("whatsapp", "founders-welcome", context)

    assert context["nome"] == "Maria"
    assert "número 7 de 48" in text


def test_the_waitlist_renders_from_the_job_payload() -> None:
    from licitaqui import templates

    payload = {"template": "founders-waitlist", "founders_list_id": 99, "posicao_espera": 3}
    context = whatsapp.build_context(name="João", payload=payload, template_id="founders-waitlist")

    assert "em 3º lugar" in templates.render("whatsapp", "founders-waitlist", context)


def test_a_payload_missing_the_seat_raises_rather_than_rendering_a_gap() -> None:
    """A welcome saying "número  de 48" is worse than a failed job."""
    from licitaqui import templates

    context = whatsapp.build_context(
        name="Maria", payload={"numero_vaga": None}, template_id="founders-welcome"
    )

    with pytest.raises(MissingPlaceholder) as caught:
        templates.render("whatsapp", "founders-welcome", context)

    assert caught.value.placeholder == "numero_vaga"


# -- pacing (§9: ≈ 1 message every 20–30 s) --------------------------------


def test_no_wait_when_nothing_has_been_sent() -> None:
    assert whatsapp.seconds_until_slot(FakeConn((None,)), interval=20.0) == 0.0


def test_the_wait_is_measured_from_the_last_recorded_send() -> None:
    """Measured from the delivery log, so it survives a restart or a second container."""
    now = datetime(2026, 9, 18, 12, 0, 0, tzinfo=UTC)
    conn = FakeConn((now - timedelta(seconds=8),))

    assert whatsapp.seconds_until_slot(conn, interval=20.0, now=now) == pytest.approx(12.0)


def test_no_wait_once_the_interval_has_passed() -> None:
    now = datetime(2026, 9, 18, 12, 0, 0, tzinfo=UTC)
    conn = FakeConn((now - timedelta(minutes=5),))

    assert whatsapp.seconds_until_slot(conn, interval=30.0, now=now) == 0.0


def test_wait_for_slot_sleeps_and_is_capped() -> None:
    """A clock skew between containers must not wedge a consumer thread."""
    slept: list[float] = []
    conn = FakeConn((datetime.now(UTC) + timedelta(hours=1),))

    waited = whatsapp.wait_for_slot(conn, sleep=slept.append, interval=20.0)

    assert waited == whatsapp.MAX_WAIT_SECONDS
    assert slept == [whatsapp.MAX_WAIT_SECONDS]


def test_the_interval_is_jittered_inside_the_spec_range() -> None:
    """A metronome is what a spam heuristic looks for (§9)."""
    conn_rows = datetime.now(UTC)
    waits = {
        round(whatsapp.wait_for_slot(FakeConn((conn_rows,)), sleep=lambda _s: None), 3)
        for _ in range(40)
    }

    assert len(waits) > 1, "the pacing interval is not jittered"
    assert min(waits) >= whatsapp.MIN_INTERVAL_SECONDS - 1
    assert max(waits) <= whatsapp.MAX_INTERVAL_SECONDS


def test_the_job_kind_matches_the_one_the_web_enqueues() -> None:
    """F1's `WELCOME_JOB_KIND` and key format. One contract, not two."""
    from licitaqui.handlers import registered_kinds

    assert whatsapp.JOB_KIND == "send_whatsapp"
    assert whatsapp.job_key(12) == "founders:12"
    assert "send_whatsapp" in registered_kinds()
    assert "whatsapp_inbound" in registered_kinds()
