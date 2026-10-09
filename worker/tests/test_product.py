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
from datetime import date
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


def test_the_charge_reminder_period_matches() -> None:
    """The **other** notice, and the one F4's sweep reads.

    Two promises frequently confused: 30 days before the *price* changes, and 3
    days before *every* charge. `docs/product.json` holds both under `notice`,
    and this file is where the worker's copy of each is held to it — the whole
    reason `product.py` duplicates these numbers rather than reading the JSON
    (`docs/` is outside the Docker build context).
    """
    assert FACTS["notice"]["chargeReminderDays"] == product.CHARGE_REMINDER_DAYS


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


def test_the_founders_opening_date_matches_the_canonical_file() -> None:
    """The assertion that did not exist when the opening moved.

    Sci moved the opening to 2026-10-17 on 2026-10-03 and cancelled the
    broadcast queued for 08/10. `docs/product.json` moved and `apps/web` moved
    with it; the worker did not, because the date lived in `whatsapp.py`'s own
    constants rather than in `product`, where every other product fact is
    asserted against this file.

    It was not a dormant difference. `broadcast_at()` builds its instant from
    this date, and a `run_after` in the past makes a job claimable
    **immediately** -- so a stale value fires early rather than not at all.
    """
    assert date.fromisoformat(FACTS["founders"]["opensOn"]) == product.OPENING_DATE


def test_the_founders_opening_hour_matches_the_canonical_file() -> None:
    """Separate from the date, because the two are allowed to move apart.

    The date is copy -- `{{data_abertura}}`, on the welcome and the waitlist
    e-mail -- and the hour belongs to the broadcast sweep alone. One test each,
    so a failure names which one drifted.
    """
    assert FACTS["founders"]["opensAtBrt"] == product.OPENING_HOUR_BRT


def test_the_broadcast_defaults_to_the_product_values() -> None:
    """`whatsapp.py` must not keep a second copy of either.

    This is the part the two tests above cannot see: they would both pass while
    `whatsapp.py` ignored `product` entirely and used its own literal, which is
    exactly the state this card found.
    """
    from licitaqui import whatsapp

    assert whatsapp.DEFAULT_OPENING_DATE is product.OPENING_DATE
    assert whatsapp.DEFAULT_BROADCAST_HOUR is product.OPENING_HOUR_BRT
