"""``coverage_check`` — B17's closure test, now a standing measurement (B17).

Two assertions matter more than the rest.

**The refusal.** A walk that collects nothing must never record 0%: PNCP blocks
some origins outright — every attempt from Portugal on 2026-09-29 and 09-30
answered ``Connection reset by peer``, including the client's own known-good
parameter shape — and a row saying "we hold 0% of the open editais" written
from a request that never arrived would be a measurement of our own blocked
connection. This repo has a standing note for exactly that shape: an empty
result may be a broken query rather than a missing row.

**The provenance of the query set.** The seven keywords are derived from the
product's own segment vocabulary and from `sync_awards.DEFAULT_SEGMENTS`, and
:func:`test_every_query_is_derived_from_the_products_own_segment_vocabulary`
checks that *as code*. An eighth keyword somebody liked the sound of fails this
file rather than quietly becoming the measurement the claim rests on.
"""

from __future__ import annotations

from typing import Any

import pytest

from licitaqui import coverage_check
from licitaqui.coverage_check import DEFAULT_QUERIES, DEFAULT_QUERY, TARGET_RATIO


class FakeConn:
    """Records what the handler writes, and answers the one select it makes."""

    def __init__(self, held: list[str]) -> None:
        self.held = held
        self.writes: list[tuple[str, Any]] = []

    def execute(self, sql: str, params: Any = None):
        if "select id from tenders" in sql:
            wanted = set(params[0])
            return _Rows([(i,) for i in self.held if i in wanted])
        self.writes.append((sql, params))
        return _Rows([])


class _Rows:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows


class FakeCtx:
    def __init__(self, conn: FakeConn, payload: dict[str, Any] | None = None) -> None:
        self.conn = conn
        self.payload = payload or {}
        self.log = _Log()


class _Log:
    def __init__(self) -> None:
        self.records: list[tuple[str, dict[str, Any]]] = []
        self.warnings: list[tuple[str, dict[str, Any]]] = []

    def info(self, message: str, extra: dict[str, Any] | None = None) -> None:
        self.records.append((message, extra or {}))

    def warning(self, message: str, extra: dict[str, Any] | None = None) -> None:
        self.warnings.append((message, extra or {}))


#: Every single-query test asks about the baseline keyword explicitly. Its
#: *absence* is now what makes a job the whole standing set, so a bare payload
#: would be a different test.
ONE = {"q": DEFAULT_QUERY}


def fake_pncp(monkeypatch: pytest.MonkeyPatch, pages: list[list[str]], total: int | None):
    """Serve `pages` of control numbers to every query, then empty."""
    monkeypatch.setattr(coverage_check, "PncpClient", lambda: object())

    seen_params: list[tuple] = []

    def search(_client, _query, page, modalities):
        seen_params.append(modalities)
        index = page - 1
        items = [{"numero_controle_pncp": c} for c in pages[index]] if index < len(pages) else []
        return {"total": total, "items": items}

    monkeypatch.setattr(coverage_check, "_search", search)
    return seen_params


def fake_pncp_per_query(
    monkeypatch: pytest.MonkeyPatch,
    by_query: dict[str, list[list[str]]],
    totals: dict[str, int] | None = None,
) -> list[str]:
    """Serve a different walk per keyword. A keyword absent here walks empty.

    A keyword mapped to :data:`BROKEN` has its request refused, which is how a
    refused request differs from a keyword nothing matches.
    """
    monkeypatch.setattr(coverage_check, "PncpClient", lambda: object())
    asked: list[str] = []

    def search(_client, query, page, _modalities):
        if page == 1:
            asked.append(query)
        pages = by_query.get(query, [])
        if pages == BROKEN:
            raise RuntimeError("Connection reset by peer")
        index = page - 1
        items = [{"numero_controle_pncp": c} for c in pages[index]] if index < len(pages) else []
        declared = (totals or {}).get(query, sum(len(p) for p in pages))
        return {"total": declared, "items": items}

    monkeypatch.setattr(coverage_check, "_search", search)
    return asked


#: Sentinel for "this keyword's request is refused", distinct from "this
#: keyword matched nothing" — the two look identical from one machine and the
#: whole design of this job turns on telling them apart. A one-element marker
#: rather than ``[]``, so it cannot be confused with the "matched nothing"
#: default by either identity or equality.
BROKEN = ["__refused__"]


def props_of(conn: FakeConn) -> list[dict[str, Any]]:
    return [params[1].obj for _sql, params in conn.writes]


# -- one query -------------------------------------------------------------


def test_it_reports_what_share_of_the_open_editais_we_hold(monkeypatch: pytest.MonkeyPatch):
    fake_pncp(monkeypatch, [["a", "b", "c", "d"]], total=4)
    conn = FakeConn(held=["a", "b", "c"])

    coverage_check.coverage_check(FakeCtx(conn, ONE))

    assert len(conn.writes) == 1
    sql, params = conn.writes[0]
    assert "insert into events" in sql
    props = params[1].obj
    assert props["collected"] == 4
    assert props["held"] == 3
    assert props["missing"] == 1
    assert props["ratio"] == 0.75
    assert props["met"] is False
    assert props["missing_sample"] == ["d"]


def test_it_passes_once_we_hold_the_target_share(monkeypatch: pytest.MonkeyPatch):
    ids = [f"t{n}" for n in range(100)]
    fake_pncp(monkeypatch, [ids[:50], ids[50:]], total=100)
    conn = FakeConn(held=ids[:96])

    coverage_check.coverage_check(FakeCtx(conn, ONE))

    props = conn.writes[0][1][1].obj
    assert props["ratio"] == 0.96
    assert props["met"] is True
    assert props["target"] == TARGET_RATIO


def test_an_empty_walk_raises_rather_than_recording_nought_percent(
    monkeypatch: pytest.MonkeyPatch,
):
    """The one that matters. PNCP refusing us is not the Radar holding nothing."""
    fake_pncp(monkeypatch, [[]], total=0)
    conn = FakeConn(held=["a"])

    with pytest.raises(RuntimeError, match="nothing measured"):
        coverage_check.coverage_check(FakeCtx(conn, ONE))

    assert conn.writes == [], "a failed walk must leave no row behind"


def test_duplicate_control_numbers_are_counted_once(monkeypatch: pytest.MonkeyPatch):
    """PNCP paginates by a moving `-data` order, so the same edital can appear
    on two pages. Counting it twice would understate coverage."""
    fake_pncp(monkeypatch, [["a", "b"], ["b", "c"]], total=4)
    conn = FakeConn(held=["a", "b", "c"])

    coverage_check.coverage_check(FakeCtx(conn, ONE))

    props = conn.writes[0][1][1].obj
    assert props["collected"] == 3
    assert props["ratio"] == 1.0


def test_the_query_is_configurable_but_defaults_to_the_measured_one(
    monkeypatch: pytest.MonkeyPatch,
):
    """The baseline was measured on `saas`; a re-run on a different keyword is
    a different question and the row has to say which was asked."""
    fake_pncp(monkeypatch, [["a"]], total=1)
    conn = FakeConn(held=["a"])

    coverage_check.coverage_check(FakeCtx(conn, {"q": "limpeza"}))

    assert conn.writes[0][1][1].obj["q"] == "limpeza"


def test_an_adhoc_run_cannot_redefine_the_standing_set(monkeypatch: pytest.MonkeyPatch):
    """`query_set` is how a reader tells "six keywords" from "six of seven" —
    and `standing` is what stops one ad-hoc question from rewriting the answer.

    `check_coverage.py --commit --q limpeza` writes a perfectly good
    measurement whose set is one keyword, and it is the **newest** row
    afterwards. Without the flag, `/admin` would take the standing set from it
    and stop noticing that the other six were never measured — the exact
    absence this card exists to see.
    """
    fake_pncp(monkeypatch, [["a"]], total=1)
    conn = FakeConn(held=["a"])

    coverage_check.coverage_check(FakeCtx(conn, {"q": "limpeza"}))

    props = conn.writes[0][1][1].obj
    assert props["query_set"] == ["limpeza"]
    assert props["standing"] is False


# -- the standing set ------------------------------------------------------


def test_a_payload_without_a_query_measures_the_whole_standing_set(
    monkeypatch: pytest.MonkeyPatch,
):
    """What the schedule enqueues. One keyword is not a measurement of a claim
    that renders on every screen: the sentence promises *os* editais abertos
    for whatever the company does, and `saas` alone cannot see a segment going
    dark."""
    asked = fake_pncp_per_query(monkeypatch, {q: [["a", "b"]] for q in DEFAULT_QUERIES})
    conn = FakeConn(held=["a", "b"])

    coverage_check.coverage_check(FakeCtx(conn))

    assert asked == list(DEFAULT_QUERIES)
    assert len(conn.writes) == len(DEFAULT_QUERIES)
    assert [props["q"] for props in props_of(conn)] == list(DEFAULT_QUERIES)
    assert all(props["query_set"] == list(DEFAULT_QUERIES) for props in props_of(conn))
    assert all(props["standing"] is True for props in props_of(conn))


def test_one_keyword_PNCP_has_nothing_for_does_not_lose_the_others(
    monkeypatch: pytest.MonkeyPatch,
):
    """Per-query isolation, and the reason the set has more than one member.

    A keyword matching nothing today is a fact about that keyword. Raising on
    it would throw away six real measurements, and — worse — a retry would
    re-walk the six that worked. What must **not** happen is a row for the
    empty one, because that row would read as 0% coverage.
    """
    walks = {q: [["a", "b"]] for q in DEFAULT_QUERIES}
    walks["pneu"] = [[]]
    fake_pncp_per_query(monkeypatch, walks)
    conn = FakeConn(held=["a", "b"])

    coverage_check.coverage_check(FakeCtx(conn))

    measured = [props["q"] for props in props_of(conn)]
    assert "pneu" not in measured, "an empty walk must never be recorded, not even as 0%"
    assert len(measured) == len(DEFAULT_QUERIES) - 1
    # And the absence is recoverable by a reader: every row still carries the
    # set that was meant to be measured.
    assert "pneu" in props_of(conn)[0]["query_set"]


def test_a_refused_request_is_isolated_the_same_way(monkeypatch: pytest.MonkeyPatch):
    """A raise inside one query's walk is caught per query, like an empty one.

    Both shapes mean "no measurement for this keyword"; neither may become a
    zero, and neither may cost the other six.
    """
    walks: dict[str, Any] = {q: [["a"]] for q in DEFAULT_QUERIES}
    walks["papel"] = BROKEN
    fake_pncp_per_query(monkeypatch, walks)
    conn = FakeConn(held=["a"])

    ctx = FakeCtx(conn)
    coverage_check.coverage_check(ctx)

    assert "papel" not in [props["q"] for props in props_of(conn)]
    assert ctx.log.warnings, "a keyword that could not be measured must be said out loud"
    assert ctx.log.warnings[0][1]["q"] == "papel"
    # The type, never the message: a PNCP error text carries the parameters.
    assert ctx.log.warnings[0][1]["error"] == "RuntimeError"


def test_a_run_where_nothing_could_be_measured_raises(monkeypatch: pytest.MonkeyPatch):
    """All seven empty is not seven facts about keywords — it is one fact about
    us. PNCP refused this origin for two days running; a run that recorded
    nothing and succeeded would be the `empty-result-is-not-absence` defect
    with extra steps, and `/admin` would read the silence as a stale reading
    rather than a broken one."""
    fake_pncp_per_query(monkeypatch, {})
    conn = FakeConn(held=["a"])

    with pytest.raises(RuntimeError, match="nothing measured"):
        coverage_check.coverage_check(FakeCtx(conn))

    assert conn.writes == []


def test_a_walk_that_stops_short_of_PNCPs_own_count_is_not_a_measurement(
    monkeypatch: pytest.MonkeyPatch,
):
    """**The empty-walk rule, one layer in**, and the review found it.

    PNCP answers page 1 with `total: 5000` and fifty items, then an empty page
    2 — an error envelope, a shape change, a blank page mid-walk. The walk ends
    with fifty ids, `truncated: false`, and nothing in the row says the other
    4 950 were never asked about. `/admin` would print that ratio as a
    complete reading of the segment, green if we happen to hold those fifty.

    It is the same defect as recording 0% from a refused request: a number
    produced by our own failed call, reported as a fact about the Radar.
    """
    fake_pncp_per_query(monkeypatch, {"saas": [["a", "b"]]}, totals={"saas": 5000})
    conn = FakeConn(held=["a", "b"])

    # Asserted at the seam, not only at the top: `_collect` is what refuses,
    # and the job-level message is the same one an empty walk produces.
    with pytest.raises(RuntimeError, match="stopped at 2 of 5000"):
        coverage_check._collect(object(), "saas", (6, 8, 4))

    ctx = FakeCtx(conn, ONE)
    with pytest.raises(RuntimeError, match="nothing measured"):
        coverage_check.coverage_check(ctx)

    assert conn.writes == [], "a short walk must leave no row behind"
    assert ctx.log.warnings[0][1]["q"] == "saas"


def test_a_duplicate_across_pages_is_not_a_short_walk(monkeypatch: pytest.MonkeyPatch):
    """The reason the guard counts items received, not unique ids.

    PNCP paginates by a moving `-data` order, so the same edital can arrive on
    two pages: four items received, three distinct. `len(ids) < total` is then
    **normal**, and a guard written that way would refuse the ordinary case —
    which is the mistake the first version of this fix would have made.
    """
    fake_pncp_per_query(monkeypatch, {"saas": [["a", "b"], ["b", "c"]]}, totals={"saas": 4})
    conn = FakeConn(held=["a", "b", "c"])

    coverage_check.coverage_check(FakeCtx(conn, ONE))

    props = props_of(conn)[0]
    assert props["collected"] == 3
    assert props["pncp_total"] == 4
    assert props["truncated"] is False


def test_hitting_the_page_ceiling_is_recorded_rather_than_refused(
    monkeypatch: pytest.MonkeyPatch,
):
    """Truncation is a deliberate ceiling, not PNCP contradicting itself.

    A keyword with more open editais than `MAX_PAGES * PAGE_SIZE` fills every
    page; the walk is short of `total` **and** every page it was allowed to ask
    for came back full, so the reading is real and labelled `truncated`. B41 is
    the card for measuring the whole set.
    """
    pages = [
        [f"p{page}i{n}" for n in range(coverage_check.PAGE_SIZE)]
        for page in range(coverage_check.MAX_PAGES)
    ]
    fake_pncp_per_query(monkeypatch, {"saas": pages}, totals={"saas": 10_000})
    conn = FakeConn(held=[])

    coverage_check.coverage_check(FakeCtx(conn, ONE))

    props = props_of(conn)[0]
    assert props["truncated"] is True
    assert props["collected"] == coverage_check.PAGE_SIZE * coverage_check.MAX_PAGES
    assert props["pncp_total"] == 10_000
    # Held nothing of the newest 600 — a real 0%, from a real answer. The rule
    # is "never a zero from an empty walk", not "never a zero".
    assert props["ratio"] == 0.0
    assert props["met"] is False


def test_the_row_carries_both_baseline_denominators(monkeypatch: pytest.MonkeyPatch):
    """2026-09-27 is two numbers, and the job is comparable with one of them.

    137 editais over every modality (57 held, 41,6% — the figure B17 is named
    for) and **128 in scope** (56 held, 43,8% — the denominator B17's
    acceptance uses). `_search` filters to the modalities the sweep collects,
    so a reading of this job belongs against the second. The row used to carry
    only the first, which is a baseline it is not comparable with.
    """
    fake_pncp(monkeypatch, [["a"]], total=1)
    conn = FakeConn(held=["a"])

    coverage_check.coverage_check(FakeCtx(conn, ONE))

    baseline = conn.writes[0][1][1].obj["baseline_2026_09_27"]
    assert baseline["in_scope"] == {"held": 56, "collected": 128, "ratio": 0.4375}
    assert baseline["all_modalities"]["collected"] == 137


def test_a_defect_on_our_side_fails_the_job_instead_of_looking_like_a_bad_keyword(
    monkeypatch: pytest.MonkeyPatch,
):
    """The seam between `_collect` and `_record`, and why it is where it is.

    The per-query `except` exists for what **PNCP** does to us. If it also
    covered our own arithmetic and our own insert, a code defect would be filed
    as *"this keyword could not be measured"* — a nightly `incomplete` reading
    on `/admin` that nobody would chase, with a green suite behind it. Found by
    a mutation check: with the empty-walk guard removed, the resulting
    `ZeroDivisionError` was swallowed and the suite stayed green, so the guard
    looked load-bearing while nothing tested it.
    """
    fake_pncp_per_query(monkeypatch, {q: [["a"]] for q in DEFAULT_QUERIES})

    class BrokenConn(FakeConn):
        def execute(self, sql: str, params: Any = None):
            if "select id from tenders" in sql:
                raise TypeError("ours, not PNCP's")
            return super().execute(sql, params)

    with pytest.raises(TypeError, match="ours, not PNCP's"):
        coverage_check.coverage_check(FakeCtx(BrokenConn(held=["a"])))


def test_an_explicit_set_is_possible_but_never_the_default(monkeypatch: pytest.MonkeyPatch):
    asked = fake_pncp_per_query(monkeypatch, {"obra": [["a"]], "cadeira": [["a"]]})
    conn = FakeConn(held=["a"])

    coverage_check.coverage_check(FakeCtx(conn, {"queries": ["obra", "cadeira"]}))

    assert asked == ["obra", "cadeira"]
    # **And it is not `standing`.** Found by this card's review: letting an
    # override declare itself the standing set would let
    # `{"queries": ["saas"]}` redefine "complete" as one keyword on `/admin`
    # for as long as that row stays the newest — the same false green a single
    # `--q` would produce. Only the derived default says what complete means.
    assert all(props["standing"] is False for props in props_of(conn))


# -- the derivation of the set --------------------------------------------


#: Which segment each keyword is there to speak for. The keyword is taken from
#: `segments.SEGMENT_KEYWORDS` for that segment; `saas` is additionally B17's
#: own baseline, and `medicamento` is the word the vocabulary's `medicament`
#: stem stems, because PNCP's `q` is a text search and not a regex.
EXPECTED_SEGMENTS = {
    "saas": "Software / Sistemas",
    "merenda": "Alimentos",
    "pavimentacao": "Construção / Hidráulica",
    "medicamento": "Saúde / Hospitalar",
    "papel": "Gráfico / Escritório",
    "pneu": "Veículos / Peças",
    "notebook": "Informática / TI",
}


def test_every_query_is_derived_from_the_products_own_segment_vocabulary():
    """**The provenance, as code.**

    The claim this job measures is *"os editais abertos que combinam com o que
    a sua empresa já faz"*, and what the product means by "o que a sua empresa
    já faz" is a segment, reached from the company's CNAE. So each keyword has
    to be one the product itself would classify into the segment it is standing
    in for — run through `segments.segment_for_text`, the same function
    `items.py` runs over an edital's objeto.

    This is the test that stops the set from drifting into words that sounded
    representative. Add a keyword the classifier does not place where you think
    it does, and this fails before the number it produces is believed.
    """
    from licitaqui.segments import label, segment_for_text

    for query, expected in EXPECTED_SEGMENTS.items():
        key = segment_for_text(query)
        assert key is not None, f"{query!r} classifies into no segment at all"
        assert label(key) == expected, f"{query!r} reaches {label(key)!r}, not {expected!r}"


def test_the_set_covers_the_segments_the_awards_sweep_already_targets():
    """The six beyond `saas` are not a new opinion about who signs up.

    `sync_awards.DEFAULT_SEGMENTS` is this repo's existing answer to "where
    will the founders' CNAEs land", taken from how heavily
    `db/reference/cnae_segments.csv` covers each segment. Re-measured
    2026-10-05 over its 572 rows: Alimentos 116, Construção / Hidráulica 115,
    Saúde / Hospitalar 87, Gráfico / Escritório 50, Veículos / Peças 45,
    Informática / TI 31. Reusing it means there is one place to change if that
    judgement changes, instead of two that can disagree silently.

    `saas` is the exception and is deliberate: it carries B17's baseline, and
    `Software / Sistemas` is not in that set.
    """
    from licitaqui.sync_awards import DEFAULT_SEGMENTS

    covered = {EXPECTED_SEGMENTS[q] for q in DEFAULT_QUERIES if q != DEFAULT_QUERY}
    assert covered == set(DEFAULT_SEGMENTS)
    assert set(DEFAULT_QUERIES) == set(EXPECTED_SEGMENTS)
    assert DEFAULT_QUERIES[0] == DEFAULT_QUERY, "the baseline keyword stays first"


def test_the_set_does_not_claim_to_cover_every_segment():
    """It covers seven of fourteen, and the review caught the sentence that
    said otherwise.

    `SEGMENT_KEYWORDS` has fourteen segments plus `other`. Measured 2026-10-05
    over the 572 rows of `db/reference/cnae_segments.csv`, the seven uncovered
    ones hold **117 codes — 20%** of the map, so a fifth of founders' CNAEs
    land in a segment nothing here asks about. **B42** is that gap. This test
    exists so the number cannot drift away from the prose again: if somebody
    adds a keyword, it changes, and whoever changes it has to look at B42, at
    `coverage.ts` and at the `docs/CLAIMS.md` row.
    """
    from licitaqui.segments import OTHER, SEGMENTS

    real = {key for key, _label in SEGMENTS if key != OTHER}
    covered = {q: EXPECTED_SEGMENTS[q] for q in DEFAULT_QUERIES}
    assert len(real) == 14
    assert len(set(covered.values())) == 7, "seven of the fourteen, not one each"


def test_the_row_records_which_segment_the_keyword_speaks_for(
    monkeypatch: pytest.MonkeyPatch,
):
    """Read by `/admin`, which names the weakest keyword *and* whose claim it
    is: "pneu · Veículos / Peças" says more to Sci than "pneu"."""
    fake_pncp(monkeypatch, [["a"]], total=1)
    conn = FakeConn(held=["a"])

    coverage_check.coverage_check(FakeCtx(conn, {"q": "pneu"}))

    assert conn.writes[0][1][1].obj["segment"] == "Veículos / Peças"


def test_an_unclassifiable_adhoc_query_records_no_segment(monkeypatch: pytest.MonkeyPatch):
    """`other` is a fallback, not a segment any company is matched on, so the
    row says nothing rather than saying "Outros"."""
    fake_pncp(monkeypatch, [["a"]], total=1)
    conn = FakeConn(held=["a"])

    coverage_check.coverage_check(FakeCtx(conn, {"q": "zzzqqq"}))

    assert conn.writes[0][1][1].obj["segment"] is None


# -- the schedule ----------------------------------------------------------


def test_it_is_on_the_schedule_daily():
    """**This assertion used to be its own opposite**, and the reasoning behind
    it was right about the cost and wrong about the risk: a cadence was called
    "a standing PNCP cost plus a Neon wake to answer a question nobody asked
    that hour".

    Measured 2026-10-05, the job had run **three times ever** — all on
    2026-09-30, all on `q=saas` — and nothing read the result. The last row
    said `ratio: 1.0` against a `0.416` baseline, so B17's gap was measured
    closed and **nobody would notice if it came back**. That is B32's shape:
    a feed that stops working also stops failing.

    05:10 BRT answers the cost objection rather than ignoring it — see the
    entry's own comment: it rides the wake `refresh_catalog_prices` is already
    holding open, so the standing cost is a job slot and at most 84 requests.
    """
    from licitaqui.scheduler import DEFAULT_SCHEDULE

    entry = next(e for e in DEFAULT_SCHEDULE if e.kind == "coverage_check")
    assert entry.daily_at == "05:10"
    assert entry.weekday is None, "daily — the claim renders every day"
    assert entry.timezone == "America/Sao_Paulo"
    # No payload: the absence of `q` is what makes it the standing set.
    assert entry.payload is None


def test_the_schedule_entry_runs_after_the_inventory_it_measures():
    """It measures what `reconcile_open_tenders` collects, so running before it
    would measure yesterday's inventory and blame the keying defect B17 is
    about. The 37 minutes one cycle took is **inferred** — B17's card records
    it complete at 07:37 UTC and the entry that starts it is 04:00 BRT — not
    timed; this sits 70 minutes behind, roughly two of them.

    Asserted as arithmetic rather than as two literals, because that is the
    shape D29 came from: two numbers chosen in different places that never met.
    """
    from licitaqui.scheduler import DEFAULT_SCHEDULE

    def minutes(kind: str) -> int:
        entry = next(e for e in DEFAULT_SCHEDULE if e.kind == kind)
        hour, minute = (int(part) for part in str(entry.daily_at).split(":"))
        return hour * 60 + minute

    assert minutes("coverage_check") - minutes("reconcile_open_tenders") >= 70


def test_it_overtakes_the_price_jobs_it_shares_a_wake_with():
    """Priority 8, not 9, and the hour is why.

    At 05:10 `refresh_catalog_prices` (04:40) has up to a thousand per-code
    jobs in the queue at priority 9. At the same priority this measurement
    would be taken at an unpredictable hour behind them; at 8 it overtakes
    them and costs about a minute. It stays **behind** every collector, where
    `sweep_titles` already sits: a missing coverage reading degrades a
    watchdog, it does not lose a tender.
    """
    from licitaqui.scheduler import DEFAULT_SCHEDULE

    by_kind = {e.kind: e for e in DEFAULT_SCHEDULE}
    assert by_kind["coverage_check"].priority < by_kind["refresh_catalog_prices"].priority
    assert by_kind["coverage_check"].priority > by_kind["sync_open_tenders"].priority


# -- the scope -------------------------------------------------------------


def test_it_asks_PNCP_only_for_the_modalities_the_sweep_collects(
    monkeypatch: pytest.MonkeyPatch,
):
    """The defect that made the first measurement meaningless.

    `sync_open_tenders` ingests `DEFAULT_MODALITIES` and nothing else. The
    first version of this job searched **every** modality, so it counted
    editais we deliberately never collect — Pregão Presencial among them — and
    reported them as coverage we had lost. 11 of 128 on 2026-09-30, every
    sampled one absent from `tenders` entirely, which reads as a gap and was
    partly just the scope.

    The tuple is asserted against `tenders.DEFAULT_MODALITIES` rather than
    against a literal, so the measurement cannot drift from what the sweep
    collects: if someone widens the sweep and not this, the two disagree
    silently, which is the whole failure mode.
    """
    from licitaqui.tenders import DEFAULT_MODALITIES

    seen = fake_pncp(monkeypatch, [["a"]], total=1)
    conn = FakeConn(held=["a"])

    coverage_check.coverage_check(FakeCtx(conn, ONE))

    assert seen, "the search was never called"
    assert all(m == DEFAULT_MODALITIES for m in seen)
    assert conn.writes[0][1][1].obj["modalities"] == list(DEFAULT_MODALITIES)


def test_a_deliberate_wider_question_is_still_possible(monkeypatch: pytest.MonkeyPatch):
    """Overridable, so asking a different question stays an explicit act."""
    seen = fake_pncp(monkeypatch, [["a"]], total=1)
    conn = FakeConn(held=["a"])

    coverage_check.coverage_check(FakeCtx(conn, {**ONE, "modalities": [6]}))

    assert seen[0] == (6,)


def test_the_request_itself_carries_the_modality_filter():
    """**Asserts the params, not the call.**

    The test above monkeypatches `_search`, so it proves the tuple reaches the
    function and nothing about the request that leaves the process. Deleting
    the `modalidades` line from the params dict left all eight tests green —
    the mutation check caught it, which is what mutation checks are for. This
    one builds the real params through the real function.
    """
    from licitaqui.tenders import DEFAULT_MODALITIES

    captured: dict = {}

    class FakeClient:
        search_breaker = object()

        def _get(self, _path, params, _breaker):
            captured.update(params)
            return {"total": 0, "items": []}

    coverage_check._search(FakeClient(), "saas", 1, DEFAULT_MODALITIES)

    assert captured["modalidades"] == "6|8|4"
    assert captured["status"] == "recebendo_proposta"
    assert captured["q"] == "saas"
