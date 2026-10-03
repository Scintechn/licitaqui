"""The catalogue price base: ingest the rows, compute the band (card B35).

One job kind, ``refresh_catalog_prices``, wearing two hats — the same shape
:mod:`licitaqui.sync_awards` uses, with the sweep and the worker collapsed into
one kind because the work item is a *code* and nothing else ever asks for it:

**no ``code`` in the payload — the sweep.** Makes no HTTP call. It picks stale
codes in descending order of how many open items point at them and enqueues one
small job each. A single long job is the thing to avoid: the worker is
concurrency-limited (``config.DEFAULT_CONCURRENCY``) and a job holding a slot
for hours starves ``sync_open_tenders`` — that is B32's lesson, where a price
feed stopped growing on 2026-09-29 and nobody noticed for two days.

**``code`` in the payload — one code's refresh.** Walks that code's price rows
for an incremental date window, writes the minimal tuple, recomputes the band
over everything stored for the code, and writes `catalog_bands` — a band or a
**reason**, never a missing row.

## The five numbers this design is made of, each measured

======================================  ==========================================
measured                                 what it decided
======================================  ==========================================
top 20% of codes carry **83.6%** of      the sweep is demand-ordered, so most of
resolved items                           the value lands in the first hours
exact 56% hit / **−3.6%** bias;          **only ``rule = 'exact'`` may feed a
prefix 42% / **+18.6%**                  band** — see `catalog_match`
median **1.87** rows per `idCompra`      one row per purchase at ingest: −47%
(mean 2.98, worst 47.8)                  storage — and **both** of that
                                         purchase's numbers, because two-row
                                         purchases are the modal multi-row case
                                         and the two differ by a third there
**99%** of refusals are spread           `refused_reason` is a column, so the
(182 of 183, measured 2026-10-02)        real constraint is a counted number
services: 22.4% resolve, **0 bands**     ``kind='S'`` gets no refresh budget
from any source over 136 items
======================================  ==========================================

## Clocks (`CLAUDE.md`)

``dataCompra`` is a **Brazilian calendar date**, so the window bounds and
`catalog_bands.window_end` are dates in **BRT**. `fetched_at` and `computed_at`
are written by ``now()`` and are therefore **UTC**, like every other timestamp in
this database. The schedule hour is BRT, and the row it writes is UTC. The two
are converted in exactly one place, :func:`brt_today`.

## The alarm, and the one it must not be

An `events` row per sweep run, as :mod:`licitaqui.catalog_sync` does, carrying
**how many codes were refreshed in the last :data:`ALARM_DAYS` days**. That is
the number worth alarming on. ``queued`` is in the same row for context and is
**never** the alarm: B32 is precisely a feed that never enqueued, therefore never
failed, and was invisible for two days. A watchdog on "0 queued" would have been
silent for exactly the outage it was meant to catch; a watchdog on "0 refreshed"
fires whether the cause is the enqueuer, the handler, the breaker or the API.

Phrase it as **"no `catalog_prices_swept` row in N days, or a row whose
`refreshed_codes` is 0"**, and read both halves. The first half matters because
a sweep that cannot run at all — the missing-table case, which is what a fresh
deploy looks like before `0014_catalog_prices.sql` is applied — writes a row
saying ``failed`` and otherwise nothing: :func:`_sweep` records on the way out of
every path precisely so that half is reachable, and the version that recorded
last reproduced B32 inside the function written to prevent it.

Per code there is no `events` row on success — 7 000 a week would be noise — but
there are two on the exceptional paths: :data:`TRUNCATED_EVENT`, and the attempt
marker that stops any failing code being re-walked daily for ever
(:data:`ATTEMPT_COOLDOWN_HOURS`).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from psycopg import Connection
from psycopg.types.json import Jsonb

from .breaker import CircuitOpen
from .catalog_match import BAND_ELIGIBLE_RULES
from .compras import MAX_PRICE_PAGES, ComprasClient, PriceWalk
from .observability import get_logger
from .price_band import (
    MAX_AGE_MONTHS,
    MAX_SAMPLES_SHOWN,
    MAX_SPREAD,
    MIN_SAMPLE,
    REFUSED_NO_ROWS,
    REFUSED_TOO_OLD,
    Band,
    BandOutcome,
    PurchasePrice,
    collapse_by_purchase,
    compute_band,
    is_usable_price,
    shift_months_back,
)
from .queue import enqueue_many
from .registry import REGISTRY, JobContext

_log = get_logger("catalog_prices")

JOB_KIND = "refresh_catalog_prices"

#: §7.3: 9 is sampling and cleanup, and nothing is waiting on this. Same
#: priority `sync_awards` runs its per-tender jobs at, for the same reason — it
#: must never sit in front of a user's screening or of `sync_open_tenders`.
PRICE_PRIORITY = 9

#: Codes one sweep enqueues. **A cap, chosen above the derived need — and the
#: arithmetic below is the honest version, because the first one did not add up.**
#:
#: What is measured [M]: 7 109 codes cover the whole open corpus; the median
#: exact-matched code holds **379 purchases**; the only throughput measured clean
#: over thousands of calls is **0.55 calls/s** (3 workers at 0.40 s spacing,
#: 2 668 calls, zero 429); a median code is ~709 rows ≈ **2 pages** at the API's
#: 500.
#:
#: What follows from that [I]: 379 is **above** :data:`DEEP_PURCHASES`, so more
#: than half of codes fall on the 30-day cadence rather than the 7-day one. A
#: half-and-half split needs ``0.5 × 7109/30 + 0.5 × 7109/7 ≈ 626`` codes a day;
#: the worst case, every code thin, needs ``7109/7 ≈ 1 016``. The earlier comment
#: here quoted only that 1 016 and then set the constant to 1 000 — a cap *below*
#: the need it had just derived, and derived from a cadence the measured median
#: contradicts. Both halves were wrong in opposite directions.
#:
#: 1 000 is kept because it is comfortably above the realistic 626 and within a
#: rounding of the all-thin bound, and because the backlog is self-levelling: a
#: code not reached today is still stale tomorrow and sorts by the same demand
#: order. At ~2 pages a code that is ≈2 000 calls ≈ **1 h of calling** at
#: 0.55 calls/s, spread over 1 000 short jobs. A full 12 974-call first pass
#: budgets at ~6.5 h on the same figure.
#:
#: Daily rather than weekly deliberately: the cadence that matters is per code,
#: and a weekly sweep would put the whole pass in one burst. Measure the first
#: real pass; treat anything faster as earned.
DEFAULT_SWEEP_CODES = 1000

#: How long a shallow code's band stays fresh. Weekly: one purchase can flip a
#: thin code across :data:`MIN_SAMPLE` or :data:`MAX_SPREAD`, and it costs one
#: page to find out.
THIN_REFRESH_HOURS = 24 * 7

#: How long a deep code's band stays fresh. Monthly: a week adds ~1.3% of new
#: rows to a deep code and a quartile moves as O(1/n), so daily buys nothing
#: measurable there while costing the most pages.
DEEP_REFRESH_HOURS = 24 * 30

#: Where "deep" starts, in purchases already banded.
DEEP_PURCHASES = 200

#: How far back the window reaches behind the last fetch. **[I], not measured.**
#:
#: A row's `dataCompra` precedes its publication: the probe of 2026-10-03 saw a
#: purchase dated 2026-09-28 carrying `dataHoraAtualizacaoItem` of 2026-10-01.
#: A window starting exactly at the last fetch would therefore miss a purchase
#: published after it, permanently — the band is recomputed from storage, so a
#: row never fetched is a row never counted. 30 days is a judgement about how
#: late a publication can be, and it is the knob to tighten once somebody has
#: measured the real lag.
REFETCH_OVERLAP_DAYS = 30

#: How long a row is kept, which is **not** the age gate.
#:
#: Six months of headroom past :data:`MAX_AGE_MONTHS` on purpose, for two
#: reasons that both bite:
#:
#: * **C4 re-tunes the gates, and `MAX_AGE_MONTHS` is one of them.** §4 of the
#:   approach doc keeps rows precisely so that re-tuning is a query rather than
#:   a 19.6-hour re-fetch — and pruning at exactly 18 months would make tuning
#:   it *upward* impossible, which is the direction that buys coverage.
#: * **It is what keeps `too_old` truthful.** Pruned at the gate, a code whose
#:   newest purchase is 20 months old would hold no rows at all and be recorded
#:   as `no_rows` — "nobody has ever bought this" — when the truth is that
#:   people stopped buying it. Two different findings.
PRUNE_AGE_MONTHS = MAX_AGE_MONTHS + 6

#: The window the alarm looks back over, and the window the event reports.
ALARM_DAYS = 7

#: What produced a stored band, written to `catalog_bands.band_version`.
#:
#: The column was called `matcher` and the migration renamed it: a band is per
#: **code**, and no item matcher takes part in computing one, so there was
#: nothing a band row could honestly attribute to a matcher.
#:
#: It names the gates, so a gate change is visible in SQL — which is what C4
#: needs when it re-tunes them.
#:
#: ``rep=median`` is the part that is **load-bearing rather than informative**.
#: Each purchase contributes two numbers, `priceBand`'s interpolating median and
#: `priceEvidence`'s lower-middle real row, and for a two-row purchase those
#: differ by a third (lots of 10 and 20 give 15 against 10). An earlier version
#: of this module computed the band from the real row, and the measured 56% hit
#: and +0.2% bias were produced by the median. Both numbers are now stored
#: (`unit_price_median` and `unit_price`), so a stored row has to say which one
#: its quartiles were drawn from, or a later comparison against the back-test
#: would be comparing two different functions.
BAND_VERSION = f"price-band-v1:min{MIN_SAMPLE}:spread{MAX_SPREAD}:age{MAX_AGE_MONTHS}:rep=median"

#: Recorded in `events` when a walk stopped at the page cap.
#:
#: **Not a `catalog_bands` row.** A truncated walk knows nothing about the code,
#: so a refusal row at today's `window_end` would supersede yesterday's correct
#: band for every reader that takes the newest window — the band would disappear
#: from the price screen on the day the cap bit. It would also have to invent an
#: `n_purchases`, and a `0` there would reclassify the deepest codes (the only
#: ones that *can* truncate) as thin in :data:`STALE_CODES_SQL`, re-walking the
#: most expensive codes four times as often. So truncation is counted here and
#: nowhere else.
TRUNCATED_EVENT = "catalog_prices_truncated"

#: How many purchases of a code keep their `description`.
#:
#: The approach doc's own figure (§4: descriptions for the newest ~10 rows per
#: code, ~18 MB), and deliberately **more** than the :data:`MAX_SAMPLES_SHOWN` a
#: thin rung can print. The asymmetry is on purpose: the trim is an
#: ``update … set description = null`` and is **irreversible** for rows past the
#: cut, while no reader for these columns exists yet, so the cheap direction to
#: be wrong in is keeping too much text. Raising this costs storage; lowering it
#: costs a re-fetch.
#:
#: Written as a ``max`` so "never fewer than a rung prints" holds by
#: construction rather than by a test somebody has to remember: if
#: :data:`MAX_SAMPLES_SHOWN` ever rises above 10, this rises with it.
DESCRIPTIONS_KEPT = max(10, MAX_SAMPLES_SHOWN)

#: How long before a code is walked to full depth again.
#:
#: :data:`REFETCH_OVERLAP_DAYS` is unmeasured and the gap it leaves is
#: **permanent** rather than late: the band is recomputed from storage, so a
#: purchase published more than the overlap after its `dataCompra` sits outside
#: every future incremental window and is never counted at all. A periodic
#: full-depth walk is what heals it.
#:
#: **The first version of this was a calendar lottery and it did not work.** It
#: asked ``today.toordinal() % 28 == code % 28`` — one day in 28 — while a code
#: is only *looked at* when it is stale, about every 7 days. 7 divides 28, so a
#: code's refresh days sit in one residue class mod 7 and can only ever meet its
#: assigned day if the phases happen to agree: simulated over a year of weekly
#: refreshes, **86% of codes would never have been walked to full depth, ever**.
#: The test passed because it asserted the mechanism (one day in 28, true by
#: construction) and never asked whether the job could reach it — `CLAUDE.md`
#: §4b's unit-not-path, in a fix written for exactly that class of defect.
#:
#: So the trigger is **data, not the calendar**: see :func:`window_for`. The
#: oldest `fetched_at` among the code's in-window rows ages monotonically under
#: incremental refreshes — they only ever rewrite recent purchases — and resets
#: only when a full-depth walk rewrites everything. That is provable for every
#: cadence instead of probable for some.
#:
#: 90 days rather than 28 is a cost choice: at 28 a deep code (refreshed
#: monthly) would be full-depth on *every* refresh, which is 62 pages a month
#: each. At 90 a thin code is full-depth on ~8% of its refreshes and a deep one
#: on ~33%, so every code is walked to full depth about four times a year — and
#: a full pass is ~12 974 calls ≈ 6.5 h at the measured 0.55 calls/s, so four of
#: them a year is ~26 h.
FULL_WALK_EVERY_DAYS = 90

#: How long a code is left alone after it was **attempted**, whatever happened.
#:
#: Without this, every failure path leaves the code permanently due. Staleness
#: is read from `catalog_bands.computed_at`, and a truncated walk deliberately
#: writes no band row (:data:`TRUNCATED_EVENT`) while the short-walk, page-count
#: and window guards all raise before writing one — so the code is stale again
#: on the next sweep, and on every sweep after it. For a truncated deep code
#: that is ~200 calls a day forever, out of a ~2 000-call daily budget, at the
#: top of the demand order, producing nothing; and `refreshed_codes` stays
#: healthy, so no alarm fires. Before the band row was removed, the refusal
#: itself backed the code off for a week.
#:
#: One attempt marker per code, rewritten, exactly as
#: :func:`licitaqui.sync_awards.mark_probed` does for a tender. It is a **floor**
#: on how often a code may be attempted, never a ceiling on the cadence: a deep
#: code still waits :data:`DEEP_REFRESH_HOURS`. And it cannot mask a transient
#: failure, because the queue's own attempts and backoff all happen inside one
#: job — this only delays the *next* job.
ATTEMPT_COOLDOWN_HOURS = THIN_REFRESH_HOURS

#: Marker name prefix, with the code in `name` so the lookup is an exact hit on
#: `events_name_created_idx` — B4's and B8's pattern.
ATTEMPT_EVENT_PREFIX = "catalog_prices:"

BRT = ZoneInfo("America/Sao_Paulo")

#: `catalog_prices.kind`. Only materials: see :data:`licitaqui.compras.PRICE_PATHS`.
MATERIAL = "M"


def brt_today(now: datetime | None = None) -> date:
    """Today's calendar date in BRT — the clock `dataCompra` is written on.

    The one conversion in this module. A shell `date` on Sci's laptop is four
    hours ahead of the product and ``now()`` is one hour behind it, and a
    worker was once declared stalled for an hour on exactly that mistake.
    """
    moment = now or datetime.now(ZoneInfo("UTC"))
    return moment.astimezone(BRT).date()


@dataclass(frozen=True, slots=True)
class PriceLot:
    """One raw lot of one purchase, with **no supplier field**.

    Not an optimisation — the rule (approach doc §4.1, `CLAUDE.md`, spec §12).
    Every raw price row carries `niFornecedor`, which is a CNPJ **or a CPF** for
    an individual supplier, plus `nomeFornecedor`; 3.9 M of those is 3.9 M
    identifiers we must not hold. Making it a type with nowhere to put one is
    the same structural argument `price-band.ts` makes for `LockedEvidence`
    having no price field: a leak would have to be a new column, not a forgotten
    line.

    The other 33 fields of the payload are dropped because nothing reads them,
    and that is where 9.65 GB becomes 0.24 GB.

    This is what :func:`parse_rows` returns — **every lot**, uncollapsed. One of
    them becomes a :class:`StoredPrice` once the purchase's median is known.
    """

    id_compra: str
    item_number: int
    unit_price: float
    purchased_on: date | None
    supply_unit: str | None
    catalog_item_code: int | None
    description: str | None


@dataclass(frozen=True, slots=True)
class StoredPrice:
    """Exactly the minimal tuple: **one row per purchase, carrying two prices.**

    ``unit_price`` is the representative lot — a price somebody actually paid,
    which is what a thin rung may print — and ``unit_price_median`` is the
    purchase's median, which is what the band is computed from. Both, because
    the lots are discarded here and the choice cannot be remade later; see
    :class:`licitaqui.price_band.Representative`.

    ``item_number`` is the representative lot's own number. It left the primary
    key in the amended migration — that key is now ``(kind, code, id_compra)``,
    so one row per purchase is structural rather than something the writer has
    to keep true.
    """

    id_compra: str
    item_number: int
    unit_price: float
    unit_price_median: float
    purchased_on: date | None
    supply_unit: str | None
    catalog_item_code: int | None
    description: str | None


def _as_positive_int(value: object) -> int | None:
    """``codigoItemCatalogo`` arrives as an int and ``codigoPdm`` as a *string*.

    Measured on a real row 2026-10-03: ``codigoItemCatalogo = 458192`` (int),
    ``codigoPdm = '13768'`` (str). So nothing here may assume either, and a
    value that is neither is dropped rather than coerced — a wrong
    `catalog_item_code` would mis-attribute a price to another product, which is
    the one failure this whole card is about.
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    # `.isdigit()` without stripping a sign, so "-5" is refused rather than
    # becoming a negative item number inside the primary key. Codes and item
    # numbers are positive; a value that is neither is dropped, not coerced.
    if isinstance(value, str) and value.strip().isdigit():
        parsed = int(value.strip())
        return parsed if parsed > 0 else None
    return None


def _as_date(value: object) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def parse_rows(rows: list[dict[str, object]]) -> list[PriceLot]:
    """API payload → the minimal tuple. **Every lot, not yet collapsed.**

    The collapse deliberately happens later, in :func:`merge_with_stored`,
    because *collapsing twice is not collapsing the union*: a window holding
    lots at 10 and 30 reduces to 10, and merging that with a stored 20 gives 10,
    where the lower-middle of ``{10, 20, 30}`` is 20. One collapse, over the
    whole set, or the stored price depends on how the lots were split across
    windows.

    What does happen here: only the fields the band and the rungs read survive,
    so no supplier identifier is carried even transiently into a tuple that
    could be logged — and the price filter runs on the **raw** value.

    ``supply_unit`` reads ``siglaUnidadeFornecimento`` and falls back to
    ``siglaUnidadeMedida``, in that order, because **measured 2026-10-03 the
    second is frequently null while the first carries the unit** (a real row:
    ``siglaUnidadeMedida = None``, ``siglaUnidadeFornecimento = 'UN'``).
    Reading only the obvious-looking field would have stored nulls.
    """
    parsed: list[PriceLot] = []
    for row in rows:
        id_compra = row.get("idCompra")
        item_number = _as_positive_int(row.get("numeroItemCompra"))
        if id_compra is None or item_number is None:
            # No identity for the purchase or the item means no primary key, and
            # a synthesised one would collide across refreshes.
            continue
        price = row.get("precoUnitario")
        if not is_usable_price(price):
            # **The filter is applied to the raw value, not after a `float()`.**
            # `float(row.get("precoUnitario") or 0.0)` was here and was two
            # defects at once: `"1830.00"` was silently *coerced* into storage
            # although `is_usable_price` rejects a string, which falsified this
            # module's claim that a non-price never reaches storage; and
            # `"1.830,00"` or a nested object raised `ValueError`/`TypeError`,
            # killing the whole code's refresh over one row of one page — and
            # taking that page's locals to Sentry on the way out.
            continue
        unit = row.get("siglaUnidadeFornecimento") or row.get("siglaUnidadeMedida")
        description = row.get("descricaoItem")
        parsed.append(
            PriceLot(
                id_compra=str(id_compra),
                item_number=item_number,
                unit_price=float(price),  # type: ignore[arg-type]
                purchased_on=_as_date(row.get("dataCompra")),
                supply_unit=str(unit) if isinstance(unit, str) and unit.strip() else None,
                catalog_item_code=_as_positive_int(row.get("codigoItemCatalogo")),
                description=str(description) if isinstance(description, str) else None,
            )
        )
    return parsed


def is_truncated(walk: PriceWalk) -> bool:
    """Whether the read is entitled to produce anything at all.

    The only refusal a *read* decides, and the reason it is not a
    `catalog_bands` row is in :data:`TRUNCATED_EVENT`.

    **An empty window is deliberately not a refusal**, and getting that wrong
    would have been the worst defect in this file: in the steady state most
    windows are empty — a month with no new purchase of a code is the normal
    case — and a ``no_rows`` read off the *window* would overwrite a perfectly
    good band with "this code has no purchases" every time nothing new arrived.
    ``no_rows`` is a statement about the **stored** history, so
    :func:`compute_band` makes it.
    """
    return not walk.complete


# -- picking the work ------------------------------------------------------

#: Codes worth refreshing, most-demanded first, stale ones only.
#:
#: ``rule`` is a bound parameter rather than a literal so the predicate is the
#: one place that rule is written — :data:`licitaqui.catalog_match.BAND_ELIGIBLE_RULES`
#: — and a test asserts the value that reaches the database rather than that a
#: string appears in this file. A prefix match's band runs **+18.6%** against
#: the real winning price where exact runs **−3.6%**, so feeding one here would
#: not fail, it would publish a biased number.
#:
#: The cadence is per code and by depth, applied in the same statement as the
#: demand order: a code with no band yet is always due, a deep one every
#: :data:`DEEP_REFRESH_HOURS`, a thin one every :data:`THIN_REFRESH_HOURS`.
#: Without this the top codes would be re-walked on every sweep and the tail
#: would never be reached at all.
STALE_CODES_SQL = """
with demand as (
  select c.code, count(*) as items
    from tender_item_codes c
    join tenders t on t.id = c.tender_id
   where c.kind = %(kind)s
     and c.rule = any(%(rules)s::text[])
     and c.code is not null
     and (t.proposals_close_at is null or t.proposals_close_at > now())
   group by c.code
)
select d.code, d.items
  from demand d
  left join lateral (
       select computed_at, n_purchases, refused_reason
         from catalog_bands b
        where b.kind = %(kind)s and b.code = d.code
        -- `computed_at`, not `window_end`: the question here is *when did we
        -- last look*, and a delayed job upserting an older window writes a
        -- fresher `computed_at`. Ordering by the window would ignore it and the
        -- code would fall due early. They are not the same question.
        order by b.computed_at desc
        limit 1
  ) last on true
 -- **A real WHERE, and that is the whole of this fix.** Every predicate below
 -- was written after `on true`, so it belonged to the LEFT JOIN's ON clause —
 -- and a failed ON condition on a left join keeps the left row and nulls the
 -- right side instead of filtering it out. The statement therefore degenerated
 -- to "the top N codes by demand": no cadence, no cooldown, and
 -- `THIN_REFRESH_HOURS`, `DEEP_REFRESH_HOURS`, `DEEP_PURCHASES` and
 -- `ATTEMPT_COOLDOWN_HOURS` all dead. `tender_value.DUE_SQL` and
 -- `sync_awards.PENDING_TENDERS_SQL` put exactly this kind of predicate in a
 -- WHERE; this one did not, and the two tests for it asserted substrings of
 -- the SQL *text*, so both passed on a statement that filtered nothing.
 where
   -- Attempted recently? Leave it alone whatever the band row says. This is
   -- what bounds every failure path: a truncated walk writes no band row and
   -- the raising guards write none either, so without this the code is stale
   -- again tomorrow and re-burns a full walk a day, for ever.
   not exists (select 1
                     from events e
                    where e.name = %(marker_prefix)s || d.code::text
                      and e.created_at > now()
                                       - make_interval(hours => %(attempt_hours)s::int))
   -- `last.computed_at is null` is **load-bearing here and was dead in the
   -- ON**: the column is `not null`, so the only way it is null is the lateral
   -- having matched no row at all — a code with no band yet, which is always
   -- due. Inside the ON clause that branch could never change the outcome,
   -- because the join kept the row whatever the expression said.
   and (last.computed_at is null
     or last.computed_at < now() - make_interval(hours => case
          -- A code with no usable purchases is not worth asking weekly: ~6% of
          -- needed codes genuinely have none in 18 months, and the answer does
          -- not change often. Treated as deep, so ~400 codes stop costing a
          -- page a week each to re-learn the same nothing.
          --
          -- `too_old` is in here for a second reason as well as that one: those
          -- refusals carry `n_purchases = 0` — the gate was applied to an empty
          -- fresh sample — so the depth branch below would read them as **thin**
          -- and re-ask weekly. That is exactly the misclassification
          -- `TRUNCATED_EVENT`'s docstring refuses to cause, arriving by a
          -- different door.
          when last.refused_reason in (%(no_rows)s, %(too_old)s)
            then %(deep_hours)s::int
          when coalesce(last.n_purchases, 0) >= %(deep)s::int
            then %(deep_hours)s::int
          else %(thin_hours)s::int
        end))
 order by d.items desc, d.code
 limit %(limit)s
"""

#: The two watermarks the window is built from, both as **BRT calendar dates**.
#:
#: ``last_fetch`` is where an incremental window starts. ``oldest_in_window`` is
#: the oldest `fetched_at` among rows the band can still use, and it is what
#: decides a full-depth walk: an incremental refresh only ever rewrites recent
#: purchases, so this value **ages monotonically** and resets only when a
#: full-depth walk rewrites them all. That makes the full-depth trigger provable
#: rather than a calendar coincidence — see :data:`FULL_WALK_EVERY_DAYS` for the
#: lottery it replaced and why that one reached 14% of codes.
#:
#: The filter is on `purchased_on` against the age gate, not on everything
#: stored: rows kept past the gate by :data:`PRUNE_AGE_MONTHS` are never
#: refetched by any window, so including them would hold this value permanently
#: old and make every walk a full-depth one.
#:
#: `fetched_at` is UTC in the row and a calendar date in the request, so both
#: conversions are explicit rather than implied.
WATERMARKS_SQL = """
select ((max(fetched_at)) at time zone 'America/Sao_Paulo')::date,
       ((min(fetched_at) filter (where purchased_on >= %(cutoff)s))
          at time zone 'America/Sao_Paulo')::date
  from catalog_prices
 where kind = %(kind)s and code = %(code)s
"""

#: "This code was attempted just now." Rewritten, one row per code.
#:
#: Nothing personal is in it (§12) — a kind and a code.
ATTEMPT_MARKER_SQL = "insert into events (name, props) values (%s, %s)"
DELETE_ATTEMPT_MARKER_SQL = "delete from events where name = %s"

#: Everything stored for one code, as the band's input.
#:
#: **`unit_price_median`, never `unit_price`.** The band is `priceBand`'s
#: arithmetic over per-purchase medians; `unit_price` is the representative real
#: lot, which for a two-row purchase is the *minimum*. Reading the wrong column
#: here is the one defect in this module that would produce a plausible,
#: systematically low band with every gate passing and nothing in the log
#: looking wrong — which is why
#: :class:`~licitaqui.price_band.PurchasePrice` has no field the other number
#: could even be assigned to, and why a test round-trips the two-lot case
#: through this statement rather than constructing the input by hand.
#:
#: Still ordered, although the amended primary key ``(kind, code, id_compra)``
#: makes one row per purchase structural: if the invariant were ever broken by
#: hand, :func:`~licitaqui.price_band.compute_band` has to pick between the
#: rows, and an unordered read would make that pick depend on the query plan.
STORED_PURCHASES_SQL = """
select id_compra, unit_price_median, purchased_on
  from catalog_prices
 where kind = %(kind)s and code = %(code)s
 order by id_compra
"""

#: The stored rows for the purchases a window is about to rewrite.
#:
#: Read **before** the delete, because the collapse has to run over
#: ``stored ∪ fetched`` and not over the window alone. A purchase whose lots do
#: not all share one `dataCompra` can appear in a window with only some of them,
#: and collapsing that subset would overwrite the representative derived from
#: the full set — so the stored price for that purchase would depend on which
#: window happened to catch it, and the band would move with it, with no record
#: that it had.
STORED_FOR_PURCHASES_SQL = """
select id_compra, item_number, unit_price, purchased_on,
       supply_unit, catalog_item_code, description
  from catalog_prices
 where kind = %(kind)s and code = %(code)s
   and id_compra = any(%(purchases)s::text[])
"""

#: One row per purchase, upserted.
#:
#: An upsert rather than the delete-then-insert this started as. The amended
#: primary key is ``(kind, code, id_compra)``, so a second lot of the same
#: purchase **cannot exist** and the delete is no longer what enforces the
#: invariant — `item_number` is now a plain column holding the representative
#: lot's number. `on conflict` updates the representative in place: one
#: statement instead of two, and no window in which the purchase is absent.
#:
#: **Both prices are written.** `unit_price` is the representative real lot (a
#: thin rung may print it); `unit_price_median` is the purchase's median (the
#: band is computed from it). Writing only one would be unrecoverable, because
#: the lots are discarded here.
INSERT_PRICES_SQL = """
insert into catalog_prices
  (kind, code, id_compra, item_number, unit_price, unit_price_median,
   purchased_on, supply_unit, catalog_item_code, description, fetched_at)
values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
on conflict (kind, code, id_compra) do update set
  item_number = excluded.item_number,
  unit_price = excluded.unit_price,
  unit_price_median = excluded.unit_price_median,
  purchased_on = excluded.purchased_on,
  supply_unit = excluded.supply_unit,
  catalog_item_code = excluded.catalog_item_code,
  description = excluded.description,
  fetched_at = now()
"""

PRUNE_STALE_SQL = """
delete from catalog_prices
 where kind = %(kind)s and code = %(code)s and purchased_on < %(cutoff)s
"""

#: Keep words only on the newest few purchases of a code.
#:
#: A thin rung prints at most :data:`MAX_SAMPLES_SHOWN`, so text beyond that is
#: paid for and never shown. Run as a sweep over the code rather than decided
#: per batch, because "newest" is a property of the whole code and an
#: incremental batch cannot see it.
#:
#: **Re-derived for the amended primary key.** It used to compare the row value
#: ``(id_compra, item_number)``; `item_number` has left the key, so the
#: comparison is now the single column ``id_compra`` — which is also simpler and
#: cheaper.
#:
#: **Why the `NOT IN` is NULL-safe.** `NOT IN` evaluates to UNKNOWN — and
#: therefore excludes *every* row, silently trimming nothing — if the subquery
#: can yield a NULL. `id_compra` is part of the primary key ``(kind, code,
#: id_compra)``, so Postgres enforces NOT NULL on it and the subquery cannot.
#: That is a dependency on the migration, not on this file: were `id_compra`
#: ever to leave the key, this statement would start updating zero rows with no
#: error. Under the old key the same argument rested on `item_number`, which has
#: since moved, and this comment is the one that would have gone stale.
TRIM_DESCRIPTIONS_SQL = """
update catalog_prices set description = null
 where kind = %(kind)s and code = %(code)s
   and description is not null
   and id_compra not in (
       select id_compra
         from catalog_prices
        where kind = %(kind)s and code = %(code)s
        order by purchased_on desc nulls last, id_compra desc
        limit %(keep)s
   )
"""

WRITE_BAND_SQL = """
insert into catalog_bands
  (kind, code, window_end, low, median, high, n_purchases,
   refused_reason, computed_at, band_version)
values (%(kind)s, %(code)s, %(window_end)s, %(low)s, %(median)s, %(high)s,
        %(n)s, %(reason)s, now(), %(band_version)s)
on conflict (kind, code, window_end) do update set
  low = excluded.low, median = excluded.median, high = excluded.high,
  n_purchases = excluded.n_purchases,
  refused_reason = excluded.refused_reason,
  computed_at = now(), band_version = excluded.band_version
"""

#: What the alarm reads: one row per outcome over the last N days.
#:
#: ``refused_reason is null`` is a band. Everything else is a counted refusal,
#: which is the entire reason the column exists rather than the row being
#: absent — 99% of them are `spread_too_wide` and nobody could have known that
#: from a screen.
REFRESH_SUMMARY_SQL = """
select coalesce(refused_reason, 'banded') as outcome, count(distinct code)
  from catalog_bands
 where kind = %(kind)s
   and computed_at > now() - make_interval(days => %(days)s::int)
 group by 1
"""

#: The alarm number itself, and it is **not** the sum of the breakdown above.
#:
#: A code that produced two outcomes inside the window — banded on Monday,
#: `spread_too_wide` on Thursday after one purchase flipped it — appears in two
#: groups, so summing them counts it twice. The alarm *direction* survives that
#: (zero is still zero), but the figure is read as a count of codes and has to
#: be one.
REFRESHED_CODES_SQL = """
select count(distinct code)
  from catalog_bands
 where kind = %(kind)s
   and computed_at > now() - make_interval(days => %(days)s::int)
"""


def stale_codes(
    conn: Connection,
    *,
    limit: int = DEFAULT_SWEEP_CODES,
    kind: str = MATERIAL,
    thin_hours: int = THIN_REFRESH_HOURS,
    deep_hours: int = DEEP_REFRESH_HOURS,
    attempt_hours: int = ATTEMPT_COOLDOWN_HOURS,
) -> list[tuple[int, int]]:
    """``[(code, open_items)]``, most-demanded first."""
    return [
        (int(code), int(items))
        for code, items in conn.execute(
            STALE_CODES_SQL,
            {
                "kind": kind,
                # The single place the exact-only rule is written.
                "rules": sorted(BAND_ELIGIBLE_RULES),
                "deep": DEEP_PURCHASES,
                "deep_hours": deep_hours,
                "thin_hours": thin_hours,
                "attempt_hours": attempt_hours,
                "marker_prefix": ATTEMPT_EVENT_PREFIX,
                "no_rows": REFUSED_NO_ROWS,
                "too_old": REFUSED_TOO_OLD,
                "limit": limit,
            },
        ).fetchall()
    ]


def mark_attempted(conn: Connection, *, kind: str, code: int) -> None:
    """Record that this code was attempted just now.

    Written **before** the walk, so it bounds every outcome including the ones
    that raise and the ones that write no band row. See
    :data:`ATTEMPT_COOLDOWN_HOURS` for what goes wrong without it.

    Rewritten rather than appended: one row per code, the shape B4's and B8's
    markers use.
    """
    name = f"{ATTEMPT_EVENT_PREFIX}{code}"
    conn.execute(DELETE_ATTEMPT_MARKER_SQL, (name,))
    conn.execute(ATTEMPT_MARKER_SQL, (name, Jsonb({"kind": kind, "code": code})))


def window_for(conn: Connection, *, kind: str, code: int, today: date) -> tuple[date, date]:
    """The ``[start, end]`` to ask for — incremental, or periodically full depth.

    First load reaches back :data:`MAX_AGE_MONTHS` and no further: a purchase
    older than the age gate can never feed a band, so asking for one is spent
    budget. Afterwards the start is the last fetch minus
    :data:`REFETCH_OVERLAP_DAYS`, which is what turns a 19.6-hour full pass into
    minutes of steady state — **except** every :data:`FULL_WALK_EVERY_DAYS`,
    when the window goes back to the gate again.

    The full-depth trigger is the **data**, not the date: ``oldest_in_window``
    is the oldest `fetched_at` among rows the band can still use, an incremental
    window only ever rewrites recent purchases, so that value ages
    monotonically and resets only when a full-depth walk rewrites them all.
    Every code therefore reaches full depth within
    :data:`FULL_WALK_EVERY_DAYS` plus one refresh interval, whatever its
    cadence. The version this replaced tested a single calendar day against the
    code number and reached 14% of codes.

    Both bounds are returned and both are sent. One alone is **silently
    ignored** by this endpoint (measured — see :mod:`licitaqui.compras`), which
    would make every "incremental" refresh an unwitting 18-month re-walk.

    One thing here looks like a bug and is not: the watermark is over **stored
    rows**, so a window that returns nothing writes nothing and ``last_fetch``
    does not advance — the window then stays wide for an inactive code. That
    costs nothing, because a wide window over a code nobody is buying returns
    few rows and is one page; and it is the property that makes a truncated or
    crashed refresh safe, since a watermark taken from `catalog_bands` would
    advance on a refusal and skip the pages the run never read.
    """
    floor = shift_months_back(today, MAX_AGE_MONTHS)
    row = conn.execute(
        WATERMARKS_SQL,
        {
            "kind": kind,
            "code": code,
            "cutoff": floor,
        },
    ).fetchone()
    last_fetch, oldest_in_window = row if row else (None, None)
    if last_fetch is None:
        return floor, today
    if oldest_in_window is None or (today - oldest_in_window).days >= FULL_WALK_EVERY_DAYS:
        return floor, today
    start = last_fetch - timedelta(days=REFETCH_OVERLAP_DAYS)
    return max(start, floor), today


def merge_with_stored(
    conn: Connection, *, kind: str, code: int, fetched: list[PriceLot]
) -> list[StoredPrice]:
    """Collapse each touched purchase over ``stored ∪ fetched``, into both prices.

    This is the **only** place the collapse runs, because collapsing twice is
    not collapsing the union: a window holding lots at 10 and 30 reduces to one
    row, and merging that with a stored 20 is not the same as taking all three.
    :func:`parse_rows` therefore hands over every lot.

    **What this guards against is measured not to happen, and the guard stays
    anyway.** The hazard is a purchase whose lots do not all share one
    `dataCompra`, so a date window sees only some of them and the subset's
    numbers overwrite the full set's. Measured 2026-10-03 on one page of PDM
    13768 — 500 rows, 136 purchases, 77 of them multi-lot, up to 32 lots —
    **0 purchases had lots carrying different `dataCompra`**, so a window takes a
    purchase's lots all or none. One page of one code is not the corpus, and the
    guard costs one indexed read, so it is cheaper to keep than to rely on that.

    **Its limit, corrected: two windows are enough, not three.** Storage holds
    one row per purchase, so the stored side contributes that purchase's
    *representative lot* and the purchase's other lots are already gone. So this
    is a two-stage collapse, and the authority is single-stage — group every lot
    of the purchase, take that group's median. The residual appears the moment a
    purchase is split across **two** windows:

    * window 1 sees lots at 200 and 1000 → stores row 200, median 600;
    * window 2 sees a lot at 250 → candidates are {250, 200}, so the stored
      median becomes 225 — where the authority over {200, 250, 1000} gives 250.

    The reviewer measured the same shape at a stored median of 600.00 where
    `priceBand` gives 250.00, moving a published median from 250 to 260 and the
    spread from 0.040 to 0.077. The earlier wording here said *"across three or
    more windows"*, which made the residual sound unreachable; it is reachable
    at two, and that sentence was the thing making it look negligible.

    **The premise does not cover it.** The measurement below — 0 of 77 multi-lot
    purchases with differing `dataCompra` — is one page of one code, and it is
    the *only* reason to think the split never happens. It is not a bound on the
    residual; it is a reason to believe the residual is not exercised. Bounding
    it properly needs either the lots kept (which §4 of the approach doc
    rejected on storage grounds) or a `dataCompra`-stability measurement across
    codes. Until one of those exists, this is a known, unbounded divergence from
    the authority that is believed not to fire.

    Fetched lots win over the stored one at the same ``(id_compra,
    item_number)``, because the API is the source of truth for a price it has
    just restated.
    """
    if not fetched:
        return []
    rows = conn.execute(
        STORED_FOR_PURCHASES_SQL,
        {
            "kind": kind,
            "code": code,
            "purchases": sorted({lot.id_compra for lot in fetched}),
        },
    ).fetchall()
    stored = [
        PriceLot(
            id_compra=str(row[0]),
            item_number=int(row[1]),
            unit_price=float(row[2]),
            purchased_on=row[3],
            supply_unit=row[4],
            catalog_item_code=row[5],
            description=row[6],
        )
        for row in rows
    ]
    seen = {(lot.id_compra, lot.item_number) for lot in fetched}
    candidates = fetched + [lot for lot in stored if (lot.id_compra, lot.item_number) not in seen]
    return [
        StoredPrice(
            id_compra=rep.row.id_compra,
            item_number=rep.row.item_number,
            # The real row a rung may print...
            unit_price=rep.row.unit_price,
            # ...and the purchase's median, which is what the band reads.
            unit_price_median=rep.median,
            purchased_on=rep.row.purchased_on,
            supply_unit=rep.row.supply_unit,
            catalog_item_code=rep.row.catalog_item_code,
            description=rep.row.description,
        )
        for rep in collapse_by_purchase(
            candidates,
            purchase_of=lambda lot: lot.id_compra,
            price_of=lambda lot: lot.unit_price,
        )
    ]


def store_prices(
    conn: Connection, *, kind: str, code: int, prices: list[StoredPrice], today: date
) -> None:
    """Write the window's rows, then enforce the two storage invariants.

    An **upsert**, since the amended primary key is ``(kind, code, id_compra)``
        and a second lot of the same purchase cannot exist. This was a
        delete-then-insert while `item_number` was in the key, because an upsert
        would then have left a previous refresh's differently numbered row behind —
        not double counting (the band is keyed by purchase) but an arbitrary choice
        between two rows with nothing saying which was the representative. The
        migration moved `item_number` out of the key, so that hazard is gone and the
        write is one statement with no window in which the purchase is absent.

        Both statements are in one transaction: ``ctx.conn`` is autocommit
        (``JobContext``), so without it a crash between them would drop the
        purchases. Losing them would be self-healing — ``max(fetched_at)`` falls and
        the next window widens to cover them — but a transaction costs nothing and
        does not need the argument.
    """
    cutoff = shift_months_back(today, PRUNE_AGE_MONTHS)
    with conn.transaction():
        if prices:
            with conn.cursor() as cur:
                cur.executemany(
                    INSERT_PRICES_SQL,
                    [
                        (
                            kind,
                            code,
                            price.id_compra,
                            price.item_number,
                            price.unit_price,
                            price.unit_price_median,
                            price.purchased_on,
                            price.supply_unit,
                            price.catalog_item_code,
                            price.description,
                        )
                        for price in prices
                    ],
                )
        # Rows past :data:`PRUNE_AGE_MONTHS` can never feed a band under any
        # gate C4 might plausibly choose, so they are storage paid for nothing —
        # this is what keeps the 0.24 GB figure true rather than true on the day
        # it was measured.
        conn.execute(PRUNE_STALE_SQL, {"kind": kind, "code": code, "cutoff": cutoff})
        conn.execute(
            TRIM_DESCRIPTIONS_SQL,
            {
                "kind": kind,
                "code": code,
                "keep": DESCRIPTIONS_KEPT,
            },
        )


def stored_purchases(conn: Connection, *, kind: str, code: int) -> list[PurchasePrice]:
    """Everything stored for this code, as the band's input.

    The band is recomputed over the **whole** stored history, not over the
    window just fetched: an incremental refresh of one month must still produce
    an 18-month band, or the gates would be applied to a sample nobody intended.
    """
    return [
        PurchasePrice(
            id_compra=str(id_compra),
            median_price=float(unit_price_median),
            purchased_on=purchased_on,
        )
        for id_compra, unit_price_median, purchased_on in conn.execute(
            STORED_PURCHASES_SQL, {"kind": kind, "code": code}
        ).fetchall()
    ]


def write_band(
    conn: Connection, *, kind: str, code: int, window_end: date, outcome: BandOutcome
) -> None:
    """One `catalog_bands` row, **always** — a band or the reason there is none.

    A missing row is indistinguishable from a code never asked about, which is
    the distinction the whole refusal vocabulary exists to keep.
    """
    band = outcome if isinstance(outcome, Band) else None
    conn.execute(
        WRITE_BAND_SQL,
        {
            "kind": kind,
            "code": code,
            "window_end": window_end,
            "low": round(band.low, 4) if band else None,
            "median": round(band.median, 4) if band else None,
            "high": round(band.high, 4) if band else None,
            "n": outcome.n_purchases,
            "reason": None if band else outcome.reason,
            "band_version": BAND_VERSION,
        },
    )


def refresh_summary(
    conn: Connection, *, kind: str = MATERIAL, days: int = ALARM_DAYS
) -> dict[str, int]:
    """``{outcome: codes}`` over the alarm window. ``banded`` is a band.

    A breakdown, **not** the alarm: a code with two outcomes in the window is in
    two groups, so these do not sum to a code count. :func:`refreshed_codes` is
    the number to watch.
    """
    return {
        str(outcome): int(codes)
        for outcome, codes in conn.execute(
            REFRESH_SUMMARY_SQL, {"kind": kind, "days": days}
        ).fetchall()
    }


def refreshed_codes(conn: Connection, *, kind: str = MATERIAL, days: int = ALARM_DAYS) -> int:
    """How many distinct codes were refreshed in the window. **The alarm.**"""
    row = conn.execute(REFRESHED_CODES_SQL, {"kind": kind, "days": days}).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def assert_material(kind: str) -> None:
    """Refuse anything but ``'M'``, loudly.

    Measured: services resolve at 22.4% and produced **0 bands from any source**
    across 136 service items, so a CATSER refresh spends API budget on rows no
    screen can read. Refused with a sentence rather than skipped quietly — or
    left to the ``KeyError`` from :data:`licitaqui.compras.PRICE_PATHS` — so an
    operator who queues one is told why.
    """
    if kind != MATERIAL:
        raise RuntimeError(
            f"refresh_catalog_prices: kind {kind!r} has no price endpoint — "
            "services produced 0 bands from any source over 136 items "
            "(measured), so they get no refresh budget"
        )


def build_client() -> ComprasClient:
    """The client one run uses. A seam, exactly as in :mod:`licitaqui.sync_awards`."""
    return ComprasClient()


def job_key(kind: str, code: int, window_end: date) -> str:
    """The `jobs_dedupe` key: one job per ``(code, window)``.

    So a sweep that runs twice in a day — two scheduler instances during a
    deploy, a retried container — produces one job per code and not two, and a
    code already queued is not queued again behind itself.
    """
    return f"{kind}:{code}:{window_end.isoformat()}"


# -- the job ---------------------------------------------------------------


@REGISTRY.job(JOB_KIND)
def refresh_catalog_prices(ctx: JobContext) -> None:
    """Sweep when the payload names no code; refresh that one code when it does.

    Payload, all optional:

    ``code``
        Refresh this code only. Its absence is what makes a job the sweep.
    ``kind``
        ``'M'``. Anything else is refused — see :func:`_refresh_one`.
    ``codes``
        Sweep size for this run (default :data:`DEFAULT_SWEEP_CODES`).
    ``priority``
        Priority of the per-code jobs (default :data:`PRICE_PRIORITY`).
    ``max_pages``
        Page ceiling for one code (default
        :data:`licitaqui.compras.MAX_PRICE_PAGES`).
    """
    if ctx.payload.get("code") is None:
        _sweep(ctx)
    else:
        _refresh_one(ctx)


def _sweep(ctx: JobContext) -> None:
    """Enqueue the most-demanded stale codes, and report what got refreshed.

    **It writes its `events` row on the way out of every path, including the
    failing one.** The first version wrote it last, after three queries, so a
    sweep that raised — the missing-table case, which is exactly what a fresh
    deploy looks like before `0014_catalog_prices.sql` is applied — produced no
    row at all rather than a row saying zero. A watchdog phrased as *"alarm when
    `refreshed_codes` is 0"* is silent when there is nothing to read, which is
    B32's failure mode reproduced inside the function written to prevent it.

    So phrase the watchdog as **"no `catalog_prices_swept` row in N days, or a
    row whose `refreshed_codes` is 0"**, and this function makes both halves
    reachable.
    """
    payload = ctx.payload
    kind = str(payload.get("kind") or MATERIAL)
    # Refused here as well as in `_refresh_one`, and that is not belt and
    # braces: `STALE_CODES_SQL` would happily return CATSER codes, so without
    # this a service sweep enqueues up to a thousand jobs that are each
    # guaranteed to raise — the budget spent before the first refusal fires.
    assert_material(kind)
    limit = int(payload.get("codes") or DEFAULT_SWEEP_CODES)
    priority = int(payload.get("priority") or PRICE_PRIORITY)
    today = brt_today()

    try:
        targets = stale_codes(ctx.conn, limit=limit, kind=kind)
        payloads = {
            job_key(kind, code, today): {"kind": kind, "code": code} for code, _items in targets
        }
        queued = enqueue_many(
            ctx.conn,
            JOB_KIND,
            list(payloads),
            priority=priority,
            payload_for=payloads.get,
        )
        # Read *after* enqueuing, so the number reported is about the refreshes
        # that have already happened rather than about this tick's intentions.
        #
        # Two queries on purpose: `refresh_summary` groups by outcome, and a code
        # banded on Monday and refused on Thursday is in two groups — summing
        # them would count it twice under a key named `refreshed_codes`. The
        # alarm direction would survive that; the figure Sci reads would not.
        summary = refresh_summary(ctx.conn, kind=kind)
        refreshed = refreshed_codes(ctx.conn, kind=kind)
    except Exception as exc:
        _record_sweep(
            ctx,
            {
                "kind": kind,
                "failed": True,
                # The type only. A message could carry a parameter value, and this
                # row is written to a table nothing redacts.
                "error": type(exc).__name__,
                "alarm_days": ALARM_DAYS,
            },
        )
        raise

    # `outcomes` is nested rather than splatted into `extra`: its keys come from
    # `catalog_bands.refused_reason`, and a stdlib `LogRecord` raises on a
    # reserved key (`message`, `module`, `name`, …). The vocabulary is guarded by
    # `Refusal.__post_init__`; a hand-fixed row is not.
    ctx.log.info(
        "catalog price sweep",
        extra={
            "kind": kind,
            "candidates": len(targets),
            "queued": queued,
            "refreshed_codes": refreshed,
            "alarm_days": ALARM_DAYS,
            "outcomes": summary,
        },
    )
    _record_sweep(
        ctx,
        {
            "kind": kind,
            "candidates": len(targets),
            # Context, never the alarm. A feed that never enqueues also never
            # fails — B32 — so this number being zero proves nothing on its own.
            "queued": queued,
            # **This** is the alarm: "0 codes refreshed in N days".
            "refreshed_codes": refreshed,
            "alarm_days": ALARM_DAYS,
            "outcomes": summary,
            "band_version": BAND_VERSION,
        },
    )


def _record_sweep(ctx: JobContext, props: dict[str, object]) -> None:
    """One `events` row per sweep run, and a failure to write one never masks
    the failure that is already on its way out."""
    try:
        ctx.conn.execute(
            "insert into events (name, props) values (%s, %s)",
            ("catalog_prices_swept", Jsonb(props)),
        )
    except Exception:
        ctx.log.warning("catalog price sweep: could not record the run", exc_info=True)


def _refresh_one(ctx: JobContext) -> None:
    """One code: walk the window, store the tuple, write the band or the reason."""
    payload = ctx.payload
    kind = str(payload.get("kind") or MATERIAL)
    code = int(payload["code"])
    max_pages = int(payload.get("max_pages") or MAX_PRICE_PAGES)
    assert_material(kind)

    today = brt_today()
    # **Before the walk, not after.** Every outcome below has to be bounded,
    # including the ones that raise and the one that writes no band row: without
    # this the code is stale again on tomorrow's sweep and re-burns a full walk
    # a day for ever. See `ATTEMPT_COOLDOWN_HOURS`.
    mark_attempted(ctx.conn, kind=kind, code=code)
    start, end = window_for(ctx.conn, kind=kind, code=code, today=today)

    try:
        with build_client() as client:
            walk = client.walk_prices(kind, code, start=start, end=end, max_pages=max_pages)
    except CircuitOpen:
        # The endpoint is down and the breaker says so. Nothing has been written,
        # the band row for today is simply not there yet, and the queue's backoff
        # brings this exact code back — the dedupe key is per (code, window), so
        # the backlog is the queue rather than something this job has to hold.
        ctx.log.warning(
            "catalog prices: circuit open",
            extra={
                "kind": kind,
                "code": code,
            },
        )
        raise

    if is_truncated(walk):
        # **Nothing is stored and no band row is written.**
        #
        # Nothing is stored because advancing ``max(fetched_at)`` over pages this
        # run never read would skip those purchases *permanently*, not until next
        # time — the band is recomputed from storage. That is the measured cost
        # of truncation: codes read to full depth banded at 11.5% against 3.2%
        # for truncated ones, so it is lost coverage rather than a wrong band.
        #
        # No band row because `catalog_bands` is keyed `(kind, code,
        # window_end)` and any reader takes the newest window: a refusal at
        # today's window would delete yesterday's correct band from the screen
        # on the day the cap bit, and would have to invent an `n_purchases`
        # that then mis-sorts the code's own refresh cadence. The count lives
        # in `events` instead, which is what makes a biting cap visible.
        ctx.conn.execute(
            "insert into events (name, props) values (%s, %s)",
            (
                TRUNCATED_EVENT,
                Jsonb(
                    {
                        "kind": kind,
                        "code": code,
                        "pages": walk.pages_read,
                        "reported_rows": walk.total,
                        "max_pages": max_pages,
                    }
                ),
            ),
        )
        ctx.log.warning(
            "catalog prices: walk truncated, nothing stored",
            extra={
                "kind": kind,
                "code": code,
                "pages": walk.pages_read,
                "reported_rows": walk.total,
            },
        )
        return

    prices = merge_with_stored(ctx.conn, kind=kind, code=code, fetched=parse_rows(walk.rows))
    store_prices(ctx.conn, kind=kind, code=code, prices=prices, today=today)

    # The band is computed over the **whole stored history**, not over this
    # window: an incremental refresh of one month must still produce an
    # 18-month band, and an empty window — the normal steady state — must not be
    # recorded as a code nobody has ever bought.
    purchases = stored_purchases(ctx.conn, kind=kind, code=code)
    outcome = compute_band(purchases, today=today)
    write_band(ctx.conn, kind=kind, code=code, window_end=today, outcome=outcome)

    ctx.log.info(
        "catalog prices refreshed",
        extra={
            "kind": kind,
            "code": code,
            "window_start": start.isoformat(),
            "window_end": end.isoformat(),
            "rows": len(walk.rows),
            "purchases_written": len(prices),
            "purchases_stored": len(purchases),
            "pages": walk.pages_read,
            "complete": walk.complete,
            "band": isinstance(outcome, Band),
            "refused_reason": None if isinstance(outcome, Band) else outcome.reason,
            "n_purchases": outcome.n_purchases,
        },
    )
