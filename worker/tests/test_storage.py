"""Object keys, and the two properties the 90-day deletion depends on.

No network and no AWS credential: `S3Store` is exercised against a fake client
that records the calls, and the rest is pure key arithmetic.
"""

from __future__ import annotations

import pytest

from licitaqui import storage

TENDER = "51885242000140-1-000744/2026"


class FakeS3:
    """The three botocore calls this project makes, and nothing else."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.deleted: list[str] = []

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> dict:  # noqa: N803 - botocore's own casing
        self.bucket = Bucket
        self.objects[Key] = (Body, ContentType)
        return {}

    def get_object(self, *, Bucket: str, Key: str) -> dict:  # noqa: N803
        if Key not in self.objects:
            raise _Missing()
        import io

        return {"Body": io.BytesIO(self.objects[Key][0])}

    def delete_object(self, *, Bucket: str, Key: str) -> dict:  # noqa: N803
        self.deleted.append(Key)
        self.objects.pop(Key, None)
        return {}


class _Missing(Exception):
    """Shaped like botocore's ClientError for a key that is not there."""

    response = {"Error": {"Code": "NoSuchKey"}}


# -- keys ------------------------------------------------------------------


def test_a_tender_id_becomes_one_readable_key_segment():
    """`numeroControlePNCP` carries a slash; a raw one would split the prefix."""
    key = storage.source_key(TENDER, 1, "a" * 64)
    assert key.startswith("tenders/51885242000140-1-000744_2026/files/0001/")
    assert key.count("/") == 4


def test_the_text_key_does_not_depend_on_the_pdf_key():
    """The sweep nulls `s3_key`; the text has to stay addressable without it.

    This is the property the whole retention design rests on, so it is asserted
    rather than left to the docstring: both keys are pure functions of
    `(tender_id, sequence, sha256)`, and `sha256` is never cleared.
    """
    digest = "b" * 64
    assert storage.text_key(TENDER, 7, digest) == (
        f"tenders/51885242000140-1-000744_2026/files/0007/{digest}.text.json.gz"
    )
    # Computable with nothing but the row's surviving columns.
    assert storage.text_key(TENDER, 7, digest) != storage.source_key(TENDER, 7, digest)


def test_different_bytes_under_the_same_document_number_are_different_objects():
    """A replaced edital keeps document number 1 and must not overwrite the old
    object: the digest is in the key, so the two coexist."""
    first = storage.source_key(TENDER, 1, "c" * 64)
    second = storage.source_key(TENDER, 1, "d" * 64)
    assert first != second


def test_a_zip_is_stored_as_a_zip():
    assert storage.suffix_for(b"PK\x03\x04rest") == ".zip"
    assert storage.suffix_for(b"%PDF-1.4") == ".pdf"
    assert storage.content_type_for(".zip") == storage.ZIP_CONTENT_TYPE
    assert storage.content_type_for(".pdf") == storage.PDF_CONTENT_TYPE


# -- the null store --------------------------------------------------------


def test_with_no_bucket_configured_every_read_misses_and_nothing_is_stored(monkeypatch):
    monkeypatch.setattr(storage.config, "resolve_secret", lambda *names, **kw: None)
    store = storage.build_store()

    assert store.configured is False
    assert store.put("k", b"x", content_type="application/pdf") is None
    assert store.get("k") is None
    assert store.delete("k") is False


# -- S3 --------------------------------------------------------------------


def test_put_and_get_round_trip():
    fake = FakeS3()
    store = storage.S3Store("bucket", client=fake)

    key = store.put("tenders/x/files/0001/abc.pdf", b"%PDF-1.4", content_type="application/pdf")

    assert key == "tenders/x/files/0001/abc.pdf"
    assert store.get(key) == b"%PDF-1.4"
    assert fake.objects[key][1] == "application/pdf"


def test_a_missing_object_reads_as_absent_rather_than_raising():
    """A PDF deleted by the 90-day sweep is *supposed* to be gone."""
    store = storage.S3Store("bucket", client=FakeS3())
    assert store.get("tenders/x/files/0001/gone.pdf") is None


def test_a_real_failure_is_not_swallowed():
    class Broken(FakeS3):
        def get_object(self, **_kwargs):
            raise RuntimeError("the network is on fire")

    store = storage.S3Store("bucket", client=Broken())
    with pytest.raises(RuntimeError, match="on fire"):
        store.get("k")


def test_deleting_the_same_key_twice_is_a_success():
    """The sweep may crash between the delete and the `update`, and re-run."""
    fake = FakeS3()
    store = storage.S3Store("bucket", client=fake)
    store.put("k", b"x", content_type="application/pdf")

    assert store.delete("k") is True
    assert store.delete("k") is True
    assert fake.deleted == ["k", "k"]


def test_the_retention_contract_is_written_down_beside_the_keys():
    described = storage.describe_retention()
    assert "90 days" in described["source"]
    assert "for ever" in described["text"]
