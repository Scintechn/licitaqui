"""Where a downloaded edital and its extracted text are kept (§3.2).

§3.2's row for *PDF and extracted text* is the whole contract this module
serves:

    | PDF and extracted text | PNCP download | until the file list changes |
    | delete PDF 90 days after closing; keep text | S3; text also in the DB |

Three consequences shape everything below.

**The PDF is deletable and the text is not.** They are two separate objects,
never one, because they have different lifetimes: a `cleanup` sweep will delete
the PDF of every tender closed more than 90 days ago and must leave the text
alone. Bundling them would make that sweep impossible without rewriting the
object.

**Both keys are pure functions of `(tender_id, sequence, sha256)`.** That is
what makes the deletion safe. The sweep nulls `tender_files.s3_key` when it
deletes the PDF; if the *text* key were derived from `s3_key` it would become
unreachable at exactly that moment. `sha256` is never cleared by the sweep, so
:func:`text_key` keeps answering for ever. See :func:`describe_retention`.

**Nothing here is required for the worker to run.** With no bucket configured —
a laptop, CI, a fresh clone — :func:`get_store` returns a :class:`NullStore`
that reports every key as absent and stores nothing. The job above it then
re-extracts on each run instead of failing, which is slower and always correct.
That is also why no test in this repository needs an AWS credential.

## LGPD and secrets (§12)

The bucket name, the region and the two keys are resolved the way
``db/migrate.py`` resolves its connection string — environment first, then the
gitignored env files — and are **never** logged, echoed, put in an exception
message or returned to a caller. Only object keys, byte counts and digests
reach a log line, and none of those is personal data.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Any, Protocol

from . import config
from .observability import get_logger

_log = get_logger("storage")

#: Resolved like every other secret (see :func:`licitaqui.config.resolve_secret`).
BUCKET_VAR = "S3_BUCKET"
REGION_VARS = ("AWS_REGION", "AWS_DEFAULT_REGION")
ACCESS_KEY_VAR = "AWS_ACCESS_KEY_ID"
SECRET_KEY_VAR = "AWS_SECRET_ACCESS_KEY"
#: Optional: a non-AWS S3-compatible endpoint (MinIO in a future dev compose).
ENDPOINT_VAR = "S3_ENDPOINT_URL"

#: Everything this project writes lives under one prefix, so a lifecycle rule or
#: a bucket policy can address it without touching anything else in the bucket.
ROOT_PREFIX = "tenders"

PDF_CONTENT_TYPE = "application/pdf"
ZIP_CONTENT_TYPE = "application/zip"
TEXT_CONTENT_TYPE = "application/gzip"

#: `numeroControlePNCP` contains `/` and `-` (`51885242000140-1-000744/2026`).
#: A raw `/` would turn one document into three key segments and make the
#: prefixes unreadable, so it is folded into `_` along with anything else that
#: is not plainly safe in a key.
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def key_segment(value: str) -> str:
    """One S3 key segment: readable, and containing no separator of its own."""
    return _UNSAFE.sub("_", str(value)).strip("_") or "unknown"


def document_prefix(tender_id: str, sequence: int) -> str:
    """Everything belonging to one document of one tender."""
    return f"{ROOT_PREFIX}/{key_segment(tender_id)}/files/{int(sequence):04d}"


def source_key(tender_id: str, sequence: int, sha256: str, *, suffix: str = ".pdf") -> str:
    """Key of the downloaded bytes. Deleted 90 days after the tender closes."""
    return f"{document_prefix(tender_id, sequence)}/{sha256}{suffix}"


def text_key(tender_id: str, sequence: int, sha256: str) -> str:
    """Key of the extracted text. Kept for ever (§3.2), so never derived from
    :func:`source_key` — the sweep nulls `s3_key`, and the text must survive it.
    """
    return f"{document_prefix(tender_id, sequence)}/{sha256}.text.json.gz"


def suffix_for(data: bytes) -> str:
    """`.pdf` or `.zip`, from the magic bytes. Many editais are published zipped."""
    if data.startswith(b"PK"):
        return ".zip"
    return ".pdf"


def content_type_for(suffix: str) -> str:
    return ZIP_CONTENT_TYPE if suffix == ".zip" else PDF_CONTENT_TYPE


class ObjectStore(Protocol):
    """The three operations this project needs. Deliberately not more."""

    @property
    def configured(self) -> bool:  # pragma: no cover - trivial
        ...

    def put(self, key: str, data: bytes, *, content_type: str) -> str | None: ...

    def get(self, key: str) -> bytes | None: ...

    def delete(self, key: str) -> bool: ...


@dataclass(frozen=True, slots=True)
class NullStore:
    """No bucket configured: remember nothing, claim nothing.

    Every read misses and every write reports "not stored" (``None``), which is
    exactly what :mod:`licitaqui.documents` needs to decide it must extract the
    document again. A worker with no bucket is slower and never wrong.
    """

    @property
    def configured(self) -> bool:
        return False

    def put(self, key: str, data: bytes, *, content_type: str) -> str | None:
        return None

    def get(self, key: str) -> bytes | None:
        return None

    def delete(self, key: str) -> bool:
        return False


class S3Store:
    """S3, with the credentials resolved by :mod:`licitaqui.config`.

    boto3 would find credentials in the process environment by itself, but the
    project keeps its secrets in gitignored env files that are *not* exported,
    so they are resolved explicitly and handed to the session. They are held on
    the client and never on this object, never logged, and never put in an
    exception message.

    ``boto3`` is imported inside :meth:`_client` for the reason ``pdfplumber``
    is imported inside ``ai_tender.extract_text``: importing the package must
    stay cheap for the tooling that only wants :mod:`licitaqui.config`.
    """

    def __init__(
        self,
        bucket: str,
        *,
        region: str | None = None,
        access_key: str | None = None,
        secret_key: str | None = None,
        endpoint_url: str | None = None,
        client: Any = None,
    ) -> None:
        self.bucket = bucket
        self._region = region
        self._access_key = access_key
        self._secret_key = secret_key
        self._endpoint_url = endpoint_url
        self._explicit_client = client
        self._cached_client: Any = None
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return True

    def _client(self) -> Any:
        if self._explicit_client is not None:
            return self._explicit_client
        with self._lock:
            if self._cached_client is None:
                import boto3  # imported here: the web and the db tooling never need it

                self._cached_client = boto3.client(
                    "s3",
                    region_name=self._region,
                    aws_access_key_id=self._access_key,
                    aws_secret_access_key=self._secret_key,
                    endpoint_url=self._endpoint_url,
                )
            return self._cached_client

    def put(self, key: str, data: bytes, *, content_type: str) -> str | None:
        self._client().put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)
        _log.debug("stored", extra={"s3_key": key, "bytes": len(data)})
        return key

    def get(self, key: str) -> bytes | None:
        """The object, or ``None`` when it is not there.

        A missing object is an ordinary outcome, not an error: the PDF of a
        tender closed over 90 days ago is *supposed* to be gone, and a text
        object can be absent because nothing has extracted it yet.
        """
        try:
            response = self._client().get_object(Bucket=self.bucket, Key=key)
        except Exception as exc:  # noqa: BLE001 - botocore's error type is not importable here
            if _is_missing(exc):
                return None
            raise
        body = response["Body"]
        try:
            return bytes(body.read())
        finally:
            close = getattr(body, "close", None)
            if close is not None:
                close()

    def delete(self, key: str) -> bool:
        """Remove one object. Deleting an absent key is a success, not an error.

        That is what makes the 90-day sweep re-runnable: it may crash between
        the delete and the `update`, and the next run must not fail on the key
        it already removed.
        """
        self._client().delete_object(Bucket=self.bucket, Key=key)
        return True


def _is_missing(exc: BaseException) -> bool:
    """Whether a botocore error means "no such key" rather than a real failure.

    Matched on the error code carried in ``response`` instead of on the
    exception class, so this module never has to import botocore — which is a
    transitive dependency of boto3 and not one this project declares.
    """
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return False
    error = response.get("Error")
    code = error.get("Code") if isinstance(error, dict) else None
    # `NoSuchBucket` is deliberately not here: a bucket that does not exist is a
    # misconfiguration and must be loud, not read as an empty cache.
    return code in {"NoSuchKey", "NotFound", "404"}


_store: ObjectStore | None = None
_store_lock = threading.Lock()


def build_store() -> ObjectStore:
    """An :class:`S3Store` when a bucket is configured, a :class:`NullStore` otherwise.

    Nothing resolved here is logged. The one line this does emit says *whether*
    storage is on and, when it is, nothing but that — not the bucket, not the
    region, and certainly not a key.
    """
    bucket = config.resolve_secret(BUCKET_VAR)
    if not bucket:
        _log.info("object storage is not configured: documents will be re-extracted on demand")
        return NullStore()
    return S3Store(
        bucket,
        region=config.resolve_secret(*REGION_VARS),
        access_key=config.resolve_secret(ACCESS_KEY_VAR),
        secret_key=config.resolve_secret(SECRET_KEY_VAR),
        endpoint_url=config.resolve_secret(ENDPOINT_VAR),
    )


def get_store() -> ObjectStore:
    """The process-wide store, built once. Tests pass their own instead."""
    global _store
    with _store_lock:
        if _store is None:
            _store = build_store()
        return _store


def reset_store() -> None:
    """Drop the cached store. For tests, and for a process that rotated a key."""
    global _store
    with _store_lock:
        _store = None


def describe_retention() -> dict[str, str]:
    """What the `cleanup` sweep (§7.1) has to do, in one readable place.

    The sweep itself is its own card. This is the contract it inherits, written
    down beside the code that creates the objects so the two cannot drift:

    1. Find every `tender_files` row with an `s3_key` whose tender closed more
       than 90 days ago (`tenders.proposals_close_at < now() - interval
       '90 days'`).
    2. :meth:`ObjectStore.delete` that key, then `update tender_files set
       s3_key = null` for the row — in that order. A crash between the two
       leaves a key naming an object that is already gone, and the next run
       deletes it again harmlessly, which is why :meth:`delete` treats an absent
       key as success.
    3. Touch **nothing else**. `sha256`, `pages`, `text_version` and `no_text`
       stay, and so does the text object: §3.2 keeps the text for ever, and
       :func:`text_key` is computed from `sha256`, which the sweep never clears.
       A screening of a tender closed two years ago therefore still explains
       itself, and re-screening it still costs nothing.
    """
    return {
        "source": "deleted 90 days after the tender closes; `s3_key` nulled in the same sweep",
        "text": "kept for ever; addressed by (tender_id, sequence, sha256), never by `s3_key`",
        "order": "delete the object, then null the column; re-running the sweep is a no-op",
    }
