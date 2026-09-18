"""``sync_files`` — what documents a tender has, and what stops being true
when that changes.

B2's sweep enqueues one of these per new or changed tender (§7.1), beside
``sync_items``. The job:

1. checks the list is still worth re-reading — §3.2 gives it a 12 h TTL, and
   B2 only enqueues when PNCP's ``dataAtualizacaoGlobal`` moved, so a job that
   arrives twice inside the TTL costs no request;
2. reads `/api/pncp/v1/.../arquivos` through B2's client, its own breaker and
   its own throttle;
3. upserts the rows, clearing the extracted-text columns of any document that
   was replaced under its number, and deleting any the agency withdrew;
4. records the new `files_hash`, which is what retires the screening.

**List only.** No PDF is downloaded here: the card says so, and S3, extraction
and OCR are later cards. Everything this job stores is what PNCP's list itself
says — `title`, `doc_type`, `url`, `active`, `published_at`, `sequence`.

It is a sibling of :mod:`licitaqui.sync_items`, not a second framework: same
``PncpClient``, same breaker discipline, same "the handler is idempotent and the
queue owns retries" contract (§7.2). Registering the kind in
:mod:`licitaqui.handlers` is also what switches B2's follow-up enqueue on.

## The acceptance criterion: an amendment invalidates text and screening

§3.2 is blunt about the stakes — *"an amendment adds a new file: invalidates
text and screening"*. A company that bids against a superseded edital has been
actively misled by us, so this cannot be best-effort.

**Screening is invalidated by the key, not by a delete.**
:func:`licitaqui.files.files_hash` digests the active file list, and
`ai_analyses` is unique on `(tender_id, mode, prompt_version,
extraction_version, files_hash)`. When the list moves, the hash moves, and
:func:`licitaqui.ai_screening.cached` — which looks up by exactly that key —
misses. The old analysis is still on the row, still true of the documents it
read and still the record of what was paid; it is simply no longer *this*
tender's current answer. Nothing has to be deleted for a superseded analysis to
stop being served, which is the property worth having: there is no window in
which a delete has not run yet and the stale row is still a hit.

Three alternatives were rejected:

*Delete the `ai_analyses` rows.* It fights C1's central invariant — a cached
`ok` row is never overwritten, because that is what makes the cost cap hold —
and §3.2 says an AI result is kept permanently. It also races: a screening job
already in flight for the old hash writes its row back after the delete, and
the stale answer returns. And it throws away the cost history §14 reports on.

*Add an `invalidated_at` (or `current`) column to `ai_analyses`.* A schema
change is its own PR (CLAUDE.md), every reader would have to remember the
filter, and the column would carry information the unique key already carries.
One forgotten `where` and a superseded analysis is on screen.

*Store the hash in a column.* A stored digest can disagree with the rows it
summarises — after a partial write, a manual fix, a restore. Deriving it
(:func:`licitaqui.files.files_hash_for`) costs a sha256 over a few short lines
and cannot be stale by construction.

**Text is invalidated per document, in the write itself.** The extraction state
(`sha256`, `s3_key`, `pages`, `text_version`, `no_text`) describes bytes. When
the document behind a number changes, :func:`licitaqui.files.upsert_files`
clears those columns in the same statement that writes the new URL, so nothing
can read the new address beside the old page count. A withdrawn document's row
goes entirely.

**What this job does not do** is re-screen. Screening is enqueued on demand at
priority 1 because a user is on screen waiting (§7.3); re-analysing every
amended tender in the country the moment it changes would spend the AI budget
on tenders nobody asked about. The invalidation is complete without it: the
next request gets a miss and pays for a fresh reading of the new documents.

## Not spending the day on an endpoint that is down

§7.2, and measured: PNCP timed out for three hours straight on 2026-09-18. The
file list gets its own circuit breaker (``pncp-arquivos``) so two consecutive
failures stop the calls for fifteen minutes instead of every job burning its
whole timeout budget; the call itself is a single unpaged GET with no retry of
its own, because the queue owns retries — 2, 8 and 30 minutes, four attempts.
A failed call raises before anything is written, so an outage can never be
mistaken for "this tender has no documents any more".
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import psycopg

from .files import map_all, mark_synced, sync_event_name, upsert_files
from .pncp import PncpClient
from .registry import REGISTRY, JobContext
from .tenders import split_control_number

#: §3.2: the file list is good for 12 hours while the tender is open.
FILES_TTL_HOURS = 12


@dataclass(frozen=True, slots=True)
class FilesState:
    """What the database already knows, and whether that is still good enough."""

    exists: bool
    synced_at: datetime | None = None
    file_count: int = 0
    #: Why we are (or are not) going back to PNCP — for the log line.
    reason: str = "missing"

    @property
    def stale(self) -> bool:
        return self.reason != "fresh"


#: `tender_files` has no timestamp column (§6.1), so freshness comes from the
#: marker :func:`licitaqui.files.mark_synced` writes — see the comment above it
#: for why that lives in `events`. Note what is being asked: *when did we last
#: read PNCP*, not *when did a row change*. A tender whose list came back
#: identical is still fresh, and a tender with genuinely no documents is too —
#: which a count of rows could not tell apart from never having looked.
#: One round trip, because the sweep runs this per changed tender and the
#: database is in São Paulo behind a pooler. `max()` over no rows still returns
#: a row (holding NULL), so the cross join cannot hide the tender.
STATE_SQL = f"""
select m.synced_at,
       (select count(*) from tender_files f where f.tender_id = t.id) as file_count,
       t.pncp_updated_at,
       m.synced_at < now() - interval '{FILES_TTL_HOURS} hours'       as expired
  from tenders t
 cross join (select max(created_at) as synced_at from events where name = %(event)s) m
 where t.id = %(tender_id)s
"""


def read_state(conn: psycopg.Connection, tender_id: str) -> FilesState:
    """Whether this tender's file list needs fetching, and why."""
    row = conn.execute(
        STATE_SQL, {"tender_id": tender_id, "event": sync_event_name(tender_id)}
    ).fetchone()
    if row is None:
        return FilesState(exists=False)
    synced_at, file_count, pncp_updated_at, expired = row
    return FilesState(
        exists=True,
        synced_at=synced_at,
        file_count=int(file_count),
        reason=_reason(synced_at, pncp_updated_at, expired=expired),
    )


def _reason(
    synced_at: datetime | None,
    pncp_updated_at: datetime | None,
    *,
    expired: bool | None,
) -> str:
    """`never` | `ttl` | `tender_changed` | `fresh`.

    The age is decided by Postgres rather than by the worker's clock, so the
    answer cannot depend on which machine the job ran on — the same reason the
    rest of the collector compares against `now()`.
    """
    if synced_at is None:
        return "never"
    if expired:
        return "ttl"
    if pncp_updated_at is not None and synced_at < pncp_updated_at:
        # B2 enqueues on a moved `dataAtualizacaoGlobal` — the tender *or any of
        # its children* changed — and an amendment is exactly that. The TTL must
        # not be what stops us looking.
        return "tender_changed"
    return "fresh"


def build_client() -> PncpClient:
    """The client one run uses. A seam, exactly as in :mod:`licitaqui.sync_items`."""
    return PncpClient()


@REGISTRY.job("sync_files")
def sync_files(ctx: JobContext) -> None:
    """Fetch one tender's document list and retire what it supersedes.

    Payload:

    ``tender_id``
        The `numeroControlePNCP`. Defaults to the job's ``key``, which is what
        B2's follow-up sets it to, so a hand-enqueued job needs only the key.
    ``force``
        Ignore the 12 h TTL. For operators re-running a tender by hand, and for
        the tests.
    """
    payload = ctx.payload
    tender_id = str(payload.get("tender_id") or ctx.job.key)
    force = bool(payload.get("force"))

    state = read_state(ctx.conn, tender_id)
    if not state.exists:
        # The sweep enqueues by id, so this only happens if the tender was
        # deleted between the two. Failing would retry four times over 40
        # minutes against a row that is never coming back.
        ctx.log.warning("sync_files: unknown tender, nothing to do", extra={"tender_id": tender_id})
        return
    if not state.stale and not force:
        ctx.log.info(
            "sync_files: the file list is fresh",
            extra={
                "tender_id": tender_id,
                "files": state.file_count,
                "ttl_hours": FILES_TTL_HOURS,
            },
        )
        return

    cnpj, year, sequence = split_control_number(tender_id)
    with build_client() as client:
        records = client.fetch_files(cnpj, year, sequence)

    # Nothing above this line has written anything: a PncpError or a CircuitOpen
    # raises here, the queue retries, and the stored list is untouched.
    result = upsert_files(ctx.conn, tender_id, map_all(tender_id, records))
    mark_synced(ctx.conn, tender_id, result)

    extra = {
        "tender_id": tender_id,
        "reason": "forced" if force else state.reason,
        "fetched": len(records),
        **result.log_fields(),
    }
    if result.changed:
        # Worth a warning, not an info: this is the moment a cached analysis
        # stopped being current, and it is the line to look for when someone
        # asks why a tender was screened twice.
        ctx.log.warning(
            "sync_files: the file list changed; text and screening invalidated", extra=extra
        )
    else:
        ctx.log.info("sync_files finished", extra=extra)
