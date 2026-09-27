"""`licitaqui.product` must agree with `docs/product.json`.

The worker cannot read that file at runtime — `docs/` is outside the Docker
build context (see the module docstring). So the numbers are written twice and
this proves they still match, which is the same bargain the legal documents
strike: duplication that cannot be removed is duplication that gets asserted.

When this fails, somebody changed `docs/product.json` and the worker's copy of
the value is stale. The fix is to copy the number across, not to relax the test.
"""

from __future__ import annotations

import json
from pathlib import Path

from licitaqui import product

FACTS = json.loads(
    (Path(__file__).resolve().parents[2] / "docs" / "product.json").read_text(encoding="utf-8")
)


def test_every_plan_price_matches_the_canonical_file() -> None:
    expected = {name: plan["brl"] for name, plan in FACTS["plans"].items()}
    assert expected == product.PLAN_PRICES


def test_the_promo_terms_match() -> None:
    promo = FACTS["plans"]["promocional"]
    assert promo["months"] == product.PROMO_MONTHS
    assert promo["thenBrl"] == product.PROMO_THEN_BRL


def test_the_contractual_seat_total_matches() -> None:
    """The total the terms promise — not the cap that is currently open.

    The open cap lives in `app_settings` so lot 2 can be released with an
    UPDATE. This is the number in terms §6 and in every template.
    """
    assert FACTS["founders"]["seatsTotal"] == product.FOUNDER_SEATS_TOTAL


def test_the_notice_period_matches() -> None:
    assert FACTS["notice"]["priceChangeDays"] == product.PRICE_CHANGE_NOTICE_DAYS


def test_the_successor_price_is_the_essencial_price() -> None:
    """Two names for one number, and they have drifted before."""
    assert product.PLAN_PRICES["essencial"] == product.PROMO_THEN_BRL


def test_the_template_context_is_all_strings() -> None:
    """`templates.py` substitutes by `str()`, and a stray int would render as
    `26` where the template expects `R$ 26` — visible only to a recipient."""
    context = product.template_context()
    assert context
    assert all(isinstance(value, str) for value in context.values()), context


def test_money_is_formatted_the_way_the_templates_write_it() -> None:
    assert product.brl(26) == "R$ 26"
    assert product.brl_exact(26) == "R$ 26,00"
    # No non-breaking space: it reads identically and compares unequal, so an
    # assertion — or a person running grep — would silently miss it.
    assert " " not in product.brl(26)
