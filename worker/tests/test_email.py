"""`send_email`'s pure parts: the context, the render pipeline, the keys.

The parts that need `founders_list` and the delivery log are in
`test_integration_email.py`. Nothing here touches the network or a database.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from licitaqui import email, templates
from licitaqui.templates import TemplateNotApproved


class FakeCursor:
    """Mirrors `test_whatsapp.py`'s own — just enough of a psycopg cursor to
    drive `send()`'s gates without a database."""

    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def execute(self, sql: str, params: Any = None) -> None:
        return None

    def fetchone(self) -> Any:
        return self._rows.pop(0) if self._rows else None


class FakeConn:
    def __init__(self, *rows: Any) -> None:
        self._rows = list(rows)

    def cursor(self) -> FakeCursor:
        return FakeCursor(self._rows)


def write(tmp_path: Path, channel: str, name: str, text: str) -> Path:
    directory = tmp_path / channel
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.md"
    path.write_text(text, encoding="utf-8")
    templates.cache_clear()
    return path


# -- the render context -------------------------------------------------------


def test_the_welcome_context_reuses_whatsapp_and_adds_email_contato() -> None:
    payload = {"template": "founders-welcome", "founders_list_id": 12, "numero_vaga": 7}

    context = email.build_context(
        name="Maria Aparecida da Silva", payload=payload, template_id="founders-welcome"
    )

    assert context["nome"] == "Maria"
    assert context["numero_vaga"] == 7
    assert context["data_abertura"]  # whatsapp.opening_date(), formatted pt-BR
    assert context["email_contato"] == email.CONTACT_EMAIL


def test_the_waitlist_context() -> None:
    context = email.build_context(
        name="Maria Silva", payload={"posicao_espera": 3}, template_id="founders-waitlist"
    )

    assert context["posicao_espera"] == 3
    assert context["email_contato"] == email.CONTACT_EMAIL
    assert "numero_vaga" not in context


def test_the_opening_context_carries_the_access_link() -> None:
    context = email.build_context(
        name="Maria Silva", payload={"numero_vaga": 5}, template_id="founders-opening"
    )

    assert context["numero_vaga"] == 5
    assert context["link_acesso"]
    assert context["email_contato"] == email.CONTACT_EMAIL


def test_the_opening_link_is_the_same_fact_on_both_channels() -> None:
    """E5 and E6 must not quietly disagree about where `{{link_acesso}}` points."""
    from licitaqui import whatsapp

    assert (
        email.build_context(name="A", payload={}, template_id="founders-opening")["link_acesso"]
        == whatsapp.opening_link()
    )


# -- render_email: subject, body, footer --------------------------------------


def test_render_email_appends_every_declared_partial_in_order(tmp_path: Path) -> None:
    write(
        tmp_path,
        "email",
        "greet",
        "---\nid: greet\nchannel: email\nsubject: 'Oi, {{nome}}'\nplaceholders: [nome]\n"
        "partials: [partial-a, partial-b]\n---\n\ncorpo\n",
    )
    write(
        tmp_path,
        "email",
        "partial-a",
        "---\nid: partial-a\nchannel: email\nplaceholders: []\n---\n\nrodape a\n",
    )
    write(
        tmp_path,
        "email",
        "partial-b",
        "---\nid: partial-b\nchannel: email\nplaceholders: []\n---\n\nrodape b\n",
    )

    subject, body = _render_with_root("greet", {"nome": "Maria"}, tmp_path)

    assert subject == "Oi, Maria"
    assert body == "corpo\n\nrodape a\n\nrodape b"


def _render_with_root(template_id: str, context: dict, root: Path) -> tuple[str, str]:
    """`render_email` always loads from `templates.TEMPLATES_DIR`, the same
    way `whatsapp.send` and `telegram_alerts.send` do — no test-only `root`
    parameter on the production path. So this borrows the technique
    `test_selfcheck.py` already uses: point the module-level directory at a
    tmp tree for the duration of one call.
    """
    original = templates.TEMPLATES_DIR
    templates.TEMPLATES_DIR = root  # type: ignore[misc]
    templates.cache_clear()
    try:
        return email.render_email(template_id, context)
    finally:
        templates.TEMPLATES_DIR = original  # type: ignore[misc]
        templates.cache_clear()


def test_render_email_raises_when_a_partial_cannot_render(tmp_path: Path) -> None:
    write(
        tmp_path,
        "email",
        "greet",
        "---\nid: greet\nchannel: email\nsubject: 'Oi'\nplaceholders: []\n"
        "partials: [partial-blocked]\n---\n\ncorpo\n",
    )
    write(
        tmp_path,
        "email",
        "partial-blocked",
        "---\nid: partial-blocked\nchannel: email\nplaceholders: []\n---\n\n"
        "TODO(Sci): decidir o rodapé.\n",
    )

    with pytest.raises(TemplateNotApproved):
        _render_with_root("greet", {}, tmp_path)


def test_render_email_raises_when_the_main_body_cannot_render(tmp_path: Path) -> None:
    write(
        tmp_path,
        "email",
        "blocked",
        "---\nid: blocked\nchannel: email\nsubject: 'Oi'\nplaceholders: []\n---\n\n"
        "TODO(Sci): ainda não decidi o texto.\n",
    )

    with pytest.raises(TemplateNotApproved):
        _render_with_root("blocked", {}, tmp_path)


# -- what actually blocks the three real templates today ----------------------


@pytest.mark.parametrize(
    ("template_id", "payload"),
    [
        ("founders-welcome", {"numero_vaga": 1}),
        ("founders-waitlist", {"posicao_espera": 2}),
        ("founders-opening", {"numero_vaga": 1}),
    ],
)
def test_every_real_founders_email_is_blocked_by_the_unapproved_footer(
    template_id: str, payload: dict
) -> None:
    """The E6 tripwire, from `email.py`'s own render path rather than
    `templates.py` directly — this is the call `send()` actually makes."""
    context = email.build_context(name="Maria Silva", payload=payload, template_id=template_id)

    with pytest.raises(TemplateNotApproved):
        email.render_email(template_id, context)


# -- keys -----------------------------------------------------------------


def test_job_key_is_identical_in_shape_to_whatsapps() -> None:
    from licitaqui import whatsapp

    assert email.job_key(12) == whatsapp.job_key(12) == "founders:12"


# -- gates, purely (SKIP_NO_EMAIL cannot exist against the real schema:
# `founders_list.email` is `citext not null`, so there is no row for an
# integration test to read) --------------------------------------------------


def test_no_recipient_is_skipped() -> None:
    delivery = email.send(
        FakeConn(None), founders_list_id=999, template="founders-welcome", payload={}
    )

    assert delivery.outcome == "skipped"
    assert delivery.reason == email.SKIP_NO_RECIPIENT


def test_no_consent_is_skipped_before_anything_is_rendered() -> None:
    # (name, email, contact_consent)
    delivery = email.send(
        FakeConn(("Maria", "maria@example.com", False)),
        founders_list_id=1,
        template="founders-welcome",
        payload={},
    )

    assert delivery.reason == email.SKIP_NO_CONSENT


def test_no_email_is_skipped() -> None:
    """Defence in depth: `founders_list.email` is `not null`, so this row
    shape cannot exist through the application — only a stub proves the gate
    still holds if that ever changes."""
    delivery = email.send(
        FakeConn(("Maria", None, True)),
        founders_list_id=1,
        template="founders-welcome",
        payload={},
    )

    assert delivery.reason == email.SKIP_NO_EMAIL


def test_already_sent_is_skipped() -> None:
    # (name, email, contact_consent), then the already-sent existence check.
    delivery = email.send(
        FakeConn(("Maria", "maria@example.com", True), (True,)),
        founders_list_id=1,
        template="founders-welcome",
        payload={},
    )

    assert delivery.reason == email.SKIP_ALREADY_SENT
