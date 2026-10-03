"""The catalogue mirror and the mapper sweep (card B36).

The two jobs themselves need a database and are exercised by the integration
suite; what is pinned here is the logic that decides **what gets written**, which
is where a silent wrong answer would come from:

* a status field that is not a boolean (truthiness fails OPEN — every inactive
  code would become active, and the log would agree with the bug);
* a walk where everything is active, which is the same failure one layer up;
* an item whose ``kind`` is neither 'M' nor 'S', which must not be matched
  against the materials vocabulary just because that column is nullable.

No network and no database in this file.
"""

from __future__ import annotations

import pytest

from licitaqui.catalog_match import (
    MATCH_CAP,
    MATCHER_VERSION,
    CatalogEntry,
    CatalogIndex,
    Resolution,
    all_words,
    product_head,
    resolve_description,
)
from licitaqui.catalog_sync import (
    _active,
    _assert_discriminating,
    _pdm_entry,
    _service_entry,
)
from licitaqui.compras import ComprasError

# ------------------------------------------------- the status field

def test_a_boolean_status_is_read_as_itself() -> None:
    assert _active(True, "statusPdm") is True
    assert _active(False, "statusPdm") is False


@pytest.mark.parametrize("value", ["false", "N", "Inativo", "0", 0, 1, None, ""])
def test_a_non_boolean_status_stops_the_run_rather_than_being_guessed(value) -> None:
    """`bool("false")` is True, and that would mark every code active.

    The damage is invisible: `load_index` would serve inactive codes, they would
    feed bands, and the event counters would agree with the bug.
    """
    with pytest.raises(ComprasError, match="not a boolean"):
        _active(value, "statusPdm")


def test_entries_carry_no_folded_head(request) -> None:
    """Heads are recomputed at load time, never stored — see `load_index`."""
    row = {"codigoPdm": 7, "nomePdm": "PAPEL ALCALINO", "statusPdm": True,
           "codigoClasse": 1, "nomeClasse": "c", "codigoGrupo": 2, "nomeGrupo": "g"}
    entry = _pdm_entry(row)
    assert entry[0] == 7
    assert entry[1] == "PAPEL ALCALINO"
    assert entry[-1] is True
    assert not any(isinstance(v, list) for v in entry)


def test_a_service_entry_refuses_a_non_boolean_status() -> None:
    with pytest.raises(ComprasError, match="not a boolean"):
        _service_entry({"codigoServico": 1, "nomeServico": "X", "statusServico": "S"})


# ------------------------------------------------- the walk-level guard

def test_a_walk_where_everything_is_active_is_refused() -> None:
    pdm = [{"statusPdm": True}, {"statusPdm": True}]
    service = [{"statusServico": True}, {"statusServico": False}]
    with pytest.raises(ComprasError, match="every code came back active"):
        _assert_discriminating(pdm, service)


def test_a_walk_that_discriminates_returns_its_counts() -> None:
    pdm = [{"statusPdm": True}, {"statusPdm": False}]
    service = [{"statusServico": True}, {"statusServico": False}]
    assert _assert_discriminating(pdm, service) == (1, 1)


def test_the_guard_fires_on_either_vocabulary() -> None:
    """Both halves are checked, so one broken parse cannot hide behind the other."""
    good_pdm = [{"statusPdm": True}, {"statusPdm": False}]
    all_active_service = [{"statusServico": True}]
    with pytest.raises(ComprasError):
        _assert_discriminating(good_pdm, all_active_service)


# ------------------------------------------------- the unknown kind

@pytest.mark.parametrize("kind", [None, "", "X", "m", "s"])
def test_an_unknown_kind_is_recorded_rather_than_coerced_to_material(kind) -> None:
    """`tender_items.kind` is nullable, and coercion would make a wrong band
    MORE likely: materials resolve `exact` at 18.7% against services' 8.1%, so a
    service matched against PDM heads is more likely to produce a confident
    answer, not less.
    """
    assert kind not in ("M", "S")
    r = Resolution(None, "unknown_kind", 0, 0)
    assert r.band_eligible is False
    assert r.code is None


def test_the_matcher_version_is_recorded_and_names_its_cap() -> None:
    """The band's measured accuracy is a property of the population this cap
    selects, so a stored row has to say which matcher produced it."""
    assert str(MATCH_CAP) in MATCHER_VERSION


# ------------------------------- the cap symmetry this file's sibling broke

def test_a_long_catalogue_name_can_still_match_exactly() -> None:
    """The regression that made 41.1% of active CATSER unreachable.

    With the catalogue head stored at 12 words and the item head capped at 4,
    compared by equality, any catalogue name folding to 5+ head words could
    never produce an `exact` match — so an item whose description IS the
    catalogue name resolved as `prefix_rev` and was not band-eligible.
    """
    name = "SERVICO MANUTENCAO PREVENTIVA CORRETIVA ELEVADOR"
    entry = CatalogEntry(code=500, name=name,
                         head=tuple(product_head(name, MATCH_CAP)),
                         words=tuple(all_words(name)))
    assert len(entry.head) == 5          # longer than HEAD_WORDS, deliberately
    r = resolve_description(CatalogIndex([entry]), name)
    assert (r.rule, r.code) == ("exact", 500)
    assert r.band_eligible is True
