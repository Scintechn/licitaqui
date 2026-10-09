"""The parts of `licitaqui.billing` that need no database — card **F4**.

The sweeps themselves are SQL and are in `test_integration_billing.py`;
asserting them against a fake connection would assert the fake.

What is here is the gate that decides whether anything is sent at all, the
context the message renders from, and the date arithmetic — which is the one
piece of this feature most likely to be quietly wrong, because the database is
UTC, the product is Brasília and this process's clock is neither.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from licitaqui import billing, product, templates

#: Set by :func:`_synthetic_root` for the cases that need a template of their
#: own. A module-level holder rather than a fixture argument so the helper
#: below can be called from a test that did not ask for the directory.
_TMP: Path | None = None


@pytest.fixture(autouse=True)
def _synthetic_root(tmp_path: Path) -> Iterator[None]:
    """Hand each test a private template root, and **put the real one back**.

    `templates.TEMPLATES_DIR` is a module global. Leaving it pointed at a
    `tmp_path` would make every later test in the same process read templates
    that no longer exist — and `pytest` runs this file before the integration
    ones, so the failure would land somewhere else entirely.
    """
    global _TMP
    original = templates.TEMPLATES_DIR
    _TMP = tmp_path
    try:
        yield
    finally:
        _TMP = None
        templates.TEMPLATES_DIR = original  # type: ignore[misc]
        templates.cache_clear()


def _write_template(root: Path | None, body: str, *, subject: str | None) -> None:
    """A `charge-reminder` under `root`, and point `templates` at it.

    The real file is a draft awaiting Sci's two sentences, so a test that needs
    one which *can* render has to supply it — the same seam
    `test_integration_email.py` uses for the founders templates.
    """
    assert root is not None, "this test needs the synthetic template root"
    folder = root / "templates" / "email"
    folder.mkdir(parents=True, exist_ok=True)
    front = ["---", "id: charge-reminder", "channel: email", "status: approved"]
    if subject is not None:
        front.append(f'subject: "{subject}"')
    used = sorted(set(re.findall(r"\{\{(\w+)\}\}", body + (subject or ""))))
    if used:
        front.append(f"placeholders: [{', '.join(used)}]")
    front.append("---")
    (folder / "charge-reminder.md").write_text("\n".join(front) + "\n\n" + body, encoding="utf-8")
    templates.TEMPLATES_DIR = root / "templates"  # type: ignore[misc]
    templates.cache_clear()


def test_the_gate_requires_a_subject_as_well_as_a_body() -> None:
    """**The hole review found, and the one that would have cost a cohort.**

    ``Template.ready_to_send`` is only ``TODO_MARKER not in body``. The day Sci
    writes the body and removes the marker **without adding a `subject:`**, a
    gate that checked only that property would pass, claim a
    ``billing_reminders`` row, enqueue, and ``render_subject`` would raise —
    the job fails, the claim survives the retry, and tomorrow's sweep looks for
    ``next_charge_on = today + 3`` and never sees that charge again.

    So the gate requires both. This asserts it against a synthetic template
    that has a body and no subject, which is the precise state that day
    produces.
    """
    body_only = templates.parse(
        "---\nid: charge-reminder\nchannel: email\nstatus: approved\n---\n\nOi.\n",
        template_id="charge-reminder",
    )
    assert body_only.ready_to_send is True, "the library property is satisfied"
    assert body_only.subject is None, "and there is still no subject to send"
    # And the gate refuses it anyway. Asserted through `template_ready()`
    # itself, against a real file, rather than by grepping this module's
    # source: a test that reads the code it is testing passes for the wrong
    # reason the first time somebody renames a local.
    _write_template(_TMP, "Oi, {{nome}}.\n", subject=None)
    assert billing.template_ready() is False


def test_the_reminder_template_is_not_ready_to_send() -> None:
    """**The current, deliberate state of F4.**

    `worker/templates/email/charge-reminder.md` exists with front matter and a
    single `TODO(Sci):` naming the two sentences it needs, because copy is
    Sci's alone (legal brief §5). `Template.ready_to_send` is false while that
    marker is in the body, and the sweep refuses to claim or enqueue anything
    while it is.

    This test is the one that must **fail** the day Sci writes the copy — and
    it should, loudly, because a test asserting "nothing can be sent" is not
    something to leave passing by accident. Delete it then; the integration
    suite's blocked-sweep test goes with it.
    """
    assert billing.template_ready() is False
    loaded = templates.load("email", billing.REMINDER_TEMPLATE)
    assert loaded.status == "draft"
    assert templates.TODO_MARKER in loaded.body


def test_a_missing_template_is_the_same_answer_as_an_unwritten_one() -> None:
    """There is no message to send either way, so the gate says the same thing.

    Checked because the first version raised `TemplateNotFound` out of the
    sweep, which would have been a failed job every day — and fifteen failed
    deliveries is how Asaas's own queue gets paused, so this repository's
    instinct is to make "nothing to send" a state rather than an exception.
    """
    assert billing.template_ready() is False
    original = billing.REMINDER_TEMPLATE
    try:
        billing.REMINDER_TEMPLATE = "no-such-template"  # type: ignore[misc]
        assert billing.template_ready() is False
    finally:
        billing.REMINDER_TEMPLATE = original  # type: ignore[misc]


def test_the_template_declares_every_placeholder_the_sender_binds() -> None:
    """The join between the copy and the code, asserted rather than hoped.

    `templates.py` already refuses a template that *uses* an undeclared
    placeholder. The direction it cannot check is this one: a placeholder the
    template declares and the **sender** never binds renders as
    `MissingPlaceholder` at send time — which is how every founders e-mail
    broke the morning `partial-footer` was approved, three placeholders bound
    out of four.
    """
    declared = set(templates.load("email", billing.REMINDER_TEMPLATE).placeholders)
    bound = set(
        billing.build_context(
            {
                "name": "Maria",
                "plan": "promocional",
                "amount": Decimal("57.00"),
                "next_charge_on": date(2026, 11, 17),
            }
        )
    )
    assert declared - bound == set(), f"the sender binds nothing for {declared - bound}"


def test_the_context_states_the_date_and_the_amount() -> None:
    """Spec §10: the reminder *"states the date and the amount"*. Both come from
    the subscription row, not from a product constant — they are the only two
    per-subscriber facts in the message."""
    context = billing.build_context(
        {
            "name": "Maria",
            "plan": "promocional",
            "amount": Decimal("57.00"),
            "next_charge_on": date(2026, 11, 17),
        }
    )
    assert context["data_cobranca"] == "17/11/2026"
    assert context["valor_cobranca"] == product.brl_exact(product.PLAN_PRICES["promocional"])
    assert context["nome"] == "Maria"
    assert context["nome_plano"] == "Promocional"


def test_every_product_number_in_the_context_comes_from_product_py() -> None:
    """So a price in a billing e-mail cannot disagree with the screen."""
    context = billing.build_context({"amount": Decimal("57.00")})
    for key, value in product.template_context().items():
        assert context[key] == value


def test_a_date_is_reordered_and_never_converted() -> None:
    """**The clock defect this avoids.**

    `next_charge_on` is a `date`, written at `America/Sao_Paulo`. Treating it
    as an instant — `datetime.fromisoformat` then a local `strftime` — parses
    it as midnight and, on a UTC+1 laptop or a UTC container, can print the day
    before. A date with no time in it needs no conversion, only a reordering.
    """
    assert billing._brt_date(date(2026, 1, 1)) == "01/01/2026"
    assert billing._brt_date("2026-12-31") == "31/12/2026"
    # A timestamp that arrived where a date was expected keeps its date half
    # rather than silently becoming something else.
    assert billing._brt_date("2026-12-31T23:30:00+00:00") == "31/12/2026"
    assert billing._brt_date(None) == ""


def test_the_reminder_key_is_the_pair_the_primary_key_is() -> None:
    """`jobs_dedupe` and `billing_reminders` must agree about what "one
    reminder" means, or the second defence does not line up with the first."""
    assert billing.reminder_job_key("sub_1", "2026-11-17") == "reminder:sub_1:2026-11-17"
    assert billing.reminder_job_key("sub_1", "2026-11-17") != billing.reminder_job_key(
        "sub_1", "2026-12-17"
    )


def test_a_cancelled_subscription_is_not_remindable() -> None:
    """Spec §10 says so outright, and `pending` is excluded for its own reason:
    it has never been paid, so "the usual charge" would be its first."""
    assert "canceled" not in billing.REMINDABLE
    assert "pending" not in billing.REMINDABLE
    assert set(billing.REMINDABLE) == {"active", "overdue"}


def test_the_sweep_reads_the_notice_period_from_product_py() -> None:
    # Not a literal 3: `docs/product.json` holds it and `test_product.py` holds
    # this module to it.
    assert "%(days)s" in billing.DUE_SQL
    assert product.CHARGE_REMINDER_DAYS == 3


def test_the_expiry_statement_spares_an_account_that_subscribed_again() -> None:
    """Read as text, because the behaviour is in one SQL predicate.

    Somebody who cancels and subscribes again has two rows: a `canceled` one
    whose `ends_on` passes, and a live one. Without the `not exists` the expiry
    of the first would drop a paying subscriber to Básico.

    The integration suite proves the behaviour; this asserts the clause is
    there at all, so deleting it is a visible change rather than a silent one.
    """
    assert "not exists" in billing.EXPIRE_SQL
    assert "'pending', 'active', 'overdue', 'suspended'" in billing.EXPIRE_SQL
    # And the boundary is the product's clock, not the container's.
    assert "America/Sao_Paulo" in billing.EXPIRE_SQL
    assert "America/Sao_Paulo" in billing.DUE_SQL


def test_the_template_file_is_where_the_module_says_it_is() -> None:
    path = Path(templates.TEMPLATES_DIR) / "email" / f"{billing.REMINDER_TEMPLATE}.md"
    assert path.is_file()
