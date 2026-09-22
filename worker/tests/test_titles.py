"""The two branches, the predicate that chooses between them, and the validator.

The cases here are not invented: every one of them is either a production
objeto or a title the screening model actually produced during the 50-tender
design measurement and the 150-tender sample that followed it. The three
fabrication cases are also regression fixtures in `worker/evaluation`; they are
duplicated here so a change to `titles.py` fails in the free, offline suite too,
without waiting for a paid evaluation run.
"""

from __future__ import annotations

import pytest

from licitaqui import titles

# -- The deterministic branch ---------------------------------------------


@pytest.mark.parametrize(
    ("objeto", "expected"),
    [
        # Sci's two examples of an objeto that already is the title.
        (
            "Aquisição de Equipamentos e materiais de roçagem",
            "Aquisição de Equipamentos e materiais de roçagem",
        ),
        (
            "Serviço de manutenção da usina fotovoltaica da CRO/12",
            "Serviço de manutenção da usina fotovoltaica da CRO/12",
        ),
        # The portal prefix: 633 production rows carry one.
        (
            "[Portal de Compras Públicas] - Aquisição de cadeiras de rodas",
            "Aquisição de cadeiras de rodas",
        ),
        ("[LICITANET] - Aquisição de medicamentos", "Aquisição de medicamentos"),
        # The legal tail, in several of the forms the corpus writes it.
        (
            "Aquisição de material odontológico, conforme descrito no Anexo I",
            "Aquisição de material odontológico",
        ),
        (
            "Aquisição de uniformes destinados ao atendimento das necessidades da rede municipal",
            "Aquisição de uniformes",
        ),
        (
            "Compra de merenda escolar para a Secretaria Municipal de Educação",
            "Compra de merenda escolar",
        ),
        (
            "Reforma da praça central – ANEXO I – Termo de Referência",
            "Reforma da praça central",
        ),
        # The trailing full stop the agency typed.
        (
            "Contratação para locação de escoras metálicas.",
            "Contratação para locação de escoras metálicas",
        ),
    ],
)
def test_the_free_branch_cuts_the_objeto_down(objeto: str, expected: str) -> None:
    assert titles.deterministic_title(objeto) == expected


def test_the_free_branch_never_invents() -> None:
    """Every character it returns came from the objeto — that is its whole point."""
    objeto = "AQUISIÇÃO DE MATERIAIS DE LIMPEZA, conforme Anexo I"
    result = titles.deterministic_title(objeto)
    assert set(titles._tokens(result)) <= set(titles._tokens(objeto))


def test_an_empty_objeto_gives_an_empty_title() -> None:
    assert titles.deterministic_title("") == ""
    assert titles.deterministic_title("   ") == ""


def test_a_connector_at_the_very_start_is_not_a_cut() -> None:
    """Cutting at position 0 would leave nothing at all."""
    assert titles.deterministic_title("Conforme ETP e TR") == "Conforme ETP e TR"


# -- De-shouting ----------------------------------------------------------


@pytest.mark.parametrize(
    ("objeto", "expected"),
    [
        # A shouted objeto comes back as prose, and the one-letter conjunction
        # comes down with it — `format.ts` leaves it as "médicos E bens".
        (
            "AQUISIÇÃO DE EQUIPAMENTOS MÉDICOS E BENS PERMANENTES",
            "Aquisição de equipamentos médicos e bens permanentes",
        ),
        # A shouted run inside prose is still shouting.
        (
            "Aquisição de LINHA BRANCA, ELETRODOMÉSTICOS E UTILIDADES",
            "Aquisição de linha branca, eletrodomésticos e utilidades",
        ),
        # …but an isolated acronym in prose is not, and must survive. This is
        # the case a ratio-only test got wrong: "IMPG/UFRJ" scores 0.22.
        (
            "4 Recargas de Botijão Gás Butano P45kg ao IMPG/UFRJ",
            "4 Recargas de Botijão Gás Butano P45kg ao IMPG/UFRJ",
        ),
        ("HD externo 2 TB", "HD externo 2 TB"),
        # Known acronyms survive even inside a shouted objeto, and the slash is
        # split so "ME/EPP" is judged as two of them.
        (
            "AQUISIÇÃO DE MATERIAIS HOSPITALARES PARA ME/EPP E SUS",
            "Aquisição de materiais hospitalares para ME/EPP e SUS",
        ),
    ],
)
def test_de_shouting(objeto: str, expected: str) -> None:
    assert titles.deterministic_title(objeto) == expected


def test_a_lowercase_opening_is_left_alone() -> None:
    """`cleanTitle` restores the opening capital only if the source had one."""
    assert titles.deterministic_title("iPhone 15 para a diretoria").startswith("iPhone")


# -- The branch predicate -------------------------------------------------


@pytest.mark.parametrize(
    "title",
    [
        "Aquisição de Equipamentos e materiais de roçagem",
        "Serviço de manutenção da usina fotovoltaica da CRO/12",
        # Finding 2: a good short objeto must never reach the model, whose item
        # context turned this one into "Revestimento cerâmico montagem e
        # desmontagem alvenaria laje e caixilho".
        "Centro Cultural - Etapa 02",
    ],
)
def test_a_good_short_title_is_kept_free(title: str) -> None:
    assert not titles.needs_model(title)


@pytest.mark.parametrize(
    "title",
    [
        "",
        "   ",
        # Still names the contract rather than the purchase.
        "Contratação de empresa para fornecimento de materiais permanentes",
        "Contratação de pessoa jurídica para serviços de limpeza",
        "Registro de preços para aquisição de medicamentos",
        "Formação de registro de preços para gêneros alimentícios",
        "O objeto da presente licitação é a compra de livros",
        "Constitui objeto deste edital a reforma da escola",
        "Futura e eventual aquisição de material de escritório",
        # Too long to read on a card.
        "Aquisição de " + "materiais diversos " * 6,
    ],
)
def test_an_unfit_title_goes_to_the_model(title: str) -> None:
    assert titles.needs_model(title)


def test_aquisicao_is_not_boilerplate() -> None:
    """It already says what is being bought — Sci's own example of a good title."""
    assert not titles.needs_model("Aquisição de cadeiras de rodas hospitalares")
    assert not titles.needs_model("Prestação de serviços de coleta de lixo")


# -- The validator: the three measured fabrications -----------------------
#
# These are the whole reason the validator exists. A prompt rule is a request;
# this is the guarantee, and under CDC art. 30 (legal brief §2.2 rule 1) a title
# claiming a tender is "para MEI" is a promise the product cannot keep.


@pytest.mark.parametrize(
    ("title", "objeto", "items", "word"),
    [
        (
            "Coleta de lixo hospitalar para MEI e pequenas empresas",
            "serviço de coleta de lixo hospitalar",
            "",
            "mei",
        ),
        (
            "Pintura e reparos em imóveis para MEI",
            "MANUTENÇÃO E CONSERVAÇÃO DE BENS IMÓVEIS",
            "",
            "pintura",
        ),
        (
            "Recapeamento asfáltico para moradores de Rio Claro",
            "EXECUÇÃO DE RECAPEAMENTO ASFÁLTICO NA AVENIDA MANOEL EDILSO",
            "",
            "moradores",
        ),
    ],
)
def test_the_three_fabrications_are_rejected(
    title: str, objeto: str, items: str, word: str
) -> None:
    assert titles.validate(title, objeto, items) == f"invented:{word}"


def test_a_faithful_title_passes() -> None:
    assert (
        titles.validate("Coleta de lixo hospitalar", "serviço de coleta de lixo hospitalar", "")
        is None
    )


def test_inflection_is_not_invention() -> None:
    """ "materiais" from "material" is the model obeying, not fabricating."""
    assert (
        titles.validate(
            "Aquisição de materiais permanentes", "AQUISIÇÃO DE MATERIAL PERMANENTE", ""
        )
        is None
    )


def test_a_word_only_the_items_carry_is_derivable() -> None:
    """The items are why the model is worth calling: objeto "Obras comuns"."""
    items = "- manutencao e melhoramentos em aerodromos e aeroportos (1 un)"
    assert (
        titles.validate("Obras de manutenção e melhoramentos em aeródromos", "Obras comuns", items)
        is None
    )


def test_a_word_the_truncation_cut_counts_as_invented() -> None:
    """The vocabulary is what the model was *sent*, not what the row holds.

    An item description is truncated to 180 characters before it reaches the
    prompt. A word beyond the cut is a word the model never saw.
    """
    long_item = "- " + ("cimento " * 30) + "guindaste"
    block = titles.item_lines([{"description": long_item, "quantity": 1, "unit": "un"}])
    assert "guindaste" not in block
    # Every other word is in the objeto, so "guindaste" is the only thing the
    # validator can be reacting to.
    assert titles.validate("Obras comuns com guindaste", "Obras comuns", block) == (
        "invented:guindaste"
    )


@pytest.mark.parametrize(
    ("title", "reason"),
    [
        ("Ótima oportunidade de coleta de lixo", "evaluative:otima"),
        ("Coleta de lixo, ideal para começar", "evaluative:ideal"),
        ("Coleta de lixo por R$ 50.000,00", "money_or_date"),
        ("Coleta de lixo até 30/06/2026", "money_or_date"),
        ("Coleta de lixo com 15% de desconto", "money_or_date"),
        ("Coleta de lixo em 2027", "year_not_in_source"),
        ("Coleta de lixo hospitalar.", "trailing_stop"),
        ("Coleta", "too_short"),
        ("", "empty"),
    ],
)
def test_the_other_guards(title: str, reason: str) -> None:
    assert titles.validate(title, "coleta de lixo", "") == reason


def test_a_year_the_source_wrote_is_kept() -> None:
    """ "SUMMIT CBCP 2026" is the event being bought for, not a deadline."""
    objeto = (
        "Aquisição de uniformes (camisetas manga curta personalizadas), "
        "destinadas ao SUMMIT CBCP 2026"
    )
    assert (
        titles.validate("Aquisição de camisetas personalizadas para o SUMMIT CBCP 2026", objeto, "")
        is None
    )


def test_the_shape_guard_is_looser_than_the_prompt() -> None:
    """It refuses a broken title, not merely a long one.

    Tightening it to the prompt's own "3 a 8 palavras" rejected two faithful
    titles in the 150-tender sample and shipped the identical, longer
    deterministic string in their place.
    """
    objeto = "Aquisição de materiais odontológicos para clínicas do "
    objeto += "Departamento de Odontologia Restauradora."
    assert titles.validate(objeto.rstrip("."), objeto, "") is None


# -- The item block the model is sent --------------------------------------


def test_items_are_truncated_and_capped() -> None:
    items = [{"description": "x" * 400, "quantity": i, "unit": "un"} for i in range(10)]
    block = titles.item_lines(items)
    assert len(block.splitlines()) == titles.MAX_ITEMS
    for line in block.splitlines():
        assert len(line) < titles.MAX_ITEM_CHARS + 40


def test_no_items_is_not_a_crash() -> None:
    """Three of the 4,760 production tenders have no item rows at all."""
    assert titles.item_lines([]) == ""
    assert "(sem itens)" in titles.user_prompt("Obras comuns", "")


def test_the_prompt_contains_the_word_json() -> None:
    """The provider rejects `response_format: json_object` without it."""
    assert "json" in titles.SYSTEM_PROMPT.lower()


# -- build(): the two branches wired together ------------------------------


def _no_call(*args, **kwargs):  # pragma: no cover - the point is it is not called
    raise AssertionError("the model must not be asked about a good short objeto")


def test_build_keeps_a_good_objeto_free(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(titles, "model_title", _no_call)
    result = titles.build(
        "Centro Cultural - Etapa 02", [{"description": "alvenaria"}], key="unused"
    )
    assert result is not None
    assert result.source == titles.SOURCE_DETERMINISTIC
    assert result.text == "Centro Cultural - Etapa 02"
    assert result.prompt_version is None


def test_build_falls_back_when_the_validator_rejects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        titles,
        "model_title",
        lambda *a, **k: titles.ModelAnswer("Coleta de lixo para MEI", cost_brl=0.0001),
    )
    objeto = "CONTRATAÇÃO DE EMPRESA PARA PRESTAÇÃO DE SERVIÇOS DE COLETA DE LIXO"
    result = titles.build(objeto, [], key="k")
    assert result is not None
    assert result.source == titles.SOURCE_AI_FALLBACK
    assert result.rejected == "invented:mei"
    assert result.text == titles.deterministic_title(objeto)
    # It still cost money, and that must be reported rather than lost.
    assert result.cost_brl == pytest.approx(0.0001)


def test_build_returns_nothing_when_rate_limited(monkeypatch: pytest.MonkeyPatch) -> None:
    """Writing the unfit deterministic title would freeze it in place."""
    monkeypatch.setattr(
        titles, "model_title", lambda *a, **k: titles.ModelAnswer(None, rate_limited=True)
    )
    objeto = "CONTRATAÇÃO DE EMPRESA PARA PRESTAÇÃO DE SERVIÇOS DE COLETA DE LIXO"
    assert titles.build(objeto, [], key="k") is None


def test_build_accepts_a_clean_model_title(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        titles,
        "model_title",
        lambda *a, **k: titles.ModelAnswer(
            "Coleta de lixo hospitalar", input_tokens=400, output_tokens=16, cost_brl=0.0001
        ),
    )
    objeto = "CONTRATAÇÃO DE EMPRESA PARA PRESTAÇÃO DE SERVIÇOS DE COLETA DE LIXO HOSPITALAR"
    result = titles.build(objeto, [], key="k")
    assert result is not None
    assert result.source == titles.SOURCE_AI
    assert result.text == "Coleta de lixo hospitalar"
    assert result.prompt_version == titles.PROMPT_VERSION
    assert result.rejected is None


# -- model_title(): the 429 -----------------------------------------------


def test_a_429_is_retried_then_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []

    def rate_limited(*args, **kwargs):
        calls.append(1)
        return 429, {"error": {"code": 429, "message": "temporarily rate-limited upstream"}}

    monkeypatch.setattr(titles.ai_tender, "call_model", rate_limited)
    answer = titles.model_title("objeto", "", "k", sleep=lambda _: None)
    assert answer.rate_limited is True
    assert answer.title is None
    assert len(calls) == titles.RATE_LIMIT_ATTEMPTS


def test_a_429_that_clears_on_retry_returns_the_title(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    answers = [
        (429, {"error": {"code": 429}}),
        (
            200,
            {
                "usage": {"prompt_tokens": 400, "completion_tokens": 16, "cost": 0.00001},
                "choices": [{"message": {"content": '{"titulo": "Coleta de lixo"}'}}],
            },
        ),
    ]
    monkeypatch.setattr(titles.ai_tender, "call_model", lambda *a, **k: answers.pop(0))
    answer = titles.model_title("objeto", "", "k", sleep=lambda _: None)
    assert answer.title == "Coleta de lixo"
    assert answer.rate_limited is False
    assert answer.attempts == 2


def test_an_http_error_is_not_a_rate_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(titles.ai_tender, "call_model", lambda *a, **k: (503, {}))
    answer = titles.model_title("objeto", "", "k", sleep=lambda _: None)
    assert answer.rate_limited is False
    assert answer.error == "http_503"


# -- The staleness contract ------------------------------------------------


def test_the_stale_sql_spares_deterministic_rows_on_a_prompt_bump() -> None:
    """A prompt change must not re-pay for the rows the model never saw."""
    assert f"t.short_title_source <> '{titles.SOURCE_DETERMINISTIC}'" in titles.STALE_SQL
    assert "prompt_version" in titles.STALE_SQL
    assert "rules_version" in titles.STALE_SQL


def test_the_basis_covers_the_objeto_the_revision_and_the_items() -> None:
    assert "t.object" in titles.BASIS_SQL
    assert "t.pncp_updated_at" in titles.BASIS_SQL
    assert "tender_items" in titles.BASIS_SQL
    # …and deliberately not the item row's own timestamp: re-writing an item
    # with identical content must not re-title the tender.
    assert "i.updated_at" not in titles.BASIS_SQL
