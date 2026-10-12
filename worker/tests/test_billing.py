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
from typing import Any

import pytest

from licitaqui import billing, evolution, product, templates
from licitaqui.breaker import CircuitOpen

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


def test_the_reminder_template_is_ready_to_send() -> None:
    """**The replacement for the test that asserted it never could be.**

    Sci approved the subject and the body on 2026-10-12 (**F24**). The test
    that stood here asserted `template_ready() is False` and said in its own
    docstring that it must fail the day the copy landed; this is that day, and
    this is what takes its place — because *"the copy exists"* is worth
    asserting in the direction that can regress.
    """
    assert billing.template_ready() is True
    loaded = templates.load("email", billing.REMINDER_TEMPLATE)
    assert loaded.status == "approved"
    assert templates.TODO_MARKER not in loaded.body
    assert loaded.subject


def test_the_whole_e_mail_renders_its_partials_too() -> None:
    """**The defect that would have cost one cohort of reminders.**

    `email.py:136` records it in full for the founders messages: `partial-footer`
    declares three placeholders, the sender bound one, and approving the footer
    did not break anything — it *uncovered* that nothing had ever rendered it.
    The reminder appends the same footer, and `build_context` bound
    `email_contato` and `link_privacidade` and **not** `link_preferencias`. So
    the day the copy landed, `send` would have raised `MissingPlaceholder` on
    the footer, the job would have failed, the `billing_reminders` claim would
    have survived the retry, and tomorrow's sweep would look for `today + 3`
    and never see that charge again.

    `test_the_template_declares_every_placeholder_the_sender_binds` cannot see
    it: it reads the reminder's own front matter, and the footer's placeholders
    are declared in the footer. So this renders **what `send` renders** —
    subject, body and every partial — against the real files.
    """
    context = billing.build_context(
        {
            "name": "Maria",
            "plan": "promocional",
            "amount": Decimal("57.00"),
            "next_charge_on": date(2026, 11, 17),
        }
    )
    loaded = templates.load("email", billing.REMINDER_TEMPLATE)
    body = loaded.render(context)
    assert loaded.render_subject(context)
    assert loaded.partials, "the reminder appends a footer; without one this proves nothing"
    for partial_id in loaded.partials:
        body = f"{body}\n\n{templates.load('email', partial_id).render(context)}"
    assert "{{" not in body


def test_the_copy_states_the_date_and_the_amount_spec_10_requires() -> None:
    """Spec §10 and terms §7: the notice names *"a data e o valor que será
    cobrado"*. Asserted against the rendered message rather than the context,
    because a bound placeholder the body never prints is not a sentence.

    Also asserted: no *"toque no botão"*. Sci struck it on 2026-10-12 as
    redundant beside a visible button, and it is the exact sentence
    `rpatinacao`'s customer received on 2026-06-09 with no button under it.
    """
    context = billing.build_context(
        {
            "name": "Maria",
            "plan": "promocional",
            "amount": Decimal("57.00"),
            "next_charge_on": date(2026, 11, 17),
        }
    )
    for channel in ("email", "whatsapp"):
        loaded = templates.load(channel, billing.REMINDER_TEMPLATE)
        rendered = f"{loaded.render_subject(context)}\n{loaded.render(context)}"
        assert "17/11/2026" in rendered, channel
        assert "R$ 57,00" in rendered, channel
        assert "Maria" in rendered, channel
        assert "16/12/2026" in rendered, channel
        assert "toque no bot" not in rendered.casefold(), channel


def test_the_whatsapp_copy_is_the_same_notice_with_whatsapp_markup() -> None:
    """One notice, two channels. The sentences must not drift apart — the
    e-mail and the WhatsApp message are the same promise (terms §7), and the
    only difference Sci asked for is `*bold*` on the labels, which WhatsApp
    renders and an inbox does not."""
    context = billing.build_context(
        {
            "name": "Maria",
            "plan": "promocional",
            "amount": Decimal("57.00"),
            "next_charge_on": date(2026, 11, 17),
        }
    )
    email_body = templates.load("email", billing.REMINDER_TEMPLATE).render(context)
    whatsapp_body = templates.load("whatsapp", billing.REMINDER_TEMPLATE).render(context)
    assert whatsapp_body.replace("*", "") == email_body
    assert "*Valor:*" in whatsapp_body
    # The title of the button message is the e-mail's approved subject, not a
    # sentence invented for the channel.
    assert templates.load("whatsapp", billing.REMINDER_TEMPLATE).subject == templates.load(
        "email", billing.REMINDER_TEMPLATE
    ).subject


def test_a_missing_template_is_the_same_answer_as_an_unwritten_one() -> None:
    """There is no message to send either way, so the gate says the same thing.

    Checked because the first version raised `TemplateNotFound` out of the
    sweep, which would have been a failed job every day — and fifteen failed
    deliveries is how Asaas's own queue gets paused, so this repository's
    instinct is to make "nothing to send" a state rather than an exception.

    The first assertion here used to be `template_ready() is False` against the
    real file, which was free while the copy was missing and is now wrong. The
    behaviour under test is the **missing** template, so the id is pointed at
    one that does not exist and nothing else is asserted for free.
    """
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


def test_the_whatsapp_template_file_is_there_too() -> None:
    path = Path(templates.TEMPLATES_DIR) / "whatsapp" / f"{billing.REMINDER_TEMPLATE}.md"
    assert path.is_file()


# -- the cycle the charge pays for (F24) --------------------------------------


def test_the_cycle_runs_from_the_charge_to_the_day_before_the_next_one() -> None:
    """Sci, 2026-10-12: *"state the new cycle from-date to-date"*.

    Monthly, so `fim_ciclo` is the day **before** the next charge rather than
    the same day — otherwise two consecutive notices claim the same date for
    the end of one period and the start of the next.
    """
    assert billing._cycle_window(date(2026, 11, 17)) == ("17/11/2026", "16/12/2026")
    assert billing._cycle_window(date(2026, 12, 17)) == ("17/12/2026", "16/01/2027")
    assert billing._cycle_window("2026-11-17") == ("17/11/2026", "16/12/2026")
    assert billing._cycle_window(None) == ("", "")


def test_a_charge_on_the_31st_clamps_the_way_asaas_clamps() -> None:
    """**The month-end case, which raises if it is not thought about.**

    `date(2027, 2, 31)` does not exist, so a naive `+1 month` is a
    `ValueError` — a failed job on a real charge. Asaas advances a 31/01
    subscription to 28/02, so clamping to the shorter month's last day gives
    the same answer, and the window still ends the day before the next charge.
    """
    assert billing._cycle_window(date(2027, 1, 31)) == ("31/01/2027", "27/02/2027")
    # A leap February, so the clamp is 29 and not a hard-coded 28.
    assert billing._cycle_window(date(2028, 1, 31)) == ("31/01/2028", "28/02/2028")
    # April has 30 days, so the next charge clamps to 30/04 and this window
    # ends the day before it — not on the 30th, which would overlap it.
    assert billing._cycle_window(date(2026, 3, 31)) == ("31/03/2026", "29/04/2026")


def test_the_cycle_reads_no_clock() -> None:
    """The three clocks (CLAUDE.md). `next_charge_on` is a `date` already in
    the product's timezone, so the arithmetic is calendar arithmetic on that
    date: no `now()`, no conversion, and therefore the same answer on a UTC
    container and on Sci's UTC+1 laptop."""
    source = Path(billing.__file__).read_text(encoding="utf-8")
    window = source[source.index("def _cycle_window") : source.index("def _as_date")]
    # The **code**, not the docstring — which names `datetime.now()` precisely
    # in order to say it is not used, and would match every pattern below.
    code = window[window.index('"""', window.index('"""') + 3) + 3 :]
    for forbidden in ("now(", "today(", "utcnow", "astimezone", "ZoneInfo"):
        assert forbidden not in code, forbidden
    assert "monthrange" in code, "the clamp is what makes a charge on the 31st safe"


# -- the payment link (F24) ---------------------------------------------------


def test_link_pagamento_is_the_asaas_invoice_and_not_the_account_screen() -> None:
    """**The distinction the card is explicit about.** `link_assinatura` is
    `/conta/plano`, our own screen, where a subscriber cancels. `link_pagamento`
    is the Asaas `invoiceUrl` — where the money is actually paid, and the
    destination of the WhatsApp button. Binding one to the other would send a
    Pix subscriber to a page with no QR on it."""
    context = billing.build_context(
        {
            "name": "Maria",
            "plan": "promocional",
            "amount": Decimal("57.00"),
            "next_charge_on": date(2026, 11, 17),
            "checkout_url": "https://sandbox.asaas.com/i/abc",
        }
    )
    assert context["link_pagamento"] == "https://sandbox.asaas.com/i/abc"
    assert context["link_pagamento"] != context["link_assinatura"]
    assert context["link_assinatura"].endswith("/conta/plano")


def test_link_pagamento_is_blank_rather_than_wrong_when_there_is_no_charge_yet() -> None:
    """`subscriptions.checkout_url` is null before the first charge exists.
    Blank is a state the WhatsApp half gates on (`no_payment_link`); a guess
    would be a button pointing somewhere nobody can pay."""
    context = billing.build_context({"amount": Decimal("57.00")})
    assert context["link_pagamento"] == ""


def test_the_sender_reads_the_invoice_url_and_the_method_from_the_row() -> None:
    """Read as text, because the three facts come from one `left join lateral`
    and a dropped column would make the WhatsApp half *skip* rather than fail.
    The integration suite proves the join; this proves it is still asked for."""
    for column in (
        "s.checkout_url",
        "u.whatsapp",
        "charge.billing_type",
        "charge.status",
        "as payable_charges",
    ):
        assert column in billing.REMINDER_ROW_SQL, column


def test_the_payable_statuses_agree_with_the_web_allow_list() -> None:
    """One vocabulary in two languages, asserted rather than remembered.

    `lib/asaas/entitlement.ts`'s `AWAITING` decides which charge the webhook
    points `checkout_url` at; this module decides whether to offer a *"Pagar
    agora"* button for it. If the two drift, the button is offered for a charge
    the web side has already stopped treating as payable.
    """
    source = (Path(__file__).parents[2] / "apps/web/lib/asaas/entitlement.ts").read_text(
        encoding="utf-8"
    )
    block = source[source.index("export const AWAITING") :]
    # Past `readonly string[]`, whose own `]` is not the end of the array.
    block = block[block.index("= [") :]
    block = block[: block.index("]")]
    web = set(re.findall(r"'([A-Z_]+)'", block))
    assert web == set(billing.whatsapp_payable_statuses())


# -- the additive WhatsApp copy (F24) -----------------------------------------
#
# These are the gates and the fallback, which are Python branches rather than
# SQL — so a fake connection asserts the branch and not the fake. The three
# facts the branches read come out of a `left join lateral`, and *that* is
# asserted against a real Postgres in `test_integration_billing.py`, because a
# fake would happily answer whatever this file told it to.


class _FakeCursor:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn
        self._row: tuple[Any, ...] | None = None

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def execute(self, sql: str, params: Any = None) -> None:
        self._conn.queries.append(sql)
        if "insert into events" in sql:
            user_id, name, props = params
            self._conn.events.append((name, user_id, dict(props.obj)))
            self._row = None
        elif "from founders_list" in sql:
            self._row = None if self._conn.founder is None else (self._conn.founder,)
        elif "founders_list_id" in sql:
            self._row = (self._conn.opted_out,)
        elif "props ->> 'template'" in sql:
            self._row = (self._conn.already_sent,)
        else:  # pragma: no cover - a query this fake was not written for
            raise AssertionError(f"unexpected query: {sql[:80]}")

    def fetchone(self) -> tuple[Any, ...] | None:
        return self._row


class _FakeConn:
    """Enough of psycopg for the gates. Records every query and every event."""

    def __init__(
        self,
        *,
        founder: int | None = None,
        opted_out: bool = False,
        already_sent: bool = False,
    ) -> None:
        self.founder = founder
        self.opted_out = opted_out
        self.already_sent = already_sent
        self.queries: list[str] = []
        self.events: list[tuple[str, int | None, dict[str, Any]]] = []

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    def named(self, name: str) -> list[dict[str, Any]]:
        return [props for event, _, props in self.events if event == name]


class _StubEvolution:
    """An `EvolutionClient` that records the call and never opens a socket."""

    def __init__(self, result: Any = None, raises: BaseException | None = None) -> None:
        self.result = result or evolution.SendResult(status="sent", message_id="wamid.1")
        self.raises = raises
        self.calls: list[dict[str, Any]] = []

    def send_url_button(self, number: str, **kwargs: Any) -> Any:
        self.calls.append({"number": number, **kwargs})
        if self.raises is not None:
            raise self.raises
        return self.result


def _row(**overrides: Any) -> dict[str, Any]:
    row = {
        "name": "Maria",
        "plan": "promocional",
        "amount": Decimal("57.00"),
        "next_charge_on": date(2026, 11, 17),
        "checkout_url": "https://sandbox.asaas.com/i/abc",
        "whatsapp": "+55 11 99999-0000",
        "charge_billing_type": "PIX",
        "charge_status": "PENDING",
        "payable_charges": 1,
    }
    row.update(overrides)
    return row


def _notice(
    conn: _FakeConn, client: _StubEvolution, **overrides: Any
) -> str:
    row = _row(**overrides)
    return billing.send_charge_notice_whatsapp(
        conn,  # type: ignore[arg-type]
        found=row,
        user_id=7,
        context=billing.build_context(row),
        subscription_id="sub_1",
        due_on="2026-11-17",
        template=billing.REMINDER_TEMPLATE,
        client=client,  # type: ignore[arg-type]
        job_id=42,
    )


def test_the_whatsapp_notice_carries_one_url_button_to_the_asaas_invoice() -> None:
    """The shape measured against our own instance on 2026-10-12: one
    `type: "url"` button, to the Asaas `invoiceUrl` and not to `/conta/plano`,
    with the approved subject as the title and the approved body as the
    description."""
    conn, client = _FakeConn(), _StubEvolution()
    assert _notice(conn, client) == "sent"
    call = client.calls[0]
    assert call["url"] == "https://sandbox.asaas.com/i/abc"
    assert call["button_text"] == billing.WHATSAPP_BUTTON_TEXT
    assert "17/11/2026" in call["title"]
    assert "R$ 57,00" in call["description"]
    assert "16/12/2026" in call["description"]
    sent = conn.named("whatsapp.sent")
    assert sent and sent[0]["subscription"] == "sub_1"
    assert sent[0]["message_id"] == "wamid.1"


def test_the_delivery_log_carries_neither_the_number_nor_the_invoice_url() -> None:
    """§12. The row is written straight into `events`, which is queried for
    support — a URL that opens one named customer's invoice is personal data,
    and so is the number."""
    conn, client = _FakeConn(), _StubEvolution()
    _notice(conn, client)
    for _, _, props in conn.events:
        rendered = str(props)
        assert "99999" not in rendered
        assert "asaas.com" not in rendered


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"whatsapp": None}, billing.SKIP_NO_WHATSAPP),
        ({"whatsapp": "  "}, billing.SKIP_NO_WHATSAPP),
        ({"charge_billing_type": "CREDIT_CARD"}, billing.SKIP_NOT_PIX),
        ({"charge_billing_type": None}, billing.SKIP_UNKNOWN_METHOD),
        ({"charge_status": "RECEIVED"}, billing.SKIP_CHARGE_SETTLED),
        ({"charge_status": "REFUNDED"}, billing.SKIP_CHARGE_SETTLED),
        ({"checkout_url": None}, billing.SKIP_NO_PAYMENT_LINK),
        ({"payable_charges": 2}, billing.SKIP_AMBIGUOUS_LINK),
    ],
)
def test_the_gates_refuse_and_say_which(overrides: dict[str, Any], reason: str) -> None:
    """Each refusal is a recorded outcome, never an exception: the e-mail is
    the channel terms §7 obliges us to use and it has already been sent.

    The card subscriber is the one the card names outright — *"a card
    subscriber receives nothing, because the card is charged automatically"* —
    and an unknown method refuses for the same reason the web side's `AWAITING`
    is an allow-list: a value we cannot read must not become a payment
    instruction.
    """
    conn, client = _FakeConn(), _StubEvolution()
    assert _notice(conn, client, **overrides) == "skipped"
    assert client.calls == []
    skipped = conn.named("whatsapp.skipped")
    assert skipped and skipped[0]["reason"] == reason


def test_an_overdue_charge_still_gets_its_button() -> None:
    """`OVERDUE` is in the payable allow-list on both sides: the subscriber
    owes it and the invoice still resolves. Terms §7's grace period is exactly
    this reader."""
    conn, client = _FakeConn(), _StubEvolution()
    assert _notice(conn, client, charge_status="OVERDUE") == "sent"
    assert client.calls


def test_a_recorded_sair_suppresses_the_whatsapp_copy_and_not_the_e_mail() -> None:
    """Spec §9: honour `SAIR`. The e-mail is a term of the contract and `SAIR`
    is a WhatsApp instruction, so the opt-out silences this channel only — and
    that is why this function is additive and returns rather than raising."""
    conn = _FakeConn(founder=3, opted_out=True)
    client = _StubEvolution()
    assert _notice(conn, client) == "skipped"
    assert client.calls == []
    assert conn.named("whatsapp.skipped")[0]["reason"] == billing.SKIP_OPTED_OUT


def test_a_number_that_is_on_no_founders_row_has_not_opted_out() -> None:
    """A subscriber who was never on the founders list resolves to nothing.
    That is *"no opt-out recorded"*, which is the correct answer rather than a
    missing one — `memory: empty-result-is-not-absence` cuts the other way
    here, and the query is a lookup by number rather than a walk."""
    conn = _FakeConn(founder=None, opted_out=True)
    assert _notice(conn, _StubEvolution()) == "sent"


def test_it_does_not_send_the_same_charge_twice() -> None:
    """§7.2: a job can run twice. Per-recipient evidence is `events`, the same
    standard the e-mail half holds itself to."""
    conn = _FakeConn(already_sent=True)
    client = _StubEvolution()
    assert _notice(conn, client) == billing.SKIP_WHATSAPP_SENT
    assert client.calls == []


def test_a_fallback_is_counted_rather_than_recorded_as_a_whole_send() -> None:
    """**`rpatinacao`'s 2026-06-09 incident, in our own code.**

    Evolution began rejecting their button payload, their fallback dropped the
    URL, and the caller recorded `status: "sent"`. A customer received *"Toque
    no botão abaixo para pagar"* with no button and nobody saw it for days.

    So a degraded send writes its own event and logs at ERROR, and the
    `whatsapp.sent` row beside it says `fallback: true`. One query counts it
    with no `props` filter at all, which is the point.
    """
    conn = _FakeConn()
    client = _StubEvolution(
        result=evolution.SendResult(
            status="sent", message_id="wamid.2", fallback=True, fallback_reason="http_error"
        )
    )
    assert _notice(conn, client) == "sent"
    counted = conn.named(billing.EVENT_WHATSAPP_FALLBACK)
    assert counted and counted[0]["reason"] == "http_error"
    assert conn.named("whatsapp.sent")[0]["fallback"] is True


@pytest.mark.parametrize(
    "raises",
    [
        evolution.EvolutionError("http_error", status=500),
        CircuitOpen("evolution", 900.0),
        ValueError("a Brazilian number has a 2-digit area code and 8 or 9 digits"),
    ],
)
def test_a_whatsapp_failure_never_fails_the_job_that_already_sent_the_e_mail(
    raises: BaseException,
) -> None:
    """The additive channel must not retry the required one. Four attempts over
    forty minutes against an e-mail already in somebody's inbox would be a
    second delivery of a contractual notice to pay for a transport fault."""
    conn = _FakeConn()
    client = _StubEvolution(raises=raises)
    assert _notice(conn, client) == "failed"
    assert conn.named("whatsapp.failed")


def test_the_dry_run_reaches_the_whole_path_and_logs_as_a_dry_run() -> None:
    """E4's lesson: configuration is not proof, and a dry run must never be
    recorded as a delivery."""
    conn = _FakeConn()
    client = _StubEvolution(result=evolution.SendResult(status="dry_run"))
    assert _notice(conn, client) == "dry_run"
    assert conn.named("whatsapp.dry_run")
    assert conn.named("whatsapp.sent") == []
