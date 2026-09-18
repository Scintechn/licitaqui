"""POC 4 port: extraction, page selection, the call plans, the rules, citations.

Nothing here touches OpenRouter. Every call goes through a stub, and the two
tests that matter most assert that no stub was called at all — a scanned PDF
must cost nothing (task C1's acceptance criterion), and a model answer must
never be believed about which page it came from.
"""

from __future__ import annotations

import json

import pytest

from licitaqui import ai_tender
from licitaqui.ai_tender import Document, Page

from . import pdfs


def answer(payload: dict, *, cost: float = 0.001, tokens: tuple[int, int] = (1000, 200)) -> dict:
    """An OpenRouter response carrying ``payload`` as the model's JSON answer."""
    return {
        "choices": [
            {
                "message": {"content": json.dumps(payload, ensure_ascii=False)},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": tokens[0], "completion_tokens": tokens[1], "cost": cost},
    }


def doc(*texts: str) -> Document:
    return Document(pages=tuple(Page(i, t) for i, t in enumerate(texts, 1)))


# -- Brazilian numbers and dates (spec §13 "minimum tests") ----------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("R$ 4.330.766,67", 4330766.67),
        ("48.196,00", 48196.0),
        ("1.234", 1234.0),
        ("12 meses, prorrogável", 12.0),
        ("0,1% ao dia", 0.1),
        (48196.0, 48196.0),
        (7, 7.0),
        (True, None),
        (None, None),
        ("não exigível", None),
    ],
)
def test_parse_number(raw, expected):
    assert ai_tender.parse_number(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("12 meses", 12.0),
        ("12 meses, prorrogável por igual período", 12.0),
        ("05 anos", 60.0),
        ("1 (um) ano", 12.0),
        ("12 (doze) meses", 12.0),
        (60, 60.0),
        ("60", 60.0),
        (None, None),
        # The POC multiplied this by 12 (the string says "ano" and not "mes")
        # and reported a 12-month price registry as 144 months. A live run of
        # the port caught it against the Campinas answer key.
        ("12 (1 ano)", 12.0),
    ],
)
def test_months(raw, expected):
    assert ai_tender.months(raw) == expected


# -- Extraction ------------------------------------------------------------


def test_extract_text_numbers_pages_across_a_zip():
    document = ai_tender.extract_text(pdfs.zip_of(pdfs.text_pdf(["um"]), pdfs.text_pdf(["dois"])))
    assert [(p.number, p.text) for p in document.pages] == [(1, "um"), (2, "dois")]


def test_pdfs_in_rejects_what_is_not_a_document():
    with pytest.raises(ValueError, match="neither a PDF nor a ZIP"):
        ai_tender.pdfs_in(b"{\\rtf1 this is a .doc")


def test_scanned_pdf_has_no_text():
    document = ai_tender.extract_text(pdfs.scanned_pdf(5))
    assert document.page_count == 5
    assert document.characters == 0
    assert document.has_text is False


def test_a_long_scan_with_one_readable_cover_page_is_still_no_text():
    """The absolute floor alone would pass this; the per-page floor is why it fails."""
    document = doc("x" * 2000, *[""] * 200)
    assert document.characters > ai_tender.MIN_TEXT_CHARACTERS
    assert document.has_text is False


def test_text_hash_changes_with_the_text_and_not_with_the_run():
    assert doc("a", "b").text_hash() == doc("a", "b").text_hash()
    assert doc("a", "b").text_hash() != doc("a", "c").text_hash()


# -- The acceptance criterion: a scan costs nothing ------------------------


def test_screening_a_scanned_pdf_makes_no_api_call():
    def explode(*_args, **_kwargs):
        raise AssertionError("the API must not be called for a PDF with no text layer")

    document = ai_tender.extract_text(pdfs.scanned_pdf(12))
    screening = ai_tender.screen(document, key="unused", call=explode)

    assert screening.status == ai_tender.NO_TEXT
    assert screening.analysis is None
    assert screening.called_api is False


def test_screening_a_scan_does_not_even_resolve_the_api_key(monkeypatch):
    """`screen()` is safe in a process with no key configured, by construction."""

    def no_key(*_names, **_kwargs):
        raise AssertionError("the key must not be resolved before the text check")

    monkeypatch.setattr(ai_tender.config, "require_secret", no_key)
    assert ai_tender.screen(doc("", "")).status == ai_tender.NO_TEXT


# -- Page selection --------------------------------------------------------


def test_select_pages_keeps_everything_under_the_budget():
    document = doc("a" * 100, "b" * 100, "c" * 100)
    selection = ai_tender.select_pages(document, 10_000)
    assert selection.kept == (1, 2, 3)
    assert selection.dropped == ()
    assert selection.text.startswith("[[página 1]]")


def test_select_pages_always_keeps_the_preamble_and_covers_the_critical_groups():
    pages = ["preambulo " + "z" * 500, "z" * 600, "z" * 600]
    pages += ["declaramos modelo de declaracao " + "z" * 600 for _ in range(10)]
    pages.append("capital social minimo de 10 % do valor estimado " + "z" * 400)
    document = doc(*pages)

    selection = ai_tender.select_pages(document, 3_000)

    assert selection.kept[:3] == (1, 2, 3), "the preamble is never dropped"
    assert len(pages) in selection.kept, "the page with the concrete capital rule is bought first"
    assert len(selection.text) <= 3_000
    assert selection.dropped, "the boilerplate pages are what got dropped"


def test_select_pages_emits_pages_in_document_order():
    document = doc(*[f"pagina {i} " + "z" * 300 for i in range(1, 12)])
    selection = ai_tender.select_pages(document, 1_500)
    markers = [int(part.split("]]")[0]) for part in selection.text.split("[[página ")[1:]]
    assert markers == sorted(markers)


# -- Call plans ------------------------------------------------------------


def test_analyse_escalates_to_the_next_plan_and_adds_up_the_cost():
    calls: list[dict] = []

    def call(_model, _system, _user, _key, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return 200, {
                "choices": [{"message": {"content": "desculpe, segue a análise:"}}],
                "usage": {"cost": 0.001, "prompt_tokens": 100, "completion_tokens": 10},
            }
        return 200, answer({"objeto": "x"}, cost=0.002, tokens=(100, 20))

    result = ai_tender.analyse("m", "lite", "texto", "key", call=call)

    assert result.ok and result.result == {"objeto": "x"}
    assert [c["reasoning"] for c in calls] == ["off", "low"]
    assert result.cost_brl == round(0.003 * ai_tender.USD_BRL, 4)
    assert (result.input_tokens, result.output_tokens) == (200, 30)


def test_analyse_stops_paying_when_the_account_has_no_credit():
    calls = []

    def call(*_args, **_kwargs):
        calls.append(1)
        return 402, {"error": {"message": "insufficient credits"}}

    result = ai_tender.analyse("m", "lite", "t", "key", call=call)

    assert len(calls) == 1, "402 cannot be fixed by another plan"
    assert result.ok is False
    assert result.error == "insufficient credits"


def test_analyse_gives_up_after_two_hangs():
    calls = []

    def call(*_args, **_kwargs):
        calls.append(1)
        return 0, {"error": "ReadTimeout"}

    result = ai_tender.analyse("m", "lite", "t", "key", call=call)

    assert len(calls) == 2, "a provider that hangs twice must not get a third chance"
    assert result.ok is False


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ('{"a": 1}', {"a": 1}),
        ('```json\n{"a": 1}\n```', {"a": 1}),
        ('claro! {"a": 1}', {"a": 1}),
        ("[1, 2]", None),
        ("desculpe, não consigo", None),
        ("", None),
    ],
)
def test_json_from_answer(content, expected):
    assert ai_tender.json_from_answer(content) == expected


# -- Rules computed in code ------------------------------------------------


def test_minimum_capital_on_the_annual_value_of_a_multi_year_contract():
    result = {
        "valor_estimado_total": "R$ 4.330.766,67",
        "vigencia_meses": "05 anos",
        "capital_ou_patrimonio_minimo": {
            "exige": True,
            "resumo": "10% do valor anual da contratação",
            "percentual": "10%",
            "base": "valor_anual",
        },
    }

    rules = ai_tender.compute_rules(result)

    assert result["vigencia_meses_normalizada"] == 60
    capital = result["capital_ou_patrimonio_minimo"]
    assert capital["valor_minimo_calculado"] == round(4330766.67 * 12 / 60 * 0.10, 2)
    assert rules["minimum_capital_brl"] == capital["valor_minimo_calculado"]
    assert "×" in capital["calculo"]


def test_minimum_capital_on_the_total_when_no_base_is_given():
    result = {
        "valor_estimado_total": 48196.0,
        "capital_ou_patrimonio_minimo": {"exige": True, "percentual": 10},
    }
    ai_tender.compute_rules(result)
    assert result["capital_ou_patrimonio_minimo"]["valor_minimo_calculado"] == 4819.6


def test_no_capital_rule_when_the_edital_does_not_require_one():
    result = {"valor_estimado_total": 48196.0, "capital_ou_patrimonio_minimo": {"exige": False}}
    assert ai_tender.compute_rules(result) == {}
    assert "valor_minimo_calculado" not in result["capital_ou_patrimonio_minimo"]


def test_compute_rules_survives_an_answer_that_is_not_a_dict():
    assert ai_tender.compute_rules(None) == {}
    assert ai_tender.compute_rules({"triagem": "nonsense"}, "deep") == {}


# -- Citation check --------------------------------------------------------


def _document_for_citations() -> Document:
    """Topics kept three pages apart: the check reads the cited page ±1."""
    return doc(
        "Pregao eletronico exclusivo para ME/EPP, microempresa e empresa de pequeno porte",
        "Do objeto e da dotacao orcamentaria do presente certame",
        "Qualificacao tecnica: atestado de capacidade tecnica nao exigivel",
        "Do pagamento em 30 dias corridos contados do recebimento",
        "Qualificacao economico-financeira: capital social minimo nao exigivel",
        "Das disposicoes finais e do foro",
    )


def test_lite_citations_verify_the_page_the_claim_came_from():
    document = _document_for_citations()
    result = {
        "beneficio_me_epp": {"situacao": "exclusivo", "pagina": 1},
        "atestado_capacidade_tecnica": {"exige": False, "pagina": 3},
        "capital_ou_patrimonio_minimo": {"exige": False, "pagina": 5},
    }

    check = ai_tender.check_citations(result, document, sent_pages=(1, 2, 3, 4, 5, 6))

    assert check["citations"] == 3
    assert check["rate"] == 1.0
    assert set(check["findings"].values()) == {"confere"}


def test_lite_citations_catch_an_invented_page_a_swapped_page_and_a_page_never_sent():
    document = _document_for_citations()
    result = {
        "garantia_contratual": {"situacao": "exigida", "pagina": 99},
        "capital_ou_patrimonio_minimo": {"exige": True, "pagina": 1},
        "atestado_capacidade_tecnica": {"exige": True, "pagina": 3},
    }

    check = ai_tender.check_citations(result, document, sent_pages=(1, 2, 5, 6))

    assert check["findings"]["garantia_contratual"] == "pagina inexistente"
    assert check["findings"]["capital_ou_patrimonio_minimo"] == "pagina errada"
    assert check["findings"]["atestado_capacidade_tecnica"] == "pagina nao enviada ao modelo"
    assert check["rate"] == 0.0


def test_lite_citations_count_a_claim_with_no_page_as_no_citation():
    check = ai_tender.check_citations(
        {"garantia_contratual": {"situacao": "nao_informado", "pagina": None}},
        _document_for_citations(),
    )
    assert check["citations"] == 0
    assert check["rate"] is None


def test_deep_citations_grade_the_excerpt_against_the_page():
    document = doc(
        "O prazo de entrega sera de 15 (quinze) dias corridos apos o recebimento da ordem",
        "Do objeto e da dotacao orcamentaria",
        "Das obrigacoes da contratada e da fiscalizacao",
        "A garantia contratual nao sera exigida neste certame",
    )
    result = {
        "exigencias": [
            {
                "descricao": "entrega",
                "trecho": "prazo de entrega sera de 15 (quinze) dias",
                "pagina": 1,
            },
            {
                "descricao": "garantia",
                "trecho": "a garantia contratual nao sera exigida",
                "pagina": 1,
            },
            {
                "descricao": "inventada",
                "trecho": "o licitante devera apresentar selo ISO 9001",
                "pagina": 2,
            },
        ]
    }

    check = ai_tender.check_excerpt_citations(result, document)

    assert check["citations"] == 3
    assert result["exigencias"][0]["citacao"] == "confere"
    assert result["exigencias"][1]["citacao"] == "trecho existe, pagina errada"
    assert result["exigencias"][2]["citacao"] == "NAO encontrado no documento"
    assert check["verified"] == 1.5


# -- screen() end to end (stubbed model) -----------------------------------


def test_screen_computes_the_rules_and_checks_the_citations():
    document = doc(
        "Pregao exclusivo para ME/EPP " + "z" * 800,
        "Capital social minimo de 10% do valor estimado " + "z" * 800,
        "Prazo de pagamento " + "z" * 800,
    )
    payload = answer(
        {
            "valor_estimado_total": "R$ 100.000,00",
            "vigencia_meses": "12 meses",
            "capital_ou_patrimonio_minimo": {"exige": True, "percentual": "10%", "pagina": 2},
            "beneficio_me_epp": {"situacao": "exclusivo", "pagina": 1},
        }
    )

    screening = ai_tender.screen(document, key="k", call=lambda *a, **kw: (200, payload))

    assert screening.status == "ok"
    assert screening.analysis.rules["minimum_capital_brl"] == 10000.0
    assert screening.analysis.citation_check["rate"] == 1.0
    assert screening.analysis.cost_brl > 0
    assert "chars_sent" in screening.log_fields()


def test_screen_reports_failure_without_raising():
    screening = ai_tender.screen(
        doc("x" * 2000), key="k", call=lambda *a, **kw: (500, {"error": "upstream"})
    )
    assert screening.status == "failed"
    assert screening.error == "upstream"
    assert screening.analysis.cost_brl == 0.0


def test_the_prompt_carries_the_page_markers_the_rules_promise():
    sent: dict[str, str] = {}

    def call(_model, system, user, _key, **_kwargs):
        sent["system"], sent["user"] = system, user
        return 200, answer({"objeto": "x"})

    ai_tender.screen(doc("primeira pagina " + "z" * 2000), key="k", call=call)

    assert "[[página N]]" in sent["system"], "the rules tell the model how pages are marked"
    assert "[[página 1]]" in sent["user"], "…so the document must actually be marked that way"
