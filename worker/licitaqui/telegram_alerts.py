"""Telegram: the linking replies and the weekly digest (task E1, spec §7.1 §10).

:mod:`licitaqui.telegram` is the transport. This module is everything above it:
who may be messaged, how often, which tenders, and the delivery log.

## Two job kinds, and why the digest fans out

``weekly_digest`` is the **sweep**: the scheduler runs it Monday 07:00 BRT
(§7.1 `weekly_alerts`), it queries which accounts are due a digest, and it
enqueues one ``send_telegram`` job per account. It sends nothing itself.

The alternative — one job that loops over every user and sends — was rejected
for three reasons, all of which have already bitten this worker elsewhere:

* **Retries.** A job is retried as a whole (§7.2, four attempts). One failure
  on user 40 re-sends users 1–39 three more times. Per-user jobs retry only the
  user who failed.
* **Dedupe.** ``jobs_dedupe (kind, key)`` is the only cross-process guarantee
  we have that a person is messaged once. It can only protect a *per-person*
  row, so the key is ``digest:<user_id>:<ISO week>`` and the week is in it: two
  sweeps in one week enqueue nothing the second time, and a sweep that runs
  twice on Monday morning produces one message.
* **Throughput.** Four consumers run in production. A fan-out uses all four;
  a loop uses one and blocks it for the whole run.

This is the shape B2 already uses for its per-tender follow-ups, and
``send_telegram`` is the analogue of E2's ``send_whatsapp``.

The **tenders are chosen when the message is sent**, not when the sweep runs:
the payload carries a user id and a template, never a list of tender ids. A
retry forty minutes later then sends what is open *now*, and the queue never
holds a stale shortlist.

## The linking replies come from the web

`POST /api/telegram/webhook` is a Next.js route (spec §8). It authenticates the
update, does the `telegram_links` write, and enqueues a priority-1
``send_telegram`` for the reply — it never calls the Bot API itself (§3's rule,
and the kill switch lives here). Those payloads carry a ``chat_id`` because a
person who typed ``/start`` with a stale token has no account row to hang the
reply on; see :func:`recipient` for what that costs and why it is bounded.

## Quotas are §10's, read from `plan_limits`

Básico: **one alert per week, one keyword, one state.** All three come out of
`plan_limits`, never out of this file — that is what "configurable without a
deploy" in §6.2 means. :func:`alert_limit` reads the cap and
:func:`digests_sent_this_week` counts against it.

One asymmetry is deliberate and is flagged in the log. `plan_limits` has an
``alert`` row for `basico` and for **no other plan**, because §10 gives the
paid plans *daily* alerts, which are the `daily_alerts` job and not this one.
Reading a missing row as "zero" — the web's rule in `lib/radar/quota.ts` —
would silence every founder on `promocional` on opening week. So a missing cap
means *uncapped for the weekly digest*, and the sweep logs
``plan has no alert limit`` with the plan name so the gap stays visible. It
wants a `plan_limits` row, which is a migration, which is its own PR.

## LGPD (§12)

A chat id is personal data. It is read from `telegram_links` at send time,
handed to the transport, and never logged: every log line and every `events`
row carries :func:`licitaqui.telegram.chat_ref` instead — a truncated SHA-256,
the same shape as ``company.cnpj_ref``. Nothing here writes a rendered message
body anywhere either: the body contains the person's name and their company's.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from logging import Logger
from typing import Any
from zoneinfo import ZoneInfo

import psycopg
from psycopg.types.json import Jsonb

from . import queue, telegram, templates
from .breaker import CircuitOpen
from .observability import get_logger
from .registry import REGISTRY, JobContext
from .telegram import SendResult, TelegramClient, TelegramError, chat_ref

#: One outbound Telegram message. Enqueued by the web (a `/start` reply) and by
#: the sweep below (a digest).
JOB_KIND = "send_telegram"
#: The Monday sweep. Spec §7.1 calls it `weekly_alerts`; the kind is named for
#: what it produces, and the scheduler entry carries the §7.1 cadence.
DIGEST_JOB_KIND = "weekly_digest"

CHANNEL = "telegram"
BRT = ZoneInfo("America/Sao_Paulo")

#: Templates that count against the §10 weekly alert quota. A `/start` reply
#: is not an alert and must not consume someone's one message of the week.
DIGEST_TEMPLATES = frozenset({"weekly-digest", "weekly-digest-empty"})

#: Up to 3 tenders (task card, and `telegram/weekly-digest.md`).
MAX_TENDERS = 3

#: The weekday the digest goes out, for `{{dia_semana}}` in `start-linked`.
#: Derived from nothing — it *is* the schedule, so it lives next to the
#: scheduler entry that implements it and `test_telegram.py` pins the pair.
DIGEST_WEEKDAY = 0  # Monday, as `datetime.weekday()` numbers it
DIGEST_WEEKDAY_PT = "segunda-feira"

#: Where the links in a message point. Overridable so a preview deployment can
#: send links to itself without a code change.
APP_BASE_URL_VAR = "APP_BASE_URL"
DEFAULT_APP_BASE_URL = "https://www.licitaquiapp.com.br"

#: `docs/legal/LEGAL_AND_BILLING_BRIEF.md` §1: the published support address.
#: Not a decision this task made — it is the one the terms and the footer carry.
CONTACT_EMAIL = "contato@licitaquiapp.com.br"

#: Delivery log, in `events` (the same reasoning as `whatsapp.py`: a new table
#: is a migration, and migrations are their own PR).
EVENT_SENT = "telegram.sent"
EVENT_DRY_RUN = "telegram.dry_run"
EVENT_SKIPPED = "telegram.skipped"
EVENT_FAILED = "telegram.failed"
#: Spec §14's gate metric, written only for a digest that actually went out.
EVENT_ALERT_SENT = "alert_sent"

#: Why a send did not happen. Stable strings: they reach the log and
#: `events.props`, and a dashboard will group by them.
SKIP_NO_RECIPIENT = "no_recipient"
SKIP_NOT_LINKED = "not_linked"
SKIP_PAUSED = "paused"
SKIP_NO_COMPANY = "no_company"
SKIP_QUOTA_REACHED = "quota_reached"
SKIP_ALREADY_SENT = "already_sent"

MONTHS_PT = (
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
)

#: `me_epp_summary` (§6.1: exclusive | quota | mixed | none) → the ready line
#: `partial-digest-item` substitutes.
#:
#: The template's front matter is explicit that this wording is the worker's:
#: *"the worker decides the wording from me_epp_summary … the template does
#: not"*. `none` and `null` are absent on purpose — they mean there is no line,
#: and the caller then passes `tem_meepp=False` and **no** `marcador_meepp`,
#: because a blank value raises (templates README §8).
ME_EPP_MARKERS = {
    "exclusive": "Item exclusivo para ME/EPP",
    "quota": "Tem cota reservada para ME/EPP",
    "mixed": "Tem item exclusivo e cota para ME/EPP",
}

_log = get_logger("telegram")


class DigestSkipped(RuntimeError):
    """A gate said no. Carries a reason code and never a person."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


# -- links ------------------------------------------------------------------


def app_base_url() -> str:
    return (os.environ.get(APP_BASE_URL_VAR) or DEFAULT_APP_BASE_URL).rstrip("/")


def radar_url() -> str:
    return f"{app_base_url()}/radar"


def alerts_url() -> str:
    """`/conta/alertas` — where the Telegram connection is made and paused."""
    return f"{app_base_url()}/conta/alertas"


def screening_url(tender_id: str) -> str:
    """The AI reading of one tender — the "screening link" the card asks for.

    `/radar/edital/<id>/triagem`, which is what `radar/client.ts`'s
    `screeningHref` builds. A PNCP id contains a slash and the route is a
    catch-all precisely so it can stay in the path unescaped.
    """
    return f"{app_base_url()}/radar/edital/{tender_id}/triagem"


# -- formatting -------------------------------------------------------------


def format_deadline(value: datetime) -> str:
    """``30/09/2026 às 08:30``, in Brasília time.

    PNCP publishes local wall-clock deadlines and a bidder misses one by an
    hour if we print UTC, so the conversion is not cosmetic.
    """
    if value.tzinfo is None:  # pragma: no cover - Neon returns timestamptz
        value = value.replace(tzinfo=UTC)
    return value.astimezone(BRT).strftime("%d/%m/%Y às %H:%M")


def format_date_pt(value: datetime) -> str:
    local = value.astimezone(BRT)
    return f"{local.day} de {MONTHS_PT[local.month - 1]} de {local.year}"


def first_name(full_name: str | None) -> str | None:
    """``{{nome}}`` wants a first name. Never logged, never stored (§12)."""
    parts = (full_name or "").split()
    return parts[0] if parts else None


def me_epp_marker(summary: str | None) -> str | None:
    """The ready ME/EPP line, or ``None`` when the tender has no such benefit."""
    return ME_EPP_MARKERS.get(str(summary or "").strip())


def week_start(moment: datetime) -> datetime:
    """Monday 00:00 in Brasília, as an aware UTC instant.

    The quota period is a *week*, and `plan_limits.period` says so, so the
    boundary has to be the one a person would draw on a calendar — in their own
    timezone. A UTC week boundary falls at 21:00 on Sunday in Brasília, which
    would let a Sunday-evening digest and a Monday-morning one both count as
    "this week" for a plan allowed exactly one.
    """
    local = moment.astimezone(BRT)
    monday = (local - timedelta(days=local.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return monday.astimezone(UTC)


def iso_week(moment: datetime) -> str:
    """``2026-W41`` in Brasília — the week component of the dedupe key."""
    year, week, _ = moment.astimezone(BRT).isocalendar()
    return f"{year}-W{week:02d}"


def digest_job_key(user_id: int, moment: datetime) -> str:
    """One digest per account per week, enforced by `jobs_dedupe`."""
    return f"digest:{user_id}:{iso_week(moment)}"


def reply_job_key(update_id: int | str) -> str:
    """One reply per Telegram update.

    Telegram redelivers an update until it is acknowledged, so the update id is
    the natural idempotency key: a redelivery dedupes against the job already
    queued instead of sending the same greeting twice.
    """
    return f"reply:{update_id}"


# -- SQL --------------------------------------------------------------------

#: Who the digest is for. `telegram_links` is the opt-in and `alerts.active` is
#: the pause switch `/pausar` flips, so both are joined rather than filtered in
#: Python: a user with no link or a paused alert is not "skipped", they are not
#: eligible, and the sweep should not create a job to discover that.
ELIGIBLE_SQL = """
select u.id, u.plan
  from users u
  join telegram_links tl on tl.user_id = u.id
  join alerts a on a.user_id = u.id
 where tl.chat_id is not null
   and tl.linked_at is not null
   and a.channel = 'telegram'
   and a.frequency = 'weekly'
   and a.active
   and u.cnpj is not null
 group by u.id, u.plan
 order by u.id
"""

RECIPIENT_SQL = """
select u.name,
       u.cnpj,
       u.plan,
       tl.chat_id,
       c.trade_name,
       c.legal_name,
       a.id       as alert_id,
       a.value    as keyword,
       a.states   as states,
       a.active   as alert_active
  from users u
  left join telegram_links tl on tl.user_id = u.id
  left join companies c on c.cnpj = u.cnpj
  left join alerts a
         on a.user_id = u.id
        and a.channel = 'telegram'
        and a.frequency = 'weekly'
 where u.id = %(user_id)s
 order by a.id
 limit 1
"""

ALERT_LIMIT_SQL = """
select period, quantity
  from plan_limits
 where plan = %(plan)s
   and feature = 'alert'
"""

STATE_LIMIT_SQL = """
select quantity
  from plan_limits
 where plan = %(plan)s
   and feature = 'states'
"""

DIGESTS_SENT_SQL = """
select count(*)
  from events
 where user_id = %(user_id)s
   and name = any(%(names)s)
   and props ->> 'template' = any(%(templates)s)
   and created_at >= %(since)s
"""

#: The Radar's own classification, in the worker's dialect.
#:
#: `apps/web/lib/radar/tenders.ts` groups a tender `compatible` when
#: `t.segments` overlaps the company's **compatible** labels — which B6's
#: `company_segments` view only awards to a *main* CNAE. The digest sends the
#: `compatible` group and nothing else: "Verificar" is a maybe, and a maybe is
#: not worth a push notification once a week.
#:
#: The keyword arm is §10's "1 palavra-chave" on Básico. It uses the same
#: `pt_unaccent` tsvector and `websearch_to_tsquery` the Radar searches with,
#: so what the digest finds and what the site finds cannot diverge.
SELECT_TENDERS_SQL = """
with segs as (
  select coalesce(array_agg(segment), '{}'::text[]) as labels
    from company_segments
   where cnpj = %(cnpj)s
     and fit = 'compatible'
)
select t.id, t.object, t.agency_name, t.state, t.modality_name,
       t.proposals_close_at, t.me_epp_summary
  from tenders t, segs
 where t.proposals_close_at > now()
   and (
         t.segments && segs.labels
         or (%(keyword)s::text is not null
             and t.search @@ websearch_to_tsquery('pt_unaccent', %(keyword)s))
       )
   and (%(states)s::text[] is null or t.state = any(%(states)s))
   and (%(alert_id)s::bigint is null
        or not exists (select 1
                         from alert_deliveries d
                        where d.alert_id = %(alert_id)s
                          and d.tender_id = t.id))
 order by t.proposals_close_at, t.id
 limit %(limit)s
"""

RECORD_DELIVERY_SQL = """
insert into alert_deliveries (alert_id, tender_id, sent_at)
values (%(alert_id)s, %(tender_id)s, now())
on conflict (alert_id, tender_id) do nothing
"""

PAUSE_SQL = """
update alerts
   set active = false
 where user_id = %(user_id)s
   and channel = 'telegram'
"""


# -- reading ----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Tender:
    """One row of the digest. Everything on it is public PNCP data."""

    id: str
    object: str
    agency_name: str | None
    state: str | None
    modality_name: str | None
    proposals_close_at: datetime | None
    me_epp_summary: str | None


@dataclass(frozen=True, slots=True)
class Recipient:
    """Who a ``send_telegram`` job is for. ``chat_id`` is never logged (§12)."""

    user_id: int | None
    chat_id: int | None
    name: str | None
    cnpj: str | None
    plan: str
    company_name: str | None
    alert_id: int | None
    keyword: str | None
    states: tuple[str, ...]
    alert_active: bool

    @property
    def linked(self) -> bool:
        return self.chat_id is not None


@dataclass(frozen=True, slots=True)
class Delivery:
    """The outcome of one ``send_telegram`` job. Carries no personal data."""

    outcome: str
    template: str
    user_id: int | None = None
    reason: str | None = None
    message_id: int | None = None
    duration_ms: int | None = None
    tender_count: int | None = None

    @property
    def delivered(self) -> bool:
        return self.outcome == "sent"


def default_client() -> TelegramClient:
    """The client :func:`send` uses when the caller does not pass one.

    A seam, so a test can replace the transport. Building one is free and
    resolves no credentials; see :mod:`licitaqui.telegram`.
    """
    return TelegramClient()


def recipient(conn: psycopg.Connection, user_id: int) -> Recipient | None:
    with conn.cursor() as cur:
        cur.execute(RECIPIENT_SQL, {"user_id": user_id})
        row = cur.fetchone()
    if row is None:
        return None
    name, cnpj, plan, chat_id, trade, legal, alert_id, keyword, states, active = row
    return Recipient(
        user_id=user_id,
        chat_id=None if chat_id is None else int(chat_id),
        name=name,
        cnpj=cnpj,
        plan=plan or "basico",
        company_name=(trade or legal or None),
        alert_id=None if alert_id is None else int(alert_id),
        keyword=(keyword or None),
        states=tuple(states or ()),
        alert_active=bool(active) if active is not None else False,
    )


def alert_limit(conn: psycopg.Connection, plan: str) -> int | None:
    """How many alerts this plan may receive per week, from `plan_limits`.

    ``None`` means uncapped. See the module docstring for why a missing row is
    uncapped here rather than zero.
    """
    with conn.cursor() as cur:
        cur.execute(ALERT_LIMIT_SQL, {"plan": plan})
        row = cur.fetchone()
    if row is None:
        _log.warning("plan has no alert limit; weekly digest uncapped", extra={"plan": plan})
        return None
    period, quantity = row
    if quantity is None:
        return None
    if period not in (None, "week"):
        # The only period §10 gives this feature is a week. Anything else is a
        # row someone changed at runtime, and guessing what it meant is worse
        # than saying so.
        _log.warning(
            "alert limit has an unexpected period; treating it as weekly",
            extra={"plan": plan, "period": period},
        )
    return int(quantity)


def state_limit(conn: psycopg.Connection, plan: str) -> int | None:
    with conn.cursor() as cur:
        cur.execute(STATE_LIMIT_SQL, {"plan": plan})
        row = cur.fetchone()
    return None if row is None or row[0] is None else int(row[0])


def digests_sent_this_week(
    conn: psycopg.Connection, user_id: int, *, now: datetime | None = None
) -> int:
    """Digests already delivered in the current Brasília week.

    A dry run counts. The point of the number is "did this account already get
    its message this week", and on a machine with the kill switch off the
    answer is yes as far as every other gate is concerned — counting only real
    sends would make a dry-run environment loop.
    """
    moment = now or datetime.now(UTC)
    with conn.cursor() as cur:
        cur.execute(
            DIGESTS_SENT_SQL,
            {
                "user_id": user_id,
                "names": [EVENT_SENT, EVENT_DRY_RUN],
                "templates": sorted(DIGEST_TEMPLATES),
                "since": week_start(moment),
            },
        )
        row = cur.fetchone()
    return int(row[0]) if row else 0


def select_tenders(
    conn: psycopg.Connection,
    *,
    cnpj: str,
    keyword: str | None = None,
    states: tuple[str, ...] = (),
    alert_id: int | None = None,
    limit: int = MAX_TENDERS,
) -> list[Tender]:
    """The up-to-3 open tenders this company should hear about this week."""
    with conn.cursor() as cur:
        cur.execute(
            SELECT_TENDERS_SQL,
            {
                "cnpj": cnpj,
                "keyword": keyword,
                "states": list(states) or None,
                "alert_id": alert_id,
                "limit": limit,
            },
        )
        rows = cur.fetchall()
    return [Tender(*row) for row in rows]


# -- rendering --------------------------------------------------------------


def render_item(tender: Tender) -> str:
    """One `partial-digest-item`.

    The ME/EPP row is the trap templates README §8 documents: it is a
    ``[[se: …]]`` block, so when the tender has no marker the flag is false and
    **no** ``marcador_meepp`` is passed at all. Passing ``""`` would raise, and
    that is deliberate — a blank value is a half-rendered message.
    """
    if tender.proposals_close_at is None:
        # Every row of the block is a fact a bidder acts on; a tender with no
        # deadline has nothing to act on and is not worth a line.
        raise ValueError("a digest item needs a proposals_close_at")

    context: dict[str, Any] = {
        "objeto": tender.object,
        "orgao": tender.agency_name or "Órgão não informado",
        "uf": tender.state or "BR",
        "modalidade": tender.modality_name or "Licitação",
        "prazo_proposta": format_deadline(tender.proposals_close_at),
        "link_edital": screening_url(tender.id),
    }
    marker = me_epp_marker(tender.me_epp_summary)
    flags: dict[str, Any] = {"tem_meepp": marker is not None}
    if marker is not None:
        context["marcador_meepp"] = marker

    # The link must not be escaped — a URL with a `_` in it would gain a
    # backslash and stop being clickable — so it is put back afterwards.
    escaped = telegram.escape_context(context)
    escaped["link_edital"] = context["link_edital"]
    return templates.render(CHANNEL, "partial-digest-item", escaped, **flags)


def build_digest_context(
    *, name: str | None, company_name: str | None, tenders: list[Tender]
) -> tuple[str, dict[str, Any]]:
    """The template id and its context. Raises :class:`DigestSkipped` if unsendable."""
    given = first_name(name)
    if not given or not company_name:
        # Both are placeholders in both digest templates, and a blank one is a
        # `MissingPlaceholder`. Better to skip with a reason than to fail four
        # times over forty minutes against a profile that is simply incomplete.
        raise DigestSkipped(SKIP_NO_COMPANY)

    base = telegram.escape_context({"nome": given, "nome_empresa": company_name})
    if not tenders:
        return "weekly-digest-empty", {**base, "link_radar": radar_url()}
    return "weekly-digest", {
        **base,
        "lista_editais": "\n\n".join(render_item(tender) for tender in tenders),
        "link_radar": radar_url(),
    }


def build_reply_context(template: str, who: Recipient | None) -> dict[str, Any]:
    """The context for one of E0's `/start`, `/ajuda` and `/pausar` replies."""
    if template in ("start-no-token", "start-token-invalid"):
        return {"link_conexao": alerts_url()}
    if template == "stop":
        return {"link_preferencias": alerts_url()}
    if template == "help":
        return {"link_app": app_base_url(), "email_contato": CONTACT_EMAIL}

    given = first_name(who.name if who else None)
    company = who.company_name if who else None
    if not given or not company:
        raise DigestSkipped(SKIP_NO_COMPANY)
    context = telegram.escape_context({"nome": given, "nome_empresa": company})
    if template == "start-linked":
        context["dia_semana"] = DIGEST_WEEKDAY_PT
    return context


# -- sending ----------------------------------------------------------------


def send(
    conn: psycopg.Connection,
    *,
    template: str,
    user_id: int | None = None,
    chat_id: int | None = None,
    client: TelegramClient | None = None,
    job_id: int | None = None,
    attempt: int | None = None,
    now: datetime | None = None,
    log: Logger | None = None,
) -> Delivery:
    """Run the gates, render, send, log. Raises only for a retryable fault."""
    log = log or _log
    client = client or default_client()
    moment = now or datetime.now(UTC)
    common: dict[str, Any] = {"template": template, "user_id": user_id}

    who = recipient(conn, user_id) if user_id is not None else None
    if user_id is not None and who is None:
        return _skip(conn, log, common, SKIP_NO_RECIPIENT, job_id, attempt)

    target = chat_id if chat_id is not None else (who.chat_id if who else None)
    if target is None:
        return _skip(conn, log, common, SKIP_NOT_LINKED, job_id, attempt)

    tenders: list[Tender] = []
    try:
        if template in DIGEST_TEMPLATES:
            if who is None:
                return _skip(conn, log, common, SKIP_NO_RECIPIENT, job_id, attempt)
            tenders, context, template = _digest(conn, who, moment)
        else:
            context = build_reply_context(template, who)
    except DigestSkipped as exc:
        return _skip(conn, log, common, exc.reason, job_id, attempt)

    common["template"] = template
    # A template fault (a missing placeholder, an unresolved TODO(Sci)) raises
    # out of here on purpose: it is our bug, not the recipient's, and it should
    # be a visible failed job rather than a silently skipped person.
    text = templates.render(CHANNEL, template, context)

    try:
        result = client.send_message(target, text)
    except CircuitOpen as exc:
        _record_failure(conn, common, "circuit_open", job_id, attempt, target)
        log.warning("telegram send skipped: circuit open", extra={"breaker": exc.name, **common})
        raise
    except TelegramError as exc:
        _record_failure(conn, common, exc.reason, job_id, attempt, target, status=exc.status)
        log.warning(
            "telegram send failed",
            extra={
                **common,
                "chat_ref": chat_ref(target),
                "reason": exc.reason,
                "status": exc.status,
                "retryable": exc.retryable,
            },
        )
        if exc.blocked and user_id is not None:
            # They blocked the bot or deleted the chat. Retrying cannot reach
            # them and next Monday's sweep would enqueue another job, so the
            # alert goes quiet until they reconnect from the site.
            pause(conn, user_id)
            log.info("telegram alert paused: the bot can no longer reach them", extra=common)
        if exc.retryable:
            raise
        return Delivery(outcome="failed", reason=exc.reason, **common)

    delivery = _record_success(conn, log, common, result, job_id, attempt, target, len(tenders))
    if delivery.delivered and who is not None and who.alert_id is not None:
        # Only after it left: a tender marked delivered by a send that failed
        # would never be offered again.
        record_deliveries(conn, who.alert_id, [tender.id for tender in tenders])
    return delivery


def _digest(
    conn: psycopg.Connection, who: Recipient, moment: datetime
) -> tuple[list[Tender], dict[str, Any], str]:
    """Quota, then selection, then context. Raises :class:`DigestSkipped`."""
    if not who.alert_active:
        raise DigestSkipped(SKIP_PAUSED)
    if not who.cnpj:
        raise DigestSkipped(SKIP_NO_COMPANY)

    assert who.user_id is not None
    cap = alert_limit(conn, who.plan)
    if cap is not None and digests_sent_this_week(conn, who.user_id, now=moment) >= cap:
        raise DigestSkipped(SKIP_QUOTA_REACHED if cap > 0 else SKIP_ALREADY_SENT)

    states = who.states
    allowed = state_limit(conn, who.plan)
    if allowed is not None and len(states) > allowed:
        # The screen enforces this when the preference is saved; clamping again
        # here is what makes it true for a row edited by hand or left behind by
        # a downgrade. §8: quota checks are always server-side.
        _log.warning(
            "alert asks for more states than the plan allows; using the first",
            extra={"plan": who.plan, "asked": len(states), "allowed": allowed},
        )
        states = states[:allowed]

    tenders = select_tenders(
        conn,
        cnpj=who.cnpj,
        keyword=who.keyword,
        states=states,
        alert_id=who.alert_id,
    )
    template, context = build_digest_context(
        name=who.name, company_name=who.company_name, tenders=tenders
    )
    return tenders, context, template


def record_deliveries(conn: psycopg.Connection, alert_id: int, tender_ids: list[str]) -> None:
    """Remember what this alert has already sent, so next week differs."""
    with conn.cursor() as cur:
        for tender_id in tender_ids:
            cur.execute(RECORD_DELIVERY_SQL, {"alert_id": alert_id, "tender_id": tender_id})


def pause(conn: psycopg.Connection, user_id: int) -> None:
    """Stop the digest without touching the account (`/pausar`, `stop.md`)."""
    with conn.cursor() as cur:
        cur.execute(PAUSE_SQL, {"user_id": user_id})


def eligible_users(conn: psycopg.Connection) -> list[tuple[int, str]]:
    with conn.cursor() as cur:
        cur.execute(ELIGIBLE_SQL)
        return [(int(row[0]), row[1] or "basico") for row in cur.fetchall()]


def enqueue_digest(
    conn: psycopg.Connection, user_id: int, *, moment: datetime, priority: int = 9
) -> int | None:
    """One digest job for one account, deduped on the ISO week."""
    return queue.enqueue(
        conn,
        JOB_KIND,
        digest_job_key(user_id, moment),
        priority=priority,
        payload={"template": "weekly-digest", "user_id": user_id},
    )


# -- handlers ---------------------------------------------------------------


@REGISTRY.job(JOB_KIND)
def send_telegram(ctx: JobContext) -> None:
    """One outbound message. Idempotent (§7.2)."""
    template = ctx.payload.get("template")
    if not template:
        raise ValueError("send_telegram payload needs a 'template'")
    user_id = ctx.payload.get("user_id")
    chat_id = ctx.payload.get("chat_id")
    if user_id is None and chat_id is None:
        raise ValueError("send_telegram payload needs a 'user_id' or a 'chat_id'")
    send(
        ctx.conn,
        template=str(template),
        user_id=None if user_id is None else int(user_id),
        chat_id=None if chat_id is None else int(chat_id),
        job_id=ctx.job.id,
        attempt=ctx.job.attempts,
        log=ctx.log,
    )


@REGISTRY.job(DIGEST_JOB_KIND)
def weekly_digest(ctx: JobContext) -> None:
    """The Monday sweep. Enqueues; never sends. See the module docstring."""
    moment = datetime.now(UTC)
    users = eligible_users(ctx.conn)
    created = 0
    for user_id, _plan in users:
        if enqueue_digest(ctx.conn, user_id, moment=moment) is not None:
            created += 1
    ctx.log.info(
        "weekly digest swept",
        extra={"eligible": len(users), "enqueued": created, "week": iso_week(moment)},
    )


# -- delivery log -----------------------------------------------------------


def _record(
    conn: psycopg.Connection, name: str, user_id: int | None, props: dict[str, Any]
) -> None:
    """One delivery-log row. Never a chat id, a name or a message body (§12)."""
    with conn.cursor() as cur:
        cur.execute(
            "insert into events (user_id, name, props) values (%s, %s, %s)",
            (user_id, name, Jsonb({k: v for k, v in props.items() if v is not None})),
        )


def _skip(
    conn: psycopg.Connection,
    log: Logger,
    common: dict[str, Any],
    reason: str,
    job_id: int | None,
    attempt: int | None,
) -> Delivery:
    _record(
        conn,
        EVENT_SKIPPED,
        common.get("user_id"),
        {**common, "reason": reason, "job_id": job_id, "attempt": attempt},
    )
    log.info(f"telegram send skipped: {reason}", extra={**common, "reason": reason})
    return Delivery(outcome="skipped", reason=reason, **common)


def _record_failure(
    conn: psycopg.Connection,
    common: dict[str, Any],
    reason: str,
    job_id: int | None,
    attempt: int | None,
    target: int,
    *,
    status: int | None = None,
) -> None:
    _record(
        conn,
        EVENT_FAILED,
        common.get("user_id"),
        {
            **common,
            "chat_ref": chat_ref(target),
            "reason": reason,
            "status": status,
            "job_id": job_id,
            "attempt": attempt,
        },
    )


def _record_success(
    conn: psycopg.Connection,
    log: Logger,
    common: dict[str, Any],
    result: SendResult,
    job_id: int | None,
    attempt: int | None,
    target: int,
    tender_count: int,
) -> Delivery:
    name = EVENT_SENT if result.delivered else EVENT_DRY_RUN
    props = {
        **common,
        "chat_ref": chat_ref(target),
        "message_id": result.message_id,
        "status": result.status_code,
        "duration_ms": result.duration_ms,
        "tenders": tender_count,
        "plain_text_fallback": result.plain_text_fallback or None,
        "job_id": job_id,
        "attempt": attempt,
    }
    _record(conn, name, common.get("user_id"), props)
    if result.delivered and common["template"] == "weekly-digest":
        # §14's gate metric. Only a real delivery of a real digest: an empty
        # week is not an alert, and a dry run did not reach anybody.
        _record(
            conn,
            EVENT_ALERT_SENT,
            common.get("user_id"),
            {"channel": CHANNEL, "tenders": tender_count},
        )
    log.info(
        "telegram message sent" if result.delivered else "telegram message not sent (dry run)",
        extra={
            **common,
            "chat_ref": chat_ref(target),
            "outcome": result.status,
            "tenders": tender_count,
            "duration_ms": result.duration_ms,
            "delivery_mode": telegram.delivery_mode(),
        },
    )
    return Delivery(
        outcome=result.status,
        message_id=result.message_id,
        duration_ms=result.duration_ms,
        tender_count=tender_count,
        **common,
    )
