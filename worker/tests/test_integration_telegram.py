"""E1 against a real database: eligibility, the §10 quota, and the selection.

These are the parts of the weekly digest that are SQL, and SQL is exactly what
a unit test cannot check: the `company_segments` join, the array overlap the
Radar groups on, the `alert_deliveries` anti-join that stops next Monday
repeating this Monday, and the quota read out of `plan_limits`.

Every row is scoped by ``RUN_ID`` (see `conftest`) and the kill switch is held
down suite-wide, so nothing here can message anybody.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from licitaqui import telegram_alerts
from licitaqui.registry import REGISTRY, JobContext
from licitaqui.telegram_alerts import DIGEST_JOB_KIND, JOB_KIND

from .conftest import e1_chat_id, e1_cnpj, e1_email, e1_tender_id

pytestmark = pytest.mark.usefixtures("e1_conn")


# -- fixtures written straight into the database ---------------------------


def a_compatible_cnae(conn: psycopg.Connection) -> tuple[str, str]:
    """A real (CNAE, segment) pair from the shipped map, rather than a guess.

    B6's `company_segments` view only awards `compatible` to a **main** CNAE, so
    the pair has to come out of `cnae_segments` for the view to agree with it.
    Reading it here instead of hard-coding one means this suite cannot drift
    from `db/reference/cnae_segments.csv`.
    """
    row = conn.execute(
        "select cnae, segment from cnae_segments where fit = 'compatible' order by cnae limit 1"
    ).fetchone()
    assert row, "0003_cnae_segments has not been applied to this database"
    return row[0], row[1]


def make_company(conn: psycopg.Connection, label: str, cnae: str, state: str = "SP") -> str:
    cnpj = e1_cnpj(label)
    conn.execute(
        """
        insert into companies (cnpj, legal_name, trade_name, main_cnae, state)
        values (%s, %s, %s, %s, %s)
        on conflict (cnpj) do update set main_cnae = excluded.main_cnae
        """,
        (cnpj, f"Empresa {label} LTDA", f"Empresa {label}", cnae, state),
    )
    return cnpj


def make_user(
    conn: psycopg.Connection,
    label: str,
    *,
    cnpj: str,
    plan: str = "basico",
    name: str | None = None,
) -> int:
    row = conn.execute(
        """
        insert into users (email, name, cnpj, plan, delivery_state)
        values (%s, %s, %s, %s, 'SP')
        returning id
        """,
        (e1_email(label), name or f"Fulano {label}", cnpj, plan),
    ).fetchone()
    assert row
    return int(row[0])


def link_telegram(conn: psycopg.Connection, user_id: int, chat_id: int) -> None:
    conn.execute(
        """
        insert into telegram_links (user_id, chat_id, linked_at)
        values (%s, %s, now())
        on conflict (user_id) do update
          set chat_id = excluded.chat_id, linked_at = now(), start_token = null
        """,
        (user_id, chat_id),
    )


def make_alert(
    conn: psycopg.Connection,
    user_id: int,
    *,
    states: list[str] | None = None,
    keyword: str | None = None,
    active: bool = True,
) -> int:
    row = conn.execute(
        """
        insert into alerts (user_id, kind, value, states, channel, frequency, active)
        values (%s, %s, %s, %s, 'telegram', 'weekly', %s)
        returning id
        """,
        (user_id, "keyword" if keyword else "cnae", keyword, states, active),
    ).fetchone()
    assert row
    return int(row[0])


def make_tender(
    conn: psycopg.Connection,
    n: int,
    *,
    segment: str,
    state: str = "SP",
    closes_in_days: int = 7,
    me_epp: str | None = None,
    object_text: str | None = None,
) -> str:
    from .conftest import E1_AGENCY_CNPJ

    tender_id = e1_tender_id(n)
    text = object_text or f"Aquisição de material de escritório lote {n}"
    conn.execute(
        """
        insert into tenders (id, agency_cnpj, year, sequence, object, agency_name, city, state,
                             modality_name, proposals_close_at, me_epp_summary, segments, search)
        values (%(id)s, %(cnpj)s, 2026, %(seq)s, %(object)s, 'Prefeitura de Testelândia',
                'Testelândia', %(state)s, 'Pregão - Eletrônico',
                now() + make_interval(days => %(days)s), %(me_epp)s, %(segments)s,
                to_tsvector('pt_unaccent', %(object)s))
        on conflict (id) do nothing
        """,
        {
            "id": tender_id,
            "cnpj": E1_AGENCY_CNPJ,
            "seq": n,
            "object": text,
            "state": state,
            "days": closes_in_days,
            "me_epp": me_epp,
            "segments": [segment],
        },
    )
    return tender_id


def a_ready_account(
    conn: psycopg.Connection, label: str, *, plan: str = "basico", chat: int = 1
) -> tuple[int, int, str]:
    """A linked, unpaused account whose CNAE reaches one segment."""
    cnae, segment = a_compatible_cnae(conn)
    cnpj = make_company(conn, label, cnae)
    user_id = make_user(conn, label, cnpj=cnpj, plan=plan)
    link_telegram(conn, user_id, e1_chat_id(chat))
    alert_id = make_alert(conn, user_id, states=["SP"])
    return user_id, alert_id, segment


class Recorder:
    """A client that records instead of sending. The switch is off regardless."""

    def __init__(self) -> None:
        self.sent: list[tuple[int, str]] = []

    def send_message(self, chat_id: int, text: str):
        from licitaqui.telegram import DELIVERY_DRY_RUN, SendResult

        self.sent.append((chat_id, text))
        return SendResult(status=DELIVERY_DRY_RUN)


def delivery_events(conn: psycopg.Connection, user_id: int) -> list[tuple[str, dict]]:
    return [
        (row[0], row[1] or {})
        for row in conn.execute(
            "select name, props from events where user_id = %s order by id", (user_id,)
        ).fetchall()
    ]


# -- the sweep --------------------------------------------------------------


def test_the_sweep_enqueues_one_job_per_eligible_account(e1_conn: psycopg.Connection) -> None:
    ready, _alert, _segment = a_ready_account(e1_conn, "ready", chat=1)

    paused_user, _a, _s = a_ready_account(e1_conn, "paused", chat=2)
    e1_conn.execute("update alerts set active = false where user_id = %s", (paused_user,))

    cnae, _segment = a_compatible_cnae(e1_conn)
    unlinked = make_user(e1_conn, "unlinked", cnpj=make_company(e1_conn, "unlinked", cnae))
    make_alert(e1_conn, unlinked, states=["SP"])

    eligible = dict(telegram_alerts.eligible_users(e1_conn))

    assert ready in eligible
    assert paused_user not in eligible
    assert unlinked not in eligible


def test_the_sweep_is_idempotent_within_the_week(e1_conn: psycopg.Connection) -> None:
    """Two ticks on a Monday must produce one message, not two."""
    user_id, _alert, _segment = a_ready_account(e1_conn, "once")
    moment = datetime.now(UTC)

    first = telegram_alerts.enqueue_digest(e1_conn, user_id, moment=moment)
    second = telegram_alerts.enqueue_digest(e1_conn, user_id, moment=moment)

    assert first is not None
    assert second is None  # the dedupe index, not a check in Python

    key = telegram_alerts.digest_job_key(user_id, moment)
    rows = e1_conn.execute(
        "select count(*) from jobs where kind = %s and key = %s", (JOB_KIND, key)
    ).fetchone()
    assert rows and rows[0] == 1


def test_the_sweep_handler_only_enqueues(e1_conn: psycopg.Connection, e1_connect) -> None:
    import logging

    from licitaqui.queue import Job

    user_id, _alert, segment = a_ready_account(e1_conn, "sweep")
    make_tender(e1_conn, 1, segment=segment)

    ctx = JobContext(
        job=Job(id=1, kind=DIGEST_JOB_KIND, key="k", priority=9, payload=None, attempts=1),
        conn=e1_conn,
        connect=e1_connect,
        log=logging.getLogger("test"),
    )
    REGISTRY.get(DIGEST_JOB_KIND)(ctx)

    queued = e1_conn.execute(
        "select count(*) from jobs where kind = %s and split_part(key, ':', 2) = %s",
        (JOB_KIND, str(user_id)),
    ).fetchone()
    assert queued and queued[0] == 1
    # It sent nothing itself: no delivery row exists yet.
    assert delivery_events(e1_conn, user_id) == []


# -- selection --------------------------------------------------------------


def test_the_digest_carries_at_most_three_compatible_tenders(
    e1_conn: psycopg.Connection,
) -> None:
    user_id, alert_id, segment = a_ready_account(e1_conn, "three")
    for n in range(1, 6):
        make_tender(e1_conn, n, segment=segment, closes_in_days=n)

    client = Recorder()
    delivery = telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=client,  # type: ignore[arg-type]
    )

    assert delivery.outcome == "dry_run"
    assert delivery.tender_count == telegram_alerts.MAX_TENDERS
    text = client.sent[0][1]
    assert text.count("Ler o edital:") == 3
    # Soonest deadline first: the list is ordered by `proposals_close_at`.
    assert text.index("lote 1") < text.index("lote 2") < text.index("lote 3")
    assert "lote 4" not in text

    delivered = e1_conn.execute(
        "select count(*) from alert_deliveries where alert_id = %s", (alert_id,)
    ).fetchone()
    assert delivered and delivered[0] == 3


def test_next_week_does_not_repeat_this_week(e1_conn: psycopg.Connection) -> None:
    user_id, alert_id, segment = a_ready_account(e1_conn, "norepeat")
    for n in range(1, 5):
        make_tender(e1_conn, n, segment=segment, closes_in_days=n + 20)

    first = Recorder()
    telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=first,  # type: ignore[arg-type]
    )
    assert "lote 1" in first.sent[0][1]

    # A week later — the quota window has moved on, the deliveries have not.
    next_week = datetime.now(UTC) + timedelta(days=7)
    second = Recorder()
    telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=second,  # type: ignore[arg-type]
        now=next_week,
    )

    assert "lote 1" not in second.sent[0][1]
    assert "lote 4" in second.sent[0][1]
    remaining = e1_conn.execute(
        "select count(*) from alert_deliveries where alert_id = %s", (alert_id,)
    ).fetchone()
    assert remaining and remaining[0] == 4


def test_a_closed_tender_is_never_in_a_digest(e1_conn: psycopg.Connection) -> None:
    user_id, _alert, segment = a_ready_account(e1_conn, "closed")
    make_tender(e1_conn, 1, segment=segment, closes_in_days=-1)

    client = Recorder()
    delivery = telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=client,  # type: ignore[arg-type]
    )

    assert delivery.template == "weekly-digest-empty"
    assert delivery.tender_count == 0
    assert "não apareceu nenhum edital" in client.sent[0][1]


def test_the_state_the_person_chose_is_the_only_one_they_hear_about(
    e1_conn: psycopg.Connection,
) -> None:
    """§10: Básico is one state."""
    user_id, _alert, segment = a_ready_account(e1_conn, "state")
    make_tender(e1_conn, 1, segment=segment, state="SP")
    make_tender(e1_conn, 2, segment=segment, state="RJ")

    client = Recorder()
    telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=client,  # type: ignore[arg-type]
    )

    text = client.sent[0][1]
    assert "lote 1" in text and "lote 2" not in text


def test_more_states_than_the_plan_allows_are_clamped_server_side(
    e1_conn: psycopg.Connection,
) -> None:
    """§8: quota checks are always server-side, even against a hand-edited row."""
    user_id, _alert, segment = a_ready_account(e1_conn, "clamp")
    e1_conn.execute(
        "update alerts set states = %s where user_id = %s", (["SP", "RJ", "MG"], user_id)
    )
    make_tender(e1_conn, 1, segment=segment, state="RJ")
    make_tender(e1_conn, 2, segment=segment, state="SP")

    assert telegram_alerts.state_limit(e1_conn, "basico") == 1

    client = Recorder()
    telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=client,  # type: ignore[arg-type]
    )
    text = client.sent[0][1]
    assert "lote 2" in text and "lote 1" not in text


def test_the_one_keyword_widens_the_digest_beyond_the_cnae(
    e1_conn: psycopg.Connection,
) -> None:
    """§10: Básico is one keyword as well as one state."""
    cnae, segment = a_compatible_cnae(e1_conn)
    cnpj = make_company(e1_conn, "kw", cnae)
    user_id = make_user(e1_conn, "kw", cnpj=cnpj)
    link_telegram(e1_conn, user_id, e1_chat_id(9))
    make_alert(e1_conn, user_id, states=["SP"], keyword="guardanapo")

    make_tender(
        e1_conn, 1, segment="Segmento Inexistente", object_text="Compra de guardanapos de papel"
    )

    client = Recorder()
    delivery = telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=client,  # type: ignore[arg-type]
    )

    assert delivery.tender_count == 1
    assert "guardanapos" in client.sent[0][1]


# -- the quota --------------------------------------------------------------


def test_basico_gets_one_alert_a_week_and_the_number_comes_from_plan_limits(
    e1_conn: psycopg.Connection,
) -> None:
    assert telegram_alerts.alert_limit(e1_conn, "basico") == 1

    user_id, _alert, segment = a_ready_account(e1_conn, "quota")
    for n in range(1, 5):
        make_tender(e1_conn, n, segment=segment, closes_in_days=n + 10)

    first = telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=Recorder(),  # type: ignore[arg-type]
    )
    second = telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=Recorder(),  # type: ignore[arg-type]
    )

    assert first.outcome == "dry_run"
    assert second.outcome == "skipped"
    assert second.reason == telegram_alerts.SKIP_QUOTA_REACHED


def test_the_quota_resets_on_the_brasilia_week_boundary(e1_conn: psycopg.Connection) -> None:
    user_id, _alert, segment = a_ready_account(e1_conn, "reset")
    make_tender(e1_conn, 1, segment=segment, closes_in_days=30)
    make_tender(e1_conn, 2, segment=segment, closes_in_days=31)

    telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=Recorder(),  # type: ignore[arg-type]
    )
    later = telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=Recorder(),  # type: ignore[arg-type]
        now=datetime.now(UTC) + timedelta(days=8),
    )

    assert later.outcome == "dry_run"


def test_a_paused_alert_is_a_skip_with_a_reason_not_a_failure(
    e1_conn: psycopg.Connection,
) -> None:
    user_id, _alert, _segment = a_ready_account(e1_conn, "pause")
    telegram_alerts.pause(e1_conn, user_id)

    delivery = telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=Recorder(),  # type: ignore[arg-type]
    )

    assert delivery.outcome == "skipped"
    assert delivery.reason == telegram_alerts.SKIP_PAUSED


def test_an_account_that_never_linked_is_skipped(e1_conn: psycopg.Connection) -> None:
    cnae, _segment = a_compatible_cnae(e1_conn)
    user_id = make_user(e1_conn, "nolink", cnpj=make_company(e1_conn, "nolink", cnae))
    make_alert(e1_conn, user_id, states=["SP"])

    delivery = telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=Recorder(),  # type: ignore[arg-type]
    )
    assert delivery.reason == telegram_alerts.SKIP_NOT_LINKED


# -- the delivery log -------------------------------------------------------


def test_the_delivery_log_never_holds_a_chat_id(e1_conn: psycopg.Connection) -> None:
    """§12. The log has to be enough to answer a support request, and no more."""
    user_id, _alert, segment = a_ready_account(e1_conn, "lgpd", chat=3)
    make_tender(e1_conn, 1, segment=segment)

    telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=Recorder(),  # type: ignore[arg-type]
    )

    events = delivery_events(e1_conn, user_id)
    assert [name for name, _ in events] == ["telegram.dry_run"]
    props = events[0][1]
    assert props["chat_ref"] and str(e1_chat_id(3)) not in str(props)
    assert "Fulano" not in str(props)  # no name, and no rendered body
    assert props["tenders"] == 1


def test_a_real_delivery_also_writes_the_gate_metric(e1_conn: psycopg.Connection) -> None:
    """§14's `alert_sent`. A dry run did not reach anybody, so it must not."""
    from licitaqui.telegram import SendResult

    user_id, _alert, segment = a_ready_account(e1_conn, "gate", chat=4)
    make_tender(e1_conn, 1, segment=segment)

    class Delivered(Recorder):
        def send_message(self, chat_id: int, text: str):
            self.sent.append((chat_id, text))
            return SendResult(status="sent", message_id=7, status_code=200, duration_ms=12)

    telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=Delivered(),  # type: ignore[arg-type]
    )

    names = [name for name, _ in delivery_events(e1_conn, user_id)]
    assert names == ["telegram.sent", "alert_sent"]


def test_someone_who_blocked_the_bot_stops_being_swept(e1_conn: psycopg.Connection) -> None:
    from licitaqui.telegram import REASON_BLOCKED, TelegramError

    user_id, _alert, segment = a_ready_account(e1_conn, "blocked", chat=5)
    make_tender(e1_conn, 1, segment=segment)

    class Blocked(Recorder):
        def send_message(self, chat_id: int, text: str):
            raise TelegramError(REASON_BLOCKED, status=403)

    delivery = telegram_alerts.send(
        e1_conn,
        template="weekly-digest",
        user_id=user_id,
        client=Blocked(),  # type: ignore[arg-type]
    )

    assert delivery.outcome == "failed"  # not retried: four attempts cannot unblock them
    assert user_id not in dict(telegram_alerts.eligible_users(e1_conn))


# -- the exit criterion -----------------------------------------------------


def test_the_digest_renders_for_five_accounts_at_once(e1_conn: psycopg.Connection) -> None:
    """The card's exit criterion, as a test rather than as a screenshot."""
    _cnae, segment = a_compatible_cnae(e1_conn)
    for n in range(1, 4):
        make_tender(e1_conn, n, segment=segment, closes_in_days=n, me_epp="exclusive")

    users = [a_ready_account(e1_conn, f"five{n}", chat=100 + n)[0] for n in range(5)]

    client = Recorder()
    outcomes = [
        telegram_alerts.send(
            e1_conn,
            template="weekly-digest",
            user_id=user_id,
            client=client,  # type: ignore[arg-type]
        )
        for user_id in users
    ]

    assert [o.outcome for o in outcomes] == ["dry_run"] * 5
    assert [o.tender_count for o in outcomes] == [3] * 5
    assert len(client.sent) == 5
    for _chat, text in client.sent:
        assert text.startswith("Bom dia, Fulano.")
        assert text.count("Ler o edital:") == 3
        assert text.count("Item exclusivo para ME/EPP") == 3
        assert "{{" not in text
