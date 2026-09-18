"""Mapping a PNCP document, and the hash that expires what it supersedes.

No database and no network: :mod:`licitaqui.files` is pure up to the point
where it writes, and the digest is the part that has to be right first.
`test_integration_sync_files.py` takes it from there.

The payloads here are the real shape, measured over the 371 documents in the
575 cached PNCP responses in the read-only knowledge base.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from licitaqui.files import (
    EMPTY_MANIFEST_DIGEST,
    MANIFEST_HEADER,
    TenderFile,
    active_files,
    files_hash,
    from_pncp,
    manifest,
    map_all,
    sync_event_name,
)

BRT = ZoneInfo("America/Sao_Paulo")
TENDER = "00394452000103-1-019867/2026"

#: One real record, verbatim from `cache_pncp/00394452000103_2026_19867.json`.
RECORD = {
    "uri": "https://pncp.gov.br/pncp-api/v1/orgaos/00394452000103/compras/2026/19867/arquivos/1",
    "url": "https://pncp.gov.br/pncp-api/v1/orgaos/00394452000103/compras/2026/19867/arquivos/1",
    "tipoDocumentoId": 20,
    "statusAtivo": True,
    "dataPublicacaoPncp": "2026-09-14T12:23:15",
    "cnpj": "00394452000103",
    "anoCompra": 2026,
    "sequencialCompra": 19867,
    "sequencialDocumento": 1,
    "titulo": "editais/Edital.zip",
    "tipoDocumentoNome": "Ato que autoriza a Contratação Direta",
    "tipoDocumentoDescricao": "Ato que autoriza a Contratação Direta",
}


def file(sequence: int = 1, **overrides) -> TenderFile:
    defaults = {
        "tender_id": TENDER,
        "sequence": sequence,
        "title": "editais/Edital.pdf",
        "doc_type": "Edital",
        "url": f"https://pncp.gov.br/pncp-api/v1/…/arquivos/{sequence}",
        "active": True,
        "published_at": datetime(2026, 9, 14, 12, 23, 15, tzinfo=BRT),
    }
    return TenderFile(**{**defaults, **overrides})


# -- mapping ---------------------------------------------------------------


def test_it_maps_the_columns_the_card_asks_for() -> None:
    mapped = from_pncp(TENDER, RECORD)

    assert mapped.sequence == 1
    assert mapped.title == "editais/Edital.zip"
    assert mapped.doc_type == "Ato que autoriza a Contratação Direta"
    assert mapped.url.endswith("/arquivos/1")
    assert mapped.active is True


def test_the_publication_timestamp_is_brasilia_not_utc() -> None:
    """The trap that stored every B2 deadline three hours early.

    PNCP sends naive wall clock; `published_at` is a `timestamptz`. Read as UTC
    this document would claim to have been published at 09:23 local, and a
    supplier reading "published 09:23" for a 12:23 document is being told
    something false.
    """
    published = from_pncp(TENDER, RECORD).published_at

    assert published.tzinfo is not None
    assert published.utcoffset() == timedelta(hours=-3)
    assert published.astimezone(UTC).hour == 15  # 12:23 BRT, not 12:23 UTC


def test_an_absent_status_means_active() -> None:
    """POC 1 reads it as `a.get("statusAtivo", True)`, and so must we.

    Presuming a listed document is dead would drop the edital out of the
    manifest and out of everything downstream. An *explicit* null is a
    different thing from an absent field and stays falsy, again as in POC 1.
    """
    record = {k: v for k, v in RECORD.items() if k != "statusAtivo"}
    assert from_pncp(TENDER, record).active is True
    assert from_pncp(TENDER, {**RECORD, "statusAtivo": False}).active is False
    assert from_pncp(TENDER, {**RECORD, "statusAtivo": None}).active is False


def test_it_falls_back_to_uri_when_there_is_no_url() -> None:
    record = {k: v for k, v in RECORD.items() if k != "url"}
    assert from_pncp(TENDER, record).url == RECORD["uri"]


def test_a_document_with_no_number_cannot_be_stored() -> None:
    """`sequencialDocumento` is half the primary key; inventing one would
    collide with a real document and retire the wrong file's text."""
    with pytest.raises(ValueError, match="sequencialDocumento"):
        from_pncp(TENDER, {k: v for k, v in RECORD.items() if k != "sequencialDocumento"})


def test_one_unmappable_document_does_not_cost_the_list() -> None:
    records = [RECORD, {"titulo": "sem número"}, {**RECORD, "sequencialDocumento": 2}]

    assert [f.sequence for f in map_all(TENDER, records)] == [1, 2]


def test_a_repeated_document_is_stored_once() -> None:
    """PNCP has been seen repeating a record under load."""
    assert len(map_all(TENDER, [RECORD, dict(RECORD)])) == 1


def test_the_list_is_ordered_by_document_number() -> None:
    out_of_order = [{**RECORD, "sequencialDocumento": n} for n in (3, 1, 2)]

    assert [f.sequence for f in map_all(TENDER, out_of_order)] == [1, 2, 3]


# -- the manifest and the hash ---------------------------------------------


def test_the_hash_is_stable_and_order_independent() -> None:
    """Two syncs of the same list must produce the same key, or every screening
    would be paid for twice."""
    files = [file(1), file(2), file(3)]

    assert files_hash(files) == files_hash(list(reversed(files)))
    assert files_hash(files) == files_hash(list(files))


def test_the_digest_is_versioned() -> None:
    """A changed recipe must not serve rows keyed under the old one."""
    assert manifest([]).startswith(MANIFEST_HEADER)
    assert files_hash([]) == EMPTY_MANIFEST_DIGEST
    assert files_hash([file(1)]) != EMPTY_MANIFEST_DIGEST


def test_the_same_instant_in_two_timezones_hashes_the_same() -> None:
    """The round-trip property the whole invalidation rests on.

    A freshly mapped file carries `-03:00`; the same row read back from
    Postgres carries `+00:00`. If those digested differently, *every* sync
    would look like an amendment and every tender would be re-analysed at full
    price, for ever.
    """
    brt = file(published_at=datetime(2026, 9, 14, 12, 23, 15, tzinfo=BRT))
    utc = file(published_at=datetime(2026, 9, 14, 15, 23, 15, tzinfo=UTC))

    assert brt.published_at == utc.published_at
    assert files_hash([brt]) == files_hash([utc])


def test_an_added_document_changes_the_hash() -> None:
    """The acceptance criterion, at the level of the digest."""
    assert files_hash([file(1)]) != files_hash([file(1), file(2, doc_type="Errata")])


def test_a_withdrawn_document_changes_the_hash() -> None:
    assert files_hash([file(1), file(2)]) != files_hash([file(1)])


def test_a_deactivated_document_leaves_the_manifest() -> None:
    """A revoked edital must not keep an analysis alive."""
    assert files_hash([file(1), file(2)]) != files_hash([file(1), file(2, active=False)])
    assert files_hash([file(1), file(2, active=False)]) == files_hash([file(1)])
    assert active_files([file(1), file(2, active=False)]) == [file(1)]


@pytest.mark.parametrize(
    "field,value",
    [
        ("url", "https://pncp.gov.br/pncp-api/v1/…/arquivos/99"),
        ("title", "editais/Edital_Retificado.pdf"),
        ("doc_type", "Termo de Referência"),
        ("published_at", datetime(2026, 9, 20, 9, 0, tzinfo=BRT)),
    ],
)
def test_a_republished_document_changes_the_hash(field: str, value) -> None:
    """The case a URL alone cannot catch.

    PNCP's download address is `…/arquivos/{sequencialDocumento}`, so an agency
    re-publishing the edital under the same document number serves different
    bytes from the same URL. `dataPublicacaoPncp` moves, and usually the
    `titulo` with it — both are in the digest for exactly this.
    """
    assert files_hash([file(1)]) != files_hash([file(1, **{field: value})])


def test_the_manifest_is_readable() -> None:
    """A diff of two manifests answers "what changed?"; a diff of two digests
    does not."""
    lines = manifest([file(1, doc_type="Edital", title="a.pdf")]).splitlines()

    assert lines[0] == MANIFEST_HEADER
    assert lines[1].split("\t")[:3] == ["1", "Edital", "a.pdf"]
    assert lines[1].endswith("2026-09-14T15:23:15+00:00")


def test_a_file_with_no_publication_date_still_hashes() -> None:
    """Every cached document had one, but a missing field must not raise on a
    Sunday night."""
    assert files_hash([file(published_at=None)])


# -- the marker ------------------------------------------------------------


def test_the_marker_name_carries_the_tender_id() -> None:
    """So the lookup is an exact hit on `events_name_created_idx (name, …)`
    rather than a scan of every tender's marker."""
    assert sync_event_name(TENDER) == f"sync_files:{TENDER}"
