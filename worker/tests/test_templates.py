"""The template renderer (E0's copy, E2's renderer).

The behaviour these pin down is the one templates README §3 calls out: a
missing placeholder **raises**, and never renders an empty string or the raw
``{{…}}``. Everything else here exists to make that guarantee hard to lose.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from licitaqui import templates
from licitaqui.templates import MissingPlaceholder, TemplateError, TemplateNotApproved

REAL_TEMPLATES = templates.TEMPLATES_DIR

WELCOME_CONTEXT = {"nome": "Maria", "numero_vaga": 7, "data_abertura": "8 de outubro de 2026"}


def write(tmp_path: Path, channel: str, name: str, text: str) -> Path:
    directory = tmp_path / channel
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.md"
    path.write_text(text, encoding="utf-8")
    templates.cache_clear()
    return path


# -- E0's real files -------------------------------------------------------


def test_every_template_in_the_repository_parses() -> None:
    """The strict checks must hold for all of E0's copy, not just E2's two.

    A template that uses an undeclared placeholder, or declares one it stopped
    using, fails here — which is what keeps the front matter trustworthy as the
    list of things a caller has to supply.
    """
    files = sorted(p for p in REAL_TEMPLATES.rglob("*.md") if p.name != "README.md")
    assert len(files) >= 20, "templates went missing"
    for path in files:
        template = templates.load(path.parent.name, path.stem)
        assert template.id == path.stem


def test_founders_welcome_renders_the_approved_copy() -> None:
    text = templates.render("whatsapp", "founders-welcome", WELCOME_CONTEXT)

    assert text.startswith("Oi, Maria! Aqui é a LicitaQui.")
    assert "número 7 de 48" in text
    assert "no dia 8 de outubro de 2026" in text
    # Templates README §4: every conversation-opening message ends with it.
    assert text.endswith("Para não receber mais mensagens, responda SAIR.")
    assert "{{" not in text


@pytest.mark.parametrize("missing", ["nome", "numero_vaga", "data_abertura"])
def test_a_missing_placeholder_raises_rather_than_rendering_blank(missing: str) -> None:
    context = {k: v for k, v in WELCOME_CONTEXT.items() if k != missing}

    with pytest.raises(MissingPlaceholder) as caught:
        templates.render("whatsapp", "founders-welcome", context)

    assert caught.value.placeholder == missing


@pytest.mark.parametrize("value", [None, "", "   "])
def test_a_blank_value_is_a_missing_placeholder(value: object) -> None:
    """ "Oi, !" is a half-rendered message wearing a different disguise."""
    with pytest.raises(MissingPlaceholder):
        templates.render("whatsapp", "founders-welcome", {**WELCOME_CONTEXT, "nome": value})


def test_the_optout_confirmation_refuses_to_render_while_it_carries_a_todo() -> None:
    """Templates README §7: a `TODO(Sci):` is a question for Sci, not copy."""
    template = templates.load("whatsapp", "optout-confirmation")
    assert not template.ready_to_send

    with pytest.raises(TemplateNotApproved):
        template.render({"email_contato": "oi@licitaqui.com.br"})


def test_no_whatsapp_template_is_approved_yet() -> None:
    """A tripwire, not a requirement: E0's copy is draft until Sci signs it off.

    When this fails, the copy was approved — update the PR notes rather than
    the assertion's intent.
    """
    statuses = {
        path.stem: templates.load("whatsapp", path.stem).status
        for path in sorted((REAL_TEMPLATES / "whatsapp").glob("*.md"))
    }
    assert set(statuses.values()) == {"draft"}, statuses


# -- the format ------------------------------------------------------------


def test_body_is_preserved_byte_for_byte_between_the_blank_lines(tmp_path: Path) -> None:
    body = "---\nid: spacing\nplaceholders: []\n---\n\na\n\n\nb\n\n"
    write(tmp_path, "whatsapp", "spacing", body)

    template = templates.load("whatsapp", "spacing", root=tmp_path)

    assert template.body == "a\n\n\nb"


def test_an_inline_list_and_a_scalar_both_parse(tmp_path: Path) -> None:
    write(
        tmp_path,
        "email",
        "two",
        "---\nid: two\nchannel: email\nsubject: Oi {{nome}}\nplaceholders: [nome, valor]\n"
        "---\n\n{{valor}}\n",
    )

    template = templates.load("email", "two", root=tmp_path)

    assert template.placeholders == ("nome", "valor")
    assert template.subject == "Oi {{nome}}"


def test_a_conditional_block_is_kept_or_dropped(tmp_path: Path) -> None:
    write(
        tmp_path,
        "email",
        "flagged",
        "---\nid: flagged\nchannel: email\nplaceholders: []\nflags: [promo]\n---\n\n"
        "base[[se: promo]] extra[[/se]]\n",
    )
    template = templates.load("email", "flagged", root=tmp_path)

    assert template.render({"promo": True}) == "base extra"
    assert template.render({"promo": False}) == "base"
    with pytest.raises(MissingPlaceholder):
        template.render({})


def test_a_malformed_placeholder_is_an_error_not_text(tmp_path: Path) -> None:
    """`{{ nome }}` would otherwise be delivered verbatim to a founder."""
    write(tmp_path, "whatsapp", "typo", "---\nid: typo\nplaceholders: [nome]\n---\n\n{{ nome }}\n")

    with pytest.raises(TemplateError, match="would be delivered verbatim"):
        templates.load("whatsapp", "typo", root=tmp_path)


def test_an_undeclared_placeholder_fails_at_load(tmp_path: Path) -> None:
    write(tmp_path, "whatsapp", "drift", "---\nid: drift\nplaceholders: [nome]\n---\n\n{{outro}}\n")

    with pytest.raises(TemplateError, match="undeclared"):
        templates.load("whatsapp", "drift", root=tmp_path)


def test_a_declared_but_unused_placeholder_fails_at_load(tmp_path: Path) -> None:
    body = "---\nid: stale\nplaceholders: [nome, velho]\n---\n\n{{nome}}\n"
    write(tmp_path, "whatsapp", "stale", body)

    with pytest.raises(TemplateError, match="does not use"):
        templates.load("whatsapp", "stale", root=tmp_path)


def test_missing_front_matter_fails(tmp_path: Path) -> None:
    write(tmp_path, "whatsapp", "bare", "just a body\n")

    with pytest.raises(TemplateError, match="does not start with"):
        templates.load("whatsapp", "bare", root=tmp_path)


def test_a_template_id_cannot_traverse_out_of_its_channel(tmp_path: Path) -> None:
    """Template ids arrive in a job payload, so they are treated as input."""
    with pytest.raises(templates.TemplateNotFound):
        templates.load("whatsapp", "../email/founders-welcome", root=tmp_path)


def test_channel_mismatch_fails(tmp_path: Path) -> None:
    body = "---\nid: wrong\nchannel: email\nplaceholders: []\n---\n\nhi\n"
    write(tmp_path, "whatsapp", "wrong", body)

    with pytest.raises(TemplateError, match="declares channel"):
        templates.load("whatsapp", "wrong", root=tmp_path)
