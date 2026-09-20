"""``extract_text`` — the tender's documents, downloaded, read and kept (§7.1).

This is the half of B4 that was never carded. B4 stores *what documents a tender
has*; §7.1 says the files are "download[ed] … only when someone requests
screening", and until this module existed nothing did. The consequence was
measurable: :func:`licitaqui.ai_screening.load_document` needs pages, a path or
a URL, the web enqueues a screening with nothing but a `tender_id`, and so every
"analisar" a user clicked failed four times and landed `failed`.

So the entry point here is :func:`ensure_documents`: *give me this tender's
active documents as one readable document, and the digest they are cached
under*. :mod:`licitaqui.ai_screening` calls it when its payload carries no
document of its own, and the ``extract_text`` job calls it to warm the cache
ahead of a user.

## Why the download lives inside the screening rather than beside it

Three shapes were possible: a prerequisite job that the web enqueues instead of
``ai_screening``; a chain where this job enqueues the screening when it
finishes; or a step inside the screening. It is the third, for four reasons.

* **The job the web already enqueues has to be the one that works.** A user
  clicking "analisar" produces exactly one row — `ai_screening` keyed
  `screening:<tender_id>` at priority 1 — and the fix for "that job fails" must
  be "that job succeeds", not "a different job exists now". Nothing in
  `apps/web` changes, and `readScreening`'s poll finds the `ai_analyses` row the
  moment it is written.
* **§3 is satisfied either way, and only in the worker.** The rule is that no
  *web request* waits on a slow call. A download that takes two minutes inside a
  priority-1 job is exactly where §3.1 step 4 puts it: `202`, "analisando", and
  the client polls every 3 s.
* **A chain would double the failure surface for one user action.** Two queue
  rows, two dedupe keys, two backoff budgets and a window in which the first
  succeeded and the second was never enqueued. One job is one thing to retry.
* **C1's cache rule stays exactly where it is.** A cached `ok` is never
  overwritten because :func:`licitaqui.ai_screening.cached` is consulted after
  the document is resolved and before anything is paid for. Resolving the
  document is now the first step of that same function rather than something
  that happened elsewhere, so there is no second place where the rule could be
  forgotten.

The ``extract_text`` job kind exists all the same — §7.1 names it — because
sampling and any future pre-warm want the extraction without the AI. Both paths
call :func:`ensure_documents`, so they cannot disagree.

## A scanned PDF still reaches `no_text` without an API call

Nothing here decides that, and that is the point. :func:`ensure_documents`
returns an :class:`~licitaqui.ai_tender.Document`;
:func:`licitaqui.ai_screening.screen_tender` checks ``document.has_text``
before the key is resolved and before the breaker is consulted, exactly as it
did when the pages arrived in the payload. This module routes *through* C1's
guard rather than around it. It also records a per-document verdict in
`tender_files.no_text` (§6.1) — see :func:`is_scan` for why that one is a
narrower test than the screening's, and what a future OCR card will select on.

A tender with **no** active documents comes back as a document with no pages,
which `has_text` reports as false, so it is stored as `no_text` — a permanent,
honest "there is nothing to read here" rather than four retries against a
tender that will never have an edital. The dangerous confusion — "no rows"
meaning *we have never looked* rather than *there are none* — is handled
explicitly: see :class:`DocumentsNotReady`.

## Not spending the day on a download that is not coming

§7.2 budgets 120 s for a download and the POCs measured one stuck at **929 s**.
An `httpx` timeout alone does not bound that: its read timeout applies to each
read, so a server dribbling a kilobyte every ten seconds never trips it and the
job runs until the consumer is declared dead. :func:`download` therefore streams
and enforces its own wall-clock deadline over the whole transfer, which is what
POC 1 does (`LIMITE_DOWNLOAD`, checked inside its read loop).

The consulta host was measured down for three hours twice in one week, so
downloads run under their own circuit breaker (``pncp-download``): two
consecutive failures stop the calls for fifteen minutes instead of every job
burning its whole budget. There is **no retry here** — the queue owns retries,
2, 8 and 30 minutes, four attempts (§7.2) — and a 4xx is recorded as a
*success* against the breaker before it raises, because a server that answers
"404" quickly is a healthy server and must not take the download path down for
every other tender.

## Partial reads are refused, and that is what keeps the cache key honest

`ai_analyses.files_hash` is B4's digest of the **file list**. Two screenings
under the same list must therefore have read the same documents, or the second
one would be served an analysis of a different set of pages under a key that
claims otherwise. So the set is all-or-nothing: if a selected document cannot be
fetched or parsed, :func:`ensure_documents` raises, nothing is written to
`ai_analyses`, and the queue retries. A tender whose edital is permanently
unreachable ends as a `failed` job with the reason on the row — which is the
truth — rather than as a confident analysis of its annexes.

## LGPD (§12)

Log lines carry the tender id, document numbers, byte counts, page counts,
digests, object keys and timings. Never the document text, never a credential,
never a bucket name.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import threading
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

import httpx
import psycopg

from . import ai_tender, files, queue, storage, sync_files
from .ai_tender import Document, Page
from .breaker import CircuitOpen, get_breaker
from .files import TenderFile
from .observability import get_logger
from .registry import REGISTRY, JobContext

_log = get_logger("documents")

JOB_KIND = "extract_text"

#: Downloads get their own breaker, separate from the JSON endpoints: the file
#: list can be perfectly healthy while the storage service behind the download
#: URLs is not, and one must not take the other down.
BREAKER_NAME = "pncp-download"

#: §7.2: download 120 s, connect 15 s. Enforced as a deadline over the whole
#: transfer, not only per read — see the module docstring and the 929 s case.
DOWNLOAD_TIMEOUT_SECONDS = 120.0
CONNECT_TIMEOUT_SECONDS = 15.0

#: A guard, not a budget. The largest edital in the knowledge base is a few MB;
#: anything past this is a scanned annexe nobody can read anyway, and holding it
#: in memory would take the consumer down with it.
MAX_DOCUMENT_BYTES = 64 * 1024 * 1024

#: §7.1 downloads "Edital and TR only". A tender with 39 documents must not turn
#: one screening into 39 downloads, and the cap is deterministic (the list is
#: ordered by document number) so it cannot make two screenings of the same list
#: read different sets.
MAX_DOCUMENTS = 8

#: What "Edital and Termo de Referência" matches, normalised
#: (:func:`licitaqui.ai_tender.norm`: lowercase, unaccented). POC 1's own
#: default set for `--baixar-arquivos`.
WANTED_TERMS = ("edital", "termo de referencia")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Language": "pt-BR,pt;q=0.9",
}


class DocumentError(RuntimeError):
    """A document that could not be fetched, or could not be read once it was."""


class DocumentsNotReady(RuntimeError):
    """The tender's file list has never been fetched, so "no documents" is unknown.

    This is the trap that separates *there is nothing to read* from *we have not
    looked yet*. Treating the second as the first would write a permanent
    `no_text` row — §3.2 keeps an AI result for ever, and C1 never overwrites a
    `no_text` — for a tender whose edital is sitting on PNCP unread.

    So when B4's sync marker is absent the screening does not answer: it
    enqueues ``sync_files`` at the waiting user's own priority and raises, and
    the queue brings it back 2 minutes later against a list that now exists.
    """


# ──────────────────────────────────────────────────────────────────────────
# Choosing what to read
# ──────────────────────────────────────────────────────────────────────────


def is_wanted(file: TenderFile) -> bool:
    """Whether this document is one §7.1 says to download.

    The `doc_type` is PNCP's own `tipoDocumentoNome` and is the reliable field;
    the `titulo` is a file name and is checked too, because agencies publish an
    edital typed "Outros" more often than the taxonomy suggests.
    """
    haystack = f"{ai_tender.norm(file.doc_type)} {ai_tender.norm(file.title)}"
    return any(term in haystack for term in WANTED_TERMS)


def wanted_files(listed: Iterable[TenderFile]) -> list[TenderFile]:
    """The documents one screening reads, in document-number order.

    Edital and Termo de Referência when the list names any; **every** active
    document otherwise, because a tender whose only file is typed "Anexo I" is
    still a tender somebody wants screened, and refusing to read it would be a
    worse failure than reading one file too many.

    Deterministic for a given list — which is what lets `ai_analyses.files_hash`
    keep digesting the list rather than the selection.
    """
    active = [f for f in files.active_files(listed) if f.url]
    chosen = [f for f in active if is_wanted(f)] or active
    return chosen[:MAX_DOCUMENTS]


# ──────────────────────────────────────────────────────────────────────────
# Fetching
# ──────────────────────────────────────────────────────────────────────────


class _Rate:
    """At most ``rate`` requests per second, shared across consumer threads.

    The same shape as :class:`licitaqui.pncp._Throttle`; kept here rather than
    imported because a download is not a JSON call and is given its own, slower
    pace without changing the sweeps'.
    """

    def __init__(self, rate: float) -> None:
        self._min_interval = 0.0 if rate <= 0 else 1.0 / rate
        self._lock = threading.Lock()
        self._next_at = 0.0

    def wait(self) -> None:
        if self._min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            sleep_for = self._next_at - now
            self._next_at = max(now, self._next_at) + self._min_interval
        if sleep_for > 0:
            time.sleep(sleep_for)


#: Two per second. Downloads are megabytes, not kilobytes, and nothing about a
#: screening needs them to arrive faster.
_rate_limiter = _Rate(2.0)


def build_client(timeout: float = DOWNLOAD_TIMEOUT_SECONDS) -> httpx.Client:
    """The HTTP client one run uses. A seam, exactly as in :mod:`licitaqui.sync_files`.

    One client per :func:`ensure_documents` call, so an edital and its Termo de
    Referência — the same host, back to back — reuse one connection.
    """
    return httpx.Client(
        follow_redirects=True,
        headers=HEADERS,
        timeout=httpx.Timeout(timeout, connect=CONNECT_TIMEOUT_SECONDS),
    )


def download(
    url: str,
    *,
    timeout: float = DOWNLOAD_TIMEOUT_SECONDS,
    max_bytes: int = MAX_DOCUMENT_BYTES,
    client: Any = None,
) -> bytes:
    """Fetch one document, under the breaker and under a wall-clock deadline.

    ``timeout`` bounds the **whole** transfer, not each read. That is the
    difference between this and a plain ``httpx.get``: PNCP's characteristic
    failure is not an error but a stall, and the POCs measured one download
    still running after 929 s while every individual read arrived inside the
    read timeout.

    Raises :class:`DocumentError` on anything that is not a complete 200. There
    is no retry here — the queue owns retries (§7.2).
    """
    breaker = get_breaker(BREAKER_NAME)
    if not breaker.allow():
        raise CircuitOpen(BREAKER_NAME, breaker.snapshot()["retry_in_s"])

    _rate_limiter.wait()
    started = time.monotonic()
    deadline = started + timeout
    owned = client is None
    http = client or build_client(timeout)
    try:
        with http.stream("GET", url) as response:
            if 400 <= response.status_code < 500:
                # The server answered, and quickly: it is healthy. A permanently
                # missing document must not open the circuit for every other
                # tender's download. Same rule as `pncp._get`.
                breaker.record_success()
                raise DocumentError(f"GET document -> HTTP {response.status_code}")
            if response.status_code != 200:
                breaker.record_failure()
                raise DocumentError(f"GET document -> HTTP {response.status_code}")
            buffer = bytearray()
            for chunk in response.iter_bytes():
                buffer += chunk
                if len(buffer) > max_bytes:
                    breaker.record_success()  # the server is fine; the file is too big
                    raise DocumentError(
                        f"document is larger than {max_bytes} bytes; refusing to read it"
                    )
                if time.monotonic() > deadline:
                    breaker.record_failure()
                    raise DocumentError(
                        f"download did not finish inside {timeout:.0f}s ({len(buffer)} bytes read)"
                    )
    except httpx.HTTPError as exc:
        breaker.record_failure()
        raise DocumentError(f"GET document -> {type(exc).__name__}: {exc}") from exc
    finally:
        if owned:
            http.close()

    breaker.record_success()
    _log.debug(
        "document downloaded",
        extra={"bytes": len(buffer), "duration_ms": int((time.monotonic() - started) * 1000)},
    )
    return bytes(buffer)


# ──────────────────────────────────────────────────────────────────────────
# One document: cache, download, extract, record
# ──────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class FileText:
    """One document of one tender, read. Pages are numbered from 1 within it."""

    sequence: int
    document: Document
    sha256: str
    #: Key of the stored bytes, or ``None`` when no bucket is configured.
    s3_key: str | None
    #: True for a scan: this document on its own carries no usable text layer.
    no_text: bool
    #: False when the text came back from the object store instead of the wire.
    downloaded: bool
    size: int = 0

    def log_fields(self) -> dict[str, Any]:
        return {
            "sequence": self.sequence,
            "pages": self.document.page_count,
            "characters": self.document.characters,
            "sha256": self.sha256,
            "no_text": self.no_text,
            "downloaded": self.downloaded,
            "bytes": self.size,
        }


def is_scan(document: Document) -> bool:
    """Whether one document carries no text layer — §6.1's `no_text`.

    Deliberately **not** :attr:`licitaqui.ai_tender.Document.has_text` negated.
    That property answers a different question: *is there enough here to screen
    a tender?*, and it keeps an absolute floor of 1,500 characters (§7.1) for
    it. A four-page Termo de Referência of 1,200 characters fails that floor and
    is plainly not a scan; recording it as one would hand a future OCR card a
    queue full of documents that are already readable.

    What identifies a scan is the per-page floor on its own: pdfplumber returns
    an empty string for a page that is nothing but an image, so a document
    averaging fewer than :data:`~licitaqui.ai_tender.MIN_CHARACTERS_PER_PAGE`
    characters a page has no text layer however long it is.

    The screening decision is untouched by this: it is made by C1 on the
    *combined* document, with the absolute floor intact.
    """
    if not document.pages:
        return True
    return document.characters < ai_tender.MIN_CHARACTERS_PER_PAGE * document.page_count


READ_STATE_SQL = """
select sha256, s3_key, pages, text_version, no_text
  from tender_files
 where tender_id = %(tender_id)s and sequence = %(sequence)s
"""

#: The extraction state, written onto the row it belongs to.
#:
#: The `url` predicate is what makes this safe beside a concurrent
#: ``sync_files``: if the document behind this number was replaced while we were
#: downloading, B4 has already cleared these columns and written the new
#: address, and this update must lose rather than staple our page count to
#: somebody else's file. A lost update costs one re-extraction; the alternative
#: costs an analysis of a document nobody is reading.
RECORD_SQL = """
update tender_files
   set sha256       = %(sha256)s,
       s3_key       = %(s3_key)s,
       pages        = %(pages)s,
       text_version = %(text_version)s,
       no_text      = %(no_text)s
 where tender_id = %(tender_id)s
   and sequence  = %(sequence)s
   and url is not distinct from %(url)s
"""


def _pack(document: Document) -> bytes:
    """The text object's bytes: the same JSON shape a `text_path` payload holds."""
    return gzip.compress(json.dumps(document.as_dict(), ensure_ascii=False).encode("utf-8"))


def _unpack(blob: bytes) -> Document:
    return Document.from_dict(json.loads(gzip.decompress(blob).decode("utf-8")))


def cached_text(
    conn: psycopg.Connection, store: storage.ObjectStore, file: TenderFile
) -> FileText | None:
    """This document's stored text, when there is one and it is still current.

    Current means: the row still carries a digest (``sync_files`` clears it the
    moment the document behind the number changes — §3.2's "invalidates text"),
    and it was extracted by *this* extraction version. A bump of
    :data:`licitaqui.ai_tender.EXTRACTION_VERSION` therefore re-reads every
    document, which is the whole reason that constant is part of the cache key.
    """
    row = conn.execute(
        READ_STATE_SQL, {"tender_id": file.tender_id, "sequence": file.sequence}
    ).fetchone()
    if row is None:
        return None
    sha256, s3_key, pages, text_version, no_text = row
    if not sha256 or text_version != ai_tender.EXTRACTION_VERSION:
        return None
    blob = store.get(storage.text_key(file.tender_id, file.sequence, sha256))
    if blob is None:
        return None
    document = _unpack(blob)
    if pages is not None and document.page_count != pages:
        # The row and the object disagree: trust neither and read the file again.
        _log.warning(
            "stored text does not match the recorded page count; re-extracting",
            extra={"tender_id": file.tender_id, "sequence": file.sequence},
        )
        return None
    return FileText(
        sequence=file.sequence,
        document=document,
        sha256=sha256,
        s3_key=s3_key,
        no_text=bool(no_text) if no_text is not None else is_scan(document),
        downloaded=False,
    )


def read_file(
    conn: psycopg.Connection,
    file: TenderFile,
    *,
    store: storage.ObjectStore,
    force: bool = False,
    client: Any = None,
) -> FileText:
    """One document, from the cache when possible and from PNCP otherwise.

    Writes `sha256`, `s3_key`, `pages`, `text_version` and `no_text` (§6.1) onto
    the row. Raises :class:`DocumentError` when the document cannot be read at
    all — the caller turns that into a retry rather than a partial analysis.
    """
    if not file.url:
        raise DocumentError(f"document {file.sequence} has no URL")

    if not force:
        hit = cached_text(conn, store, file)
        if hit is not None:
            return hit

    data = download(file.url, client=client)
    digest = hashlib.sha256(data).hexdigest()
    try:
        document = ai_tender.extract_text(data)
    except Exception as exc:  # noqa: BLE001 - a .doc or a corrupt PDF is a DocumentError
        raise DocumentError(f"document {file.sequence} could not be read: {exc}") from exc

    suffix = storage.suffix_for(data)
    source_key = store.put(
        storage.source_key(file.tender_id, file.sequence, digest, suffix=suffix),
        data,
        content_type=storage.content_type_for(suffix),
    )
    store.put(
        storage.text_key(file.tender_id, file.sequence, digest),
        _pack(document),
        content_type=storage.TEXT_CONTENT_TYPE,
    )

    result = FileText(
        sequence=file.sequence,
        document=document,
        sha256=digest,
        s3_key=source_key,
        no_text=is_scan(document),
        downloaded=True,
        size=len(data),
    )
    record(conn, file, result)
    return result


def record(conn: psycopg.Connection, file: TenderFile, text: FileText) -> bool:
    """Write the extraction state onto `tender_files`. False when the row moved."""
    with conn.cursor() as cur:
        cur.execute(
            RECORD_SQL,
            {
                "tender_id": file.tender_id,
                "sequence": file.sequence,
                "url": file.url,
                "sha256": text.sha256,
                "s3_key": text.s3_key,
                "pages": text.document.page_count,
                "text_version": text.document.extraction_version,
                "no_text": text.no_text,
            },
        )
        written = cur.rowcount
    if not written:
        _log.warning(
            "the document was replaced while it was being read; extraction state not stored",
            extra={"tender_id": file.tender_id, "sequence": file.sequence},
        )
    return bool(written)


# ──────────────────────────────────────────────────────────────────────────
# A whole tender
# ──────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class TenderDocuments:
    """Everything one screening needs: the pages, and the key they cache under."""

    tender_id: str
    #: Every selected document, concatenated and renumbered from 1 so a citation
    #: to "page 62" means the same thing whether the edital came as one PDF, a
    #: ZIP or an edital plus a Termo de Referência.
    document: Document
    #: B4's digest of the **active file list**, computed from the same snapshot
    #: the documents were chosen from.
    files_hash: str
    parts: tuple[FileText, ...] = ()
    #: How many documents PNCP actually served this run (0 = all cached).
    downloaded: int = 0
    #: Active documents the selection left out, for the log line.
    skipped: int = 0
    seconds: float = 0.0

    def log_fields(self) -> dict[str, Any]:
        return {
            "tender_id": self.tender_id,
            "documents": len(self.parts),
            "downloaded": self.downloaded,
            "skipped": self.skipped,
            "pages": self.document.page_count,
            "characters": self.document.characters,
            "has_text": self.document.has_text,
            "files_hash": self.files_hash,
            "seconds": round(self.seconds, 1),
            "sequences": [p.sequence for p in self.parts],
        }


def _combine(parts: Sequence[FileText]) -> Document:
    """One document out of several, numbered continuously in document order."""
    pages: list[Page] = []
    for part in parts:
        offset = len(pages)
        for page in part.document.pages:
            pages.append(Page(offset + page.number, page.text))
    return Document(pages=tuple(pages))


def ensure_documents(
    conn: psycopg.Connection,
    tender_id: str,
    *,
    force: bool = False,
    store: storage.ObjectStore | None = None,
    client: Any = None,
    log: Any = _log,
) -> TenderDocuments:
    """This tender's readable documents, and the digest they are cached under.

    The file list is read **once** and both the selection and the hash come from
    that snapshot, so a ``sync_files`` landing mid-screening can never produce a
    document set and a `files_hash` that describe different lists.

    Raises :class:`DocumentsNotReady` when PNCP has never been asked what
    documents this tender has, and :class:`DocumentError` when a selected
    document cannot be read.
    """
    started = time.monotonic()
    state = sync_files.read_state(conn, tender_id)
    if not state.exists:
        raise ValueError(f"unknown tender '{tender_id}'")

    listed = files.read_files(conn, tender_id)
    digest = files.files_hash(listed)
    chosen = wanted_files(listed)

    if not chosen:
        if state.synced_at is None:
            # Never fetched. "No documents" is not a fact yet, and writing a
            # permanent `no_text` from it would be unrecoverable (§3.2 keeps an
            # AI result for ever). Fetch the list at priority 1 — a user is on
            # screen waiting for the screening behind it (§7.3) — and let the
            # queue bring this job back.
            queue.enqueue(
                conn,
                "sync_files",
                tender_id,
                priority=1,
                payload={"tender_id": tender_id},
            )
            raise DocumentsNotReady(
                f"the file list for '{tender_id}' has never been fetched; sync_files enqueued"
            )
        log.info(
            "extract_text: the tender has no readable documents",
            extra={"tender_id": tender_id, "files_hash": digest},
        )
        return TenderDocuments(tender_id=tender_id, document=Document(pages=()), files_hash=digest)

    store = store or storage.get_store()
    owned = client is None
    http = client or build_client()
    try:
        parts = tuple(
            read_file(conn, file, store=store, force=force, client=http) for file in chosen
        )
    finally:
        if owned:
            http.close()
    result = TenderDocuments(
        tender_id=tender_id,
        document=_combine(parts),
        files_hash=digest,
        parts=parts,
        downloaded=sum(1 for p in parts if p.downloaded),
        skipped=len(files.active_files(listed)) - len(chosen),
        seconds=time.monotonic() - started,
    )
    log.info("extract_text finished", extra=result.log_fields())
    return result


# ──────────────────────────────────────────────────────────────────────────
# The job
# ──────────────────────────────────────────────────────────────────────────


def job_key(tender_id: str) -> str:
    """One live extraction per tender."""
    return tender_id


def enqueue(
    conn: psycopg.Connection,
    tender_id: str,
    *,
    priority: int = 9,
    payload: dict[str, Any] | None = None,
) -> int | None:
    """Queue an extraction. Priority 9 by default: this is the sampling path
    (§7.3). A user waiting does not go through here — their screening resolves
    its own documents, which is the point of :func:`ensure_documents`.
    """
    body: dict[str, Any] = {"tender_id": tender_id, **(payload or {})}
    return queue.enqueue(conn, JOB_KIND, job_key(tender_id), priority=priority, payload=body)


@REGISTRY.job(JOB_KIND)
def extract_text(ctx: JobContext) -> None:
    """Warm one tender's extracted text (§7.1).

    Idempotent (§7.2): a second run finds the digests and the stored text and
    downloads nothing. ``force`` re-reads the files anyway, for an operator who
    suspects the stored text.
    """
    payload = ctx.payload
    tender_id = str(payload.get("tender_id") or ctx.job.key)
    ensure_documents(ctx.conn, tender_id, force=bool(payload.get("force")), log=ctx.log)


#: Named here as well, so a reader who arrives at the download from the job side
#: finds the retention rule without having to know :mod:`licitaqui.storage`.
retention = storage.describe_retention
