"""What a 404 from PNCP's item and file endpoints actually means.

`/api/pncp/v1/.../itens` and `/.../arquivos` answer **404** in more than one
situation, and the status alone cannot tell them apart:

* the contratação exists and simply has nothing to list;
* the contratação was **excluded** by the agency after we ingested it;
* PNCP is confused about a path — a real possibility on endpoints §3.2 already
  calls unstable.

Treating all three as a hard failure is what production was doing, and it costs
four attempts over forty minutes per job, every time the sweep re-enqueues,
forever — the tender never reaches a state that says "we looked". Treating all
three as an empty list is worse: it would let
:func:`licitaqui.items.upsert_items` and :func:`licitaqui.files.upsert_files`
prune rows we still hold, so a PNCP glitch would silently delete a tender's
items and retire the analysis of its edital.

## The rule

**Do we already have rows for this tender?**

*Yes* — the 404 is a **regression**. Data we had has apparently vanished, and
that is not a thing this job is allowed to act on: it raises
:class:`DataVanished` with the tender, the endpoint and the counts, writes
nothing, deletes nothing, and the job ends `failed` with that diagnosis in
`jobs.error`. Never silently zeroed out.

*No* — the 404 is **information**, and the job completes rather than retrying
into the void. Which information is settled by one more question, to the
Consulta detail endpoint (:meth:`licitaqui.pncp.PncpClient.contratacao_state`):

| Consulta says | verdict | what it means |
|---|---|---|
| `410 GONE` | :data:`WITHDRAWN` | the agency excluded the contratação |
| `200` | :data:`EMPTY` | it is live and genuinely has nothing to list |
| anything else | :data:`UNCONFIRMED` | Consulta is down or circuit-broken |

All three finish the job and record "synced, nothing found" so the next sweep
does not re-enqueue it. They differ in what is written to the marker and at
what level it is logged — an :data:`EMPTY` is routine, a :data:`WITHDRAWN` is a
tender that may still be on someone's Radar, and an :data:`UNCONFIRMED` is a
reading we could not check.

## Why the evidence forced the extra question

On 2026-09-21 three tenders had their `sync_items`/`sync_files` jobs die this
way. All three were still in `tenders`, all three 404 on both endpoints, and on
2026-09-22 all three answered the Consulta detail endpoint with

    410 — "A contratação informada foi excluída e não pode ser consultada."

So in production this 404 was neither "no items" nor a wrong path: it was a
**withdrawn** contratação. Recording those as "synced with zero items" and
nothing more would have been recording a falsehood about a tender the Radar
still shows as open. The verdict is cheap — one request, only ever on the 404
path, which was 3 requests out of ~9,200 collector jobs — and it is the
difference between "this tender has nothing for you" and "this tender no longer
exists".

**What this module does not do** is hide a withdrawn tender from users. Whether
a withdrawn tender disappears from the Radar, is greyed out, or is left alone is
a product decision, and the spec does not cover it (§3.2 has no row for a
withdrawn contratação). It is recorded and left visible; see `docs/STATUS.md`.
"""

from __future__ import annotations

from dataclasses import dataclass

from .pncp import (
    CONTRATACAO_GONE,
    CONTRATACAO_PRESENT,
    PncpClient,
    PncpNotFound,
)

#: The contratação is live on PNCP and has nothing to list.
EMPTY = "empty"
#: PNCP answered `410 GONE`: the agency excluded the contratação.
WITHDRAWN = "withdrawn"
#: We could not reach Consulta to find out which of the two it is.
UNCONFIRMED = "unconfirmed"
#: We hold rows PNCP no longer admits to. Not a verdict a job may act on.
REGRESSION = "regression"


class DataVanished(RuntimeError):
    """PNCP 404s for a tender whose rows we already hold.

    Its own type so it is greppable in `jobs.error` and distinguishable from
    every ordinary :class:`licitaqui.pncp.PncpError` in the logs. The job fails
    on it — loudly, with the counts — rather than deleting anything.
    """


@dataclass(frozen=True, slots=True)
class Absence:
    """Why PNCP has nothing for this tender, and what the job may do about it."""

    verdict: str
    #: One line for the log and, on a regression, for `jobs.error`.
    detail: str

    @property
    def is_regression(self) -> bool:
        return self.verdict == REGRESSION

    @property
    def confirmed(self) -> bool:
        """Whether Consulta actually told us which kind of absence this is."""
        return self.verdict in (EMPTY, WITHDRAWN)

    def log_fields(self) -> dict[str, str]:
        return {"absent": self.verdict, "absent_detail": self.detail}


def classify(
    client: PncpClient,
    *,
    tender_id: str,
    cnpj: int | str,
    year: int,
    sequence: int,
    stored_rows: int,
    error: PncpNotFound,
) -> Absence:
    """Resolve one 404 into something the caller may act on.

    ``stored_rows`` is how many rows of the kind being synced we already hold
    for this tender — the whole rule turns on it, so it is a required argument
    rather than something this module re-reads and could get wrong.

    Makes at most **one** extra request, and only when there is nothing to lose
    (``stored_rows == 0``). A regression is decided from the database alone.
    """
    if stored_rows > 0:
        return Absence(
            REGRESSION,
            f"PNCP 404s for {tender_id}, which already has {stored_rows} stored row(s). "
            f"Refusing to treat that as an empty list; nothing was written or deleted. "
            f"Underlying call: {error}",
        )

    state = client.contratacao_state(cnpj, year, sequence)
    if state == CONTRATACAO_GONE:
        return Absence(
            WITHDRAWN,
            f"PNCP 404s for {tender_id} and Consulta answers 410: the contratação was "
            f"excluded by the agency. Recorded as synced with nothing to list.",
        )
    if state == CONTRATACAO_PRESENT:
        return Absence(
            EMPTY,
            f"PNCP 404s for {tender_id} but Consulta still publishes it: it genuinely "
            f"has nothing to list. Recorded as synced with nothing to list.",
        )
    return Absence(
        UNCONFIRMED,
        f"PNCP 404s for {tender_id} and Consulta could not be reached to say whether it "
        f"was withdrawn. Nothing was stored for this tender, so it is recorded as synced "
        f"with nothing to list and re-read when the TTL expires.",
    )
