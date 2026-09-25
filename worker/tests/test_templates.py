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
    # The denominator went on 2026-09-24 (Sci): the seat is the receipt, but
    # "1 de 48" on an empty list advertises that nobody else has signed up.
    # Asserting its absence too, so the two halves cannot drift apart —
    # `founders.confirmation.seat` on the page says the same thing.
    assert "número 7" in text
    assert "de 48" not in text
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


# -- optional rows: the blank-value trap -----------------------------------
#
# These two files carry rows that are absent for most tenders — the ME/EPP
# marker, and the estimated value PNCP is entitled to withhold
# (`tenders.confidential_budget`). The tempting shape is a placeholder the
# caller sets to `""`, and it does not work: a blank value is a
# `MissingPlaceholder` by design (README §3), so the digest would have raised
# on the first tender without a marker. The rows are `[[se: …]]` blocks
# instead, and conditionals resolve *before* substitution, so the caller passes
# nothing at all when the row is off.


def test_the_digest_item_drops_the_me_epp_line_without_passing_a_blank() -> None:
    context = {
        "objeto": "Pilhas AA",
        "orgao": "Prefeitura de Campinas",
        "uf": "SP",
        "modalidade": "Pregão eletrônico",
        "prazo_proposta": "30/09/2026 às 08:30",
        "link_edital": "https://licitaquiapp.com.br/e/1",
    }

    without = templates.render("telegram", "partial-digest-item", context, tem_meepp=False)
    assert "ME/EPP" not in without
    # The line is gone, not blanked: no empty line opens up where it was.
    assert "\n\n" not in without
    assert without.splitlines()[-1].startswith("Ler o edital:")

    with_marker = templates.render(
        "telegram",
        "partial-digest-item",
        context,
        tem_meepp=True,
        marcador_meepp="Item exclusivo para ME/EPP",
    )
    assert "\nItem exclusivo para ME/EPP\nLer o edital:" in with_marker


def test_a_blank_marker_still_raises_when_the_flag_is_on() -> None:
    """The guard is the flag, not a licence to pass empty strings."""
    context = {
        "objeto": "Pilhas AA",
        "orgao": "Prefeitura de Campinas",
        "uf": "SP",
        "modalidade": "Pregão eletrônico",
        "prazo_proposta": "30/09/2026 às 08:30",
        "link_edital": "https://licitaquiapp.com.br/e/1",
        "marcador_meepp": "   ",
    }
    with pytest.raises(MissingPlaceholder):
        templates.render("telegram", "partial-digest-item", context, tem_meepp=True)


ALERT_CONTEXT = {
    "nome": "Sci",
    "objeto": "Registro de preços de baterias e pilhas",
    "orgao": "Prefeitura de Campinas",
    "cidade_uf": "Campinas/SP",
    "modalidade": "Pregão eletrônico",
    "prazo_proposta": "30/09/2026 às 08:30",
    "link_edital": "https://licitaquiapp.com.br/radar/edital/123",
}


@pytest.mark.parametrize("tem_valor", [True, False])
@pytest.mark.parametrize("tem_meepp", [True, False])
def test_the_tender_alert_renders_every_combination_of_its_optional_rows(
    tem_valor: bool, tem_meepp: bool
) -> None:
    context = dict(ALERT_CONTEXT)
    if tem_valor:
        context["valor_estimado"] = "R$ 48.196,00"
    if tem_meepp:
        context["marcador_meepp"] = "Item exclusivo para ME/EPP"

    text = templates.render(
        "whatsapp", "tender-alert", context, tem_valor=tem_valor, tem_meepp=tem_meepp
    )

    assert ("Valor estimado" in text) is tem_valor
    assert ("ME/EPP" in text) is tem_meepp
    # A withheld budget must not leave a hole in the block of facts.
    assert "\n\n📅" not in text
    # §4: every WhatsApp message that starts a conversation carries the opt-out.
    assert text.endswith("Para não receber mais mensagens, responda SAIR.")


# -- render_subject (E6: nothing rendered a subject before this task) ------


def test_render_subject_fills_placeholders(tmp_path: Path) -> None:
    write(
        tmp_path,
        "email",
        "greet",
        "---\nid: greet\nchannel: email\nsubject: 'Oi, {{nome}}!'\nplaceholders: [nome]\n"
        "---\n\ncorpo\n",
    )

    template = templates.load("email", "greet", root=tmp_path)

    assert template.render_subject({"nome": "Maria"}) == "Oi, Maria!"


def test_render_subject_raises_on_a_missing_placeholder(tmp_path: Path) -> None:
    write(
        tmp_path,
        "email",
        "greet2",
        "---\nid: greet2\nchannel: email\nsubject: 'Oi, {{nome}}!'\nplaceholders: [nome]\n"
        "---\n\ncorpo\n",
    )
    template = templates.load("email", "greet2", root=tmp_path)

    with pytest.raises(MissingPlaceholder):
        template.render_subject({})


def test_render_subject_raises_when_the_template_has_no_subject(tmp_path: Path) -> None:
    write(tmp_path, "whatsapp", "nosubj", "---\nid: nosubj\nplaceholders: []\n---\n\ncorpo\n")
    template = templates.load("whatsapp", "nosubj", root=tmp_path)

    with pytest.raises(TemplateError, match="no subject"):
        template.render_subject({})


def test_render_subject_refuses_a_todo_the_same_as_the_body(tmp_path: Path) -> None:
    """README §7's rule applies to the subject line too, not only the body."""
    write(
        tmp_path,
        "email",
        "open-question",
        "---\nid: open-question\nchannel: email\nsubject: 'Oi, {{nome}}'\nplaceholders: [nome]\n"
        "---\n\ncorpo\n\nTODO(Sci): decidir o assunto de verdade.\n",
    )
    template = templates.load("email", "open-question", root=tmp_path)

    with pytest.raises(TemplateNotApproved):
        template.render_subject({"nome": "Maria"})


# -- the founders e-mail trio (E6): what actually blocks a real send -------
#
# `worker/licitaqui/email.py` is the caller that proves these two facts in
# context (real `founders_list` rows, the delivery log); these two pin the
# facts themselves, directly against the real files, so a change to either
# template's front matter is caught here even by someone who never opens
# `email.py`.


@pytest.mark.parametrize(
    "template_id", ["founders-welcome", "founders-waitlist", "founders-opening"]
)
def test_every_founders_email_declares_the_footer_partial(template_id: str) -> None:
    template = templates.load("email", template_id)
    assert "partial-footer" in template.partials


def test_the_footer_still_carries_the_todo_that_blocks_every_founders_email() -> None:
    """The tripwire for E6's one open blocker (docs/CLAIMS.md).

    When this fails, Sci has written the footer — update the PR notes rather
    than the assertion's intent, the same instruction `test_no_whatsapp_
    template_is_approved_yet` carries above.
    """
    footer = templates.load("email", "partial-footer")
    assert not footer.ready_to_send
    with pytest.raises(TemplateNotApproved):
        footer.render({})


def test_the_founders_opening_email_renders_now_that_the_price_is_decided() -> None:
    """This template's own blocker — the price question — was answered by Sci on
    2026-09-25, so the tripwire that stood here fired and is inverted.

    The question it held open was whether 08/10 is free or paid. It is paid:
    the founder receives the subscription link, joins Essencial at the
    promotional price and pays. That decision is what removed the TODO, so
    this test now guards the thing the decision bought — an opening e-mail
    that can actually render on the night.
    """
    template = templates.load("email", "founders-opening")
    assert template.ready_to_send, "a TODO(Sci): came back and blocks the 08/10 opening e-mail"
    assert "TODO(Sci):" not in template.body
