"""The catalogue price base (card B35). **No network and no database.**

The HTTP half runs on `httpx.MockTransport`, as `test_compras.py` does; the SQL
half runs against a fake connection that records the statement and the
parameters, so what is pinned is *the values that reach the database* rather than
strings that happen to appear in a source file. `CLAUDE.md` §4b: a `grep` that
finds a word inside a comment reads as confirmation and proves nothing.

What each group is for:

* **the gates** — that the three constants and the interpolation still agree with
  `apps/web/lib/radar/price-band.ts`, which is the only validated component we
  own and the code the measured 56% hit rate was produced by;
* **the collapse** — that one purchase contributes one *real* price, because an
  interpolated figure is a price nobody paid and a thin rung prints it;
* **privacy** — that no supplier identifier survives anywhere. `niFornecedor` is
  a CNPJ *or a CPF*, and this is the single most important rule in the card;
* **the walk** — that an empty read raises, a truncated read writes no band, and
  a window the API silently ignored is caught rather than believed;
* **the job** — that only `rule = 'exact'` feeds a band, that the alarm is "0
  refreshed" and never "0 queued", and that a refusal is a row.
"""

from __future__ import annotations

import dataclasses
import itertools
import json
import math
import re
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from licitaqui import breaker as breaker_module
from licitaqui import catalog_prices as job_module
from licitaqui import compras as compras_module
from licitaqui.breaker import CircuitOpen, get_breaker
from licitaqui.catalog_match import BAND_ELIGIBLE_RULES
from licitaqui.compras import (
    PAGE_SIZE,
    PRICE_PATHS,
    PRICE_ROW_FIELDS,
    WALK_DRIFT_TOLERANCE,
    ComprasClient,
    ComprasError,
    PriceWalk,
)
from licitaqui.price_band import (
    MAX_AGE_MONTHS,
    MAX_SAMPLES_SHOWN,
    MAX_SPREAD,
    MIN_SAMPLE,
    REFUSED_NO_ROWS,
    REFUSED_SPREAD_TOO_WIDE,
    REFUSED_TOO_FEW_PURCHASES,
    REFUSED_TOO_OLD,
    Band,
    PurchasePrice,
    Refusal,
    collapse_by_purchase,
    compute_band,
    is_usable_price,
    percentile,
    shift_months_back,
)

TODAY = date(2026, 10, 3)
FRESH = date(2026, 9, 1)


@pytest.fixture(autouse=True)
def _fresh_breakers():
    """Breakers and the request spacing are both process-wide."""
    from licitaqui import compras

    breaker_module.reset_all()
    original = compras.MIN_INTERVAL[0]
    compras.MIN_INTERVAL[0] = 0.0
    yield
    compras.MIN_INTERVAL[0] = original
    breaker_module.reset_all()


# ========================================================= the gate constants

PRICE_BAND_TS = (
    Path(__file__).resolve().parents[2] / "apps" / "web" / "lib" / "radar" / "price-band.ts"
)


def _ts_constant(source: str, name: str) -> str | None:
    found = re.search(rf"export const {name} = ([0-9]+(?:\.[0-9]+)?)\b", source)
    return found.group(1) if found else None


def test_the_gate_constants_have_not_drifted_from_price_band_ts() -> None:
    """The mirror, held by this test and by nothing else.

    `price_band.py` retypes four numbers that `price-band.ts` owns, and the
    worker image does not ship `apps/web` so it cannot import them. This is the
    whole safeguard, which is why it **asserts it extracted every value before
    comparing any**: a regex that matched nothing would compare nothing and pass,
    which is `CLAUDE.md` §4b's "a `replace` that matched nothing prints success".
    """
    assert PRICE_BAND_TS.is_file(), f"{PRICE_BAND_TS} is the source of these gates"
    source = PRICE_BAND_TS.read_text(encoding="utf-8")

    extracted = {
        name: _ts_constant(source, name)
        for name in ("MIN_SAMPLE", "MAX_SPREAD", "MAX_AGE_MONTHS", "MAX_SAMPLES_SHOWN")
    }
    missing = [name for name, value in extracted.items() if value is None]
    assert not missing, (
        f"could not read {missing} out of {PRICE_BAND_TS.name} — the drift check "
        "did not run, so do not read this test passing as agreement"
    )

    assert float(extracted["MIN_SAMPLE"]) == MIN_SAMPLE
    assert float(extracted["MAX_SPREAD"]) == MAX_SPREAD
    assert float(extracted["MAX_AGE_MONTHS"]) == MAX_AGE_MONTHS
    assert float(extracted["MAX_SAMPLES_SHOWN"]) == MAX_SAMPLES_SHOWN


def test_the_drift_check_would_notice_a_different_value() -> None:
    """The mutation, asserted as code rather than as a string in a file.

    Without this, a regex that silently stopped matching the real declarations
    would leave the test above comparing nothing. Here the extractor is run
    against a deliberately altered source and must disagree.
    """
    altered = "export const MIN_SAMPLE = 3\n"
    assert _ts_constant(altered, "MIN_SAMPLE") == "3"
    assert float(_ts_constant(altered, "MIN_SAMPLE")) != MIN_SAMPLE


def test_the_percentile_interpolates_the_way_the_typescript_does() -> None:
    """Pinned on values where a different convention gives a different answer.

    `statistics.quantiles` and numpy's default both disagree with the
    TypeScript's `(n-1) * fraction` positioning, so this is not a tautology — it
    is the reason :func:`percentile` is written out rather than imported.
    """
    assert percentile([5.0], 0.5) == 5.0
    assert percentile([1.0, 2.0, 3.0, 4.0], 0.25) == 1.75
    assert percentile([1.0, 2.0, 3.0, 4.0], 0.5) == 2.5
    assert percentile([1.0, 2.0, 3.0, 4.0], 0.75) == 3.25
    assert percentile([10.0, 10.5, 11.0, 11.5, 12.0], 0.25) == 10.5


def test_the_age_cutoff_reproduces_javascripts_month_rollover() -> None:
    """`setMonth` does not clamp, and the cutoff is a gate.

    2026-03-31 minus 18 months is 2024-09-31, which JavaScript rolls to
    2024-10-01. Clamping to 2024-09-30 would silently admit a day's worth of
    purchases the TypeScript excludes.
    """
    assert shift_months_back(date(2026, 3, 31), 18) == date(2024, 10, 1)
    assert shift_months_back(date(2026, 10, 3), 18) == date(2025, 4, 3)
    # Feb 2026 has 28 days, so Feb 31 rolls three days into March — and in a
    # leap year it rolls two. Clamping would give 2026-02-28 and 2024-02-29.
    assert shift_months_back(date(2026, 3, 31), 1) == date(2026, 3, 3)
    assert shift_months_back(date(2024, 3, 31), 1) == date(2024, 3, 2)
    # Crossing a year boundary, and the one case that proves the roll can only
    # ever land inside the target year: November has 30 days, so the 31st rolls
    # into December — December itself has 31 and can never overflow.
    assert shift_months_back(date(2026, 1, 31), 2) == date(2025, 12, 1)


# ============================================== one price per purchase, real


def _lot(
    id_compra: str,
    item_number: int,
    price: float,
    *,
    description: str | None = None,
    unit: str | None = "UN",
) -> job_module.PriceLot:
    return job_module.PriceLot(
        id_compra=id_compra,
        item_number=item_number,
        unit_price=price,
        purchased_on=FRESH,
        supply_unit=unit,
        catalog_item_code=458192,
        description=description,
    )


def _collapse(lots: list[job_module.PriceLot]):
    """The representatives: each one a real row **and** that purchase's median."""
    return collapse_by_purchase(
        lots, purchase_of=lambda r: r.id_compra, price_of=lambda r: r.unit_price
    )


def _reps(lots: list[job_module.PriceLot]) -> list[job_module.PriceLot]:
    return [rep.row for rep in _collapse(lots)]


def test_the_collapse_picks_a_real_row_and_never_an_average() -> None:
    """Two lots at 10 and 20 collapse to **10**, not to 15.

    15 is the defect `priceEvidence`'s comment describes: a figure nobody paid,
    printed beside a third row's words. The lower-middle row by price is the
    same choice made among rows that exist.
    """
    collapsed = _collapse([_lot("c1", 1, 10.0), _lot("c1", 2, 20.0)])
    assert [rep.row.unit_price for rep in collapsed] == [10.0]
    # And the purchase's median — the other number, 15, which the band uses and
    # which no rung may print because nobody paid it.
    assert [rep.median for rep in collapsed] == [15.0]


def test_the_chosen_row_keeps_its_own_words_and_its_own_unit() -> None:
    """The description has to belong to the price printed beside it."""
    rows = [
        _lot("c1", 1, 20.0, description="CADERNO CAPA DURA", unit="CX"),
        _lot("c1", 2, 10.0, description="CADERNO BROCHURA", unit="UN"),
    ]
    (chosen,) = _reps(rows)
    assert (chosen.unit_price, chosen.description, chosen.supply_unit) == (
        10.0,
        "CADERNO BROCHURA",
        "UN",
    )


def test_a_registro_de_precos_with_forty_eight_lots_counts_once() -> None:
    """The measured worst case: 47.8 rows for one `idCompra`."""
    lots = [_lot("c1", n, 1.20 + n / 1000) for n in range(48)]
    assert len(_collapse(lots)) == 1


def test_the_collapse_is_stable_so_a_refresh_rewrites_nothing() -> None:
    """Ties on price must resolve the same way every pass, or an idempotent
    refresh would churn storage for no change."""
    rows = [_lot("c1", 7, 10.0), _lot("c1", 3, 10.0), _lot("c1", 9, 10.0)]
    first = _reps(rows)
    assert [r.item_number for r in first] == [r.item_number for r in _reps(rows)]


@pytest.mark.parametrize(
    "value",
    [
        0,
        0.0,
        -1,
        -0.01,
        None,
        "10",
        "1830.00",
        "1.830,00",
        {"v": 1},
        [1],
        float("nan"),
        float("inf"),
        True,
        False,
    ],
)
def test_a_non_price_never_reaches_storage(value) -> None:
    """`Number.isFinite(v) && v > 0`, applied at ingest **through the path**.

    This test used to call `_lot()` — building a `StoredPrice` by hand — so
    `parse_rows` was never asked about a string price, and it turned out to
    *coerce* one: `float("1830.00")` stored 1830.0 although `is_usable_price`
    rejects a string, and `float("1.830,00")` raised and killed the whole code's
    refresh over one row. §4b's "the test exercised the unit, not the path",
    exactly. It now goes through `parse_rows`.

    Moving the TypeScript's own filter to ingest is also what makes `too_old`
    truthful: with junk already gone, age is the only thing the freshness filter
    removes, so an empty fresh set means the rows are old rather than unusable.
    """
    assert is_usable_price(value) is False
    assert job_module.parse_rows([{**RAW_ROW, "precoUnitario": value}]) == []
    assert _collapse([_lot("c1", 1, value)]) == []  # type: ignore[arg-type]


def test_a_numeric_price_as_a_string_is_refused_and_does_not_crash() -> None:
    """Both halves of the defect, named apart.

    A Brazilian-formatted price must not raise (it killed the refresh), and a
    dot-decimal string must not be quietly coerced into storage (it falsified
    the module's own claim that a non-price never reaches it).
    """
    assert job_module.parse_rows([{**RAW_ROW, "precoUnitario": "1.830,00"}]) == []
    assert job_module.parse_rows([{**RAW_ROW, "precoUnitario": "1830.00"}]) == []
    assert job_module.parse_rows([{**RAW_ROW, "precoUnitario": 1830.0}])[0].unit_price == 1830.0


# ========================================================= the band and gates


def _purchases(prices: list[float], *, on: date = FRESH) -> list[PurchasePrice]:
    """Purchases carrying **medians**, which is the only price the band's input
    type has a field for — see `PurchasePrice`."""
    return [
        PurchasePrice(id_compra=f"c{i}", median_price=p, purchased_on=on)
        for i, p in enumerate(prices)
    ]


def test_five_tight_purchases_produce_the_quartiles_the_typescript_would() -> None:
    band = compute_band(_purchases([10.0, 10.5, 11.0, 11.5, 12.0]), today=TODAY)
    assert isinstance(band, Band)
    assert (band.low, band.median, band.high, band.n_purchases) == (10.5, 11.0, 11.5, 5)


def test_a_wide_spread_is_refused_and_the_reason_is_recorded() -> None:
    """99% of all refusals (182 of 183, measured), so this is the column's job."""
    outcome = compute_band(_purchases([1.0, 5.0, 10.0, 50.0, 100.0]), today=TODAY)
    assert outcome == Refusal(reason=REFUSED_SPREAD_TOO_WIDE, n_purchases=5)


def test_the_spread_gate_is_applied_at_exactly_max_spread() -> None:
    """A band at the boundary passes; `priceBand` refuses only *above* it."""
    # IQR/median = (12 - 8) / 10 = 0.4 < MAX_SPREAD, and 0.5 is the boundary.
    assert isinstance(compute_band(_purchases([6.0, 8.0, 10.0, 12.0, 14.0]), today=TODAY), Band)
    # (12.5 - 7.5) / 10 = 0.5 exactly — not greater than, so still a band.
    assert isinstance(compute_band(_purchases([5.0, 7.5, 10.0, 12.5, 15.0]), today=TODAY), Band)
    assert MAX_SPREAD == 0.5


def test_four_purchases_are_too_few() -> None:
    outcome = compute_band(_purchases([10.0, 10.5, 11.0, 11.5]), today=TODAY)
    assert outcome == Refusal(reason=REFUSED_TOO_FEW_PURCHASES, n_purchases=4)
    assert MIN_SAMPLE == 5


def test_lots_cannot_disarm_the_spread_gate() -> None:
    """`priceBand`'s own worked example, and it must not come back.

    A registro de preços split into 40 lots at R$ 1,20 beside four purchases at
    R$ 2,40–2,60. Quartiles over *rows* would make p25, median and p75 all 1.20
    with a spread of zero — a band at a fifth of what four of the five payers
    actually paid. Collapsed per purchase, the lots are one observation.
    """
    lots = [("c0", 1.20 + n / 10_000) for n in range(40)]
    others = [("c1", 2.40), ("c2", 2.50), ("c3", 2.55), ("c4", 2.60)]
    collapsed = collapse_by_purchase(
        [_lot(cid, i, price) for i, (cid, price) in enumerate(lots + others)],
        purchase_of=lambda r: r.id_compra,
        price_of=lambda r: r.unit_price,
    )
    assert len(collapsed) == 5
    band = compute_band(
        [PurchasePrice(rep.row.id_compra, rep.median, rep.row.purchased_on) for rep in collapsed],
        today=TODAY,
    )
    assert isinstance(band, Band)
    assert band.median == pytest.approx(2.50)
    assert band.median > 2.0, "the 40 lots must not drag the median to 1.20"


def test_everything_past_the_age_gate_is_too_old_and_not_no_rows() -> None:
    """Two different findings: nobody buys this, versus nobody buys it *now*."""
    stale = date(2024, 1, 1)
    outcome = compute_band(_purchases([10.0] * 6, on=stale), today=TODAY)
    assert outcome == Refusal(reason=REFUSED_TOO_OLD, n_purchases=0)
    assert MAX_AGE_MONTHS == 18


def test_nothing_stored_at_all_is_no_rows() -> None:
    """A genuine answer: ~6% of needed codes have no purchases in 18 months."""
    assert compute_band([], today=TODAY) == Refusal(reason=REFUSED_NO_ROWS, n_purchases=0)


def test_a_null_purchase_date_counts_as_fresh_like_the_typescript() -> None:
    outcome = compute_band(_purchases([10.0, 10.5, 11.0, 11.5, 12.0], on=None), today=TODAY)
    assert isinstance(outcome, Band)


def test_a_broken_invariant_is_collapsed_by_the_group_median() -> None:
    """**Makes the defensive collapse observable, which it was not.**

    `compute_band` runs `collapse_by_purchase` over its input as a guard for the
    case where one purchase somehow has several stored rows — a partly applied
    prune, a hand fix. With the invariant intact the group is a single row and
    *every* way of picking from it agrees, so the guard's own choice was
    untestable: a mutation swapping the group median for the representative row
    passed the whole suite, including the conformance fixture.

    The authority groups rows per purchase and takes `percentile(rows, 0.5)` of
    the group. Two rows at 200 and 1000 are therefore **600**, not 200 — and 200
    is the lower-middle row, which is the card's own defect class reappearing
    inside the guard written against it. This is the test that can tell.
    """
    duplicated = [
        PurchasePrice(id_compra="dup", median_price=200.0, purchased_on=FRESH),
        PurchasePrice(id_compra="dup", median_price=1000.0, purchased_on=FRESH),
        *_purchases([300.0, 400.0, 500.0, 700.0]),
    ]
    band = compute_band(duplicated, today=TODAY)
    assert isinstance(band, Band)
    assert band.n_purchases == 5, "the duplicate pair is one purchase"
    # The pair contributes its group median, 600, so the sorted values are
    # [300, 400, 500, 600, 700]. Taking the lower-middle row instead would
    # contribute 200 and give [200, 300, 400, 500, 700] — a band at every
    # quartile, with no gate refusing it and nothing in the log looking wrong.
    # The numbers are chosen so the two outcomes differ; an earlier version of
    # this test used values where they coincided, and a mutation swapping the
    # two passed all 153 tests.
    assert (band.low, band.median, band.high) == (400.0, 500.0, 600.0)
    assert band.median != 400.0, "400 is what the representative row would give"


def test_a_refusal_outside_the_vocabulary_cannot_be_constructed() -> None:
    """The worker has no type checker, so the constructor is the gate.

    A reason the product cannot explain must not be writable to the column at
    all — the same argument `Resolution.__post_init__` makes for match rules.
    """
    with pytest.raises(ValueError, match="unknown refusal reason"):
        Refusal(reason="spread_a_bit_wide", n_purchases=9)


def test_n_purchases_describes_the_sample_the_gate_was_applied_to() -> None:
    """Fresh purchases only — a stored row the age gate dropped is not evidence
    the band rests on, so counting it would make the row describe a different
    sample than it came from."""
    mixed = _purchases([10.0, 10.5, 11.0, 11.5, 12.0]) + _purchases(
        [99.0, 99.0], on=date(2023, 1, 1)
    )
    band = compute_band(mixed, today=TODAY)
    assert isinstance(band, Band)
    assert band.n_purchases == 5


# ====================================================== no supplier, anywhere

#: A realistic row, with the supplier fields replaced by sentinels so their
#: presence anywhere downstream is detectable. The other field values are the
#: real shapes measured against the live API on 2026-10-03.
SUPPLIER_CNPJ = "SENTINEL-NI-11222333000181"
SUPPLIER_NAME = "SENTINEL-NOME-FORNECEDOR"
SUPPLIER_CPF = "SENTINEL-NI-12345678909"

RAW_ROW = {
    "idCompra": 92990906001072026,
    "dataCompra": "2026-09-28",
    "idItemCompra": 12857375,
    "numeroItemCompra": 2,
    "niFornecedor": SUPPLIER_CNPJ,
    "nomeFornecedor": SUPPLIER_NAME,
    "codigoItemCatalogo": 458192,
    "quantidade": 1.0,
    "precoUnitario": 1830.0,
    "descricaoItem": "APARELHO AR CONDICIONADO, CAPACIDADE REFRIGERACAO: 12.000 BTU",
    # Measured: the *medida* fields are frequently null while the *fornecimento*
    # ones carry the unit.
    "siglaUnidadeFornecimento": "UN",
    "nomeUnidadeFornecimento": "UNIDADE",
    "siglaUnidadeMedida": None,
    "nomeUnidadeMedida": None,
    "codigoUasg": "929909",
    "nomeUasg": "EPB-ASSEMBLEIA LEGISLATIVA DA PARAIBA",
    "estado": "PB",
    "codigoPdm": "13768",
    "nomePdm": "APARELHO AR CONDICIONADO",
}


def test_no_supplier_identifier_survives_the_parse() -> None:
    """`niFornecedor` is a CNPJ **or a CPF**, and `CLAUDE.md` forbids both.

    Asserted over every field of the parsed row rather than by naming the two
    columns, so a future field that happened to carry one would fail here too.
    """
    individual = {**RAW_ROW, "idCompra": 1, "niFornecedor": SUPPLIER_CPF}
    parsed = job_module.parse_rows([RAW_ROW, individual])
    assert len(parsed) == 2
    values = [str(value) for row in parsed for value in dataclasses.asdict(row).values()]
    for sentinel in (SUPPLIER_CNPJ, SUPPLIER_CPF, SUPPLIER_NAME):
        assert not any(sentinel in value for value in values), values


def test_the_stored_tuple_has_nowhere_to_put_a_supplier() -> None:
    """Structural, not vigilant: a leak would have to be a new column.

    The same argument `price-band.ts` makes for `LockedEvidence` having no price
    field — there it is checked by `tsc`, here by this assertion over the
    dataclass itself.
    """
    for shape, expected in (
        (
            job_module.PriceLot,
            {
                "id_compra",
                "item_number",
                "unit_price",
                "purchased_on",
                "supply_unit",
                "catalog_item_code",
                "description",
            },
        ),
        (
            job_module.StoredPrice,
            {
                "id_compra",
                "item_number",
                "unit_price",
                "unit_price_median",
                "purchased_on",
                "supply_unit",
                "catalog_item_code",
                "description",
            },
        ),
    ):
        names = {field.name for field in dataclasses.fields(shape)}
        assert names == expected, shape
        assert not any("fornecedor" in name or "supplier" in name or name == "ni" for name in names)


def test_the_insert_statement_writes_exactly_the_minimal_tuple() -> None:
    """Read off the SQL as a column list, not searched for as a substring.

    `CLAUDE.md` §4b: a `grep` that finds a word in a comment reads as
    confirmation. This parses the statement's own column list and compares the
    whole set, so an added supplier column fails rather than going unnoticed.
    """
    columns = re.search(
        r"insert into catalog_prices\s*\((.*?)\)", job_module.INSERT_PRICES_SQL, re.S
    )
    assert columns is not None
    named = {part.strip() for part in columns.group(1).split(",")}
    assert named == {
        "kind",
        "code",
        "id_compra",
        "item_number",
        "unit_price",
        "unit_price_median",
        "purchased_on",
        "supply_unit",
        "catalog_item_code",
        "description",
        "fetched_at",
    }


def test_the_supply_unit_reads_the_field_that_is_actually_populated() -> None:
    """Measured on a real row: `siglaUnidadeMedida` was null, the other was 'UN'.

    Reading only the obvious-looking field would have stored nulls for every
    row and nothing would have failed.
    """
    (row,) = job_module.parse_rows([RAW_ROW])
    assert row.supply_unit == "UN"
    fallback = {**RAW_ROW, "siglaUnidadeFornecimento": None, "siglaUnidadeMedida": "KG"}
    assert job_module.parse_rows([fallback])[0].supply_unit == "KG"
    blank = {**RAW_ROW, "siglaUnidadeFornecimento": "  ", "siglaUnidadeMedida": None}
    assert job_module.parse_rows([blank])[0].supply_unit is None


def test_a_row_with_no_purchase_or_item_identity_is_dropped() -> None:
    """There would be no primary key, and a synthesised one would collide."""
    assert job_module.parse_rows([{**RAW_ROW, "idCompra": None}]) == []
    assert job_module.parse_rows([{**RAW_ROW, "numeroItemCompra": None}]) == []
    assert job_module.parse_rows([{**RAW_ROW, "numeroItemCompra": "two"}]) == []


def test_a_numeric_code_arriving_as_a_string_is_still_read() -> None:
    """Measured: `codigoItemCatalogo` is an int and `codigoPdm` is a string, on
    the same row. Neither may be assumed, and a value that is neither is dropped
    rather than coerced — a wrong `catalog_item_code` mis-attributes a price."""
    assert (
        job_module.parse_rows([{**RAW_ROW, "codigoItemCatalogo": "458192"}])[0].catalog_item_code
        == 458192
    )
    assert (
        job_module.parse_rows([{**RAW_ROW, "codigoItemCatalogo": "4581-x"}])[0].catalog_item_code
        is None
    )
    assert (
        job_module.parse_rows([{**RAW_ROW, "codigoItemCatalogo": True}])[0].catalog_item_code
        is None
    )


# ============================================================== the page walk


def _price_page(rows: list[dict], total: int, pages: int | None = None) -> httpx.Response:
    """A page body. ``pages`` defaults to the count the row total implies.

    Defaulted rather than spelled out in every fixture because the walk now
    *derives* the page count and refuses a `totalPaginas` that contradicts the
    row count — so a fixture inventing an inconsistent pair would be testing the
    guard rather than whatever the test is about.
    """
    if pages is None:
        pages = -(-total // PAGE_SIZE)
    return httpx.Response(
        200, json={"resultado": rows, "totalRegistros": total, "totalPaginas": pages}
    )


def _paged(total: int):
    """A handler that serves ``total`` rows in full pages, like the real API."""

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["pagina"])
        offset = (page - 1) * PAGE_SIZE
        count = max(0, min(PAGE_SIZE, total - offset))
        return _price_page(_rows(count), total)

    return handler


def _client(handler) -> ComprasClient:
    return ComprasClient(
        transport=httpx.MockTransport(handler), attempts=2, sleep=lambda _seconds: None
    )


_ROW_SEQ = itertools.count(1)


def _row(day: str | None = "2026-09-15", **over) -> dict:
    """A price row with a **distinct** identity.

    Distinct because the walk now counts `(idCompra, numeroItemCompra)` pairs
    rather than rows: a pagination fault that serves page 1 again for page 2
    gives `len(rows) == total` and used to pass with 500 duplicates standing in
    for 500 unread purchases. The first version of these fixtures was
    `[_row()] * n` — identical rows — and the new guard caught them, which is
    the check working on its author.
    """
    return {**RAW_ROW, "idCompra": next(_ROW_SEQ), "numeroItemCompra": 1, "dataCompra": day, **over}


def _rows(count: int) -> list[dict]:
    return [_row() for _ in range(count)]


def test_the_walk_sends_both_date_bounds_because_one_alone_is_ignored() -> None:
    """Measured 2026-10-03: `dataCompraInicio` alone returned the same 30 616
    rows as an unfiltered request, including rows two months outside the window,
    with HTTP 200. An incremental refresh built on it would re-walk 18 months
    while its log said otherwise."""
    seen: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.url.params))
        return _price_page([_row()], 1, 1)

    client = _client(handler)
    client.walk_prices("M", 13768, start=date(2026, 9, 1), end=date(2026, 9, 30))
    assert seen[0]["dataCompraInicio"] == "2026-09-01"
    assert seen[0]["dataCompraFim"] == "2026-09-30"
    assert seen[0]["tipo"] == "codigoPdm"
    assert seen[0]["codigo"] == "13768"
    assert seen[0]["tamanhoPagina"] == str(PAGE_SIZE)
    client.close()


def test_the_walk_raises_when_the_api_ignored_the_window() -> None:
    """The guard for the measured trap, and it has to be code: nothing in the
    response says the filter was dropped."""
    client = _client(lambda r: _price_page([_row("2026-07-29")], 1, 1))
    with pytest.raises(ComprasError, match="ignored the window"):
        client.walk_prices("M", 13768, start=date(2026, 9, 1), end=date(2026, 9, 30))
    client.close()


def test_a_row_with_an_unparseable_date_is_not_evidence_either_way() -> None:
    client = _client(lambda r: _price_page([_row(None), _row("2026-09-15")], 2, 1))  # type: ignore[arg-type]
    walk = client.walk_prices("M", 13768, start=date(2026, 9, 1), end=date(2026, 9, 30))
    assert len(walk.rows) == 2
    client.close()


def test_the_walk_raises_when_it_collected_nothing_despite_reported_rows() -> None:
    """`CLAUDE.md`: an empty result is a broken run, not a finding of zero."""
    client = _client(lambda r: _price_page([], 900, 2))
    with pytest.raises(ComprasError, match="collected none"):
        client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    client.close()


def test_a_short_read_beyond_the_drift_tolerance_raises() -> None:
    client = _client(lambda r: _price_page([_row()], 400))
    with pytest.raises(ComprasError, match="short by more than"):
        client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    client.close()


def test_a_single_empty_page_is_not_a_complete_walk() -> None:
    """**The defect a one-page tolerance hid, and the reason it is now 5 rows.**

    The first version tolerated `PAGE_SIZE`, so one page coming back empty — or
    404ing, which `get` turns into an empty body — lost exactly 500 rows and
    `total - 500 < total - 500` was false. No raise, `complete=True`, and a band
    computed and stored over the surviving sample with `refused_reason` null and
    nothing counting it. On a median code that is ~70% of the evidence gone, and
    a shrunken sample makes `MAX_SPREAD` *more* likely to pass.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["pagina"])
        rows = _rows(PAGE_SIZE) if page == 1 else []
        return _price_page(rows, 1000)

    client = _client(handler)
    with pytest.raises(ComprasError, match="short by more than"):
        client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    client.close()


def test_a_shortfall_inside_the_drift_tolerance_is_accepted() -> None:
    """Unlike the vocabulary walk, which demands exact equality: a purchase
    inserted mid-walk can shift a row across a page boundary. The tolerance is a
    handful of rows, which is what the measured insert rate supports — **not** a
    page, which is what it used to be."""
    total = 400
    client = _client(lambda r: _price_page(_rows(total - WALK_DRIFT_TOLERANCE), total))
    walk = client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    assert walk.complete is True
    assert len(walk.rows) == total - WALK_DRIFT_TOLERANCE
    client.close()


def test_a_missing_page_count_does_not_read_as_one_complete_page() -> None:
    """`totalPaginas` absent or zero beside a non-zero `totalRegistros` used to
    mean `min(0, max_pages) == 0`: the page loop never ran, only page 1 was
    read, and `0 <= max_pages` declared the walk finished. Up to 999 rows became
    500 with a band over half of them. The count is now derived from the rows."""
    seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["pagina"])
        seen.append(page)
        offset = (page - 1) * PAGE_SIZE
        count = max(0, min(PAGE_SIZE, 900 - offset))
        # `totalPaginas` omitted entirely, which is the shape being guarded.
        return httpx.Response(200, json={"resultado": _rows(count), "totalRegistros": 900})

    client = _client(handler)
    walk = client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    assert seen == [1, 2]
    assert len(walk.rows) == 900
    assert walk.complete is True
    client.close()


def test_a_page_count_contradicting_the_row_count_raises() -> None:
    """The module exists because this API lies by omission — the
    `dataCompraInicio` finding — so a `totalPaginas` that does not follow from
    `totalRegistros` is refused rather than guessed between."""
    client = _client(lambda r: _price_page([_row()], 100, pages=7))
    with pytest.raises(ComprasError, match="which is not 1 pages"):
        client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    client.close()


def test_the_walk_returns_only_the_whitelisted_fields() -> None:
    """**The privacy boundary, and it is about tracebacks, not storage.**

    `StoredPrice` has nowhere to put a supplier, which protects the database and
    does nothing about Sentry: `init_sentry` passes `send_default_pii=False`,
    which leaves `include_local_variables` at its default `True`, so the locals
    of every frame in a traceback are serialised and sent. A raw payload left
    alive as a local of the refresh job would therefore reach a third-party
    error tracker on any ordinary database failure — and no test could see it,
    because Sentry is not initialised under pytest.

    So the projection happens at the HTTP boundary and this is what pins it.
    """
    client = _client(lambda r: _price_page([_row()], 1))
    walk = client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    assert set(walk.rows[0]) == set(PRICE_ROW_FIELDS)
    for sentinel in (SUPPLIER_CNPJ, SUPPLIER_CPF, SUPPLIER_NAME):
        assert not any(sentinel in str(value) for row in walk.rows for value in row.values())
    assert not any(
        "ornecedor" in field for field in PRICE_ROW_FIELDS if field != "siglaUnidadeFornecimento"
    )
    client.close()


def test_a_404_is_a_genuine_absence_and_never_a_failure() -> None:
    client = _client(lambda r: httpx.Response(404, json={}))
    walk = client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    assert (walk.total, walk.rows, walk.complete) == (0, [], True)
    assert get_breaker("compras-pesquisa-preco").state == "closed"
    client.close()


def test_a_genuine_zero_is_an_answer_rather_than_a_broken_walk() -> None:
    """~6% of needed codes really have no rows in 18 months (measured, verified
    by re-asking over 5 years), and a blocked connection raises instead."""
    client = _client(lambda r: _price_page([], 0, 0))
    walk = client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    assert (walk.total, walk.complete) == (0, True)
    client.close()


def test_the_walk_follows_every_page() -> None:
    client = _client(_paged(1200))
    walk = client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY, max_pages=10)
    assert len(walk.rows) == 1200
    assert walk.pages_read == 3
    assert walk.complete is True
    client.close()


def test_the_page_cap_reports_the_walk_incomplete_rather_than_pretending() -> None:
    """Truncation costs coverage — codes read to full depth banded at 11.5%
    against 3.2% for ones a probe cap truncated — so it must be visible."""
    client = _client(_paged(2000))
    walk = client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY, max_pages=2)
    assert walk.pages_read == 2
    assert walk.complete is False
    assert len(walk.rows) == 2 * PAGE_SIZE
    client.close()


def test_a_repeating_page_does_not_pass_as_a_complete_walk() -> None:
    """`len(rows) == total` with 500 duplicates standing in for 500 unread
    purchases. The collapse would dedupe them and the band would be computed
    over a halved sample with `refused_reason` null — the same consequence the
    one-page tolerance had, reached a different way, so the check counts
    `(idCompra, numeroItemCompra)` identities and not rows."""
    repeated = _rows(PAGE_SIZE)

    def handler(request: httpx.Request) -> httpx.Response:
        return _price_page(repeated, 1000)  # the same 500 rows for both pages

    client = _client(handler)
    with pytest.raises(ComprasError, match="distinct items"):
        client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    client.close()


@pytest.mark.parametrize(
    "raw", ["30.616", "30,616", {"n": 1}, [1], True, False, None, 1.5, "²", "½", "", "  "]
)
def test_an_unreadable_count_never_raises_and_never_reads_as_zero(raw) -> None:
    """Two properties of `_as_count`, and both have been wrong.

    It must **not raise**, because its only caller holds a raw price payload as
    a frame local and a raised exception serialises that into Sentry. `'²'` is
    the sharp one: `str.isdigit()` is True for it while `int('²')` raises, so
    the test has to be `isdecimal()`.

    And it must **not return 0**, because `walk_prices` reads `total == 0` as
    *this code has no purchases* — so an unreadable count discarded a whole page
    of real rows and wrote `refused_reason='no_rows'`, a finding manufactured
    out of our own failure to parse a number.
    """
    assert compras_module._as_count(raw) is None


@pytest.mark.parametrize(
    "raw,expected", [(0, 0), (30616, 30616), (30616.0, 30616), ("30616", 30616), (-5, 0)]
)
def test_a_readable_count_is_read(raw, expected) -> None:
    """A JSON float is a count written sloppily; a negative one is not a count."""
    assert compras_module._as_count(raw) == expected


@pytest.mark.parametrize(
    "body",
    [
        {"resultado": [], "totalRegistros": "30.616"},  # a localized string
        {"resultado": [], "totalRegistros": {"n": 1}},  # not a scalar at all
        {"resultado": [], "totalRegistros": True},  # int(True) == 1, silently
        [],  # a top-level JSON array
    ],
)
def test_an_unreadable_count_is_refused_rather_than_recorded_as_zero(body) -> None:
    """**The walk raises; the parse frame does not.**

    That split is the whole design. `_as_count` returns ``None`` without raising,
    so the frame holding the payload stays unraisable; `walk_prices` then refuses
    in a frame that holds only projected rows. The first version returned ``0``
    here and the walk early-returned on it, so one upstream type change would
    have written `no_rows` across the whole feed at once while
    `refreshed_codes` stayed healthy — refusals are band rows.
    """
    client = _client(lambda r: httpx.Response(200, json=body))
    with pytest.raises(ComprasError, match="unreadable"):
        client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    client.close()


def test_a_full_page_beside_a_zero_count_is_a_broken_read() -> None:
    """**The dangerous pairing the earlier test never built.**

    Every fixture there paired a bad count with an *empty* `resultado`, so the
    test passed while blessing the behaviour it should have caught: rows in hand
    and a count saying there are none. One of the two is wrong, neither is a
    finding, and silently believing the count throws the page away.
    """
    client = _client(
        lambda r: httpx.Response(200, json={"resultado": _rows(PAGE_SIZE), "totalRegistros": 0})
    )
    with pytest.raises(ComprasError, match="0 while the page carried"):
        client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    client.close()


def test_a_genuine_zero_with_no_rows_is_still_an_answer() -> None:
    client = _client(lambda r: httpx.Response(200, json={"resultado": [], "totalRegistros": 0}))
    walk = client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    assert (walk.total, walk.rows, walk.complete) == (0, [], True)
    client.close()


def test_a_malformed_result_with_rows_advertised_still_raises_the_empty_walk() -> None:
    """Narrowing the types must not turn a broken body into a finding of zero.

    `resultado` unusable while `totalRegistros` says 1 is the empty-walk case,
    and `CLAUDE.md` is explicit that an empty result is not an absence. The
    raise happens in `walk_prices`, whose frame holds only projected rows — so
    refusing loudly and not leaking are both satisfied, which is the point of
    doing the narrowing one frame lower down.
    """
    client = _client(
        lambda r: httpx.Response(200, json={"resultado": "not a list", "totalRegistros": 1})
    )
    with pytest.raises(ComprasError, match="collected none"):
        client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    client.close()


def test_the_price_breaker_opens_on_http_errors_and_is_its_own() -> None:
    """A breaker is **per endpoint**, and the status check must stay inside
    `guard()`: a 503 returned from inside it would record *success* and reset the
    failure count, so the circuit could never open. That was a real defect in
    this client and `test_compras.py` pins the catalogue side of it."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503, json={})

    client = _client(handler)
    with pytest.raises(ComprasError):
        client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    assert get_breaker("compras-pesquisa-preco").state == "open"
    # The vocabulary mirror the mapper depends on is untouched by this.
    assert get_breaker("compras-catalogo").state == "closed"
    before = calls["n"]
    with pytest.raises((CircuitOpen, ComprasError)):
        client.walk_prices("M", 1, start=date(2026, 9, 1), end=TODAY)
    assert calls["n"] == before
    client.close()


def test_there_is_no_service_price_endpoint() -> None:
    """`kind='S'` costs nothing: services resolve at 22.4% and produced 0 bands
    from any source over 136 items. A path in this mapping would be an
    invitation to spend the budget on rows no screen can read."""
    assert set(PRICE_PATHS) == {"M"}
    client = _client(lambda r: _price_page([_row()], 1, 1))
    with pytest.raises(KeyError):
        client.walk_prices("S", 1, start=date(2026, 9, 1), end=TODAY)
    client.close()


# =================================================== the read-level refusals


def _walk(*, complete: bool = True, total: int = 10) -> PriceWalk:
    return PriceWalk(rows=[], total=total, pages_read=1, complete=complete)


def test_a_truncated_walk_is_the_only_thing_the_read_decides() -> None:
    assert job_module.is_truncated(_walk(complete=False)) is True
    assert job_module.is_truncated(_walk(complete=True)) is False


def test_an_empty_window_is_not_a_refusal() -> None:
    """The worst defect this file could have had.

    In the steady state most windows are empty — a month with no new purchase of
    a code is normal — so `no_rows` read off the *window* would overwrite a good
    band with "nobody buys this" every time nothing new arrived. `no_rows` is a
    statement about the stored history, and `compute_band` makes it.
    """
    assert job_module.is_truncated(_walk(total=0)) is False


def test_truncation_is_not_in_the_band_refusal_vocabulary() -> None:
    """It is not a statement about a sample, and writing it as one would delete
    a good band from the screen on the day the page cap bit."""
    from licitaqui.price_band import REFUSAL_REASONS

    assert "truncated_walk" not in REFUSAL_REASONS
    assert set(REFUSAL_REASONS) == {
        REFUSED_NO_ROWS,
        REFUSED_TOO_OLD,
        REFUSED_TOO_FEW_PURCHASES,
        REFUSED_SPREAD_TOO_WIDE,
    }


# ================================================================== the job


class _Result:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple]:
        return self._rows

    def fetchone(self) -> tuple | None:
        return self._rows[0] if self._rows else None


class FakeConn:
    """Records every statement and its parameters; answers by SQL marker.

    Deliberately not a database: what these tests have to pin is the *values
    that reach* one. Matching canned answers by a marker rather than by call
    order means a test cannot pass because two unrelated statements happened to
    swap places.
    """

    def __init__(self, answers: dict[str, list[tuple]] | None = None) -> None:
        self.calls: list[tuple[str, object]] = []
        self.batches: list[tuple[str, list]] = []
        self._answers = answers or {}

    def execute(self, sql: str, params: object = None) -> _Result:
        self.calls.append((sql, params))
        for marker, rows in self._answers.items():
            if marker in sql:
                return _Result(rows)
        return _Result([])

    def cursor(self) -> FakeConn:
        return self

    def __enter__(self) -> FakeConn:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def executemany(self, sql: str, rows: list) -> None:
        self.batches.append((sql, list(rows)))

    def events(self) -> dict[str, object]:
        """``{event name: props}`` for every `events` insert, in order.

        A helper rather than `params_for("insert into events")`, because several
        different events are written in one run — the per-code attempt marker
        and the sweep's own row — and matching the first would quietly assert
        against whichever happened to be written first.
        """
        return {
            params[0]: params[1].obj for sql, params in self.calls if "insert into events" in sql
        }

    @contextmanager
    def transaction(self):
        yield

    def params_for(self, marker: str) -> object:
        for sql, params in self.calls:
            if marker in sql:
                return params
        raise AssertionError(f"no statement containing {marker!r} was run")

    def ran(self, marker: str) -> bool:
        return any(marker in sql for sql, _ in self.calls)


class FakeCtx:
    def __init__(self, conn: FakeConn, payload: dict | None = None) -> None:
        self.conn = conn
        self._payload = payload or {}
        self.log = get_logger_stub()

    @property
    def payload(self) -> dict:
        return self._payload


def get_logger_stub():
    class _Log:
        def __init__(self) -> None:
            self.records: list[tuple[str, dict]] = []

        def info(self, message, *, extra=None) -> None:
            self.records.append((message, extra or {}))

        def warning(self, message, *, extra=None) -> None:
            self.records.append((message, extra or {}))

    return _Log()


def test_only_exact_rule_codes_are_eligible_to_feed_a_band() -> None:
    """Asserted on the parameter that reaches the database, and sourced from the
    single place the rule is written.

    A prefix match's band runs **+18.6%** against the real winning price where
    exact runs **−3.6%** — it would not fail, it would publish a biased number.
    """
    conn = FakeConn({"with demand": [(13768, 410), (4915, 12)]})
    assert job_module.stale_codes(conn) == [(13768, 410), (4915, 12)]
    params = conn.params_for("with demand")
    assert params["rules"] == sorted(BAND_ELIGIBLE_RULES)
    assert params["rules"] == ["exact"]
    assert params["kind"] == "M"


def test_the_demand_query_asks_only_about_open_editais_and_orders_by_demand() -> None:
    """The top 20% of codes carry 83.6% of resolved items, so the order is where
    most of the value comes from. Pinned on the statement's own clauses because
    there is no database here to prove it with."""
    sql = job_module.STALE_CODES_SQL
    assert "order by d.items desc" in sql
    assert "proposals_close_at > now()" in sql
    assert "c.rule = any(%(rules)s::text[])" in sql


def test_the_sweep_enqueues_one_job_per_code_and_window(monkeypatch) -> None:
    recorded: dict[str, object] = {}

    def fake_enqueue_many(conn, kind, keys, *, priority, payload_for):
        recorded.update(
            kind=kind,
            keys=list(keys),
            priority=priority,
            payloads=[payload_for(key) for key in keys],
        )
        return len(keys)

    monkeypatch.setattr(job_module, "enqueue_many", fake_enqueue_many)
    conn = FakeConn({"with demand": [(13768, 410), (4915, 12)]})
    job_module.refresh_catalog_prices(FakeCtx(conn))

    today = job_module.brt_today()
    assert recorded["kind"] == job_module.JOB_KIND
    assert recorded["keys"] == [f"M:13768:{today}", f"M:4915:{today}"]
    assert recorded["priority"] == job_module.PRICE_PRIORITY
    assert recorded["payloads"] == [{"kind": "M", "code": 13768}, {"kind": "M", "code": 4915}]


def test_a_code_is_marked_attempted_before_the_walk(monkeypatch) -> None:
    """**The marker is what bounds every failure path.**

    Staleness is read from `catalog_bands.computed_at`, and a truncated walk
    deliberately writes no band row while the short-walk, page-count and window
    guards all raise before writing one — so without a marker the code is stale
    again on tomorrow's sweep and re-burns a full walk a day, for ever, at the
    top of the demand order, producing nothing and firing no alarm.

    Written *before* the walk, so even an exception out of the client leaves it.
    """

    class Exploding:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def walk_prices(self, *_a, **_k):
            raise ComprasError("the endpoint is unwalkable")

    monkeypatch.setattr(job_module, "build_client", Exploding)
    conn = FakeConn(_watermarks(None, None))
    with pytest.raises(ComprasError):
        job_module.refresh_catalog_prices(FakeCtx(conn, {"code": 13768}))
    assert f"{job_module.ATTEMPT_EVENT_PREFIX}13768" in conn.events()


def test_the_sweep_leaves_an_events_row_even_when_it_fails() -> None:
    """**B32's failure mode, reproduced inside the function built to prevent it.**

    The row used to be written last, after three queries. A sweep that raised —
    the missing-table case, which is exactly a fresh deploy before the migration
    lands — produced *no row at all* rather than a row saying zero, so a
    watchdog phrased "alarm when `refreshed_codes` is 0" was silent for the one
    outage it existed to catch.
    """

    class Failing(FakeConn):
        def execute(self, sql, params=None):
            if "with demand" in sql:
                raise RuntimeError('relation "catalog_bands" does not exist')
            return super().execute(sql, params)

    conn = Failing()
    with pytest.raises(RuntimeError):
        job_module.refresh_catalog_prices(FakeCtx(conn))
    recorded = conn.events()["catalog_prices_swept"]
    assert recorded["failed"] is True
    # The type only: a message can carry a parameter value, and `events` is a
    # table nothing redacts.
    assert recorded["error"] == "RuntimeError"
    assert "does not exist" not in str(recorded)


def test_the_outcome_keys_are_nested_rather_than_splatted_into_the_log() -> None:
    """They come from `catalog_bands.refused_reason`, and a stdlib `LogRecord`
    raises on a reserved key — `message`, `module`, `name`. The vocabulary is
    guarded for rows this code writes and not for a hand-fixed one."""
    import logging

    conn = FakeConn(
        {"with demand": [], "group by 1": [("message", 3)], "select count(distinct code)": [(3,)]}
    )
    ctx = FakeCtx(conn)
    # A real Logger, so the failure mode is the real one rather than the stub's.
    ctx.log = logging.getLogger("test_catalog_prices_outcomes")
    job_module.refresh_catalog_prices(ctx)
    assert conn.events()["catalog_prices_swept"]["outcomes"] == {"message": 3}


def test_the_job_key_is_per_code_and_window() -> None:
    """So a sweep running twice in a day dedupes to one job per code."""
    assert job_module.job_key("M", 13768, date(2026, 10, 3)) == "M:13768:2026-10-03"
    assert job_module.job_key("M", 13768, date(2026, 10, 4)) != job_module.job_key(
        "M", 13768, date(2026, 10, 3)
    )


def test_the_sweep_alarms_on_codes_refreshed_and_never_on_codes_queued(monkeypatch) -> None:
    """B32: a feed that never enqueues also never fails, which is why it was
    invisible for two days. So the event carries both numbers and the one worth
    watching is `refreshed_codes`."""
    monkeypatch.setattr(
        job_module, "enqueue_many", lambda *a, **k: 0
    )  # nothing queued: everything is fresh
    conn = FakeConn(
        {
            "with demand": [],
            "group by 1": [("banded", 41), ("spread_too_wide", 1620), ("no_rows", 30)],
            "select count(distinct code)": [(1655,)],
        }
    )
    job_module.refresh_catalog_prices(FakeCtx(conn))

    recorded = conn.events()["catalog_prices_swept"]
    assert recorded["queued"] == 0
    # **Not the sum of the breakdown.** 41 + 1620 + 30 is 1691, and a code that
    # banded on Monday and was refused on Thursday is in two of those groups —
    # so summing them counts it twice under a key named `refreshed_codes`. The
    # first version of this test asserted the sum, which pinned the arithmetic
    # instead of questioning it.
    assert recorded["refreshed_codes"] == 1655
    assert recorded["refreshed_codes"] != 41 + 1620 + 30
    assert recorded["outcomes"]["spread_too_wide"] == 1620
    assert recorded["alarm_days"] == job_module.ALARM_DAYS
    assert recorded["band_version"] == job_module.BAND_VERSION
    assert "rep=median" in recorded["band_version"]


def test_the_refresh_summary_counts_codes_by_outcome() -> None:
    """`banded` is a band; every other key is a counted refusal. A breakdown,
    not the alarm — see the sweep test for why the two are different queries."""
    conn = FakeConn({"group by 1": [("banded", 1)]})
    assert job_module.refresh_summary(conn) == {"banded": 1}
    assert job_module.refreshed_codes(FakeConn()) == 0


def _watermarks(last_fetch: date | None, oldest: date | None):
    """`WATERMARKS_SQL`'s one row: where the last fetch was, and how old the
    oldest band-eligible stored row's `fetched_at` is."""
    return {"min(fetched_at) filter": [(last_fetch, oldest)]}


def test_a_full_depth_walk_is_triggered_by_data_and_not_by_the_calendar() -> None:
    """**The defect this replaced reached 14% of codes, and its test passed.**

    The first version asked ``today.toordinal() % 28 == code % 28`` — one day in
    28 — while a code is only looked at when it is stale, about every 7 days. 7
    divides 28, so a code's refresh days sit in one residue class mod 7 and
    could only ever meet its assigned day if the phases agreed: simulated over a
    year of weekly refreshes, **86% of codes would never have had a full-depth
    walk**. The test asserted "exactly one hit in 28 days", which is true by
    construction for every code and every calendar, and never asked whether the
    job could reach it — §4b's unit-not-path, inside a fix written for that.

    The trigger is now the oldest band-eligible row's `fetched_at`, which ages
    monotonically under incremental refreshes (they only rewrite recent
    purchases) and resets only when a full-depth walk rewrites them all. So it
    fires for **every** code at `FULL_WALK_EVERY_DAYS`, whatever the cadence.
    """
    every = job_module.FULL_WALK_EVERY_DAYS
    floor = shift_months_back(TODAY, MAX_AGE_MONTHS)

    # Freshly walked: incremental, however the code number and date interact.
    for code in range(0, 40):
        conn = FakeConn(_watermarks(TODAY - timedelta(days=1), TODAY - timedelta(days=1)))
        start, _ = job_module.window_for(conn, kind="M", code=code, today=TODAY)
        assert start != floor, f"code {code} went full depth one day after one"

    # Aged past the threshold: full depth, for every code, on every date.
    for code in range(0, 40):
        for offset in range(0, 28):
            today = TODAY + timedelta(days=offset)
            conn = FakeConn(_watermarks(today - timedelta(days=3), today - timedelta(days=every)))
            start, _ = job_module.window_for(conn, kind="M", code=code, today=today)
            assert start == shift_months_back(today, MAX_AGE_MONTHS), (
                f"code {code} on {today} did not go full depth"
            )


def test_the_full_depth_threshold_is_above_the_slowest_cadence() -> None:
    """At 28 days a deep code — refreshed monthly — would be full depth on
    *every* refresh: 62 pages a month each, for the most expensive codes in the
    corpus. The threshold has to sit above `DEEP_REFRESH_HOURS`."""
    assert job_module.FULL_WALK_EVERY_DAYS > job_module.DEEP_REFRESH_HOURS / 24


def test_no_band_eligible_rows_means_full_depth() -> None:
    """Rows exist but none inside the age gate: an incremental window could
    never reach the purchases that matter."""
    conn = FakeConn(_watermarks(TODAY - timedelta(days=1), None))
    start, _ = job_module.window_for(conn, kind="M", code=7, today=TODAY)
    assert start == shift_months_back(TODAY, MAX_AGE_MONTHS)


def test_a_purchase_is_recollapsed_over_stored_and_fetched_rows() -> None:
    """A window that catches only some of a purchase's lots must not replace the
    representative derived from all of them.

    Lots do not have to share a `dataCompra`, so a window can see a subset. The
    first version collapsed the window's rows alone and then deleted everything
    stored for those purchases, so the stored price depended on which window
    happened to catch it and the band moved between refreshes with nothing
    recording that it had.
    """
    # Stored: the purchase's cheap lot. Fetched this window: only the dear one.
    stored_rows = [("c1", 1, 10.0, FRESH, "UN", 458192, "CHEAP LOT")]
    conn = FakeConn({"supply_unit, catalog_item_code, description": stored_rows})
    merged = job_module.merge_with_stored(conn, kind="M", code=1, fetched=[_lot("c1", 2, 20.0)])
    assert [(row.id_compra, row.unit_price) for row in merged] == [("c1", 10.0)]
    assert job_module.merge_with_stored(conn, kind="M", code=1, fetched=[]) == []


def test_the_collapse_runs_once_over_the_union_and_not_twice() -> None:
    """Collapsing twice is not collapsing the union, and the difference is the
    stored price.

    A window holding lots at 10 and 30 reduces to 10 on its own; merged with a
    stored 20 that gives 10, while the lower-middle of `{10, 20, 30}` is 20. So
    `parse_rows` must **not** collapse — it used to — and `merge_with_stored`
    must be the only place it happens, or the representative depends on how the
    lots happened to be split across windows.
    """
    fetched = job_module.parse_rows(
        [
            {**RAW_ROW, "idCompra": 1, "numeroItemCompra": 1, "precoUnitario": 10.0},
            {**RAW_ROW, "idCompra": 1, "numeroItemCompra": 2, "precoUnitario": 30.0},
        ]
    )
    assert len(fetched) == 2, "parse_rows must hand over every lot"
    stored_rows = [("1", 3, 20.0, FRESH, "UN", 458192, None)]
    conn = FakeConn({"supply_unit, catalog_item_code, description": stored_rows})
    merged = job_module.merge_with_stored(conn, kind="M", code=1, fetched=fetched)
    assert [row.unit_price for row in merged] == [20.0]


def test_the_fetched_row_wins_over_a_stored_row_for_the_same_item() -> None:
    """The API is the source of truth for a price it has just restated."""
    stored_rows = [("c1", 1, 10.0, FRESH, "UN", 458192, "OLD")]
    conn = FakeConn({"supply_unit, catalog_item_code, description": stored_rows})
    merged = job_module.merge_with_stored(conn, kind="M", code=1, fetched=[_lot("c1", 1, 99.0)])
    assert [(row.item_number, row.unit_price) for row in merged] == [(1, 99.0)]


def test_the_stored_read_is_ordered_so_the_band_cannot_move_between_runs() -> None:
    """If the one-row-per-purchase invariant ever broke, `compute_band` has to
    pick between the rows — and an unordered read would make the pick depend on
    the query plan, moving the band with `n_purchases` unchanged."""
    assert "order by id_compra" in job_module.STORED_PURCHASES_SQL
    # And it reads the median column, which is the band's number. Asserted here
    # too because this is the statement the band's whole calibration rests on.
    assert "unit_price_median" in job_module.STORED_PURCHASES_SQL


def test_a_service_sweep_is_refused_before_a_single_job_is_queued(monkeypatch) -> None:
    """`STALE_CODES_SQL` would happily return CATSER codes, so refusing only in
    the per-code job would enqueue up to a thousand guaranteed failures — the
    budget spent before the first refusal fired."""

    def forbidden(*_a, **_k):
        raise AssertionError("a service sweep must not enqueue anything")

    monkeypatch.setattr(job_module, "enqueue_many", forbidden)
    with pytest.raises(RuntimeError, match="no price endpoint"):
        job_module.refresh_catalog_prices(FakeCtx(FakeConn(), {"kind": "S"}))


def test_the_two_per_purchase_numbers_are_both_kept_and_are_not_the_same() -> None:
    """**The defect this schema change exists for, pinned from both sides.**

    `priceBand` takes each purchase's *median* (`percentile(rows, 0.5)`, which
    interpolates); `priceEvidence` takes the *lower-middle real row*
    (`sorted[floor((n-1)/2)]`). For a two-row purchase those differ by a third —
    lots of 10 and 20 give 15 and 10 — and at the measured 1.87 rows per
    purchase two-row purchases are the modal multi-row case.

    An earlier version of this module conflated them and computed the band from
    the real row, which put every quartile low, in the dangerous direction for a
    number somebody bids against. Both are now stored, because the lots are
    discarded at ingest and the choice is unrecoverable afterwards.
    """
    (rep,) = _collapse([_lot("c1", 1, 10.0), _lot("c1", 2, 20.0)])
    assert rep.row.unit_price == 10.0, "the printable row: a price somebody paid"
    assert rep.median == 15.0, "the band's number: priceBand's interpolated median"
    assert rep.median == percentile([10.0, 20.0], 0.5)
    assert rep.row.unit_price != rep.median
    assert "rep=median" in job_module.BAND_VERSION


def test_a_negative_or_zero_item_number_is_refused() -> None:
    """It would become part of the primary key, and `_as_positive_int`'s own
    docstring says a value that is neither is dropped rather than coerced."""
    assert job_module.parse_rows([{**RAW_ROW, "numeroItemCompra": "-5"}]) == []
    assert job_module.parse_rows([{**RAW_ROW, "numeroItemCompra": 0}]) == []
    assert job_module.parse_rows([{**RAW_ROW, "numeroItemCompra": -2}]) == []


def test_the_first_window_reaches_back_the_age_gate_and_no_further() -> None:
    """A purchase older than the gate can never feed a band, so asking for one
    is spent budget."""
    conn = FakeConn(_watermarks(None, None))
    start, end = job_module.window_for(conn, kind="M", code=13768, today=TODAY)
    assert start == shift_months_back(TODAY, MAX_AGE_MONTHS)
    assert end == TODAY


def test_the_window_becomes_incremental_once_rows_exist() -> None:
    """What turns a 19.6-hour pass into minutes — with an overlap, because a
    row's publication lags its `dataCompra` (measured: dated 2026-09-28,
    published 2026-10-01)."""
    conn = FakeConn(_watermarks(date(2026, 9, 30), date(2026, 9, 30)))
    start, end = job_module.window_for(conn, kind="M", code=13768, today=TODAY)
    assert start == date(2026, 9, 30) - timedelta(days=job_module.REFETCH_OVERLAP_DAYS)
    assert end == TODAY


def test_the_incremental_window_never_reaches_past_the_age_gate() -> None:
    conn = FakeConn(_watermarks(date(2024, 1, 1), TODAY - timedelta(days=2)))
    start, _end = job_module.window_for(conn, kind="M", code=13768, today=TODAY)
    assert start == shift_months_back(TODAY, MAX_AGE_MONTHS)


def test_a_refused_band_is_a_row_and_never_a_missing_one() -> None:
    """`refused_reason` is a column so "spread too wide" is a counted number
    rather than something discovered on a screen."""
    conn = FakeConn()
    job_module.write_band(
        conn,
        kind="M",
        code=13768,
        window_end=TODAY,
        outcome=Refusal(reason=REFUSED_SPREAD_TOO_WIDE, n_purchases=379),
    )
    params = conn.params_for("insert into catalog_bands")
    assert params["reason"] == REFUSED_SPREAD_TOO_WIDE
    assert (params["low"], params["median"], params["high"]) == (None, None, None)
    assert params["n"] == 379
    # The column was `matcher`; the migration renamed it, because a band is per
    # code and no item matcher takes part in computing one.
    assert params["band_version"] == job_module.BAND_VERSION


def test_a_band_row_carries_the_quartiles_and_no_reason() -> None:
    conn = FakeConn()
    job_module.write_band(
        conn,
        kind="M",
        code=1,
        window_end=TODAY,
        outcome=Band(low=10.5, median=11.0, high=11.5, n_purchases=5),
    )
    params = conn.params_for("insert into catalog_bands")
    assert (params["low"], params["median"], params["high"]) == (10.5, 11.0, 11.5)
    assert params["reason"] is None


def test_a_truncated_walk_stores_nothing_and_supersedes_no_band(monkeypatch) -> None:
    """Two separate refusals, and the second one was a real defect.

    Storing a partial read would advance `max(fetched_at)` past pages this run
    never read, so those purchases would be skipped *permanently* rather than
    next time — the measured cost of truncation is lost coverage.

    And **no `catalog_bands` row is written at all.** It used to write a
    `truncated_walk` refusal at today's `window_end`, which is a newer window
    than yesterday's good band: every reader takes the newest window, so the
    band would have disappeared from the price screen on the day the page cap
    bit. The refusal also had to invent `n_purchases=0`, which then reclassified
    the deepest codes — the only ones that can truncate — as thin in
    `STALE_CODES_SQL`, re-walking the most expensive codes four times as often.
    """

    class TruncatingClient:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def walk_prices(self, kind, code, *, start, end, max_pages):
            return PriceWalk(rows=[RAW_ROW], total=100_000, pages_read=max_pages, complete=False)

    monkeypatch.setattr(job_module, "build_client", TruncatingClient)
    conn = FakeConn(_watermarks(None, None))
    job_module.refresh_catalog_prices(FakeCtx(conn, {"code": 1}))

    assert not conn.ran("insert into catalog_bands")
    assert not conn.ran("insert into catalog_prices")
    assert conn.batches == []
    assert not conn.ran("delete from catalog_prices")
    events = conn.events()
    assert job_module.TRUNCATED_EVENT in events
    assert events[job_module.TRUNCATED_EVENT]["code"] == 1


def test_a_completed_walk_stores_the_tuple_and_writes_the_band(monkeypatch) -> None:
    """The whole path in one test, with the API and the database faked: the
    window is asked for, the rows are collapsed and written, the band is
    computed over **stored** history, and a row lands in `catalog_bands`."""

    class OkClient:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def walk_prices(self, kind, code, *, start, end, max_pages):
            return PriceWalk(
                rows=[RAW_ROW, {**RAW_ROW, "idCompra": 7, "precoUnitario": 1900.0}],
                total=2,
                pages_read=1,
                complete=True,
            )

    monkeypatch.setattr(job_module, "build_client", OkClient)
    stored = [(f"c{i}", 1830.0 + i, FRESH) for i in range(5)]
    conn = FakeConn({**_watermarks(None, None), "order by id_compra": stored})
    job_module.refresh_catalog_prices(FakeCtx(conn, {"code": 13768}))

    ((sql, rows),) = conn.batches
    assert "insert into catalog_prices" in sql
    assert len(rows) == 2
    assert all(
        SUPPLIER_CNPJ not in str(value) and SUPPLIER_NAME not in str(value)
        for row in rows
        for value in row
    )
    assert conn.ran("purchased_on < %(cutoff)s")  # the prune, specifically:
    # both deletes begin "delete from catalog_prices", so matching on that
    # prefix would be true if only the touched-purchase delete had run and the
    # comment naming the prune would be unverified.
    assert conn.ran("update catalog_prices set description = null")
    band = conn.params_for("insert into catalog_bands")
    assert band["reason"] is None
    assert band["n"] == 5


def _insert_columns() -> list[str]:
    """`INSERT_PRICES_SQL`'s own column list, in order."""
    found = re.search(r"insert into catalog_prices\s*\((.*?)\)", job_module.INSERT_PRICES_SQL, re.S)
    assert found is not None
    return [part.strip() for part in found.group(1).split(",")]


def _stored_select() -> list[str]:
    """`STORED_PURCHASES_SQL`'s own select list, in order."""
    found = re.search(r"select (.*?)\s+from catalog_prices", job_module.STORED_PURCHASES_SQL, re.S)
    assert found is not None
    return [part.strip() for part in found.group(1).split(",")]


class RoundTripConn(FakeConn):
    """A fake that actually stores what the job writes and serves it back.

    The column mapping is **read off the two statements** rather than hardcoded
    by position, so this does not quietly become a test of the current column
    order — reorder either statement and it still round-trips.
    """

    def executemany(self, sql: str, rows: list) -> None:
        super().executemany(sql, rows)
        if "insert into catalog_prices" not in sql:
            return
        columns = _insert_columns()
        self.stored = [dict(zip(columns, row, strict=False)) for row in rows]

    def execute(self, sql: str, params: object = None):
        if "from catalog_prices" in sql and "order by id_compra" in sql:
            select = _stored_select()
            return _Result(
                [tuple(row[name] for name in select) for row in getattr(self, "stored", [])]
            )
        return super().execute(sql, params)


def _two_lot_payload(purchases: int = 5) -> list[dict]:
    """``purchases`` purchases, each with lots at R$ 10 and R$ 20.

    The modal multi-row shape at the measured 1.87 rows per purchase, and the
    one where the two per-purchase numbers differ most: the median is 15 and the
    lower-middle real row is 10.
    """
    rows = []
    for n in range(purchases):
        for item, price in ((1, 10.0), (2, 20.0)):
            rows.append(
                {**RAW_ROW, "idCompra": 1000 + n, "numeroItemCompra": item, "precoUnitario": price}
            )
    return rows


def test_the_band_is_computed_from_the_median_column_and_not_from_unit_price(monkeypatch) -> None:
    """**The whole reason `unit_price_median` exists, pinned end to end.**

    Five purchases, each two lots at R$ 10 and R$ 20. Every purchase's median is
    15 and every representative real row is 10, so:

    * `priceBand`'s arithmetic over medians gives a band at **15** — and the
      measured 56% hit / +0.2% bias were produced by that arithmetic;
    * the same code reading `unit_price` would give **10**, a third low, with
      every gate passing and nothing looking wrong.

    This goes through the real `parse_rows` → `merge_with_stored` →
    `store_prices` → `stored_purchases` → `compute_band` path against a fake
    that round-trips the rows, rather than constructing `PurchasePrice` by hand —
    §4b: the unit passing is not evidence the path does.
    """

    class TwoLotClient:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def walk_prices(self, kind, code, *, start, end, max_pages):
            rows = _two_lot_payload()
            return PriceWalk(rows=rows, total=len(rows), pages_read=1, complete=True)

    monkeypatch.setattr(job_module, "build_client", TwoLotClient)
    conn = RoundTripConn(_watermarks(None, None))
    job_module.refresh_catalog_prices(FakeCtx(conn, {"code": 13768}))

    # One row per purchase, each carrying both numbers.
    assert len(conn.stored) == 5
    assert {row["unit_price"] for row in conn.stored} == {10.0}
    assert {row["unit_price_median"] for row in conn.stored} == {15.0}

    band = conn.params_for("insert into catalog_bands")
    assert band["reason"] is None
    assert band["n"] == 5
    assert (band["low"], band["median"], band["high"]) == (15.0, 15.0, 15.0)
    assert band["median"] != 10.0, "the band must not read `unit_price`"


def test_the_band_input_type_cannot_carry_the_printable_price() -> None:
    """Structural, so the conflation above would need a new field rather than a
    forgotten assignment — the argument `price-band.ts` makes for
    `LockedEvidence` having no price field."""
    names = {field.name for field in dataclasses.fields(PurchasePrice)}
    assert names == {"id_compra", "median_price", "purchased_on"}
    assert "unit_price" not in names


def test_a_service_code_is_refused_rather_than_fetched(monkeypatch) -> None:
    """Measured: 0 bands from any source over 136 service items. Refused loudly,
    so an operator who queues one is told why rather than being served a
    `KeyError`."""

    def forbidden():
        raise AssertionError("a service code must not reach the API")

    monkeypatch.setattr(job_module, "build_client", forbidden)
    with pytest.raises(RuntimeError, match="no price endpoint"):
        job_module.refresh_catalog_prices(FakeCtx(FakeConn(), {"code": 1, "kind": "S"}))


def test_the_band_version_names_the_gates_it_was_judged_by() -> None:
    """C4 re-tunes these, so a stored row has to say which rule produced it."""
    for value in (MIN_SAMPLE, MAX_SPREAD, MAX_AGE_MONTHS):
        assert str(value) in job_module.BAND_VERSION


def test_rows_are_kept_longer_than_the_age_gate_so_c4_can_tune_it_upward() -> None:
    """Pruning at exactly the gate would make re-tuning it *upward* impossible
    without a 19.6-hour re-fetch, and would turn a code whose purchases are all
    20 months old from `too_old` into `no_rows` — a different finding."""
    assert job_module.PRUNE_AGE_MONTHS > MAX_AGE_MONTHS


def test_the_description_trim_never_keeps_fewer_than_a_rung_prints() -> None:
    """The trim is an irreversible `set description = null` for a reader that
    does not exist yet, so it keeps the approach doc's ~10 rather than the bare
    4 a rung can print — and the floor holds by construction, not by this test.
    """
    conn = FakeConn()
    job_module.store_prices(conn, kind="M", code=1, prices=[], today=TODAY)
    keep = conn.params_for("update catalog_prices set description = null")["keep"]
    assert keep == job_module.DESCRIPTIONS_KEPT
    assert keep >= MAX_SAMPLES_SHOWN


def test_math_is_not_quietly_importing_a_different_convention() -> None:
    """`percentile` must stay hand-written; this is the canary if somebody
    replaces it with a stdlib call."""
    assert math.isclose(percentile([1.0, 2.0, 3.0, 4.0], 0.25), 1.75)


# ================================================ conformance with the TypeScript

CONFORMANCE = Path(__file__).parent / "fixtures" / "price_band_conformance.json"


def _conformance() -> dict:
    assert CONFORMANCE.is_file(), (
        f"{CONFORMANCE} is missing — regenerate with worker/scripts/gen_price_band_conformance.py"
    )
    return json.loads(CONFORMANCE.read_text(encoding="utf-8"))


def _case_purchases(case: dict) -> tuple[list[PurchasePrice], dict[str, float]]:
    """One case's lots → the band's input, collapsed **once** over all of them.

    Single-stage, exactly as the TypeScript groups them, so what is compared is
    the arithmetic. Returns the purchases and the chosen representative row per
    purchase, so both halves of the collapse are pinned.
    """
    lots = [
        job_module.PriceLot(
            id_compra=c["tenderId"],
            item_number=n,
            unit_price=c["unitAwardedValue"],
            purchased_on=date.fromisoformat(c["awardedOn"]) if c["awardedOn"] else None,
            supply_unit=None,
            catalog_item_code=None,
            description=c.get("description"),
        )
        for n, c in enumerate(case["comparables"])
    ]
    reps = collapse_by_purchase(
        lots, purchase_of=lambda x: x.id_compra, price_of=lambda x: x.unit_price
    )
    purchases = [
        PurchasePrice(
            id_compra=rep.row.id_compra, median_price=rep.median, purchased_on=rep.row.purchased_on
        )
        for rep in reps
    ]
    chosen = {rep.row.id_compra: rep.row.unit_price for rep in reps}
    return purchases, chosen


def test_the_conformance_fixture_records_its_provenance() -> None:
    """A fixture with no provenance cannot be re-derived, and one generated from
    Python would only prove Python equals itself."""
    fixture = _conformance()
    assert fixture["generated_from"] == "apps/web/lib/radar/price-band.ts"
    assert len(fixture["source_sha"]) == 40
    assert fixture["cases"], "an empty fixture would pass every assertion"


def test_the_fixtures_constants_agree_with_the_mirrored_ones() -> None:
    """So a fixture regenerated from a changed TypeScript cannot quietly bring
    different gates with it — the drift test and this fixture have to agree."""
    constants = _conformance()["constants"]
    assert constants["MIN_SAMPLE"] == MIN_SAMPLE
    assert constants["MAX_SPREAD"] == MAX_SPREAD
    assert constants["MAX_AGE_MONTHS"] == MAX_AGE_MONTHS
    assert constants["MAX_SAMPLES_SHOWN"] == MAX_SAMPLES_SHOWN


@pytest.mark.parametrize(
    "case", _conformance()["cases"], ids=[c["name"] for c in _conformance()["cases"]]
)
def test_the_band_matches_the_typescript_that_produced_the_measurements(case) -> None:
    """**The arithmetic pinned to the authority, not to numbers somebody typed.**

    Expected values come out of the real `priceBand` in `price-band.ts` — the
    implementation the measured 56% hit and +0.2% bias belong to. Before this
    fixture existed, `price_band.py` pinned the four constants to the TypeScript
    and the arithmetic only to hand-written expectations, and two defects got in
    that way: the band computed from each purchase's lower-middle row instead of
    its median, and the age cutoff admitting the cutoff day. Every hand-written
    case agreed with both.

    If this fails, the port is wrong. Regenerating is the right answer only when
    the TypeScript was deliberately changed.
    """
    purchases, _chosen = _case_purchases(case)
    # `now` comes from the fixture, so the clock is pinned and what is under
    # test is the arithmetic. (`price_band.py`'s module docstring records the
    # one clock divergence that remains in production.)
    today = datetime.fromisoformat(case["now"].replace("Z", "+00:00")).date()
    outcome = compute_band(purchases, today=today)

    expected = case["band"]
    if expected is None:
        assert isinstance(outcome, Refusal), (
            f"{case['name']}: the TypeScript refuses, the port banded {outcome}"
        )
        return
    assert isinstance(outcome, Band), (
        f"{case['name']}: the TypeScript bands {expected}, the port refused {outcome}"
    )
    assert outcome.low == pytest.approx(expected["low"])
    assert outcome.median == pytest.approx(expected["median"])
    assert outcome.high == pytest.approx(expected["high"])
    assert outcome.n_purchases == expected["sampleSize"]


@pytest.mark.parametrize(
    "case",
    [c for c in _conformance()["cases"] if c["evidence"] is not None],
    ids=[c["name"] for c in _conformance()["cases"] if c["evidence"] is not None],
)
def test_the_chosen_row_matches_price_evidences_choice(case) -> None:
    """The *other* per-purchase number, pinned to `priceEvidence`.

    `collapse_by_purchase` returns both, and only one of them is the band's. The
    row is what a thin rung prints, so it has to be the row the authority would
    print — `sorted[floor((n - 1) / 2)]`, not the median and not the mean.
    """
    _purchases, chosen = _case_purchases(case)
    samples = case["evidence"]["samples"]
    assert samples, "a case with no samples pins nothing"
    for sample in samples:
        assert sample["tenderId"] in chosen, case["name"]
        assert chosen[sample["tenderId"]] == pytest.approx(sample["value"]), (
            f"{case['name']}: priceEvidence chose {sample['value']} for "
            f"{sample['tenderId']}, the port chose {chosen[sample['tenderId']]}"
        )


def test_the_two_stage_ingest_collapse_diverges_from_the_authority() -> None:
    """**A known, unbounded divergence, written down rather than discovered.**

    `merge_with_stored` is a *two-stage* collapse: storage holds one row per
    purchase, so when a purchase's lots arrive in two windows the second window
    collapses ``{this window's lots} ∪ {the stored representative}`` and the
    purchase's other lots are already gone. The authority is single-stage.

    The fixture's `split_windows` case is the authority for one such purchase —
    lots at 200, 1000 and 250 — and the TypeScript's median for it is 250. Split
    across two windows the stored median is **225**, because window 1 stores the
    row 200 (median 600) and window 2 then collapses {250, 200}.

    This asserts the divergence rather than the agreement, on purpose. It is not
    bounded by anything: the only reason to think it never fires is that 0 of 77
    multi-lot purchases on one page of one code carried differing `dataCompra`,
    which is a reason to believe it is not exercised and **not** a bound. If the
    premise ever fails, this test is where the consequence is written down.
    """
    case = next(c for c in _conformance()["cases"] if c["name"] == "split_windows")
    authority = {s["tenderId"]: s["value"] for s in case["evidence"]["samples"]}
    assert authority["split"] == 250.0, "the authority's chosen row for `split`"
    _purchases, chosen = _case_purchases(case)
    assert chosen["split"] == 250.0, "single-stage, the port agrees"

    # Now the same lots split across two windows, through the real ingest path.
    first = [_lot("split", 1, 200.0), _lot("split", 2, 1000.0)]
    window_one = job_module.merge_with_stored(conn := FakeConn(), kind="M", code=1, fetched=first)
    assert [(r.unit_price, r.unit_price_median) for r in window_one] == [(200.0, 600.0)]

    stored_rows = [
        (
            r.id_compra,
            r.item_number,
            r.unit_price,
            r.purchased_on,
            r.supply_unit,
            r.catalog_item_code,
            r.description,
        )
        for r in window_one
    ]
    conn = FakeConn({"supply_unit, catalog_item_code, description": stored_rows})
    window_two = job_module.merge_with_stored(
        conn, kind="M", code=1, fetched=[_lot("split", 3, 250.0)]
    )
    (row,) = window_two
    assert row.unit_price_median == 225.0
    assert row.unit_price_median != 250.0, (
        "the divergence is real: 225 stored against the authority's 250"
    )


# ============================================ the due predicate, executed

#: Mechanical substitutions that render `STALE_CODES_SQL` for SQLite.
#:
#: Each one is applied with :func:`re.subn` and **asserted to have matched**, so
#: a rename upstream makes this fixture fail rather than silently test a
#: different statement. Only the first is semantic — SQLite has no LATERAL, so
#: the correlated `limit 1` becomes a `row_number()` join — and the predicates
#: under test are carried through **verbatim**, which is asserted below.
SQLITE_RENDER = (
    (
        "lateral -> row_number join",
        r"left join lateral \(\s*select computed_at, n_purchases, refused_reason\s*"
        r"from catalog_bands b\s*where b\.kind = %\(kind\)s and b\.code = d\.code\s*"
        r"order by b\.computed_at desc\s*limit 1\s*\) last on true",
        "left join (select code, computed_at, n_purchases, refused_reason,"
        " row_number() over (partition by code order by computed_at desc) as rn"
        " from catalog_bands where kind = %(kind)s) last"
        " on last.code = d.code and last.rn = 1",
    ),
    ("any() -> equality", r"c\.rule = any\(%\(rules\)s::text\[\]\)", "c.rule = %(rule0)s"),
    (
        "attempt interval",
        r"e\.created_at > now\(\)\s*- make_interval\(hours => %\(attempt_hours\)s::int\)",
        "e.created_at > datetime('now', '-' || %(attempt_hours)s || ' hours')",
    ),
    (
        "cadence interval open",
        r"last\.computed_at < now\(\) - make_interval\(hours => case",
        "last.computed_at < datetime('now', '-' || (case",
    ),
    (
        "cadence interval close",
        r"else %\(thin_hours\)s::int\s*end\)\)",
        "else %(thin_hours)s end) || ' hours'))",
    ),
    ("open tenders", r"t\.proposals_close_at > now\(\)", "t.proposals_close_at > datetime('now')"),
    ("code cast", r"d\.code::text", "cast(d.code as text)"),
    ("strip int casts", r"::int", ""),
    ("placeholders", r"%\((\w+)\)s", r":\1"),
)


def _sqlite_statement() -> str:
    """`STALE_CODES_SQL`, rendered for SQLite with every substitution asserted."""
    sql = "\n".join(
        line for line in job_module.STALE_CODES_SQL.split("\n") if not line.strip().startswith("--")
    )
    for label, pattern, repl in SQLITE_RENDER:
        sql, count = re.subn(pattern, repl, sql, flags=re.S)
        assert count > 0, (
            f"the SQLite rendering of STALE_CODES_SQL could not apply {label!r} "
            "— the statement changed shape, so this fixture is no longer "
            "testing it. Fix the rendering, do not skip it."
        )
    # The predicates under test must survive character for character, or this
    # tests the rendering instead of the statement.
    assert "not exists (select 1" in sql
    assert "when last.refused_reason in (:no_rows, :too_old)" in sql
    assert "when coalesce(last.n_purchases, 0) >= :deep" in sql
    assert "last.computed_at is null" in sql
    return sql


def _depth0(text: str) -> str:
    """``text`` with everything inside parentheses removed.

    So "is there a top-level WHERE here?" can be asked without the `not exists`
    subquery's own `where` answering it — which it did, on the first attempt at
    this assertion.
    """
    out, depth = [], 0
    for char in text:
        if char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(char)
    return "".join(out)


def test_the_statement_keeps_its_predicates_at_the_top_level() -> None:
    """The structural half of the same guard, independent of any dialect.

    `STALE_CODES_SQL`'s predicates must sit in a real WHERE and the join must end
    at a bare `on true`. Checked at paren depth 0, so a subquery's own `where`
    cannot answer for the statement's.
    """
    body = "\n".join(
        line for line in job_module.STALE_CODES_SQL.split("\n") if not line.strip().startswith("--")
    )
    # `_depth0` drops the parentheses themselves, so the lateral's closing one
    # is gone and the depth-0 token stream resumes at `last`.
    tokens = _depth0(body[body.index(") last on true") :]).split()
    assert tokens[:4] == ["last", "on", "true", "where"], (
        "the predicates are hanging off the LEFT JOIN's ON clause, where a "
        "failed condition keeps the left row instead of filtering it — the "
        f"depth-0 tokens after the join are {tokens[:6]}"
    )


def _due_db():
    """Three codes in the states that distinguish a WHERE from an ON clause."""
    db = sqlite3.connect(":memory:")
    db.executescript("""
    create table tender_item_codes (tender_id text, code int, kind text, rule text);
    create table tenders (id text, proposals_close_at text);
    create table catalog_bands (kind text, code int, computed_at text,
      n_purchases int, refused_reason text);
    create table events (name text, created_at text);
    insert into tenders values ('t1', null);
    insert into tender_item_codes values
      ('t1', 101, 'M', 'exact'),    -- banded a minute ago: NOT due
      ('t1', 102, 'M', 'exact'),    -- banded 10 days ago, thin: due
      ('t1', 103, 'M', 'exact'),    -- no band row at all: always due
      ('t1', 104, 'M', 'prefix'),   -- not band-eligible: never due
      ('t1', 105, 'M', 'exact'),    -- banded 10 days ago, deep: NOT due
      ('t1', 106, 'M', 'exact'),    -- refused no_rows 10 days ago: NOT due
      ('t1', 107, 'M', 'exact');    -- refused too_old 10 days ago: NOT due
    insert into catalog_bands values
      ('M', 101, datetime('now', '-1 minute'),  10, null),
      ('M', 102, datetime('now', '-10 days'),   10, null),
      ('M', 105, datetime('now', '-10 days'),  400, null),
      ('M', 106, datetime('now', '-10 days'),    0, 'no_rows'),
      ('M', 107, datetime('now', '-10 days'),    0, 'too_old');
    """)
    return db


DUE_PARAMS = {
    "kind": "M",
    "rule0": "exact",
    "no_rows": REFUSED_NO_ROWS,
    "too_old": REFUSED_TOO_OLD,
    "deep": job_module.DEEP_PURCHASES,
    "deep_hours": job_module.DEEP_REFRESH_HOURS,
    "thin_hours": job_module.THIN_REFRESH_HOURS,
    "attempt_hours": job_module.ATTEMPT_COOLDOWN_HOURS,
    "marker_prefix": job_module.ATTEMPT_EVENT_PREFIX,
    "limit": 50,
}


def _due(db) -> list[int]:
    return sorted(row[0] for row in db.execute(_sqlite_statement(), DUE_PARAMS))


def test_the_cadence_and_the_cooldown_actually_filter() -> None:
    """**Executed, because the substring tests that used to guard this passed on
    a statement that filtered nothing.**

    Every predicate sat after `) last on true`, so it belonged to the LEFT
    JOIN's ON clause — and a failed ON condition keeps the left row and nulls
    the right side. `STALE_CODES_SQL` therefore returned the top N codes by
    demand, full stop: no cadence, no cooldown, and `THIN_REFRESH_HOURS`,
    `DEEP_REFRESH_HOURS`, `DEEP_PURCHASES` and `ATTEMPT_COOLDOWN_HOURS` all
    dead. Two tests asserted that fragments of the SQL *text* were present. They
    were present. They did nothing.

    SQLite shares SQL-92 LEFT JOIN semantics, which is the only thing this needs
    to be the right oracle.
    """
    assert _due(_due_db()) == [102, 103]


def test_an_attempted_code_is_left_alone_whatever_the_band_says() -> None:
    """The floor on attempts, which is what bounds every failure path."""
    db = _due_db()
    for code in (102, 103):
        db.execute(
            "insert into events values (?, datetime('now', '-1 hour'))",
            (f"{job_module.ATTEMPT_EVENT_PREFIX}{code}",),
        )
    assert _due(db) == []
    # And an *old* marker does not suppress it.
    db.execute("delete from events")
    db.execute(
        "insert into events values (?, datetime('now', '-30 days'))",
        (f"{job_module.ATTEMPT_EVENT_PREFIX}102",),
    )
    assert _due(db) == [102, 103]


def test_a_marker_for_another_code_does_not_suppress_this_one() -> None:
    """`e.name = prefix || code` must not match by prefix alone — code 10 and
    code 102 would otherwise collide."""
    db = _due_db()
    db.execute(
        "insert into events values (?, datetime('now', '-1 hour'))",
        (f"{job_module.ATTEMPT_EVENT_PREFIX}10",),
    )
    assert _due(db) == [102, 103]


def test_the_fixture_would_have_caught_the_defect() -> None:
    """**The mutation check, and it lives in the suite rather than in a shell.**

    Put the predicates back where they were — appended to `on true` — and the
    statement returns every band-eligible code, which is what shipped. If this
    ever stops failing to filter, the fixture above has stopped discriminating
    and its green is worthless.
    """
    # The rendering turns the LATERAL into a `row_number()` join, so the join
    # condition it ends on is `last.rn = 1`. Moving the predicates onto *that*
    # ON clause reproduces the shipped defect exactly: a left join whose ON
    # fails keeps the left row either way.
    rendered = _sqlite_statement()
    broken, count = re.subn(
        r"and last\.rn = 1\s+where\s+not exists",
        "and last.rn = 1 and not exists",
        rendered,
        flags=re.S,
    )
    assert count == 1, "could not reconstruct the ON-clause shape"
    tail = _depth0(broken.split("and last.rn = 1")[1].split("order by")[0])
    assert "where" not in tail, (
        f"the reconstruction left a top-level WHERE behind, so it is not the broken shape: {tail!r}"
    )
    db = _due_db()
    everything = sorted(row[0] for row in db.execute(broken, DUE_PARAMS))
    # Every exact-rule code, regardless of cadence or cooldown.
    assert everything == [101, 102, 103, 105, 106, 107]
    # And the fixed statement, on the same data, filters.
    assert _due(db) == [102, 103]
