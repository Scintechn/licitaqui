"""Mapping a PNCP document onto a `tender_files` row — and the hash that
retires everything derived from the old set.

§3.2 gives the file list a 12 h TTL and then says the thing this module exists
for: *"an amendment adds a new file: invalidates text and screening"*. A
Brazilian tender is amended often, and a replaced edital can reverse every
conclusion the AI drew from the previous one. A company bidding against a
superseded edital is the failure this code has to make impossible.

## The manifest hash is the invalidation

`ai_analyses` is unique on `(tender_id, mode, prompt_version,
extraction_version, files_hash)` and :mod:`licitaqui.ai_screening` looks a
cached answer up by exactly that key. So invalidation is not a delete: it is a
**different key**. :func:`files_hash` digests the tender's active file list, so
the moment PNCP publishes an amendment the hash moves, the lookup for the new
hash misses, and the analysis of the old set stops being served as current
while staying on the row — still true of the documents it actually read, and
still the cost record for what was paid.

That is why nothing here writes to `ai_analyses`. See the module docstring of
:mod:`licitaqui.sync_files` for the alternatives that were rejected.

## What goes into the digest, and why each field is in it

The manifest is one line per **active** document, ordered by
`sequencialDocumento`::

    <sequence>\\t<doc_type>\\t<title>\\t<url>\\t<published_at as UTC ISO-8601>

* `sequence` and `url` catch an added or withdrawn document — the ordinary
  amendment.
* `published_at` and `title` catch a **replaced** one, which `url` alone cannot:
  PNCP's download URL is `…/arquivos/{sequencialDocumento}`, so re-publishing
  "Edital" under the same document number serves new bytes from the same
  address. `dataPublicacaoPncp` is what moves; the `titulo` (a file name, e.g.
  `editais/Edital_Retificado.pdf`) usually moves with it.
* a document going **inactive** drops out of the set, which changes the digest
  too. That is right: a revoked edital must not keep an analysis alive.

The digest is over the list *as recorded*, not over the file bytes, because B4
is list-only by its card. Every amendment PNCP actually publishes moves one of
those fields. The gap is an agency silently swapping bytes at the same URL
without touching `dataPublicacaoPncp`; :data:`MANIFEST_VERSION` is there so the
card that downloads the files can fold `tender_files.sha256` into the same
recipe and expire every hash computed without it, in one line.

## Two traps this module is built around

**PNCP sends naive Brasília wall-clock time.** `dataPublicacaoPncp` lands in a
`timestamptz`, and Postgres would resolve a naive value in the session's
timezone (UTC for the worker), storing every publication three hours early.
:func:`licitaqui.tenders.parse_timestamp` attaches the offset at the edge, and
the manifest normalises to UTC before formatting — otherwise the hash computed
from a freshly parsed record (`-03:00`) and the hash computed from the same row
read back from Postgres (`+00:00`) would differ, and *every* sync would look
like an amendment.

**Extracted text belongs to bytes, not to a tender.** `tender_files` carries
the per-file extraction state (`sha256`, `s3_key`, `pages`, `text_version`,
`no_text`). When a document's identity changes under a document number those
columns describe a file that no longer exists, so :func:`upsert_files` clears
them. That is the "invalidates text" half of §3.2, and it is done in the same
statement as the write so no concurrent reader can see the new URL beside the
old page count.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .tenders import parse_timestamp

#: Bump when the recipe in :func:`manifest` changes — a different recipe must
#: produce a different hash, or a stale `ai_analyses` row would be served under
#: a key that no longer means what it meant. Folding in the file bytes (the
#: download card) is exactly such a change.
MANIFEST_VERSION = 1

#: Prefix of the digest input, so two recipes can never collide.
MANIFEST_HEADER = f"licitaqui/tender_files/{MANIFEST_VERSION}"

#: The digest of a tender with no active documents. Precomputed so a caller can
#: recognise "nothing to read" without comparing to a magic string.
EMPTY_MANIFEST_DIGEST = hashlib.sha256(f"{MANIFEST_HEADER}\n".encode()).hexdigest()


@dataclass(frozen=True, slots=True)
class TenderFile:
    """One `tender_files` row as PNCP lists it, before anything is downloaded.

    Only the columns §6.1 calls the *list*: `sha256`, `s3_key`, `pages`,
    `text_version` and `no_text` are the download card's and are never written
    from here — only cleared, by :func:`upsert_files`, when they stop applying.
    """

    tender_id: str
    sequence: int
    title: str | None = None
    doc_type: str | None = None
    url: str | None = None
    active: bool = True
    published_at: datetime | None = None

    @property
    def identity(self) -> tuple[Any, ...]:
        """What makes this *the same document*, for the text already extracted.

        `active` is deliberately absent: a document being withdrawn does not
        change its bytes, so the text stays valid for as long as the row does.
        What it does change is the manifest, which is where withdrawal has to
        bite.

        Mirrored by :data:`_SAME_DOCUMENT` in SQL, and
        ``test_integration_sync_files`` changes each of these fields in turn to
        prove the two agree.
        """
        return (self.title, self.doc_type, self.url, self.published_at)


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def from_pncp(tender_id: str, record: dict[str, Any]) -> TenderFile:
    """Map one ``/api/pncp/v1/.../arquivos`` record.

    ``sequencialDocumento`` is half the primary key, so a record without one
    cannot be stored idempotently and is rejected rather than renumbered — a
    made-up number would collide with a real document on the next sync, and the
    collision would silently retire the wrong file's extracted text.

    ``statusAtivo`` absent means active, which is POC 1's reading
    (``a.get("statusAtivo", True)``) and the safe one: presuming a listed
    document is dead would drop the edital out of the manifest.
    """
    sequence = _int(record.get("sequencialDocumento"))
    if sequence is None:
        raise ValueError("tender file has no sequencialDocumento")
    return TenderFile(
        tender_id=tender_id,
        sequence=sequence,
        title=_text(record.get("titulo")),
        # `tipoDocumentoNome` and `tipoDocumentoDescricao` were identical in all
        # 371 cached documents in the knowledge base; the name is §6.1's column
        # ("Edital, Termo de Referência, ETP…"). `tipoDocumentoId` is a code,
        # not a flag — it is kept out of the row rather than misread the way
        # `orcamentoSigilosoCodigo` was.
        doc_type=(
            _text(record.get("tipoDocumentoNome")) or _text(record.get("tipoDocumentoDescricao"))
        ),
        # POC 1 falls back to `uri`; both were present and equal in the cache,
        # but a row with no address is a document nobody can ever read.
        url=_text(record.get("url")) or _text(record.get("uri")),
        active=bool(record.get("statusAtivo", True)),
        # Naive Brasília wall clock. See the module docstring.
        published_at=parse_timestamp(record.get("dataPublicacaoPncp")),
    )


def map_all(tender_id: str, records: Iterable[dict[str, Any]]) -> list[TenderFile]:
    """Map a whole file list, skipping records that cannot be keyed.

    One unmappable document must not cost the whole list: the edital is usually
    document 1, and losing it because document 7 is malformed would leave the
    tender unreadable. Duplicates are dropped for the same reason
    :func:`licitaqui.items.classify_all` drops them — PNCP has been seen
    repeating a record under load, and the count in the log should not lie.
    """
    files: list[TenderFile] = []
    seen: set[int] = set()
    for record in records:
        try:
            mapped = from_pncp(tender_id, record)
        except ValueError:
            continue
        if mapped.sequence in seen:
            continue
        seen.add(mapped.sequence)
        files.append(mapped)
    return sorted(files, key=lambda f: f.sequence)


# -- the hash --------------------------------------------------------------


def _stamp(value: datetime | None) -> str:
    """A publication timestamp as one canonical string, or empty.

    Normalised to UTC first. A `TenderFile` mapped from PNCP carries a
    ``-03:00`` offset and the same row read back from Postgres carries
    ``+00:00``; the two are the same instant and must digest identically, or
    the hash would change on every round trip and every sync would be read as
    an amendment.
    """
    if value is None:
        return ""
    if value.tzinfo is None:  # pragma: no cover - parse_timestamp always attaches one
        raise ValueError("published_at must be timezone-aware before it is hashed")
    return value.astimezone(UTC).isoformat()


def active_files(files: Iterable[TenderFile]) -> list[TenderFile]:
    """The documents that count: active, ordered by document number."""
    return sorted((f for f in files if f.active), key=lambda f: f.sequence)


def manifest(files: Iterable[TenderFile]) -> str:
    """The exact text :func:`files_hash` digests. Readable on purpose.

    When a screening is unexpectedly re-run, the question is always *what
    changed?* — and a diff of two manifests answers it, where a diff of two
    digests does not.
    """
    lines = [
        "\t".join(
            (
                str(f.sequence),
                f.doc_type or "",
                f.title or "",
                f.url or "",
                _stamp(f.published_at),
            )
        )
        for f in active_files(files)
    ]
    return "\n".join([MANIFEST_HEADER, *lines]) + "\n"


def files_hash(files: Iterable[TenderFile]) -> str:
    """The `ai_analyses.files_hash` for this file list (§6.3).

    This is the value :mod:`licitaqui.ai_screening` keys its cache on. That job
    resolves it for itself with :func:`files_hash_for` when it runs, rather than
    being handed it in a payload the queue can outlive — see
    :func:`licitaqui.ai_screening.resolve_files_hash`.
    """
    return hashlib.sha256(manifest(files).encode("utf-8")).hexdigest()


# -- persistence -----------------------------------------------------------


READ_SQL = """
select tender_id, sequence, title, doc_type, url, active, published_at
  from tender_files
 where tender_id = %s
 order by sequence
"""

#: Same document under the same number? `is not distinct from` rather than `=`
#: so a NULL on either side compares as a value: a title that appears, or a URL
#: that disappears, is a change, not an unknown.
#:
#: Mirrors :attr:`TenderFile.identity`. Keep the two in step.
_SAME_DOCUMENT = """(
      tender_files.title        is not distinct from excluded.title
  and tender_files.doc_type     is not distinct from excluded.doc_type
  and tender_files.url          is not distinct from excluded.url
  and tender_files.published_at is not distinct from excluded.published_at
)"""

#: The write and the text invalidation, in one statement.
#:
#: The `case` arms are the "invalidates text" half of §3.2: when the document
#: behind a number is no longer the one we extracted, everything derived from
#: those bytes is cleared in the same row write, so no reader can ever see the
#: new URL next to the old page count. Doing it as a second `update` would open
#: exactly that window.
UPSERT_SQL = f"""
insert into tender_files (
    tender_id, sequence, title, doc_type, url, active, published_at
) values (
    %(tender_id)s, %(sequence)s, %(title)s, %(doc_type)s, %(url)s, %(active)s, %(published_at)s
)
on conflict (tender_id, sequence) do update set
    title        = excluded.title,
    doc_type     = excluded.doc_type,
    url          = excluded.url,
    active       = excluded.active,
    published_at = excluded.published_at,
    sha256       = case when {_SAME_DOCUMENT} then tender_files.sha256       else null end,
    s3_key       = case when {_SAME_DOCUMENT} then tender_files.s3_key       else null end,
    pages        = case when {_SAME_DOCUMENT} then tender_files.pages        else null end,
    text_version = case when {_SAME_DOCUMENT} then tender_files.text_version else null end,
    no_text      = case when {_SAME_DOCUMENT} then tender_files.no_text      else null end
"""

#: An amendment can withdraw a document. Anything under this tender PNCP no
#: longer lists is deleted — but only within one tender, and only after a
#: *complete* fetch: :mod:`licitaqui.sync_files` lets a failed call raise
#: rather than prune, because a 500 is an outage, not an empty list.
PRUNE_SQL = """
delete from tender_files
 where tender_id = %(tender_id)s
   and not (sequence = any(%(sequences)s))
"""


@dataclass(frozen=True, slots=True)
class FileSync:
    """What one sync did to the list, for the log line and for the caller."""

    #: Digest of the active set before the write.
    previous_hash: str
    #: Digest of the active set after it. Differs ⇒ screening is invalidated.
    files_hash: str
    added: int = 0
    #: Documents whose identity moved under the same number: a replaced edital.
    #: Their extracted text was cleared.
    replaced: int = 0
    removed: int = 0
    unchanged: int = 0
    stored: int = 0

    @property
    def changed(self) -> bool:
        """Whether anything derived from the old list has to be redone."""
        return self.files_hash != self.previous_hash

    def log_fields(self) -> dict[str, Any]:
        return {
            "files": self.stored,
            "added": self.added,
            "replaced": self.replaced,
            "removed": self.removed,
            "unchanged": self.unchanged,
            "files_hash": self.files_hash,
            "previous_files_hash": self.previous_hash,
            "invalidated": self.changed,
        }


def _params(file: TenderFile) -> dict[str, Any]:
    return {
        "tender_id": file.tender_id,
        "sequence": file.sequence,
        "title": file.title,
        "doc_type": file.doc_type,
        "url": file.url,
        "active": file.active,
        "published_at": file.published_at,
    }


def read_files(conn: psycopg.Connection, tender_id: str) -> list[TenderFile]:
    """This tender's file list as stored, ordered by document number."""
    rows = conn.execute(READ_SQL, (tender_id,)).fetchall()
    return [
        TenderFile(
            tender_id=row[0],
            sequence=row[1],
            title=row[2],
            doc_type=row[3],
            url=row[4],
            active=True if row[5] is None else bool(row[5]),
            published_at=row[6],
        )
        for row in rows
    ]


def files_hash_for(conn: psycopg.Connection, tender_id: str) -> str:
    """The `files_hash` to screen this tender under, from the stored list.

    This is the entry point for everything downstream:
    :func:`licitaqui.ai_screening.resolve_files_hash` calls it at the top of
    every screening, and a tender whose hash has moved since its last analysis
    has no current one. It is derived rather than stored on purpose — a cached
    digest can disagree with the rows it summarises, and then the product serves
    an analysis of documents nobody is reading. A digest in a job payload is a
    cached digest with a queue delay attached, which is why the job asks here
    instead.
    """
    return files_hash(read_files(conn, tender_id))


def upsert_files(
    conn: psycopg.Connection,
    tender_id: str,
    files: Sequence[TenderFile],
    *,
    prune: bool = True,
) -> FileSync:
    """Write this tender's file list and report what it invalidated.

    Idempotent (§7.2): the primary key is `(tender_id, sequence)`, so running
    the job twice rewrites the same rows and the returned
    :attr:`FileSync.changed` is then false. ``prune=False`` is for a partial
    fetch — deleting on incomplete data would drop live documents.
    """
    before = {f.sequence: f for f in read_files(conn, tender_id)}
    previous_hash = files_hash(before.values())

    if files:
        with conn.cursor() as cur:
            cur.executemany(UPSERT_SQL, [_params(f) for f in files])
    removed = 0
    if prune:
        kept = [f.sequence for f in files]
        with conn.cursor() as cur:
            cur.execute(PRUNE_SQL, {"tender_id": tender_id, "sequences": kept})
            removed = cur.rowcount

    added = sum(1 for f in files if f.sequence not in before)
    replaced = sum(
        1 for f in files if f.sequence in before and before[f.sequence].identity != f.identity
    )
    return FileSync(
        previous_hash=previous_hash,
        # Read back rather than digest the list in hand, even though a complete
        # sync makes them equal: this is the value `ai_screening` will be keyed
        # on, and it must be the one :func:`files_hash_for` returns to the next
        # caller — including after a `prune=False` partial write.
        files_hash=files_hash_for(conn, tender_id),
        added=added,
        replaced=replaced,
        removed=removed,
        unchanged=len(files) - added - replaced,
        stored=len(files),
    )


# -- the 12 h TTL marker ---------------------------------------------------
#
# §3.2 gives the file list a 12 h TTL, which needs a "when did we last look?"
# per tender — and `tender_files` (§6.1) has no timestamp column at all. A
# migration is its own PR (CLAUDE.md), so this follows the precedent B2 set for
# its watermark and keeps the marker in `events`: the table exists, the worker's
# `app` role can write it, and it is the project's established answer to "a
# small piece of collector state with no column of its own".
#
# The tender id goes in `name` rather than in `props` so the lookup is an exact
# hit on `events_name_created_idx (name, created_at)`. With the id in `props`
# the only indexed predicate would be the shared name, and reading one tender's
# marker would scan every tender's. The marker is rewritten rather than
# appended, so this is one row per tender and not one per sync.

SYNC_EVENT_PREFIX = "sync_files:"


def sync_event_name(tender_id: str) -> str:
    return f"{SYNC_EVENT_PREFIX}{tender_id}"


DELETE_MARKER_SQL = "delete from events where name = %s"
INSERT_MARKER_SQL = "insert into events (name, props) values (%s, %s)"


def mark_synced(conn: psycopg.Connection, tender_id: str, result: FileSync) -> None:
    """Record that PNCP was read for this tender just now, and what changed.

    Rewritten rather than appended: it is a marker, not a metric, and one row
    per tender keeps `events` from growing by a row per tender per 12 hours.
    Nothing here is personal data (§12) — a tender id, counts and two digests.

    The two statements are not one transaction, and they do not need to be: the
    only way to lose between them is to lose the marker, and a missing marker
    reads as `never`, which costs one extra fetch. The reverse — a marker for a
    sync that did not happen — is not reachable.
    """
    name = sync_event_name(tender_id)
    conn.execute(DELETE_MARKER_SQL, (name,))
    conn.execute(INSERT_MARKER_SQL, (name, Jsonb({"tender_id": tender_id, **result.log_fields()})))
