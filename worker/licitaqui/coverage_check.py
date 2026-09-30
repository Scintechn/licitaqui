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

## One-off, and deliberately not on the schedule

`DEFAULT_SCHEDULE` does not mention this. It is enqueued by hand when somebody
wants the number — `scripts/check_coverage.py --commit` — because it walks a
keyword search to its end and B17 is a question asked at a moment, not a metric
that needs a cadence. A `ScheduleEntry` for it would be a standing PNCP cost to
answer a question nobody is asking that hour, and would land in the same
five-minute Neon wake this repo has just spent effort reducing.

## Where the answer goes

An ``events`` row: ``name = 'coverage_check'``, ``props`` carrying the query,
both counts, the ratio and the sample of ids we are missing. No migration, and
readable with one `select` afterwards. It is also logged, because the log is
where somebody watching a deploy will look first.

**It writes no tender and fixes nothing.** It reports. If the number is short,
the fix is B17's sweep, not this file.
"""

from __future__ import annotations

import json
from typing import Any

from psycopg.types.json import Jsonb

from .pncp import SEARCH_PATH, PncpClient
from .registry import REGISTRY, JobContext
from .tenders import DEFAULT_MODALITIES

#: The keyword B17 measured. Kept as the default so a re-run is comparable with
#: the 2026-09-27 baseline rather than with a different question.
DEFAULT_QUERY = "saas"

#: PNCP's page size for this walk, and the cap on how far it goes. 50 × 12 is
#: comfortably past the ~137 the baseline saw; a keyword that matched more than
#: 600 would be a different measurement and should say so rather than truncate.
PAGE_SIZE = 50
MAX_PAGES = 12

#: B17 passes at 95%. The baseline was 41,6%.
TARGET_RATIO = 0.95


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


@REGISTRY.job("coverage_check")
def coverage_check(ctx: JobContext) -> None:
    query = str(ctx.payload.get("q") or DEFAULT_QUERY)
    # The scope the sweep actually collects. Overridable so a future question
    # can be asked deliberately, never by forgetting.
    modalities = tuple(int(m) for m in ctx.payload.get("modalities") or DEFAULT_MODALITIES)
    client = PncpClient()

    ids: list[str] = []
    seen: set[str] = set()
    total: int | None = None
    truncated = False

    for page in range(1, MAX_PAGES + 1):
        body = _search(client, query, page, modalities)
        if total is None:
            total = body.get("total")
        items = body.get("items") or []
        if not items:
            break
        for item in items:
            control = item.get("numero_controle_pncp") or item.get("numeroControlePNCP")
            if control and control not in seen:
                seen.add(control)
                ids.append(control)
        if total is not None and len(ids) >= total:
            break
    else:
        truncated = True

    if not ids:
        # **Not "we hold none".** An empty walk means PNCP answered nothing,
        # and recording 0% from it would be a measurement of our own failed
        # request. Raise, so the queue retries and the row is never written.
        raise RuntimeError(f"PNCP returned no editais for q={query!r}; nothing measured")

    found = ctx.conn.execute("select id from tenders where id = any(%s)", (ids,)).fetchall()
    held = {row[0] for row in found}
    missing = [control for control in ids if control not in held]
    ratio = len(held) / len(ids)

    props = {
        "q": query,
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
        # A sample, not the list: this row is read by a person, and 80 control
        # numbers in a log line help nobody.
        "missing_sample": missing[:10],
        "baseline_2026_09_27": {"held": 57, "collected": 137, "ratio": 0.416},
    }

    ctx.conn.execute(
        "insert into events (name, props) values (%s, %s)",
        ("coverage_check", Jsonb(props)),
    )
    ctx.log.info("coverage measured", extra={"coverage": json.dumps(props)})
