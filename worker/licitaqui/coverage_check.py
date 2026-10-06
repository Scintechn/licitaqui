"""``coverage_check`` — B17's closure test, run where PNCP will answer.

## Why this is a job and not a script

B17's acceptance is a specific comparison: ask PNCP for the editais matching a
keyword that are *open for proposals*, and count how many of them we hold.
Measured 2026-09-27 as **57 of 137 — 41,6%**, which is the "44%" the card is
named for.

It could not be re-run from a laptop. On 2026-09-29 and again on 09-30,
`GET /api/search/` answered every attempt from Portugal with
``ReadError: [Errno 54] Connection reset by peer`` — including the client's own
known-good parameter shape, so it was not a malformed query. The same endpoint
answers the worker perfectly: ``sync_open_tenders`` completed 47 times in the
24 h to 2026-09-30 06:53 UTC. PNCP is refusing that origin, not that request.

So the measurement has to run from the worker, and the honest way to do that is
a job kind rather than an ssh session: it goes through the same client, the
same breaker and the same throttle as every other PNCP read, and it leaves a
row behind instead of a terminal buffer.

## Why it is now on the schedule, having deliberately not been

The previous version of this docstring argued the opposite, and it was right
about the cost and wrong about the risk. Measured 2026-10-05: this job had run
**three times ever**, all on 2026-09-30, over **one** query, and **nothing read
its result** — no card, no alarm. Its last run recorded ``ratio: 1.0, held:
119, missing: 0`` against ``baseline_2026_09_27: {held: 57, ratio: 0.416}``, so
the B17 gap was measured closed **and nobody would notice if it came back**.

That is B32's shape exactly: a feed stopped on 2026-09-29 and went unnoticed
for two days, because a feed that stops enqueuing also stops failing. B37 built
the watchdog for the catalogue feeds; the sentence this job measures —
*"os editais abertos que combinam com o que a sua empresa já faz"* — had none,
and its `docs/CLAIMS.md` row comes due **17/10**.

A question asked once is not a measurement of a claim that renders every day.

## The query set, and where every keyword comes from

``DEFAULT_QUERIES`` is **derived, not chosen.** Nothing here is a keyword
somebody thought sounded representative:

``saas``
    the keyword B17 measured, and the only one with a recorded baseline
    (57 of 137 on 2026-09-27 over every modality; **56 of the 128 in-scope** —
    see :data:`BASELINE` on why both numbers exist; 119 of 119 on 2026-09-30).
    It stays first and stays spelled this way or the series is no longer
    comparable. It is also a member of `segments.SEGMENT_KEYWORDS['software']`.

the other six
    one keyword per segment in :data:`licitaqui.sync_awards.DEFAULT_SEGMENTS`,
    which is this repo's existing answer to *"where will the founders' CNAEs
    land"* — the six segments `db/reference/cnae_segments.csv` covers most
    heavily. Re-measured 2026-10-05 over its 572 rows: Alimentos 116,
    Construção / Hidráulica 115, Saúde / Hospitalar 87, Gráfico / Escritório
    50, Veículos / Peças 45, Informática / TI 31. (`sync_awards`' docstring
    quotes 86/82/69/37/35/26, from an earlier and smaller file; the **ranking**
    is unchanged, which is all its choice rested on.)

    Each keyword is itself taken from `segments.SEGMENT_KEYWORDS` for that
    segment, so the word we ask PNCP about is a word the product uses to decide
    an edital belongs to that segment — `items.py` runs the same classifier
    over the objeto text. ``papel`` and ``notebook`` are additionally POC 3's
    own worked examples, named in `sync_awards.DEFAULT_SEGMENTS`' docstring.

    ``medicamento`` is the one small liberty: the vocabulary entry is the stem
    ``medicament``, because the classifier is a regex, and PNCP's ``q`` is a
    text search — so the query is the word that stem stems.

``test_coverage_check.py`` asserts the provenance **as code**: every query must
classify into its named segment through `segments.segment_for_text`, and the
six segments must be exactly `sync_awards.DEFAULT_SEGMENTS`. An invented
eighth keyword fails the suite rather than quietly becoming the measurement.

**What this set is not: one keyword per segment.** `SEGMENT_KEYWORDS` has
**fourteen** segments plus `other`, and these seven reach seven of them. The
uncovered seven are Vestuário / Uniformes 27 codes, Elétrica 26, Limpeza /
Higiene 20, Ferragens / Ferramentas 15, Mobiliário 15, Esportes / Lazer 10 and
Segurança Eletrônica / CFTV 4 — **117 of the 572 rows in
`db/reference/cnae_segments.csv`, 20%**, against 455 covered. So a fifth of the
CNAE map is in a segment this watchdog never asks about, and the card's own
argument — an average can sit above target while one segment holds nothing —
applies to those as well. **B42** is that gap; it is not closed by this file,
and the sentences in `coverage.ts` and `docs/CLAIMS.md` say *six heavily
covered segments plus the baseline*, not *every segment*, for that reason.

``papel`` is the loosest of the seven in one respect worth writing down: it is
`office`'s first keyword, but `cleaning` carries ``papel higienico``, so a
`q=papel` walk includes editais the product would classify as Limpeza /
Higiene. That makes it a slightly wider question than "Gráfico / Escritório",
not a wrong one — every edital it returns is one a company in one of those two
segments would expect to see.

## The budget

Seven queries × :data:`MAX_PAGES` pages of :data:`PAGE_SIZE` is **at most 84
requests**, about 21 s at the client's throttle. For scale: the daily
``reconcile_open_tenders`` spends ~80 requests and ``refresh_catalog_prices``
~2 000 a day.

A broad keyword (``papel``, ``medicamento``) will **probably** exceed 600 open
editais nationally and stop at the ceiling with ``truncated: true``. That is
**inferred from how common those words are in Brazilian procurement, not
measured** — nothing has run this set against PNCP yet, because PNCP refuses
this origin (see above) and the first real figures arrive with the first
scheduled run. When it does truncate the ratio is over the **newest** 600 by
``-data``, which is the right bias for this particular watchdog — the newest
editais are exactly the ones the change-feed keying used to miss — and
`/admin` labels those readings *mais recentes* beside PNCP's own total. **B41**
is the card for measuring the whole set instead.

## Where the answer goes

One ``events`` row **per query**: ``name = 'coverage_check'``, ``props``
carrying the query, the segment it reaches, both counts, the ratio, the sample
of ids we are missing, and ``query_set`` — the whole standing set, so a reader
can tell *"six of seven keywords measured"* from *"six keywords"*. No
migration, and `apps/web/lib/admin/coverage.ts` reads it.

The row name is unchanged from the three rows of 2026-09-30, so the history is
still one `select`.

## Empty is never zero — and nor is half an answer

An empty walk records **nothing for that query** — never a 0% — and a run in
which **no** query could be measured raises, so the queue retries. A walk that
stopped **short of the total PNCP itself declared** is refused the same way: it
is the same defect one layer in, found by this card's own review. PNCP
answering `total: 5000` on page 1 and an empty page 2 would otherwise be
recorded as `collected: 50, truncated: false` — a complete reading of 1% of the
segment, green if we happen to hold those fifty. That is the
`empty-result-is-not-absence` rule, and it is why a measurement that needs PNCP
cannot be taken from Sci's laptop at all.

Per-query isolation is what the seven queries buy on top of coverage: one
keyword matching nothing today is a fact about that keyword, while all seven
coming back empty is a fact about our connection. The first leaves six real
measurements standing; the second fails the job.

**It writes no tender and fixes nothing.** It reports. If the number is short,
the fix is B17's sweep, not this file.
"""

from __future__ import annotations

import json
from typing import Any

from psycopg.types.json import Jsonb

from .pncp import SEARCH_PATH, PncpClient
from .registry import REGISTRY, JobContext
from .segments import label, segment_for_text
from .tenders import DEFAULT_MODALITIES

#: The keyword B17 measured. Kept as the default so a re-run is comparable with
#: the 2026-09-27 baseline rather than with a different question.
DEFAULT_QUERY = "saas"

#: The standing set the daily entry measures. Derived, not chosen — see the
#: module docstring, and `test_coverage_check.py`, which pins the derivation as
#: code. Order is the baseline first, then `sync_awards.DEFAULT_SEGMENTS`'s own
#: order.
DEFAULT_QUERIES: tuple[str, ...] = (
    DEFAULT_QUERY,
    "merenda",
    "pavimentacao",
    "medicamento",
    "papel",
    "pneu",
    "notebook",
)

#: PNCP's page size for this walk, and the cap on how far it goes. 50 × 12 is
#: comfortably past the ~137 the baseline saw; a keyword that matched more than
#: 600 would be a different measurement and should say so rather than truncate.
PAGE_SIZE = 50
MAX_PAGES = 12

#: B17 passes at 95%. The baseline was 41,6%.
TARGET_RATIO = 0.95

#: **Two numbers for one measurement, and the difference is the scope.**
#: 2026-09-27 against `q=saas, status=recebendo_proposta`: PNCP returned
#: **137** editais over every modality, of which we held 57 — the 41,6% B17 is
#: named for. Narrowed to the modalities we actually collect (6/8/4, see
#: `_search`) it is **56 of 128**, which is 43,8% and the denominator B17's
#: acceptance uses ("≥ 122 of the 128 in-scope").
#:
#: This job searches **in scope**, so `in_scope` is the figure a reading of it
#: is comparable with. `all_modalities` is kept because it is the number
#: `docs/CLAIMS.md` and the card's own title quote, and dropping it would make
#: the 44% unsourceable. Recorded in every row rather than remembered.
BASELINE = {
    "measured_on": "2026-09-27",
    "in_scope": {"held": 56, "collected": 128, "ratio": 0.4375},
    "all_modalities": {"held": 57, "collected": 137, "ratio": 0.4161},
}


def _search(
    client: PncpClient, query: str, page: int, modalities: tuple[int, ...]
) -> dict[str, Any]:
    """One page of `q=<query>, status=recebendo_proposta`, **in scope**.

    Through `client._get` rather than `search_page`, because `_search_params`
    has no `q` — the product never needs a keyword search, and B17's
    measurement does. Same breaker, same throttle, same headers.

    ## `modalidades` is the whole point of this function

    The first version of this job left it out, and the resulting number was
    **not a measurement of B17**. `sync_open_tenders` ingests
    `DEFAULT_MODALITIES` — (6, 8, 4), Pregão Eletrônico, Dispensa,
    Concorrência — and nothing else. An unfiltered search returns every
    modality PNCP has, **Pregão Presencial among them**, so the comparison
    counted editais we deliberately never collect and reported them as
    coverage we had lost.

    Measured 2026-09-30: unfiltered gave 117 of 128 (91,4%) and 11 "missing",
    every sampled one absent from `tenders` entirely — which reads as a gap
    and was, in part, simply the scope. Sci spotted it from the number alone:
    *"there is one case we didnt scope to received, is the Pregáo presencial"*.

    The modality set is imported from `tenders.py` rather than written here,
    so the measurement cannot drift from what the sweep actually collects —
    the two would then disagree silently, which is exactly the failure this
    file is for.
    """
    params = {
        "q": query,
        "tipos_documento": "edital",
        "ordenacao": "-data",
        "status": "recebendo_proposta",
        "modalidades": "|".join(str(m) for m in modalities),
        "tam_pagina": PAGE_SIZE,
        "pagina": page,
    }
    return client._get(SEARCH_PATH, params, client.search_breaker) or {}


def _walk(
    client: PncpClient, query: str, modalities: tuple[int, ...]
) -> tuple[list[str], int | None, bool, int]:
    """Collect the open editais PNCP has for ``query``, de-duplicated.

    Returns the control numbers, PNCP's own ``total``, whether the walk hit
    :data:`MAX_PAGES`, and **how many items arrived in all** — which is not
    `len(ids)`: PNCP paginates by a moving `-data` order, so the same edital can
    come back on two pages.

    That fourth number is what tells a finished walk from an abandoned one.
    `len(ids) < total` is **normal** (it is exactly what a duplicate looks
    like); `received < total` with pages left to ask for is PNCP contradicting
    its own count, and :func:`_collect` refuses it.

    An empty list is **not** a result — the caller decides what to do about it,
    and the one thing it never does is write a zero.
    """
    ids: list[str] = []
    seen: set[str] = set()
    total: int | None = None
    truncated = False
    received = 0

    for page in range(1, MAX_PAGES + 1):
        body = _search(client, query, page, modalities)
        if total is None:
            total = body.get("total")
        items = body.get("items") or []
        if not items:
            break
        received += len(items)
        for item in items:
            control = item.get("numero_controle_pncp") or item.get("numeroControlePNCP")
            if control and control not in seen:
                seen.add(control)
                ids.append(control)
        if total is not None and len(ids) >= total:
            break
    else:
        truncated = True

    return ids, total, truncated, received


def segment_of(query: str) -> str | None:
    """The segment label a company would be matched on for this keyword.

    Recorded in the row and printed on `/admin`, so the reading says *which
    kind of company* the weak query belongs to rather than only which word was
    asked. ``None`` when the classifier falls back to `other`, which is what an
    ad-hoc `--q` is likely to do.
    """
    key = segment_for_text(query)
    return None if key is None else label(key)


def _collect(client: PncpClient, query: str, modalities: tuple[int, ...]):
    """What PNCP will say about ``query``, or a raise. **No database, no row.**

    Split from :func:`_record` on purpose, and the seam is which side of it an
    exception may be swallowed on. Everything PNCP can do to us lives here —
    a reset connection, a 503, an open breaker, an answer with nothing in it —
    and the caller catches it per query, because one keyword PNCP has nothing
    for today must not cost the other six.

    Everything on the *other* side of the seam is ours: the arithmetic, the
    props, the insert. A bug there is not "this keyword could not be measured",
    and swallowing it would turn a code defect into a nightly `incomplete`
    reading nobody chases. So it is deliberately outside the `try`.
    """
    ids, total, truncated, received = _walk(client, query, modalities)

    if not ids:
        # **Not "we hold none".** An empty walk means PNCP answered nothing,
        # and recording 0% from it would be a measurement of our own failed
        # request. Raise, so nothing is written for this query at all.
        raise RuntimeError(f"PNCP returned no editais for q={query!r}; nothing measured")

    if total is not None and received < total and not truncated:
        # **The same rule, one layer in.** The walk ended on an empty page
        # while PNCP's own count says there was more to come and the page
        # ceiling was never reached — an error envelope, a shape change, a page
        # that came back blank in the middle. Scoring what did arrive would
        # report a fraction of a segment as the whole of it, with no
        # `truncated` flag to warn anybody. Found by this card's review.
        #
        # `received`, not `len(ids)`: a duplicate across pages makes
        # `len(ids) < total` legitimately, and refusing that would refuse the
        # normal case.
        raise RuntimeError(
            f"PNCP stopped at {received} of {total} for q={query!r}; nothing measured"
        )

    return ids, total, truncated


def _record(
    ctx: JobContext,
    query: str,
    ids: list[str],
    total: int | None,
    truncated: bool,
    modalities: tuple[int, ...],
    query_set: tuple[str, ...],
    standing: bool,
) -> dict[str, Any]:
    """Compare what PNCP listed against what we hold, and write the row."""
    found = ctx.conn.execute("select id from tenders where id = any(%s)", (ids,)).fetchall()
    held = {row[0] for row in found}
    missing = [control for control in ids if control not in held]
    ratio = len(held) / len(ids)

    props = {
        "q": query,
        # The segment this keyword reaches, so the row says whose claim it is
        # about. Derived from the product's own classifier, never typed here.
        "segment": segment_of(query),
        # Recorded, because a coverage figure without the scope it was taken
        # in is the defect this field exists to prevent.
        "modalities": list(modalities),
        "pncp_total": total,
        "collected": len(ids),
        "held": len(held),
        "missing": len(missing),
        "ratio": round(ratio, 4),
        "target": TARGET_RATIO,
        "met": ratio >= TARGET_RATIO,
        "truncated": truncated,
        # The whole set this run measured, in every row. Without it a reader
        # counting rows cannot tell "six keywords" from "six of seven
        # measured", and a keyword that fails every night would simply be
        # absent — which is absence of success going unnoticed, the thing this
        # card is for.
        "query_set": list(query_set),
        # **Whether that set is the standing one.** An ad-hoc
        # `check_coverage.py --q limpeza` writes a perfectly good measurement
        # whose set is one keyword, and it is the newest row afterwards — so
        # without this flag it would redefine "complete" as that one keyword
        # for the rest of the day and `/admin` would stop noticing the other
        # six. The reader takes the set from the newest **standing** row.
        "standing": standing,
        # A sample, not the list: this row is read by a person, and 80 control
        # numbers in a log line help nobody.
        "missing_sample": missing[:10],
        # Both denominators, labelled. The old key carried only the
        # all-modalities one while this job searches in scope, so the row
        # offered a baseline it was not comparable with.
        "baseline_2026_09_27": BASELINE,
    }

    ctx.conn.execute(
        "insert into events (name, props) values (%s, %s)",
        ("coverage_check", Jsonb(props)),
    )
    ctx.log.info("coverage measured", extra={"coverage": json.dumps(props)})
    return props


@REGISTRY.job("coverage_check")
def coverage_check(ctx: JobContext) -> None:
    """Measure the Radar's share of the open editais, per keyword.

    Payload, all optional:

    ``q``
        Measure this one keyword. An ad-hoc question
        (`worker/scripts/check_coverage.py --q …`); its absence is what makes a
        job the standing set.
    ``queries``
        Override the set. Never the default: the default is derived, and an
        override is a different question that should look like one — so it is
        **not** `standing` either, for the same reason a single `q` is not.
        Shrinking the watchdog's own denominator should take a code change.
    ``modalities``
        Override the scope. Defaults to the modalities the sweep collects.
    """
    payload = ctx.payload
    single = payload.get("q")
    # **Only the derived default is `standing`.** A run that names its own
    # keywords — one `q` or a `queries` list — is an ad-hoc question, not a
    # statement about what the standing set is, and `/admin` takes the set from
    # the newest standing row. Letting an override declare itself standing
    # would let `{"queries": ["saas"]}` redefine "complete" as one keyword for
    # as long as that row stays the newest. See the `standing` prop.
    standing = single is None and not payload.get("queries")
    if single is not None:
        queries: tuple[str, ...] = (str(single),)
    else:
        queries = tuple(str(q) for q in payload.get("queries") or DEFAULT_QUERIES)
    # The scope the sweep actually collects. Overridable so a future question
    # can be asked deliberately, never by forgetting.
    modalities = tuple(int(m) for m in payload.get("modalities") or DEFAULT_MODALITIES)
    client = PncpClient()

    measured: list[dict[str, Any]] = []
    failed: dict[str, str] = {}

    for query in queries:
        try:
            collected = _collect(client, query, modalities)
        except Exception as exc:
            # **Only around the PNCP half** (see `_collect`). Per query, so one
            # keyword PNCP has nothing for today does not lose the other six
            # real measurements. The type only — a message can carry a
            # parameter value, and this goes to the log.
            failed[query] = type(exc).__name__
            ctx.log.warning(
                "coverage query failed",
                extra={"q": query, "error": type(exc).__name__},
            )
            continue
        # Outside the `try`: a defect in our own arithmetic or insert must fail
        # the job, not be filed as "this keyword could not be measured".
        measured.append(_record(ctx, query, *collected, modalities, queries, standing))

    if not measured:
        # Every query came back empty or raised. That is our connection, not
        # the Radar: fail the job so the queue retries, and leave no row
        # claiming we hold 0%.
        raise RuntimeError(f"no coverage query could be measured ({failed}); nothing measured")

    worst = min(measured, key=lambda props: props["ratio"])
    ctx.log.info(
        "coverage sweep finished",
        extra={
            "measured": len(measured),
            "of": len(queries),
            "failed": failed,
            "worst_q": worst["q"],
            "worst_ratio": worst["ratio"],
            "met": all(props["met"] for props in measured),
        },
    )
