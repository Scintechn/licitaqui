"""The two billing sweeps against a real Postgres — cards **F4** and **D8**.

Both are SQL: the dates are computed `at time zone 'America/Sao_Paulo'`, the
idempotency is a primary key, and the downgrade's scope is one `not exists`.
Asserting any of that against a fake connection would assert the fake, so it
runs here, on ``TEST_DATABASE_URL`` (`licitaqui_test`), and skips without it.

**Resend is never called**, and neither is Evolution: `EMAIL_DELIVERY` and
`WHATSAPP_DELIVERY` are both off for this suite, so the whole path runs and no
socket is opened.

Sci approved the reminder's copy on **2026-10-12** (**F24**), so the real
template is sendable now and the *blocked* sweep — the behaviour that used to
be free, because the file itself was blocked — needs a template of its own. Both
states are monkeypatched from a `tmp_path`: `sendable` and `blocked`, the same
seam `test_integration_email.py` uses. Asserting the blocked sweep against the
real file would have made this suite's coverage of it vanish the day the copy
landed, with nothing failing to say so.

Every row is scoped by ``RUN_ID``: the users under a per-run e-mail domain, the
subscriptions and payments under a per-run id prefix. Two concurrent runs of
this file cannot see each other's rows (CLAUDE.md's per-run rule).

It needs migration **0015** — `billing_reminders`, `subscription_payments` and
`subscriptions.checkout_url`. Until that is applied these fail rather than
skip, deliberately: a suite that skips itself on a missing table is how a
migration gets forgotten.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import psycopg
import pytest

from licitaqui import billing, product, queue, templates
from licitaqui.observability import get_logger
from licitaqui.registry import REGISTRY, JobContext
from tests.conftest import RUN_ID

LOG = get_logger("test")

DOMAIN = f"billing-{RUN_ID}.test.invalid"
SUB = f"sub-{RUN_ID}"
PAY = f"pay-{RUN_ID}"


@pytest.fixture(autouse=True)
def _optout_enforceable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make a ``SAIR`` honourable, so this file can exercise the rest of the
    notice. The twin of the fixture in ``test_billing.py``.

    ``billing._optout_is_enforceable`` returns ``False`` for everybody — the
    gate added 2026-10-13 after review found that `politica-de-privacidade.md`
    §6 promises an opt-out the product cannot hear: it is keyed on a
    ``founders_list`` id and **nothing enqueues the inbound job**. Card
    **F40**.

    Without this, the WhatsApp assertions here pass by skipping — which is how
    this file failed once already: the first version of this round removed the
    old consent fixture and did not add this one, so
    ``test_the_whatsapp_copy_reads_the_three_facts_the_lateral_join_adds``
    expected ``dry_run`` and got ``skipped``. The gate's own behaviour is
    asserted in ``test_billing.py``, under the ``real_optout_gate`` marker.
    """
    monkeypatch.setattr(billing, "_optout_is_enforceable", lambda conn, number: True)


@pytest.fixture(autouse=True)
def _fresh_templates() -> None:
    templates.cache_clear()


@pytest.fixture
def clean(conn: psycopg.Connection) -> Iterator[None]:
    _wipe(conn)
    try:
        yield
    finally:
        _wipe(conn)


def _wipe(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "delete from billing_reminders where asaas_subscription_id like %s", (f"{SUB}%",)
        )
        cur.execute(
            "delete from subscription_payments where asaas_subscription_id like %s", (f"{SUB}%",)
        )
        cur.execute("delete from jobs where key like %s", (f"reminder:{SUB}%",))
        # **F41's notices are keyed by their own kind** (`notice_job_key`), so
        # the reminder's pattern above does not reach them — and a row this
        # file leaves behind in a **shared** database is the per-run isolation
        # rule broken from the other side. One pattern per kind, not a `like`
        # on the subscription, because the key's first field is the kind.
        for notice_kind in (billing.FAILED_ROW_KIND, billing.ENDED_ROW_KIND):
            cur.execute("delete from jobs where key like %s", (f"{notice_kind}:{SUB}%",))
        cur.execute("delete from events where props ->> 'subscription' like %s", (f"{SUB}%",))
        cur.execute("delete from subscriptions where asaas_subscription_id like %s", (f"{SUB}%",))
        cur.execute("delete from users where email like %s", (f"%@{DOMAIN}",))
        cur.execute("delete from founders_list where email like %s", (f"%@{DOMAIN}",))


def _brt_today(conn: psycopg.Connection) -> date:
    """Today in the **product's** clock, read from the database.

    Not `date.today()`: this process runs on whatever the container or the
    laptop says, the database is UTC, and the product is Brasília — three
    clocks, and on 2026-09-23 an hour was lost to comparing two of them.
    """
    with conn.cursor() as cur:
        cur.execute("select (now() at time zone 'America/Sao_Paulo')::date")
        row = cur.fetchone()
    assert row is not None
    return row[0]


def _subscriber(
    conn: psycopg.Connection,
    *,
    label: str,
    status: str = "active",
    next_charge_on: date | None = None,
    ends_on: date | None = None,
    plan: str = "promocional",
    user_plan: str = "promocional",
    email: str | None = None,
    whatsapp: str | None = None,
    checkout_url: str | None = None,
    name: str | None = "",
    user_id: int | None = None,
) -> tuple[int, str]:
    """One subscription, and by default one user to own it.

    `user_id` since F41's review: `0015`'s unique index scopes *"one live
    subscription"* to the four live statuses, so a `canceled` row and a new
    live row **coexist by design** — somebody who cancelled and subscribed
    again. Every fixture here inserted its own user, so no test in this file
    had two subscriptions on one account, and the encerramento notice went out
    to a resubscriber with nothing to catch it.
    """
    subscription_id = f"{SUB}-{label}"
    if user_id is not None:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into subscriptions (user_id, asaas_customer_id, asaas_subscription_id,
                                           plan, amount, status, next_charge_on, ends_on,
                                           checkout_url)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    user_id,
                    f"cus-{RUN_ID}-{label}",
                    subscription_id,
                    plan,
                    product.PLAN_PRICES["promocional"],
                    status,
                    next_charge_on,
                    ends_on,
                    checkout_url,
                ),
            )
        return user_id, subscription_id
    with conn.cursor() as cur:
        cur.execute(
            "insert into users (email, name, plan, whatsapp) values (%s, %s, %s, %s) returning id",
            (
                email if email is not None else f"{label}@{DOMAIN}",
                # `name=None` writes a **null** name, which is what the Resend
                # magic-link provider produces and what review proved loses a
                # reminder. Every fixture in this file bound a name before, so
                # the case was untested.
                f"Pessoa {label}" if name == "" else name,
                user_plan,
                whatsapp,
            ),
        )
        row = cur.fetchone()
        assert row is not None
        user_id = int(row[0])
        cur.execute(
            """
            insert into subscriptions (user_id, asaas_customer_id, asaas_subscription_id,
                                       plan, amount, status, next_charge_on, ends_on,
                                       checkout_url)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                user_id,
                f"cus-{RUN_ID}-{label}",
                subscription_id,
                plan,
                product.PLAN_PRICES["promocional"],
                status,
                next_charge_on,
                ends_on,
                checkout_url,
            ),
        )
    return user_id, subscription_id


def _charge(
    conn: psycopg.Connection,
    *,
    user_id: int,
    subscription_id: str,
    label: str,
    due_on: date,
    billing_type: str = "PIX",
    status: str = "PENDING",
) -> None:
    """One `subscription_payments` row: the charge the reminder announces.

    `billing.send` reads it through a lateral join for three facts — the exact
    amount, the method and whether it is still payable — so a test about the
    WhatsApp half has to have one.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into subscription_payments (asaas_payment_id, asaas_subscription_id, user_id,
                                               status, billing_type, value, due_on)
            values (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                f"{PAY}-{label}",
                subscription_id,
                user_id,
                status,
                billing_type,
                product.PLAN_PRICES["promocional"],
                due_on,
            ),
        )


def _reminders(conn: psycopg.Connection) -> list[tuple[Any, ...]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            select asaas_subscription_id, due_on, kind, job_id
              from billing_reminders
             where asaas_subscription_id like %s
             order by asaas_subscription_id
            """,
            (f"{SUB}%",),
        )
        return cur.fetchall()


def _events(conn: psycopg.Connection, name: str) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            "select props from events where name = %s order by created_at desc limit 20", (name,)
        )
        return [row[0] for row in cur.fetchall()]


@pytest.fixture
def blocked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A `charge-reminder` that **cannot** render: an unresolved `TODO(Sci):`.

    Until 2026-10-12 this state was the real file, so the blocked sweep could
    be asserted for free. The copy landed, and a test that still read the real
    template would have started passing for the opposite reason — the sweep is
    no longer blocked — or failing outright, which is what it did. Neither is
    coverage of the gate.

    The gate itself is not about Sci's copy: it is *"can this render a whole
    e-mail"*, and that can go back to false from a renamed placeholder or a
    footer that grows a fourth one. So the state is synthesised here and the
    behaviour stays under test.
    """
    root = tmp_path / "templates"
    (root / "email").mkdir(parents=True)
    (root / "email" / "charge-reminder.md").write_text(
        "---\n"
        "id: charge-reminder\n"
        "channel: email\n"
        # **A `subject:` on purpose.** `template_ready()` is false for two
        # independent reasons — no subject *or* an unresolved marker — so a
        # fixture missing both would still pass with the `ready_to_send` half
        # deleted, which is the half this fixture exists to exercise. Review
        # found that; now only the marker blocks it.
        'subject: "x {{data_cobranca}}"\n'
        "status: draft\n"
        "placeholders: [data_cobranca]\n"
        "---\n\n"
        f"{templates.TODO_MARKER} falta a cópia.\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(templates, "TEMPLATES_DIR", root)
    templates.cache_clear()
    return root


@pytest.fixture
def sendable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A synthetic `charge-reminder` with no `TODO(Sci):` in it.

    Synthetic rather than the real file so these tests assert the *machinery*
    and not the wording: the copy is Sci's and may be edited without this suite
    going red. `test_billing.py` is where the real file's own sentences are
    held to the contract (spec §10's date and amount).
    """
    root = tmp_path / "templates"
    (root / "email").mkdir(parents=True)
    (root / "email" / "charge-reminder.md").write_text(
        "---\n"
        "id: charge-reminder\n"
        "channel: email\n"
        'subject: "x {{data_cobranca}}"\n'
        "status: approved\n"
        "placeholders: [data_cobranca, valor_cobranca]\n"
        "---\n\n"
        "x {{valor_cobranca}}\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(templates, "TEMPLATES_DIR", root)
    templates.cache_clear()
    return root


# -- charge_reminder ----------------------------------------------------------


def test_the_sweep_refuses_to_claim_anything_when_the_template_cannot_render(
    conn: psycopg.Connection, clean: None, blocked: Path
) -> None:
    """**The gate, now that the copy is no longer what closes it.**

    A sweep that cannot render must claim nothing — a claimed row would record
    a reminder as handled on a day nothing could be sent, and the charge would
    then arrive with no warning at all, which is worse than no sweep.

    It must also be **loud**: B32's lesson is that a feed which never enqueues
    also never fails, so the event carries the number of subscribers who would
    have been written to.
    """
    due = _brt_today(conn) + timedelta(days=product.CHARGE_REMINDER_DAYS)
    _subscriber(conn, label="blocked", next_charge_on=due)

    result = billing.sweep(conn)

    assert result.blocked is True
    assert result.due == 1
    assert result.queued == 0
    assert _reminders(conn) == []
    rows = _events(conn, billing.EVENT_REMINDER_BLOCKED)
    assert rows and rows[0]["subscribers"] >= 1
    assert rows[0]["reason"] == billing.SKIP_TEMPLATE_BLOCKED


def test_the_real_template_no_longer_blocks_the_sweep(
    conn: psycopg.Connection, clean: None
) -> None:
    """**The other half, and the one that would have shipped silently.**

    No fixture: this reads `worker/templates/email/charge-reminder.md` as it
    is on disk, because the thing under test is that *the file Sci approved*
    unblocks the sweep. The suite above runs on synthetic templates, so without
    this test every assertion here would still pass with the `TODO(Sci):` back
    in place.
    """
    due = _brt_today(conn) + timedelta(days=product.CHARGE_REMINDER_DAYS)
    _subscriber(conn, label="real", next_charge_on=due)

    result = billing.sweep(conn)

    assert billing.template_ready() is True
    assert result.blocked is False
    # `>=`, not `==`: `DUE_SQL` is **global** and `apps/web/lib/asaas/billing.db.test.ts`
    # writes subscriptions into this same database, so an exact count is another
    # lane's fixture away from a mysterious failure. The scoped list below is
    # what actually pins the behaviour. Review's finding.
    assert result.queued >= 1
    assert result.unrenderable == 0
    assert [row[0] for row in _reminders(conn)] == [f"{SUB}-real"]


def test_a_subscriber_with_no_name_is_refused_and_nothing_is_claimed(
    conn: psycopg.Connection, clean: None
) -> None:
    """**Review's blocker, against the database.**

    `users.name` is nullable and `lib/auth/adapter.ts` writes `user.name ??
    null` — the Resend magic-link provider supplies no name at all. The approved
    body opens `Olá, {{nome}}!` and `templates.py` refuses a blank value, so
    before this fix the render raised *after* the `billing_reminders` row was
    committed: four identical retries, and the next sweep looks for `today + 3`
    and never sees that charge again.

    So the sweep renders first. Nothing is claimed, nothing is enqueued, and it
    is **loud** — `billing.reminder_unrenderable` plus an ERROR line, naming the
    placeholder and never the person (§12). **F29** is the residual.

    **Per subscriber, not per sweep**, which is the second half of the test: a
    refusal that blocked the whole sweep would cost that day's entire cohort
    for one null binding, which is worse than the defect. One bad row and one
    good row, and the good one must still be claimed and enqueued.
    """
    due = _brt_today(conn) + timedelta(days=product.CHARGE_REMINDER_DAYS)
    _subscriber(conn, label="nameless", next_charge_on=due, name=None)
    # **A good subscriber beside the bad one, and this is the assertion that
    # matters.** Review's second point: refusing per *sweep* — the
    # `template_ready()` shape, which returns `blocked=True` for everybody —
    # would make one null binding cost that day's whole cohort, a strictly
    # worse defect than the one being fixed. Without this second row the test
    # cannot tell "skipped that subscriber" from "aborted the sweep".
    _, good = _subscriber(conn, label="named", next_charge_on=due)

    result = billing.sweep(conn)

    assert result.unrenderable >= 1
    assert result.blocked is False, "one bad row aborted the sweep for everybody"
    with conn.cursor() as cur:
        cur.execute("select count(*) from jobs where key like %s", (f"reminder:{SUB}-nameless%",))
        row = cur.fetchone()
    assert row is not None and row[0] == 0, "a job was enqueued for a notice that cannot render"
    refused = [
        r
        for r in _events(conn, billing.EVENT_REMINDER_UNRENDERABLE)
        if r.get("subscription") == f"{SUB}-nameless"
    ]
    assert refused and refused[0]["reason"] == "nome:blank"

    # The nameless one is not claimed; the one beside it is, and is enqueued.
    claimed = [row[0] for row in _reminders(conn)]
    assert claimed == [good], claimed
    with conn.cursor() as cur:
        cur.execute("select count(*) from jobs where key like %s", (f"reminder:{good}%",))
        row = cur.fetchone()
    assert row is not None and row[0] == 1


def test_a_founders_name_is_recovered_when_the_user_row_has_none(
    conn: psycopg.Connection, clean: None
) -> None:
    """The ordinary case of the same defect, and the reason the fix is a
    `coalesce` rather than an invented salutation (brief §5): a founder who
    signed in by magic link has the name they typed in `founders_list`, under
    the same e-mail."""
    due = _brt_today(conn) + timedelta(days=product.CHARGE_REMINDER_DAYS)
    email = f"founder-{RUN_ID}@{DOMAIN}"
    with conn.cursor() as cur:
        cur.execute(
            "insert into founders_list (name, email, contact_consent) values (%s, %s, true)",
            (f"Fundadora {RUN_ID}", email),
        )
    user_id, subscription_id = _subscriber(
        conn, label="founder", next_charge_on=due, name=None, email=email
    )

    result = billing.sweep(conn)

    assert result.unrenderable == 0
    assert [row[0] for row in _reminders(conn)] == [subscription_id]

    delivery = billing.send(
        conn,
        template=billing.REMINDER_TEMPLATE,
        user_id=user_id,
        subscription_id=subscription_id,
        due_on=str(due),
    )
    assert delivery.outcome == "dry_run"


def test_it_reminds_three_days_before_a_charge_and_not_on_other_days(
    conn: psycopg.Connection, clean: None, sendable: Path
) -> None:
    today = _brt_today(conn)
    days = product.CHARGE_REMINDER_DAYS
    _, on_time = _subscriber(conn, label="ontime", next_charge_on=today + timedelta(days=days))
    _subscriber(conn, label="tooearly", next_charge_on=today + timedelta(days=days + 1))
    _subscriber(conn, label="toolate", next_charge_on=today + timedelta(days=days - 1))
    _subscriber(conn, label="today", next_charge_on=today)

    result = billing.sweep(conn)

    assert result.due == 1
    assert result.queued == 1
    rows = _reminders(conn)
    assert [row[0] for row in rows] == [on_time]
    assert rows[0][1] == today + timedelta(days=days)
    assert rows[0][2] == billing.REMINDER_ROW_KIND
    # The job the sweep created is recorded on the row, so "was it sent?" has
    # something to join to. The *evidence* of delivery is still `events`.
    assert rows[0][3] is not None


def test_two_sweeps_on_one_day_send_one_reminder(
    conn: psycopg.Connection, clean: None, sendable: Path
) -> None:
    """Spec §10's *"idempotent per (subscription, due date)"*, and it is the
    primary key rather than a check: the sweep inserts and enqueues **only if
    the insert created the row**. Two scheduler instances during a deploy, or a
    retried container, are the real case."""
    due = _brt_today(conn) + timedelta(days=product.CHARGE_REMINDER_DAYS)
    _subscriber(conn, label="once", next_charge_on=due)

    first = billing.sweep(conn)
    second = billing.sweep(conn)

    assert first.queued == 1
    assert second.queued == 0
    assert len(_reminders(conn)) == 1
    with conn.cursor() as cur:
        cur.execute("select count(*) from jobs where key like %s", (f"reminder:{SUB}%",))
        row = cur.fetchone()
    assert row is not None and row[0] == 1


def test_it_never_reminds_a_cancelled_subscription(
    conn: psycopg.Connection, clean: None, sendable: Path
) -> None:
    """Spec §10 says so outright. Two independent reasons it is excluded —
    `status` and `ends_on` — because a cancel sets both and either alone would
    be a single point of failure on the one message a cancelled subscriber
    must not receive."""
    today = _brt_today(conn)
    due = today + timedelta(days=product.CHARGE_REMINDER_DAYS)
    _subscriber(conn, label="cancelled", status="canceled", next_charge_on=due, ends_on=today)
    _subscriber(conn, label="ending", status="active", next_charge_on=due, ends_on=today)

    assert billing.sweep(conn).queued == 0
    assert _reminders(conn) == []


def test_it_does_not_remind_a_subscription_that_has_never_been_paid(
    conn: psycopg.Connection, clean: None, sendable: Path
) -> None:
    # `pending` means the first charge has not been settled, so "a cobrança de
    # sempre" would be its first — a different message, and not one that
    # exists.
    due = _brt_today(conn) + timedelta(days=product.CHARGE_REMINDER_DAYS)
    _subscriber(conn, label="pending", status="pending", next_charge_on=due)
    assert billing.sweep(conn).queued == 0


def test_it_reminds_an_overdue_subscription(
    conn: psycopg.Connection, clean: None, sendable: Path
) -> None:
    # Terms §7's grace period: still a subscriber, still owed a warning before
    # the next attempt.
    due = _brt_today(conn) + timedelta(days=product.CHARGE_REMINDER_DAYS)
    _subscriber(conn, label="overdue", status="overdue", next_charge_on=due)
    assert billing.sweep(conn).queued == 1


# -- send_billing_email -------------------------------------------------------


def test_the_message_refuses_a_subscription_cancelled_since_the_sweep(
    conn: psycopg.Connection, clean: None, sendable: Path
) -> None:
    """The gap the sweep cannot close: a cancel can land in the minutes between
    the sweep and the send, and that is exactly the message spec §10 forbids.
    Re-checked at send time rather than trusted from the payload."""
    today = _brt_today(conn)
    due = today + timedelta(days=product.CHARGE_REMINDER_DAYS)
    user_id, subscription_id = _subscriber(conn, label="racer", next_charge_on=due)
    billing.sweep(conn)

    with conn.cursor() as cur:
        cur.execute(
            "update subscriptions set status = 'canceled', ends_on = %s "
            "where asaas_subscription_id = %s",
            (today, subscription_id),
        )

    delivery = billing.send(
        conn,
        template=billing.REMINDER_TEMPLATE,
        user_id=user_id,
        subscription_id=subscription_id,
        due_on=str(due),
    )
    assert delivery.outcome == "skipped"
    assert delivery.reason == billing.SKIP_CANCELLED


def test_the_message_is_a_dry_run_while_the_kill_switch_is_off(
    conn: psycopg.Connection, clean: None, sendable: Path
) -> None:
    """`EMAIL_DELIVERY` is off for this suite, so this proves the whole path —
    gates, render, log — without a socket, and the log row says `dry_run`
    rather than `sent`. E4's lesson: configuration is not proof, and a dry run
    must never be recorded as a delivery."""
    due = _brt_today(conn) + timedelta(days=product.CHARGE_REMINDER_DAYS)
    user_id, subscription_id = _subscriber(conn, label="dry", next_charge_on=due)

    delivery = billing.send(
        conn,
        template=billing.REMINDER_TEMPLATE,
        user_id=user_id,
        subscription_id=subscription_id,
        due_on=str(due),
    )
    assert delivery.outcome == "dry_run"
    dry = _events(conn, "email.dry_run")
    assert dry and dry[0]["subscription"] == subscription_id
    assert dry[0]["due_on"] == str(due)
    # And nothing claims it was sent.
    sent = [r for r in _events(conn, "email.sent") if r.get("subscription") == subscription_id]
    assert sent == []


def test_the_whatsapp_copy_reads_the_three_facts_the_lateral_join_adds(
    conn: psycopg.Connection, clean: None
) -> None:
    """**The SQL, which a fake connection cannot prove.**

    `billing.send` learns three things from one `left join lateral`: the
    subscriber's `whatsapp`, the subscription's `checkout_url` (the Asaas
    `invoiceUrl` the button points at) and the announced charge's
    `billing_type` and `status`. Every gate in the WhatsApp half is a branch on
    one of them, so a join that silently returned nulls would make this feature
    *skip* rather than fail — which is the quietest possible outcome and the one
    this repository keeps paying for.

    No template fixture: the real approved copy is what ships, and
    `WHATSAPP_DELIVERY` is off, so the whole path runs and no socket opens.
    """
    due = _brt_today(conn) + timedelta(days=product.CHARGE_REMINDER_DAYS)
    user_id, subscription_id = _subscriber(
        conn,
        label="pix",
        next_charge_on=due,
        whatsapp="+55 11 99999-0000",
        checkout_url="https://sandbox.asaas.com/i/f24",
    )
    _charge(conn, user_id=user_id, subscription_id=subscription_id, label="pix", due_on=due)

    delivery = billing.send(
        conn,
        template=billing.REMINDER_TEMPLATE,
        user_id=user_id,
        subscription_id=subscription_id,
        due_on=str(due),
    )

    assert delivery.outcome == "dry_run"
    assert delivery.whatsapp == "dry_run"
    rows = [
        r for r in _events(conn, "whatsapp.dry_run") if r.get("subscription") == subscription_id
    ]
    assert rows, "the WhatsApp copy was never attempted"
    assert rows[0]["due_on"] == str(due)
    # §12: neither the number nor the invoice URL may reach the delivery log.
    # Asserted over the **rendered props**, not as absent dict keys — keys that
    # were never written are absent whatever the code does, which is a check
    # that cannot fail. Review found that version here.
    rendered = str(rows[0])
    assert "asaas.com" not in rendered
    assert "99999" not in rendered
    assert "sandbox" not in rendered


def test_an_overdue_charge_beside_the_next_one_withholds_the_button(
    conn: psycopg.Connection, clean: None
) -> None:
    """**The count that makes the link attributable, and it is a subquery.**

    `subscriptions.checkout_url` is one column per subscription:
    `refreshCheckoutUrl` overwrites it on every payable payment event, so with
    an overdue month *and* the upcoming one both payable, it holds whichever
    event arrived last. The notice names one date, so a button that may open
    the other charge is withheld — **F28** stores the per-charge URL and
    deletes this gate. The e-mail still goes: terms §7 is unconditional.
    """
    today = _brt_today(conn)
    due = today + timedelta(days=product.CHARGE_REMINDER_DAYS)
    user_id, subscription_id = _subscriber(
        conn,
        label="twocharges",
        status="overdue",
        next_charge_on=due,
        whatsapp="+55 11 99999-0002",
        checkout_url="https://sandbox.asaas.com/i/f24-which",
    )
    _charge(conn, user_id=user_id, subscription_id=subscription_id, label="next", due_on=due)
    _charge(
        conn,
        user_id=user_id,
        subscription_id=subscription_id,
        label="late",
        due_on=today - timedelta(days=30),
        status="OVERDUE",
    )

    delivery = billing.send(
        conn,
        template=billing.REMINDER_TEMPLATE,
        user_id=user_id,
        subscription_id=subscription_id,
        due_on=str(due),
    )

    assert delivery.outcome == "dry_run"
    assert delivery.whatsapp == "skipped"
    skipped = [
        r for r in _events(conn, "whatsapp.skipped") if r.get("subscription") == subscription_id
    ]
    assert skipped and skipped[0]["reason"] == billing.SKIP_AMBIGUOUS_LINK


def test_a_card_subscriber_gets_the_e_mail_and_no_button(
    conn: psycopg.Connection, clean: None
) -> None:
    """F24: *"a card subscriber receives nothing [on WhatsApp], because the
    card is charged automatically"* — while terms §7's e-mail is unconditional
    and still goes. The method comes from the announced charge itself, so this
    needs no F25 column and no call to Asaas."""
    due = _brt_today(conn) + timedelta(days=product.CHARGE_REMINDER_DAYS)
    user_id, subscription_id = _subscriber(
        conn,
        label="card",
        next_charge_on=due,
        whatsapp="+55 11 99999-0001",
        checkout_url="https://sandbox.asaas.com/i/f24-card",
    )
    _charge(
        conn,
        user_id=user_id,
        subscription_id=subscription_id,
        label="card",
        due_on=due,
        billing_type="CREDIT_CARD",
    )

    delivery = billing.send(
        conn,
        template=billing.REMINDER_TEMPLATE,
        user_id=user_id,
        subscription_id=subscription_id,
        due_on=str(due),
    )

    assert delivery.outcome == "dry_run"
    assert delivery.whatsapp == "skipped"
    skipped = [
        r for r in _events(conn, "whatsapp.skipped") if r.get("subscription") == subscription_id
    ]
    assert skipped and skipped[0]["reason"] == billing.SKIP_NOT_PIX


def test_the_sweep_enqueues_a_kind_the_registry_can_run(
    conn: psycopg.Connection, clean: None, sendable: Path
) -> None:
    """B2's rule, which B32 is the cost of breaking: a queued kind nothing can
    run burns four attempts over forty minutes and lands in `failed`."""
    from licitaqui import handlers
    from licitaqui.registry import REGISTRY

    handlers.registered_kinds()
    due = _brt_today(conn) + timedelta(days=product.CHARGE_REMINDER_DAYS)
    _subscriber(conn, label="kind", next_charge_on=due)
    billing.sweep(conn)

    with conn.cursor() as cur:
        cur.execute("select distinct kind from jobs where key like %s", (f"reminder:{SUB}%",))
        kinds = [row[0] for row in cur.fetchall()]
    assert kinds == [billing.SEND_KIND]
    assert billing.SEND_KIND in set(REGISTRY.kinds())


# -- expire_subscriptions -----------------------------------------------------


def test_a_cancelled_subscription_drops_to_basico_the_day_after_it_ends(
    conn: psycopg.Connection, clean: None
) -> None:
    """**The other half of a one-click cancel.**
    `0004_subscription_refunds.sql` added `ends_on` saying *"the downgrade job
    reads this every day"*, and until F4 nothing did — so cancelling wrote a
    date nothing acted on."""
    today = _brt_today(conn)
    user_id, subscription_id = _subscriber(
        conn,
        label="expired",
        status="canceled",
        ends_on=today - timedelta(days=1),
        next_charge_on=None,
    )

    assert billing.expire(conn) == 1

    with conn.cursor() as cur:
        cur.execute("select plan from users where id = %s", (user_id,))
        row = cur.fetchone()
    assert row is not None and row[0] == "basico"
    expired = _events(conn, billing.EVENT_EXPIRED)
    assert expired and expired[0]["subscription"] == subscription_id


def test_it_honours_the_period_already_paid_for(conn: psycopg.Connection, clean: None) -> None:
    """Terms §8: paid access runs **to** the last day already paid for, so a
    subscription ending today is not downgraded today."""
    today = _brt_today(conn)
    user_id, _ = _subscriber(conn, label="lastday", status="canceled", ends_on=today)

    assert billing.expire(conn) == 0
    with conn.cursor() as cur:
        cur.execute("select plan from users where id = %s", (user_id,))
        row = cur.fetchone()
    assert row is not None and row[0] == "promocional"


def test_it_spares_an_account_that_subscribed_again(conn: psycopg.Connection, clean: None) -> None:
    """Cancel, then subscribe again: two rows, one of them `canceled` with a
    past `ends_on` and one live. Without the `not exists` the expiry of the
    first would drop a paying subscriber to Básico."""
    today = _brt_today(conn)
    user_id, _ = _subscriber(
        conn, label="again", status="canceled", ends_on=today - timedelta(days=5)
    )
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into subscriptions (user_id, asaas_customer_id, asaas_subscription_id,
                                       plan, amount, status, next_charge_on)
            values (%s, %s, %s, 'promocional', %s, 'active', %s)
            """,
            (
                user_id,
                f"cus-{RUN_ID}-again",
                f"{SUB}-again-2",
                product.PLAN_PRICES["promocional"],
                today + timedelta(days=20),
            ),
        )

    assert billing.expire(conn) == 0
    with conn.cursor() as cur:
        cur.execute("select plan from users where id = %s", (user_id,))
        row = cur.fetchone()
    assert row is not None and row[0] == "promocional"


def test_it_is_idempotent(conn: psycopg.Connection, clean: None) -> None:
    # §7.2: a job can run twice. The second pass finds nothing because
    # `u.plan <> 'basico'` is no longer true.
    today = _brt_today(conn)
    _subscriber(conn, label="twice", status="canceled", ends_on=today - timedelta(days=2))
    assert billing.expire(conn) == 1
    assert billing.expire(conn) == 0


def test_it_leaves_a_live_subscriber_alone(conn: psycopg.Connection, clean: None) -> None:
    today = _brt_today(conn)
    user_id, _ = _subscriber(
        conn, label="live", status="active", next_charge_on=today + timedelta(days=10)
    )
    assert billing.expire(conn) == 0
    with conn.cursor() as cur:
        cur.execute("select plan from users where id = %s", (user_id,))
        row = cur.fetchone()
    assert row is not None and row[0] == "promocional"


def test_the_queue_module_is_the_one_the_sweep_uses(
    conn: psycopg.Connection, clean: None, sendable: Path
) -> None:
    # A guard against the sweep growing its own INSERT: `queue.enqueue` is what
    # applies the dedupe index and the priority convention.
    due = _brt_today(conn) + timedelta(days=product.CHARGE_REMINDER_DAYS)
    _subscriber(conn, label="viaqueue", next_charge_on=due)
    billing.sweep(conn)
    with conn.cursor() as cur:
        cur.execute("select priority from jobs where key like %s", (f"reminder:{SUB}%",))
        row = cur.fetchone()
    assert row is not None
    # Behind a user on screen (1), ahead of the background sweeps (9).
    assert row[0] == 4
    assert queue.enqueue is not None


# -- F41: the overdue notice and the encerramento notice ----------------------


def _notice_template(
    root: Path, template_id: str, placeholders: str, subject: str, body: str, *, todo: bool
) -> None:
    """One synthetic notice under `root`, approved or blocked.

    Synthetic for the same reason `sendable` is: the wording is Sci's and may
    change without this suite going red. What is asserted here is the SQL — the
    dates at `America/Sao_Paulo`, the payable-charge predicate, the window and
    the primary key.
    """
    marker = f"\n{templates.TODO_MARKER} falta a cópia.\n" if todo else ""
    (root / "email" / f"{template_id}.md").write_text(
        "---\n"
        f"id: {template_id}\n"
        "channel: email\n"
        f'subject: "{subject}"\n'
        f"status: {'draft' if todo else 'approved'}\n"
        f"placeholders: {placeholders}\n"
        "---\n\n"
        f"{body}\n{marker}",
        encoding="utf-8",
    )


@pytest.fixture
def notices(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Approved copies of the two notices F41 wires, and nothing else."""
    root = tmp_path / "templates"
    (root / "email").mkdir(parents=True)
    _notice_template(
        root,
        billing.FAILED_TEMPLATE,
        "[data_cobranca, valor_cobranca]",
        "x {{data_cobranca}}",
        "x {{valor_cobranca}}",
        todo=False,
    )
    # **The subject and the body must use different placeholders here**, or
    # this fixture stops proving that `render_subject` is called at all —
    # `template_ready()` has two independent halves and the reminder's own
    # `blocked` fixture carries the same note for the same reason.
    _notice_template(
        root,
        billing.ENDED_TEMPLATE,
        "[data_encerramento, nome]",
        "x {{nome}}",
        "x {{data_encerramento}}",
        todo=False,
    )
    monkeypatch.setattr(templates, "TEMPLATES_DIR", root)
    templates.cache_clear()
    return root


@pytest.fixture
def blocked_notices(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The same two with an unresolved `TODO(Sci):` — today's real state.

    Synthetic rather than the real files, deliberately: the real ones are
    drafts awaiting Sci's approval, and a test that read them would start
    passing for the opposite reason the day the copy lands — which is exactly
    what happened to the reminder's blocked test on 2026-10-12 and is why
    `blocked` above exists.
    """
    root = tmp_path / "templates"
    (root / "email").mkdir(parents=True)
    _notice_template(
        root, billing.FAILED_TEMPLATE, "[data_cobranca]", "x {{data_cobranca}}", "x", todo=True
    )
    _notice_template(
        root,
        billing.ENDED_TEMPLATE,
        "[data_encerramento]",
        "x {{data_encerramento}}",
        "x",
        todo=True,
    )
    monkeypatch.setattr(templates, "TEMPLATES_DIR", root)
    templates.cache_clear()
    return root


def _overdue_subscriber(
    conn: psycopg.Connection,
    label: str,
    *,
    days_late: int,
    status: str = "overdue",
    charge_status: str = "PENDING",
) -> tuple[int, str]:
    """A subscriber whose charge passed its due date `days_late` days ago."""
    due = _brt_today(conn) - timedelta(days=days_late)
    user_id, subscription_id = _subscriber(
        conn,
        label=label,
        status=status,
        next_charge_on=due,
        checkout_url="https://sandbox.asaas.com/i/abc",
    )
    _charge(
        conn,
        user_id=user_id,
        subscription_id=subscription_id,
        label=label,
        due_on=due,
        status=charge_status,
    )
    return user_id, subscription_id


def test_the_overdue_sweep_claims_nothing_while_the_copy_is_unapproved(
    conn: psycopg.Connection, clean: None, blocked_notices: Path
) -> None:
    """The reminder's gate, for the notice that did not exist when it was written.

    Terms §7 obliges the e-mail, so *"there is no message"* must be a state and
    a loud one — never a claimed row, which would record the notice as handled
    on a day nothing could be sent.
    """
    _overdue_subscriber(conn, "late", days_late=1)

    result = billing.overdue_sweep(conn)

    assert result.blocked is True
    assert result.due == 1, "the subscriber is counted even though nothing was sent"
    assert result.queued == 0
    assert _reminders(conn) == []
    blocked_events = [
        props
        for props in _events(conn, billing.EVENT_REMINDER_BLOCKED)
        if props.get("template") == billing.FAILED_TEMPLATE
    ]
    assert blocked_events, "a blocked sweep that logs nothing is a feed that never fails"
    assert blocked_events[0]["reason"] == billing.SKIP_TEMPLATE_BLOCKED
    assert blocked_events[0]["subscribers"] == 1


def test_the_overdue_sweep_queues_a_notice_for_every_late_charge_and_nobody_else(
    conn: psycopg.Connection, clean: None, notices: Path
) -> None:
    """**Five rows: two are late and three are not, each for its own reason.**

    `late` and `active-late` are terms §7's *"tentaremos novamente e avisaremos
    você"*. That the second one is in that half is review's finding: the sweep
    selects on **the charge**, not on `subscriptions.status`, because the grant
    path sets `active` on any non-cancelled row — so paying an older charge
    used to hide a newer one that was already past due.

    The other three are the remaining predicates, and every one of them is
    somebody who would otherwise receive *"não recebemos o seu pagamento"*
    wrongly, which is the message this card most has to get right. `paid` is
    the one that matters: the charge settled while the subscription status
    still says late, and the payable `exists` is the only thing that knows.
    """
    _overdue_subscriber(conn, "late", days_late=2)
    _overdue_subscriber(conn, "active-late", days_late=2, status="active")
    # Paid: the charge settled, so the status is stale and the `exists` is the
    # only thing that knows. This is the row the sweep would hurt most.
    _overdue_subscriber(conn, "paid", days_late=2, charge_status="RECEIVED")
    # Nothing is owed on a subscription that ended.
    _overdue_subscriber(conn, "gone", days_late=2, status="canceled")
    # Not late at all: the charge falls due tomorrow. That is the reminder's
    # cohort, three days out, not this one.
    due_tomorrow = _brt_today(conn) + timedelta(days=1)
    user_id, subscription_id = _subscriber(
        conn, label="soon", status="active", next_charge_on=due_tomorrow
    )
    _charge(
        conn, user_id=user_id, subscription_id=subscription_id, label="soon", due_on=due_tomorrow
    )

    result = billing.overdue_sweep(conn)

    assert result.blocked is False
    assert (result.due, result.queued, result.unrenderable) == (2, 2, 0)
    rows = _reminders(conn)
    assert [(row[0], row[2]) for row in rows] == [
        (f"{SUB}-active-late", billing.FAILED_ROW_KIND),
        (f"{SUB}-late", billing.FAILED_ROW_KIND),
    ]
    assert all(row[3] is not None for row in rows), "the job id is attached to each claim"
    with conn.cursor() as cur:
        cur.execute(
            "select kind, key from jobs where key like %s",
            (f"{billing.FAILED_ROW_KIND}:{SUB}-late%",),
        )
        queued_jobs = cur.fetchall()
    assert len(queued_jobs) == 1
    assert queued_jobs[0][0] == billing.SEND_KIND


def test_the_overdue_notice_is_sent_once_however_many_days_it_stays_unpaid(
    conn: psycopg.Connection, clean: None, notices: Path
) -> None:
    """A charge is late every day until it is paid; the notice goes once.

    The reminder gets this free — it only ever looks at `today + 3`, so a
    second sweep on the same day is the only duplicate it can have. This sweep
    sees the same row tomorrow and the day after, so the primary key is doing
    real work rather than guarding against a double tick.
    """
    _overdue_subscriber(conn, "late", days_late=1)

    first = billing.overdue_sweep(conn)
    second = billing.overdue_sweep(conn)

    assert (first.queued, second.queued) == (1, 0)
    assert second.due == 1, "still late, still counted — it is the claim that stops the message"
    assert len(_reminders(conn)) == 1
    with conn.cursor() as cur:
        cur.execute(
            "select count(*) from jobs where key like %s",
            (f"{billing.FAILED_ROW_KIND}:{SUB}-late%",),
        )
        row = cur.fetchone()
    assert row is not None and row[0] == 1


def test_the_encerramento_notice_fires_after_the_paid_period_and_only_then(
    conn: psycopg.Connection, clean: None, notices: Path
) -> None:
    """Terms §14's fifth notice, and the three rows it must not reach.

    `ended` is the case. `leaving` is the one that matters most: terms §8 keeps
    the paid plan until `ends_on`, so *"sua assinatura foi encerrada"* on the
    day somebody cancels would be false for up to a month — and the plan screen
    has already confirmed the cancellation to them. `ancient` is the backstop
    in `ENDED_SQL`: the claim is what makes this once-only, and the window is
    what stops the first run after a deploy mailing every subscription that
    ever ended.
    """
    today = _brt_today(conn)
    _subscriber(conn, label="ended", status="canceled", ends_on=today - timedelta(days=1))
    _subscriber(conn, label="leaving", status="canceled", ends_on=today + timedelta(days=20))
    _subscriber(
        conn,
        label="ancient",
        status="canceled",
        ends_on=today - timedelta(days=billing.ENDED_NOTICE_DAYS + 1),
    )
    _subscriber(conn, label="living", status="active", next_charge_on=today + timedelta(days=3))

    first = billing.ended_notices(conn)
    second = billing.ended_notices(conn)

    assert (first.due, first.queued) == (1, 1)
    assert second.queued == 0, "one notice per subscription, and the claim is why"
    rows = _reminders(conn)
    assert [(row[0], row[1], row[2]) for row in rows] == [
        (f"{SUB}-ended", today - timedelta(days=1), billing.ENDED_ROW_KIND)
    ], "the claim is keyed on ends_on, which is the date the message is about"


def test_the_downgrade_job_also_announces_the_encerramento(
    conn: psycopg.Connection, clean: None, notices: Path
) -> None:
    """**The job, not the two functions** — §4b's distinction, and the reason
    the notice is not hung off `EXPIRE_SQL`'s own rows.

    `EXPIRE_SQL` only returns an account it actually moved (`u.plan <>
    'basico'`), so a notice driven by its result would be lost for ever the day
    the enqueue failed after the update committed. Here the downgrade and the
    notice both happen, and the second one is keyed on the subscription's own
    end date — which is why a second run of the job finds the account already
    on `basico` and the notice already claimed, and does neither twice.
    """
    today = _brt_today(conn)
    user_id, _ = _subscriber(
        conn, label="ended", status="canceled", ends_on=today - timedelta(days=1)
    )

    job = queue.Job(id=1, kind=billing.EXPIRE_KIND, key="k", priority=9, payload={}, attempts=1)
    REGISTRY.get(billing.EXPIRE_KIND)(JobContext(job=job, conn=conn, connect=lambda: None, log=LOG))

    with conn.cursor() as cur:
        cur.execute("select plan from users where id = %s", (user_id,))
        row = cur.fetchone()
    assert row is not None and row[0] == "basico", "the downgrade still happens"
    assert [r[2] for r in _reminders(conn)] == [billing.ENDED_ROW_KIND]


def test_the_late_notice_reaches_a_subscription_that_was_never_paid(
    conn: psycopg.Connection, clean: None, notices: Path
) -> None:
    """**The cohort the first version of this sweep could not see at all.**

    Found by review (§4b). `'overdue'` is written in exactly one place —
    `lib/asaas/entitlement.ts:292` — and only for a row that is already
    `active`, while `upsertSubscription` creates every row `pending`. So a
    founder who subscribes by pix on 17/10 and never pays is `pending` for
    ever: the webhook arrives, the guard refuses it, and a sweep keyed on
    `'overdue'` reports `due = 0` and looks healthy. On opening day that is the
    *only* population there is.

    The fixtures could not have caught it — they write `status` into the row by
    hand — so this one spells the production state instead: `pending`, a first
    charge past its due date, `OVERDUE` in Asaas's own vocabulary.
    """
    _overdue_subscriber(conn, "never-paid", days_late=1, status="pending", charge_status="OVERDUE")

    result = billing.overdue_sweep(conn)

    assert (result.due, result.queued) == (1, 1), "a pending subscription is the opening-day case"
    assert [(row[0], row[2]) for row in _reminders(conn)] == [
        (f"{SUB}-never-paid", billing.FAILED_ROW_KIND)
    ]


def test_a_resubscriber_is_not_told_their_subscription_ended(
    conn: psycopg.Connection, clean: None, notices: Path
) -> None:
    """**The guard `EXPIRE_SQL` has and `ENDED_SQL` did not.** Found by review.

    `0015`'s unique index scopes "one live subscription" to the four live
    statuses, so a `canceled` row and a new live row coexist by design.
    `expire()` already knows not to downgrade that account — *"so somebody who
    cancelled and subscribed again is not dropped to Básico by the expiry of
    the row they replaced"* — and the notice would have gone anyway, telling a
    paying subscriber that their subscription had ended and that they were on
    the free plan. Both false, and the second contradicting `users.plan`, which
    `expire()` deliberately left alone.
    """
    today = _brt_today(conn)
    user_id, _ = _subscriber(
        conn, label="again-old", status="canceled", ends_on=today - timedelta(days=1)
    )
    _subscriber(
        conn,
        label="again-new",
        status="active",
        next_charge_on=today + timedelta(days=20),
        user_id=user_id,
    )

    result = billing.ended_notices(conn)

    assert (result.due, result.queued) == (0, 0), "the account still has a live subscription"
    assert _reminders(conn) == []
    with conn.cursor() as cur:
        cur.execute("select plan from users where id = %s", (user_id,))
        row = cur.fetchone()
    assert row is not None and row[0] == "promocional", "and the plan was never taken away"
