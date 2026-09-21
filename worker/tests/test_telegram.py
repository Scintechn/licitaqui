"""E1: the Telegram transport, the kill switch, and the digest's copy contract.

Everything here runs without a database. The parts that need one —
eligibility, the quota, the tender selection — are in
``test_integration_telegram.py``.

Two properties get most of the attention, because both are things you cannot
take back once they are wrong in production:

* **the kill switch**, which is the only thing standing between a worker
  pointed at the production database and a real message to a real founder; and
* **the blank-value trap** in ``templates.py`` — a placeholder set to ``""``
  raises, deliberately, so every optional row in a digest item has to be a
  ``[[se: …]]`` block. ``partial-digest-item`` is exactly that shape and
  :func:`licitaqui.telegram_alerts.render_item` has to honour it for every
  value of ``me_epp_summary`` the schema permits.
"""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import httpx
import pytest

from licitaqui import telegram, telegram_alerts, templates
from licitaqui.breaker import reset_all
from licitaqui.scheduler import DEFAULT_SCHEDULE, ScheduleEntry
from licitaqui.telegram import TelegramClient, TelegramError
from licitaqui.telegram_alerts import DigestSkipped, Recipient, Tender

SAO_PAULO = ZoneInfo("America/Sao_Paulo")

#: A chat id shaped like a real one. Nothing dials it: `conftest`'s autouse
#: `_telegram_delivery_off` holds the kill switch down for the whole suite,
#: and every client below runs on an `httpx.MockTransport`.
CHAT_ID = 1234567890


@pytest.fixture(autouse=True)
def _closed_breakers() -> None:
    reset_all()


def enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(telegram.DELIVERY_VAR, telegram.DELIVERY_SEND)


def ok_response(message_id: int = 42) -> httpx.Response:
    return httpx.Response(200, json={"ok": True, "result": {"message_id": message_id}})


def api_error(status: int, description: str) -> httpx.Response:
    return httpx.Response(
        status, json={"ok": False, "error_code": status, "description": description}
    )


def client(handler, **kwargs) -> TelegramClient:
    return TelegramClient(
        token="123:fake-token-for-tests",
        api_base="https://telegram.test",
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


def tender(**overrides) -> Tender:
    base = {
        "id": "51885242000140-1-000744/2026",
        "object": "Aquisição de pilhas e baterias",
        "agency_name": "Prefeitura de Campinas",
        "state": "SP",
        "modality_name": "Pregão - Eletrônico",
        "proposals_close_at": datetime(2026, 9, 30, 11, 30, tzinfo=UTC),
        "me_epp_summary": None,
    }
    return Tender(**{**base, **overrides})


def recipient(**overrides) -> Recipient:
    base = {
        "user_id": 7,
        "chat_id": CHAT_ID,
        "name": "Sci Lima",
        "cnpj": "36955612000185",
        "plan": "basico",
        "company_name": "Scint Tecnologia",
        "alert_id": 3,
        "keyword": None,
        "states": ("SP",),
        "alert_active": True,
    }
    return Recipient(**{**base, **overrides})


# -- the kill switch -------------------------------------------------------


def test_nothing_leaves_the_process_with_the_switch_off() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("the transport was reached with the kill switch off")

    result = client(handler).send_message(CHAT_ID, "olá")

    assert result.status == telegram.DELIVERY_DRY_RUN
    assert not result.delivered
    assert telegram.delivery_mode() == telegram.DELIVERY_DRY_RUN


@pytest.mark.parametrize("value", ["1", "true", "yes", "on", "SEND", "Send", "senda", "", "0"])
def test_only_the_exact_word_send_turns_it_on(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    """A copy-pasted `=1` must not start messaging people."""
    monkeypatch.setenv(telegram.DELIVERY_VAR, value)
    assert not telegram.sending_enabled()


def test_surrounding_whitespace_is_forgiven_the_way_evolution_forgives_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An env file that gained a trailing space is still a deliberate `send`."""
    monkeypatch.setenv(telegram.DELIVERY_VAR, " send ")
    assert telegram.sending_enabled()


def test_the_transport_refuses_outright_if_it_is_reached_with_the_switch_off() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("a request was made")

    with pytest.raises(telegram.SendingDisabled):
        client(handler).post_message(CHAT_ID, "olá")


def test_a_dry_run_needs_no_credentials_at_all(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every CI run and every laptop. Building the client resolves nothing."""
    monkeypatch.delenv(telegram.BOT_TOKEN_VAR, raising=False)
    assert TelegramClient().send_message(CHAT_ID, "olá").status == telegram.DELIVERY_DRY_RUN


def test_with_the_switch_on_it_posts_one_sendmessage(monkeypatch: pytest.MonkeyPatch) -> None:
    enabled(monkeypatch)
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok_response(message_id=99)

    result = client(handler).send_message(CHAT_ID, "*Bom dia*")

    assert result.delivered and result.message_id == 99
    assert len(seen) == 1
    assert seen[0].url.path.endswith("/sendMessage")
    import json

    body = json.loads(seen[0].content)
    assert body["chat_id"] == CHAT_ID
    assert body["parse_mode"] == telegram.PARSE_MODE
    assert body["disable_web_page_preview"] is True


# -- LGPD: the chat id never escapes --------------------------------------


def test_chat_ref_correlates_without_naming() -> None:
    ref = telegram.chat_ref(CHAT_ID)
    assert ref == telegram.chat_ref(str(CHAT_ID))
    assert ref != telegram.chat_ref(CHAT_ID + 1)
    assert str(CHAT_ID) not in ref
    assert len(ref) == 16


def test_an_error_carries_a_reason_code_and_never_the_chat_id_or_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enabled(monkeypatch)

    def handler(_request: httpx.Request) -> httpx.Response:
        # Telegram quotes back what it was given; none of it may propagate.
        return api_error(400, f"Bad Request: chat not found for {CHAT_ID}")

    with pytest.raises(TelegramError) as raised:
        client(handler).send_message(CHAT_ID, "olá")

    text = str(raised.value)
    assert telegram.REASON_CHAT_NOT_FOUND in text
    assert str(CHAT_ID) not in text
    assert "fake-token-for-tests" not in text
    assert raised.value.__cause__ is None


def test_a_timeout_does_not_chain_the_request_that_carried_the_chat_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enabled(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    with pytest.raises(TelegramError) as raised:
        client(handler).send_message(CHAT_ID, "olá")

    assert raised.value.reason == telegram.REASON_TIMEOUT
    assert raised.value.__cause__ is None
    assert str(CHAT_ID) not in str(raised.value)


# -- Markdown ---------------------------------------------------------------


def test_escape_markdown_neutralises_every_metacharacter() -> None:
    assert telegram.escape_markdown("MATERIAL_ESCOLAR") == r"MATERIAL\_ESCOLAR"
    assert telegram.escape_markdown("lote *3* [A] `x`") == r"lote \*3\* \[A] \`x\`"


def test_escape_context_leaves_the_conditional_flags_alone() -> None:
    """A flag turned into the string 'False' is truthy, and renders the block."""
    out = telegram.escape_context({"nome": "Sci_", "tem_meepp": False, "nada": None})
    assert out["nome"] == r"Sci\_"
    assert out["tem_meepp"] is False
    assert out["nada"] is None


def test_a_rejected_parse_falls_back_to_plain_text_rather_than_dropping_the_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enabled(monkeypatch)
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        body = json.loads(request.content)
        calls.append(body)
        if "parse_mode" in body:
            return api_error(400, "Bad Request: can't parse entities: unmatched '*'")
        return ok_response()

    result = client(handler).send_message(CHAT_ID, "*quebrado")

    assert result.delivered
    assert result.plain_text_fallback is True
    assert len(calls) == 2 and "parse_mode" not in calls[1]


def test_any_other_400_is_not_retried_without_the_parse_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enabled(monkeypatch)
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return api_error(403, "Forbidden: bot was blocked by the user")

    with pytest.raises(TelegramError) as raised:
        client(handler).send_message(CHAT_ID, "olá")

    assert calls == 1
    assert raised.value.reason == telegram.REASON_BLOCKED
    assert raised.value.blocked and not raised.value.retryable


@pytest.mark.parametrize(
    ("status", "description", "reason"),
    [
        (403, "Forbidden: bot was blocked by the user", telegram.REASON_BLOCKED),
        (403, "Forbidden: user is deactivated", telegram.REASON_BLOCKED),
        (400, "Bad Request: chat not found", telegram.REASON_CHAT_NOT_FOUND),
        (401, "Unauthorized", telegram.REASON_UNAUTHORISED),
        (429, "Too Many Requests: retry after 12", telegram.REASON_RATE_LIMITED),
        # Measured against the live bot on 2026-09-21, sending to the id in
        # `TELEGRAM_CHAT_ID` — which turned out to be the bot's own.
        (403, "Forbidden: the bot can't send messages to the bot", telegram.REASON_FORBIDDEN),
    ],
)
def test_failures_map_to_stable_reason_codes(
    monkeypatch: pytest.MonkeyPatch, status: int, description: str, reason: str
) -> None:
    enabled(monkeypatch)

    def handler(_request: httpx.Request) -> httpx.Response:
        return api_error(status, description)

    with pytest.raises(TelegramError) as raised:
        client(handler).post_message(CHAT_ID, "olá")
    assert raised.value.reason == reason


def test_a_plain_forbidden_does_not_pause_somebody_s_digest() -> None:
    """Only a real block should. A misconfiguration must stay loud."""
    error = TelegramError(telegram.REASON_FORBIDDEN, status=403)
    assert not error.retryable
    assert not error.blocked


def test_a_200_that_says_ok_false_is_still_a_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """Telegram answers some failures with HTTP 200 and `ok: false`."""
    enabled(monkeypatch)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": False, "description": "Bad Request: chat not found"})

    with pytest.raises(TelegramError) as raised:
        client(handler).post_message(CHAT_ID, "olá")
    assert raised.value.reason == telegram.REASON_CHAT_NOT_FOUND


def test_two_consecutive_failures_open_the_breaker(monkeypatch: pytest.MonkeyPatch) -> None:
    from licitaqui.breaker import CircuitOpen

    enabled(monkeypatch)

    def handler(_request: httpx.Request) -> httpx.Response:
        return api_error(500, "Internal Server Error")

    bot = client(handler)
    for _ in range(2):
        with pytest.raises(TelegramError):
            bot.post_message(CHAT_ID, "olá")
    with pytest.raises(CircuitOpen):
        bot.post_message(CHAT_ID, "olá")


# -- the blank-value trap --------------------------------------------------


@pytest.mark.parametrize(
    ("summary", "expected"),
    [
        ("exclusive", "Item exclusivo para ME/EPP"),
        ("quota", "Tem cota reservada para ME/EPP"),
        ("mixed", "Tem item exclusivo e cota para ME/EPP"),
        ("none", None),
        (None, None),
        ("", None),
    ],
)
def test_the_me_epp_marker_covers_every_value_the_column_allows(
    summary: str | None, expected: str | None
) -> None:
    """`tenders_me_epp_summary_check`: exclusive | quota | mixed | none | null."""
    assert telegram_alerts.me_epp_marker(summary) == expected


@pytest.mark.parametrize("summary", ["exclusive", "quota", "mixed", "none", None])
def test_a_digest_item_renders_for_every_me_epp_value(summary: str | None) -> None:
    """The trap: with no marker the flag is false and **nothing** is passed.

    A `marcador_meepp=""` would raise `MissingPlaceholder` on the first tender
    without a benefit, which is most of them.
    """
    text = telegram_alerts.render_item(tender(me_epp_summary=summary))

    assert "Aquisição de pilhas e baterias" in text
    assert "Propostas até 30/09/2026 às 08:30" in text
    assert text.splitlines()[-1].startswith("Ler o edital:")
    assert ("ME/EPP" in text) is (summary in ("exclusive", "quota", "mixed"))
    # The row is removed, not blanked: no hole opens where it was.
    assert "\n\n" not in text


def test_a_digest_item_survives_a_tender_whose_object_breaks_markdown() -> None:
    text = telegram_alerts.render_item(
        tender(object="AQUISIÇÃO DE MATERIAL_ESCOLAR *URGENTE*", agency_name="Prefeitura [SP]")
    )
    assert r"MATERIAL\_ESCOLAR" in text
    assert r"\*URGENTE\*" in text
    assert r"Prefeitura \[SP]" in text


def test_the_screening_link_is_never_escaped() -> None:
    """A backslash in a URL stops it being a link, and the id contains a slash."""
    text = telegram_alerts.render_item(tender())
    assert "Ler o edital: https://www.licitaquiapp.com.br/radar/edital/" in text
    assert "51885242000140-1-000744/2026/triagem" in text
    assert "\\" not in text.splitlines()[-1]


def test_a_tender_with_no_deadline_is_not_a_digest_row() -> None:
    with pytest.raises(ValueError, match="proposals_close_at"):
        telegram_alerts.render_item(tender(proposals_close_at=None))


# -- the digest context ----------------------------------------------------


def test_three_tenders_render_into_the_weekly_digest() -> None:
    tenders = [
        tender(id=f"5188524200014{n}-1-00074{n}/2026", object=f"Objeto {n}") for n in range(3)
    ]
    name, context = telegram_alerts.build_digest_context(
        name="Sci Lima", company_name="Scint Tecnologia", tenders=tenders
    )
    text = templates.render("telegram", name, context)

    assert name == "weekly-digest"
    assert text.startswith("Bom dia, Sci.")
    assert text.count("Ler o edital:") == 3
    assert "Ver todos no Radar: https://www.licitaquiapp.com.br/radar" in text


def test_an_empty_week_uses_the_other_template_rather_than_sending_nothing() -> None:
    name, context = telegram_alerts.build_digest_context(
        name="Sci Lima", company_name="Scint Tecnologia", tenders=[]
    )
    text = templates.render("telegram", name, context)

    assert name == "weekly-digest-empty"
    assert "não apareceu nenhum edital" in text


def test_a_profile_with_no_company_is_skipped_rather_than_half_rendered() -> None:
    with pytest.raises(DigestSkipped) as raised:
        telegram_alerts.build_digest_context(name="Sci", company_name=None, tenders=[])
    assert raised.value.reason == telegram_alerts.SKIP_NO_COMPANY

    with pytest.raises(DigestSkipped):
        telegram_alerts.build_digest_context(name="   ", company_name="Scint", tenders=[])


def test_a_company_name_with_an_underscore_does_not_break_the_bold_run() -> None:
    _name, context = telegram_alerts.build_digest_context(
        name="Sci", company_name="Scint_Tecnologia", tenders=[]
    )
    text = templates.render("telegram", "weekly-digest-empty", context)
    assert r"*Scint\_Tecnologia*" in text


# -- every reply E0 wrote, rendered from a real context --------------------


@pytest.mark.parametrize(
    "template",
    [
        "start-linked",
        "start-already-linked",
        "start-no-token",
        "start-token-invalid",
        "help",
        "stop",
    ],
)
def test_every_telegram_reply_renders_from_its_context_builder(template: str) -> None:
    """The contract between E0's copy and E1's context dicts, pinned.

    A placeholder E0 adds and this does not supply raises at render time, and
    the failure would otherwise be a job failing four times in production.
    """
    context = telegram_alerts.build_reply_context(template, recipient())
    text = templates.render("telegram", template, context)

    assert text.strip()
    assert "{{" not in text and "[[" not in text


def test_the_linked_reply_promises_the_day_the_scheduler_actually_runs() -> None:
    """`start-linked.md` says "toda {{dia_semana}}". It must not be a guess."""
    text = templates.render(
        "telegram", "start-linked", telegram_alerts.build_reply_context("start-linked", recipient())
    )
    assert f"toda {telegram_alerts.DIGEST_WEEKDAY_PT} de manhã" in text

    entry = next(e for e in DEFAULT_SCHEDULE if e.kind == telegram_alerts.DIGEST_JOB_KIND)
    assert entry.weekday == telegram_alerts.DIGEST_WEEKDAY
    assert entry.daily_at == "07:00"


def test_the_replies_that_have_no_account_need_no_recipient() -> None:
    """`/start` with a stale token comes from a chat we cannot name."""
    for template in ("start-no-token", "start-token-invalid", "help", "stop"):
        context = telegram_alerts.build_reply_context(template, None)
        assert templates.render("telegram", template, context).strip()


# -- time -------------------------------------------------------------------


def test_the_deadline_is_printed_in_brasilia_time() -> None:
    """PNCP deadlines are wall-clock local; printing UTC loses a bidder an hour."""
    at = datetime(2026, 9, 30, 11, 30, tzinfo=UTC)
    assert telegram_alerts.format_deadline(at) == "30/09/2026 às 08:30"


def test_the_quota_week_starts_on_monday_in_brasilia_not_in_utc() -> None:
    """A UTC week boundary falls at 21:00 on Sunday in São Paulo.

    Two digests either side of it are the same calendar week to the person
    reading them, and the plan allows one.
    """
    sunday_evening = datetime(2026, 10, 11, 23, 0, tzinfo=UTC)  # 20:00 BRT, Sunday
    monday_morning = datetime(2026, 10, 12, 10, 0, tzinfo=UTC)  # 07:00 BRT, Monday

    assert telegram_alerts.week_start(sunday_evening) != telegram_alerts.week_start(monday_morning)
    assert (
        telegram_alerts.week_start(monday_morning)
        .astimezone(SAO_PAULO)
        .strftime("%Y-%m-%d %H:%M %a")
        == "2026-10-12 00:00 Mon"
    )

    # …and 21:30 UTC on that Sunday is still the *old* week, which a naive
    # UTC boundary would already have rolled over.
    late = datetime(2026, 10, 11, 21, 30, tzinfo=UTC)
    assert telegram_alerts.week_start(late) == telegram_alerts.week_start(sunday_evening)


def test_the_digest_key_carries_the_week_so_two_sweeps_produce_one_message() -> None:
    monday = datetime(2026, 10, 12, 10, 0, tzinfo=UTC)
    thursday = datetime(2026, 10, 15, 10, 0, tzinfo=UTC)
    next_monday = datetime(2026, 10, 19, 10, 0, tzinfo=UTC)

    assert telegram_alerts.digest_job_key(7, monday) == "digest:7:2026-W42"
    assert telegram_alerts.digest_job_key(7, thursday) == telegram_alerts.digest_job_key(7, monday)
    assert telegram_alerts.digest_job_key(7, next_monday) != telegram_alerts.digest_job_key(
        7, monday
    )


def test_a_redelivered_update_dedupes_on_its_update_id() -> None:
    assert telegram_alerts.reply_job_key(9001) == "reply:9001"


# -- the weekly scheduler entry --------------------------------------------


def test_the_weekly_entry_lands_on_monday_morning_brasilia() -> None:
    entry = ScheduleEntry(kind="weekly_digest", daily_at="07:00", weekday=0)

    # Thursday 09:00 BRT → the coming Monday.
    after = datetime(2026, 10, 15, 12, 0, tzinfo=UTC)
    assert entry.next_due(after).astimezone(SAO_PAULO).strftime("%Y-%m-%d %H:%M %a") == (
        "2026-10-19 07:00 Mon"
    )

    # Monday 06:00 BRT → today, not next week.
    early = datetime(2026, 10, 12, 9, 0, tzinfo=UTC)
    assert entry.next_due(early).astimezone(SAO_PAULO).strftime("%Y-%m-%d %H:%M %a") == (
        "2026-10-12 07:00 Mon"
    )

    # Monday 08:00 BRT, already past → next Monday, not tomorrow.
    late = datetime(2026, 10, 12, 11, 0, tzinfo=UTC)
    assert entry.next_due(late).astimezone(SAO_PAULO).strftime("%Y-%m-%d %H:%M %a") == (
        "2026-10-19 07:00 Mon"
    )


def test_a_weekday_without_a_daily_time_is_a_configuration_error() -> None:
    with pytest.raises(ValueError, match="weekday needs daily_at"):
        ScheduleEntry(kind="x", every_seconds=60, weekday=0)
    with pytest.raises(ValueError, match="0 \\(Monday\\)"):
        ScheduleEntry(kind="x", daily_at="07:00", weekday=7)


def test_both_telegram_job_kinds_have_a_handler() -> None:
    """The scheduler must never enqueue a kind nothing can run."""
    from licitaqui import handlers
    from licitaqui.registry import REGISTRY

    assert handlers.registered_kinds()
    assert telegram_alerts.JOB_KIND in REGISTRY.kinds()
    assert telegram_alerts.DIGEST_JOB_KIND in REGISTRY.kinds()
