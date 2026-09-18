"""The CNAE → segment map, without a database.

Two kinds of test live here: the seed artefact's own invariants (it is reference
data a human edits, so a typo must fail CI rather than reach production), and
the pure combination rule in :func:`licitaqui.cnae.combine`.
"""

from __future__ import annotations

import csv
import importlib.util
import sys

import pytest

from licitaqui import cnae
from licitaqui.config import ROOT

REFERENCE = ROOT / "db" / "reference"
MIGRATION = ROOT / "db" / "migrations" / "0003_cnae_segments.sql"


def _load_db_module():
    """Import `db/cnae_reference.py`, which is tooling and not an installed package."""
    path = ROOT / "db" / "cnae_reference.py"
    spec = importlib.util.spec_from_file_location("licitaqui_db_cnae_reference", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


reference = _load_db_module()


@pytest.fixture(scope="module")
def rows() -> list[dict[str, str]]:
    return reference.load_rows()


@pytest.fixture(scope="module")
def subclasses() -> dict[str, str]:
    return reference.load_subclasses()


# -- the seed artefact ------------------------------------------------------


def test_segment_names_match_the_worker(rows):
    """One list of 14 segments, spelled the same in SQL, tooling and worker."""
    assert reference.SEGMENTS == cnae.SEGMENTS


def test_every_mapped_code_is_a_real_cnae_subclass(rows, subclasses):
    """A typo in the CSV would silently map nothing at all."""
    unknown = sorted({row["cnae"] for row in rows} - set(subclasses))
    assert unknown == []


def test_descriptions_match_the_ibge_list(rows, subclasses):
    """The description column is there to be read; it must be the official one."""
    wrong = [r["cnae"] for r in rows if r["description"] != subclasses[r["cnae"]]]
    assert wrong == []


def test_rows_are_sorted_and_unique(rows):
    """Sorted by (cnae, segment): a stable file makes review diffs readable."""
    keys = [(r["cnae"], r["segment"]) for r in rows]
    assert keys == sorted(keys)
    assert len(keys) == len(set(keys))


def test_the_map_is_deliberately_incomplete(rows, subclasses):
    """555 of 1332 subclasses are mapped, and that is the intended outcome.

    This asserts the shape of the decision, not the exact number: if a review
    were ever to "complete" the map by mapping nearly every CNAE, that would be
    the failure mode the card warns about, and it should fail here first.
    """
    mapped = {row["cnae"] for row in rows}
    assert 300 < len(mapped) < len(subclasses) * 0.6
    assert len(subclasses) == 1332


def test_notes_explain_the_arguable_mappings(rows):
    """A `check` row without a note is a mapping nobody can review."""
    silent = [r["cnae"] for r in rows if r["fit"] == "check" and not r["note"].strip()]
    assert silent == []


def test_the_csv_uses_the_seven_digit_padded_form_b5_stores(rows):
    """B5 stores `cnae_fiscal` zero-padded to 7 digits; the join needs the same."""
    assert all(len(row["cnae"]) == 7 and row["cnae"].isdigit() for row in rows)


def test_reference_csv_has_no_stray_whitespace():
    """Trailing spaces make a review diff lie about what changed."""
    for path in (REFERENCE / "cnae_segments.csv", REFERENCE / "cnae_subclasses.csv"):
        text = path.read_text(encoding="utf-8")
        assert "\r" not in text, f"{path} must use LF endings"
        assert not any(line != line.rstrip() for line in text.splitlines()), path


def test_migration_matches_the_csv(rows):
    """The migration is generated. If the CSV moved, the SQL must have moved too.

    This is the whole reason the CSV can be the artefact people review: it
    cannot drift away from what the database is actually given.
    """
    expected = reference.render_seed_sql(rows)
    text = MIGRATION.read_text(encoding="utf-8")
    start = text.index(reference.MARKER_BEGIN)
    end = text.index(reference.MARKER_END) + len(reference.MARKER_END) + 1
    assert text[start:end] == expected, (
        "regenerate with: python3 db/cnae_reference.py db/migrations/0003_cnae_segments.sql"
    )


def test_migration_declares_the_same_segments():
    """The table's check constraint is the last line of defence; keep it in step."""
    text = MIGRATION.read_text(encoding="utf-8")
    for segment in cnae.SEGMENTS:
        assert f"'{segment}'" in text


def test_load_rows_rejects_a_bad_fit(tmp_path):
    path = tmp_path / "bad.csv"
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(["cnae", "description", "segment", "fit", "note"])
        writer.writerow(["4761003", "PAPELARIA", "Gráfico / Escritório", "maybe", ""])
    with pytest.raises(ValueError, match="fit"):
        reference.load_rows(path)


def test_load_rows_rejects_an_unknown_segment(tmp_path):
    path = tmp_path / "bad.csv"
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(["cnae", "description", "segment", "fit", "note"])
        writer.writerow(["4761003", "PAPELARIA", "Papelaria", "compatible", ""])
    with pytest.raises(ValueError, match="segments"):
        reference.load_rows(path)


# -- spot checks on the mapping's judgement ---------------------------------
#
# Not exhaustive, and not meant to be: these are the codes the acceptance
# criterion names (papelaria, limpeza, TI, hospitalar) plus the ones where the
# compatible/check line was hardest to draw. If a review moves one of these,
# the test should be moved with it, deliberately.

EXPECTED = {
    ("4761003", "Gráfico / Escritório"): "compatible",  # papelaria
    ("4647801", "Gráfico / Escritório"): "compatible",  # escritório, atacado
    ("4649408", "Limpeza / Higiene"): "compatible",  # produtos de limpeza, atacado
    ("8121400", "Limpeza / Higiene"): "check",  # limpeza predial: a service
    ("4751201", "Informática / TI"): "compatible",  # loja de informática
    ("6201501", "Software / Sistemas"): "compatible",  # desenvolvimento sob encomenda
    ("6209100", "Informática / TI"): "check",  # suporte em TI: a service
    ("4645101", "Saúde / Hospitalar"): "compatible",  # material hospitalar
    ("8630504", "Saúde / Hospitalar"): "check",  # consultório odontológico: a service
    ("4644301", "Saúde / Hospitalar"): "compatible",  # medicamentos
    ("4744099", "Construção / Hidráulica"): "compatible",  # material de construção
    ("4744001", "Ferragens / Ferramentas"): "compatible",  # ferragens e ferramentas
    ("4742300", "Elétrica"): "compatible",  # material elétrico
    ("4530703", "Veículos / Peças"): "compatible",  # peças automotivas
    ("4642702", "Vestuário / Uniformes"): "compatible",  # uniformes profissionais
    ("8020001", "Segurança Eletrônica / CFTV"): "compatible",  # monitoramento eletrônico
    ("4754701", "Mobiliário"): "compatible",  # móveis
    ("4763602", "Esportes / Lazer"): "compatible",  # artigos esportivos
    ("4633801", "Alimentos"): "compatible",  # hortifruti, atacado
    ("4635401", "Alimentos"): "check",  # água mineral: a beverage, not food
}

#: Codes that must stay out of the map. Each is a real CNAE with no honest home
#: among the 14 segments; mapping one would be the "stretch to look complete"
#: the card warns against.
DELIBERATELY_UNMAPPED = (
    "4693100",  # mercadorias em geral sem predominância — a distributor of anything
    "4713004",  # lojas de departamentos
    "6911701",  # serviços advocatícios
    "8599604",  # treinamento em desenvolvimento profissional
)


def test_spot_checks(rows):
    actual = {(r["cnae"], r["segment"]): r["fit"] for r in rows}
    wrong = {key: (actual.get(key), fit) for key, fit in EXPECTED.items() if actual.get(key) != fit}
    assert wrong == {}


def test_deliberately_unmapped_codes_stay_unmapped(rows, subclasses):
    mapped = {row["cnae"] for row in rows}
    for code in DELIBERATELY_UNMAPPED:
        assert code in subclasses, f"{code} is not a CNAE 2.3 subclass"
        assert code not in mapped, f"{code} was mapped; was that deliberate?"


# -- the combination rule ---------------------------------------------------

MAPPING: cnae.Mapping = {
    "4761003": (("Gráfico / Escritório", "compatible"),),
    "4647802": (("Gráfico / Escritório", "check"),),
    "8121400": (("Limpeza / Higiene", "check"),),
    "4649408": (("Limpeza / Higiene", "compatible"),),
    "4744099": (
        ("Construção / Hidráulica", "compatible"),
        ("Elétrica", "check"),
        ("Ferragens / Ferramentas", "check"),
    ),
}


def test_main_cnae_alone():
    result = cnae.combine("4761003", [], MAPPING)
    assert result.names == ("Gráfico / Escritório",)
    assert result.compatible == ("Gráfico / Escritório",)
    assert result.unmapped_cnaes == ()
    assert result.manual_cnae is False


def test_a_compatible_secondary_does_not_lift_a_check_primary():
    """The stated rule: `compatible` requires the main CNAE.

    Measured on 20 real suppliers, the opposite rule made the average company
    compatible with 5.75 of the 14 segments, against 0.8 now. See the module
    docstring.
    """
    result = cnae.combine("4647802", ["4761003"], MAPPING)
    assert result.fit_for("Gráfico / Escritório") == "check"
    entry = result.segments[0]
    assert entry.from_main_cnae is True
    assert entry.from_secondary_cnae is True


def test_a_check_secondary_does_not_weaken_a_compatible_primary():
    result = cnae.combine("4761003", ["4647802"], MAPPING)
    assert result.fit_for("Gráfico / Escritório") == "compatible"


def test_a_segment_reached_only_through_a_secondary_is_capped_at_check():
    """4649408 is `compatible` in the map, but not for a company whose main
    activity is something else."""
    result = cnae.combine("4647802", ["4649408"], MAPPING)
    assert result.fit_for("Limpeza / Higiene") == "check"
    assert result.compatible == ()


def test_a_secondary_only_segment_keeps_its_own_fit():
    result = cnae.combine("4761003", ["8121400"], MAPPING)
    assert result.fit_for("Limpeza / Higiene") == "check"
    limpeza = next(e for e in result.segments if e.segment == "Limpeza / Higiene")
    assert limpeza.from_main_cnae is False
    assert limpeza.from_secondary_cnae is True


def test_one_cnae_can_reach_several_segments():
    result = cnae.combine("4744099", [], MAPPING)
    assert result.compatible == ("Construção / Hidráulica",)
    assert result.check == ("Elétrica", "Ferragens / Ferramentas")


def test_display_order_is_compatible_then_main_then_alphabetical():
    result = cnae.combine("4761003", ["4744099", "8121400"], MAPPING)
    assert result.names == (
        "Gráfico / Escritório",  # compatible, main
        "Construção / Hidráulica",  # check, secondary
        "Elétrica",  # check, secondary
        "Ferragens / Ferramentas",  # check, secondary
        "Limpeza / Higiene",  # check, secondary
    )


def test_unmapped_cnaes_are_reported_not_guessed():
    result = cnae.combine("6911701", ["9430800"], MAPPING)
    assert result.segments == ()
    assert result.unmapped_cnaes == ("6911701", "9430800")
    assert result.manual_cnae is False


def test_a_repeated_secondary_is_counted_once():
    result = cnae.combine("4761003", ["4761003", "4647802", "4647802"], MAPPING)
    assert len(result.segments) == 1
    assert result.segments[0].from_main_cnae is True


def test_no_main_cnae_is_the_manual_form_not_an_empty_answer():
    result = cnae.combine(None, ["4761003"], MAPPING)
    assert result.manual_cnae is True
    assert result.segments == ()
    assert result.unmapped_cnaes == ()


def test_none_secondaries_are_accepted():
    assert cnae.combine("4761003", None, MAPPING).names == ("Gráfico / Escritório",)
