"""The ``ai_screening`` job: one lite analysis of one tender, cached for ever.

The reading itself is :mod:`licitaqui.ai_tender` (the POC 4 port). This module
is the job around it: where the document comes from, the cache, the circuit
breaker, the `ai_analyses` row and the cost line in the log. They are separate
files because they fail for different reasons and are tested differently —
`ai_tender` never touches the database and never needs one, and changing a
prompt there is what triggers `evaluate-ai.yml`.

## The cache is the product's cost control

§3.2: an AI result is kept **permanently** and **shared across users**, keyed by
prompt version + extraction version + file hash — which is exactly the unique
key of `ai_analyses` (§6.3). So the first user to screen a tender pays for it
and everybody after that reads the row. A hit does not call the API, and neither
does a second attempt of the same job: that is what makes the handler idempotent
(§7.2) rather than merely re-runnable.

Two consequences:

- **A cached `ok` or `no_text` row is never overwritten.** The upsert's `where`
  clause only lets a `failed`/`running` row be replaced. A re-run after a
  failure is free to try again; a re-run after success cannot spend money.
- **`files_hash` must identify the bytes, not the tender.** An amendment
  republishes the edital, which §3.2 says invalidates text and screening: a new
  hash, a new row, the old one still valid for the old file. B4 (`sync_files`)
  owns that hash and :func:`resolve_files_hash` asks it for the current one.

## The hash is resolved when the job **runs**, not when it is queued

:func:`resolve_files_hash` calls :func:`licitaqui.files.files_hash_for` inside
the handler. The alternative — the enqueue site digesting the list and putting
the value in the payload — is wrong for this job, and the difference is exactly
the case the hash exists for:

*A payload is a snapshot, and this one goes stale.* Between the enqueue and the
execution sits the whole queue: priority, backoff (2, 8 and 30 minutes, four
attempts) and whatever is ahead of it. `sync_files` can land an errata in that
window. The documents the handler then reads are the **new** ones, so a payload
hash would key an analysis of the new edital under the old list's digest — a
row that lies about which documents it read, and, because a cached `ok` is never
overwritten, lies permanently. Resolving at execution keeps the key and the
bytes describing the same thing, which is the invariant above.

*The queue de-duplicates, so the payload cannot even be trusted to be this
request's.* `jobs_dedupe` is unique on `(kind, key)` while queued or running and
:func:`job_key` is one key per tender, so the second request for a tender that
is already queued does not enqueue anything — its payload is dropped. Queue the
hash and the amended request silently inherits the pre-amendment one.

*Only the worker can spell the digest.* The recipe lives in
:mod:`licitaqui.files` (``MANIFEST_VERSION``, tab-separated fields, UTC
ISO-8601). A web enqueue site would have to re-implement it in TypeScript and
agree with Python byte for byte for ever; the day the two disagree every
screening misses its cache and is paid for again — about R$ 0,0014 each, per
tender, for ever. Deriving it once, in the worker, from the rows themselves is
the same argument B4 makes for not storing the digest in a column.

An explicit ``files_hash`` in the payload still wins, for the evaluation
harness, for a document that is not in `tender_files` at all, and for an
operator re-running one exact file set.

## Where the document comes from

Resolving the key is half the hand-over; the other half is *finding the
document it names*. The web enqueues `{tender_id}` and nothing else, so
:func:`load_document` prefers whatever the payload carries (pages, a cache file,
a local PDF, a URL — the evaluation harness and the operator paths) and
otherwise asks :func:`licitaqui.documents.ensure_documents` to download and
extract the tender's active Edital and Termo de Referência. That last source is
what makes a user's "analisar" complete; see that module's docstring for why the
download is a step of this job rather than a job of its own.

It also tightens the rule above by one notch. ``ensure_documents`` reads the
file list **once** and returns both the documents it chose and the digest of
that same snapshot, so in that branch the snapshot's digest is preferred over
the one :func:`resolve_files_hash` read a moment earlier: a `sync_files` landing
between the two calls would otherwise key an analysis under one list while
having read another — the very thing resolving-at-execution exists to prevent,
one level down.

## Never for a scanned PDF

`no_text` is decided from the extracted text before any key is resolved, and the
row is written with no model, no tokens and no cost. OCR is v2 (§16).

## LGPD (§12)

The log line carries the tender id, the versions, tokens, cost and seconds. It
never carries the document, the prompt, the answer or the API key.
"""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from . import ai_tender, documents, files, queue
from .ai_tender import Document, Screening
from .breaker import CircuitOpen, get_breaker
from .observability import get_logger
from .registry import REGISTRY, JobContext

_log = get_logger("ai_screening")

JOB_KIND = "ai_screening"
MODE = "lite"

#: The download itself lives in :mod:`licitaqui.documents`, which owns the
#: breaker, the wall-clock deadline and the size guard. Re-exported here because
#: the `url` payload branch below is the operator path into it.
DOWNLOAD_TIMEOUT_SECONDS = documents.DOWNLOAD_TIMEOUT_SECONDS
DOWNLOAD_BREAKER_NAME = documents.BREAKER_NAME

CACHE_SQL = """
select id, status, result, citation_check, rules, model, cost_brl
  from ai_analyses
 where tender_id = %(tender_id)s
   and mode = %(mode)s
   and prompt_version = %(prompt_version)s
   and extraction_version = %(extraction_version)s
   and files_hash = %(files_hash)s
   and status in ('ok', 'no_text')
"""

# The `where` is what makes a permanent cache permanent: a successful analysis
# can be read again and again but never paid for twice, while a `failed` or
# abandoned `running` row is free to be replaced by a later attempt.
UPSERT_SQL = """
insert into ai_analyses (tender_id, mode, model, prompt_version, extraction_version,
                         files_hash, status, result, citation_check, rules,
                         input_tokens, output_tokens, cost_brl, seconds)
values (%(tender_id)s, %(mode)s, %(model)s, %(prompt_version)s, %(extraction_version)s,
        %(files_hash)s, %(status)s, %(result)s, %(citation_check)s, %(rules)s,
        %(input_tokens)s, %(output_tokens)s, %(cost_brl)s, %(seconds)s)
on conflict (tender_id, mode, prompt_version, extraction_version, files_hash) do update
   set model          = excluded.model,
       status         = excluded.status,
       result         = excluded.result,
       citation_check = excluded.citation_check,
       rules          = excluded.rules,
       input_tokens   = excluded.input_tokens,
       output_tokens  = excluded.output_tokens,
       cost_brl       = excluded.cost_brl,
       seconds        = excluded.seconds,
       created_at     = now()
 where ai_analyses.status not in ('ok', 'no_text')
returning id
"""


def job_key(tender_id: str) -> str:
    """Dedupe key for the `jobs` row: one live screening per tender."""
    return f"screening:{tender_id}"


def enqueue(
    conn: psycopg.Connection,
    tender_id: str,
    *,
    priority: int = 1,
    payload: dict[str, Any] | None = None,
) -> int | None:
    """Queue a screening. Priority 1: a user is on screen waiting (§7.3).

    The payload does **not** need a ``files_hash``: the handler resolves the
    current one from `tender_files` when it runs (see the module docstring).
    Pass one only to pin a screening to a file set the database does not hold.
    """
    body: dict[str, Any] = {"tender_id": tender_id, **(payload or {})}
    return queue.enqueue(conn, JOB_KIND, job_key(tender_id), priority=priority, payload=body)


def _read_pages_file(path: Path) -> dict[str, Any]:
    """Extracted pages from a `.json` or `.json.gz` cache file."""
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            return json.load(handle)
    return json.loads(path.read_text(encoding="utf-8"))


def download(url: str) -> bytes:
    """Fetch one file. Delegates to :func:`licitaqui.documents.download`.

    Kept as a name here because the `url` payload branch is an operator path and
    this is where someone looks for it, but the budget, the breaker and the
    wall-clock deadline are owned by one implementation, not two.
    """
    return documents.download(url)


def resolve_files_hash(
    conn: psycopg.Connection,
    tender_id: str,
    payload: dict[str, Any],
) -> str | None:
    """The digest this screening must be keyed on, as the file list stands *now*.

    This is the B4 → C1 hand-over: `ai_analyses` is unique on `(tender_id, mode,
    prompt_version, extraction_version, files_hash)` and :func:`cached` looks up
    by exactly that key, so passing the current digest is what makes an
    amendment miss the cache — and passing a *stable* digest for an unamended
    tender is what keeps the hit free. See the module docstring for why this is
    resolved here rather than at the enqueue site.

    Precedence:

    1. ``payload['files_hash']`` — an explicit pin always wins. Only the caller
       knows which files went into a hash it computed itself.
    2. the stored list, via :func:`licitaqui.files.files_hash_for`.
    3. ``None``, when the tender has no active documents on record — either
       `sync_files` has not run yet or the agency withdrew everything. The
       caller then falls back to hashing what it actually read, which is
       C1's original behaviour and stays honest: a digest of the bytes rather
       than :data:`licitaqui.files.EMPTY_MANIFEST_DIGEST`, which is the same
       constant for every tender and would claim a file list we do not have.
    """
    given = payload.get("files_hash")
    if given:
        return str(given)
    digest = files.files_hash_for(conn, tender_id)
    return None if digest == files.EMPTY_MANIFEST_DIGEST else digest


def load_document(
    payload: dict[str, Any],
    files_hash: str | None = None,
    *,
    conn: psycopg.Connection | None = None,
    tender_id: str | None = None,
    log: Any = None,
) -> tuple[Document, str]:
    """The document to screen and the `files_hash` that identifies it.

    Five sources, in order of how much work they save: pages already extracted
    (what the evaluation harness passes), a cache file of the same shape, a
    local PDF/ZIP, a URL to download — and finally the tender's **own**
    documents, downloaded and extracted by :mod:`licitaqui.documents`. The last
    one is the ordinary path: it is what the web's `{tender_id}`-only payload
    resolves to, and the four above it are the operator and harness routes.

    ``files_hash`` is the key the caller resolved (:func:`resolve_files_hash`);
    it wins, then the payload's own, then — for a document that is in no file
    list — the digest of the bytes, and last the digest of the extracted text.
    The fifth source is the one exception, and deliberately so: see its branch.
    """
    given_hash = files_hash or payload.get("files_hash")

    if payload.get("pages") is not None:
        document = Document.from_dict(payload)
    elif payload.get("text_path"):
        document = Document.from_dict(_read_pages_file(Path(payload["text_path"])))
    elif payload.get("pdf_path") or payload.get("url"):
        if payload.get("pdf_path"):
            data = Path(payload["pdf_path"]).read_bytes()
        else:
            data = download(payload["url"])
        given_hash = given_hash or hashlib.sha256(data).hexdigest()
        document = ai_tender.extract_text(data)
    elif conn is not None and tender_id:
        resolved = documents.ensure_documents(conn, tender_id, log=log or _log)
        # Only an explicit **payload** pin beats this one. The value
        # `resolve_files_hash` handed down does not, and that is not an
        # oversight: `ensure_documents` chose these documents from a file list
        # it read itself, and returns the digest of that same snapshot. A
        # `sync_files` landing between the two reads would otherwise key this
        # analysis under one list while it had read another.
        #
        # It is also why `EMPTY_MANIFEST_DIGEST` is right here where
        # `resolve_files_hash` rejects it. That rule guards the other four
        # sources, where an empty `tender_files` sits beside a document the list
        # never mentioned and claiming the empty list would be a lie. Here the
        # empty list *is* what was read: the tender genuinely has no active
        # documents, the screening is `no_text`, and the key moves the moment
        # `sync_files` finds one. Keying on the digest of an empty document
        # instead would be just as constant and would not match what
        # `_cached_without_reading` looks up.
        return resolved.document, payload.get("files_hash") or resolved.files_hash
    else:
        raise ValueError(
            "ai_screening payload needs 'pages', 'text_path', 'pdf_path' or 'url', "
            "or a connection and a tender to read the tender's own documents"
        )

    return document, given_hash or document.text_hash()


def cached(
    conn: psycopg.Connection,
    tender_id: str,
    files_hash: str,
    *,
    extraction_version: int = ai_tender.EXTRACTION_VERSION,
) -> dict[str, Any] | None:
    """The stored analysis for this exact prompt/extraction/file, if there is one.

    ``extraction_version`` is the one that produced *this* text, which is not
    necessarily the current constant: pages handed over by another job carry
    their own, and keying the cache on anything else would serve an answer read
    from a different extraction of the same file.
    """
    with conn.cursor() as cur:
        cur.execute(
            CACHE_SQL,
            {
                "tender_id": tender_id,
                "mode": MODE,
                "prompt_version": ai_tender.PROMPT_VERSION_LITE,
                "extraction_version": extraction_version,
                "files_hash": files_hash,
            },
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {
        "id": row[0],
        "status": row[1],
        "result": row[2],
        "citation_check": row[3],
        "rules": row[4],
        "model": row[5],
        "cost_brl": row[6],
    }


def store(
    conn: psycopg.Connection,
    tender_id: str,
    files_hash: str,
    screening: Screening,
) -> int | None:
    """Write the row. Returns ``None`` when a cached `ok` row was kept instead."""
    analysis = screening.analysis
    document = screening.document
    extraction_version = document.extraction_version if document else ai_tender.EXTRACTION_VERSION
    with conn.cursor() as cur:
        cur.execute(
            UPSERT_SQL,
            {
                "tender_id": tender_id,
                "mode": MODE,
                "model": analysis.model if analysis else None,
                "prompt_version": ai_tender.PROMPT_VERSION_LITE,
                "extraction_version": extraction_version,
                "files_hash": files_hash,
                "status": screening.status,
                "result": Jsonb(analysis.result) if analysis and analysis.result else None,
                "citation_check": Jsonb(analysis.citation_check)
                if analysis and analysis.citation_check
                else None,
                "rules": Jsonb(analysis.rules) if analysis and analysis.rules else None,
                "input_tokens": analysis.input_tokens if analysis else 0,
                "output_tokens": analysis.output_tokens if analysis else 0,
                "cost_brl": analysis.cost_brl if analysis else 0,
                "seconds": int(analysis.seconds) if analysis else 0,
            },
        )
        row = cur.fetchone()
    return None if row is None else int(row[0])


def _transport_failed(screening: Screening) -> bool:
    """True when OpenRouter itself misbehaved, as opposed to the model answering badly.

    Only the first kind says anything about the endpoint's health, so only the
    first kind may open the circuit. A model that returns prose instead of JSON
    three times is a model problem; tripping the breaker on it would block every
    other tender for fifteen minutes.
    """
    analysis = screening.analysis
    if analysis is None or analysis.ok or not analysis.attempts:
        return False
    return all(a.http == 0 or a.http >= 500 or a.http == 429 for a in analysis.attempts)


#: Payload keys that carry a document of the caller's own.
_DOCUMENT_KEYS = ("pages", "text_path", "pdf_path", "url")


def _cached_without_reading(
    conn: psycopg.Connection | None,
    payload: dict[str, Any],
    tender_id: str,
    resolved: str | None,
    *,
    log: Any,
) -> Screening | None:
    """The stored answer, found before a single byte is downloaded.

    :func:`resolve_files_hash` has just derived the cache key from rows this
    process can already read, and for the ordinary `{tender_id}`-only payload
    that key is complete — nothing about it depends on the documents. Asking the
    cache now is what keeps the poll in §3.1 step 4 cheap: the second user to
    open a tender, and every 3-second poll of the first, costs one query instead
    of two PDF downloads.

    Only for a payload with no document of its own. When the caller brought
    pages or a path, the key may depend on what they brought
    (:func:`load_document` falls back to the digest of the bytes), and only
    `load_document` knows it.

    ``EMPTY_MANIFEST_DIGEST`` stands in for a ``None`` resolution here for the
    same reason the fifth source in :func:`load_document` uses it: that is the
    key a tender with no active documents is stored under, and the two have to
    agree or the hit is never found.
    """
    if conn is None or payload.get("force"):
        return None
    if any(payload.get(key) is not None for key in _DOCUMENT_KEYS):
        return None
    hit = cached(conn, tender_id, resolved or files.EMPTY_MANIFEST_DIGEST)
    if hit is None:
        return None
    screening = Screening(status=hit["status"], cached=True)
    log.info(
        "ai screening",
        extra={
            "tender_id": tender_id,
            "files_hash": resolved or files.EMPTY_MANIFEST_DIGEST,
            **screening.log_fields(),
        },
    )
    return screening


def screen_tender(
    conn: psycopg.Connection,
    payload: dict[str, Any],
    *,
    log: Any,
) -> Screening:
    """Cache, then document, then — only if it has text and nothing is cached — the API."""
    tender_id = payload.get("tender_id")
    if not tender_id:
        raise ValueError("ai_screening payload needs a 'tender_id'")

    # Resolved once and used twice: the cheap cache probe below, and the key the
    # analysis is stored under. Two calls would be two `files_hash_for` queries
    # and, worse, two chances to read different lists.
    resolved = resolve_files_hash(conn, tender_id, payload) if conn is not None else None

    cheap = _cached_without_reading(conn, payload, tender_id, resolved, log=log)
    if cheap is not None:
        return cheap

    document, files_hash = load_document(
        payload, files_hash=resolved, conn=conn, tender_id=tender_id, log=log
    )

    if not payload.get("force"):
        hit = cached(conn, tender_id, files_hash, extraction_version=document.extraction_version)
        if hit is not None:
            screening = Screening(status=hit["status"], document=document, cached=True)
            log.info(
                "ai screening",
                extra={"tender_id": tender_id, "files_hash": files_hash, **screening.log_fields()},
            )
            return screening

    if not document.has_text:
        # Before the key is resolved and before the breaker is consulted: a
        # scanned edital must not be able to spend anything (§7.2).
        screening = Screening(status=ai_tender.NO_TEXT, document=document)
        store(conn, tender_id, files_hash, screening)
        log.warning(
            "ai screening skipped: no text layer",
            extra={"tender_id": tender_id, "files_hash": files_hash, **screening.log_fields()},
        )
        return screening

    breaker = get_breaker(ai_tender.BREAKER_NAME)
    if not breaker.allow():
        raise CircuitOpen(ai_tender.BREAKER_NAME, breaker.snapshot()["retry_in_s"])
    try:
        screening = ai_tender.screen(document)
    except Exception:
        breaker.record_failure()
        raise
    if _transport_failed(screening):
        breaker.record_failure()
    else:
        breaker.record_success()

    store(conn, tender_id, files_hash, screening)
    log.info(
        "ai screening",
        extra={"tender_id": tender_id, "files_hash": files_hash, **screening.log_fields()},
    )
    return screening


@REGISTRY.job(JOB_KIND)
def ai_screening(ctx: JobContext) -> None:
    """Handler. Idempotent: a second run reads the cached row (§7.2).

    Raises on a failed analysis so B1's backoff retries it — 2, 8 and 30 minutes
    later, four attempts, then `failed` with the reason stored on the job. The
    `ai_analyses` row is written first either way, so the failure is visible to
    the screen as well as to the queue.
    """
    screening = screen_tender(ctx.conn, ctx.payload, log=ctx.log)
    if screening.status == "failed":
        raise RuntimeError(f"ai_screening failed: {screening.error}")
