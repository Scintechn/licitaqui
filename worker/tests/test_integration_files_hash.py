"""B4's `files_hash` actually reaching C1's cache, against the real database.

Needs `TEST_DATABASE_URL_FH` (see `worker/README.md`); skips without it, and CI
fails a skip. Every tender here belongs to the fictitious agency
`conftest.FH_CNPJ`, which carries the per-run id, and is deleted before and
after each test; `tender_files` and `ai_analyses` follow it through the
cascade, and the sync markers in `events` go by the same run-scoped prefix.

The gap this file closes: B4 computes the digest of a tender's active document
list and `ai_analyses` is unique on it, but nothing passed it to the screening,
so an amended tender kept serving the analysis of the superseded edital. The
screening now resolves the digest itself, from `tender_files`, **when the job
runs**.

Two assertions carry the card, and they pull in opposite directions:

* an amended tender must be analysed again — otherwise a company bids against
  an edital that no longer exists;
* an unamended one must not — a screening costs about R$ 0,0014, and paying it
  again for documents that did not move is the failure mode that scales.

:func:`test_the_hash_is_resolved_when_the_job_runs_not_when_it_is_queued` is the
one that discriminates between resolving the hash here and resolving it at the
enqueue site: the file list moves *between* the two.

No OpenRouter call is ever made: `ai_tender.call_model` is stubbed and the key
is poisoned.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
import psycopg
import pytest

from licitaqui import ai_screening, ai_tender
from licitaqui import breaker as breaker_module
from licitaqui import sync_files as sync_files_module
from licitaqui.files import EMPTY_MANIFEST_DIGEST, files_hash_for
from licitaqui.pncp import FILES_PATH, PncpClient
from licitaqui.queue import Job
from licitaqui.registry import REGISTRY, JobContext
from licitaqui.sync_files import sync_files
from licitaqui.tenders import from_consulta, upsert_tenders

from .conftest import FH_CNPJ

LOG = logging.getLogger("licitaqui.fhtest")


@pytest.fixture(autouse=True)
def _fresh_breakers():
    breaker_module.reset_all()
    yield
    breaker_module.reset_all()


@pytest.fixture(autouse=True)
def _never_the_real_key(monkeypatch):
    """A test must never be able to spend money, even if a stub is forgotten."""
    monkeypatch.setenv(ai_tender.OPENROUTER_KEY_VAR, "not-a-real-key")


# -- the tender, its documents and its analysis ----------------------------


def tender_id(seq: int) -> str:
    return f"{FH_CNPJ}-1-{seq:06d}/2026"


def files_key(seq: int) -> str:
    return f"{FH_CNPJ}/2026/{seq}"


def document(
    sequence: int,
    *,
    titulo: str = "editais/Edital.pdf",
    tipo: str = "Edital",
    published: str = "2026-09-14T12:23:15",
    ativo: bool = True,
) -> dict[str, Any]:
    """One record in the shape `/…/arquivos` really answers with."""
    return {
        "uri": f"https://pncp.gov.br/pncp-api/v1/…/arquivos/{sequence}",
        "url": f"https://pncp.gov.br/pncp-api/v1/…/arquivos/{sequence}",
        "tipoDocumentoId": 2,
        "statusAtivo": ativo,
        "dataPublicacaoPncp": published,
        "sequencialDocumento": sequence,
        "titulo": titulo,
        "tipoDocumentoNome": tipo,
        "tipoDocumentoDescricao": tipo,
    }


EDITAL = document(1)
TERMO = document(2, titulo="editais/TermoReferencia.pdf", tipo="Termo de Referência")
ERRATA = document(
    3, titulo="editais/Errata_01.pdf", tipo="Outros Documentos", published="2026-09-20T09:15:00"
)
#: The dangerous shape: the same document number and the same download URL,
#: different bytes. Only `titulo` and `dataPublicacaoPncp` move.
EDITAL_RETIFICADO = document(
    1, titulo="editais/Edital_Retificado.pdf", published="2026-09-20T09:15:00"
)

ANSWER = {
    "objeto": "aquisicao de pilhas alcalinas",
    "valor_estimado_total": "R$ 100.000,00",
    "vigencia_meses": "12 meses",
    "capital_ou_patrimonio_minimo": {"exige": True, "percentual": "10%", "pagina": 2},
    "beneficio_me_epp": {"situacao": "exclusivo", "pagina": 1},
    "nota_triagem_0_a_10": 8,
}

PAGES = [
    {"page": 1, "text": "Pregao exclusivo para ME/EPP e microempresa " + "z" * 800},
    {"page": 2, "text": "Capital social minimo de 10% do valor estimado " + "z" * 800},
    {"page": 3, "text": "Do pagamento em 30 dias " + "z" * 800},
]

#: A scanned edital: pages with no text layer at all.
BLANK_PAGES = [{"page": 1, "text": ""}, {"page": 2, "text": "   "}]


def given_tender(conn: psycopg.Connection, seq: int) -> str:
    upsert_tenders(
        conn,
        [
            from_consulta(
                {
                    "numeroControlePNCP": tender_id(seq),
                    "objetoCompra": "Aquisição de pilhas alcalinas",
                    "orgaoEntidade": {"cnpj": FH_CNPJ, "razaoSocial": "ÓRGÃO DE TESTE FH"},
                    "unidadeOrgao": {"ufSigla": "SP", "municipioNome": "São Paulo"},
                    "modalidadeId": 6,
                    "valorTotalEstimado": 100_000.0,
                    "dataAtualizacaoGlobal": "2026-09-14T10:00:00",
                }
            )
        ],
    )
    return tender_id(seq)


def serving(lists: dict[str, list]) -> Any:
    """A client factory answering the arquivos endpoint from memory."""

    def handler(request: httpx.Request) -> httpx.Response:
        for key, body in lists.items():
            cnpj, year, sequence = key.split("/")
            if request.url.path == FILES_PATH.format(cnpj=cnpj, year=year, sequence=sequence):
                return httpx.Response(200, json=body)
        return httpx.Response(404, text="not found")

    def factory() -> PncpClient:
        return PncpClient(transport=httpx.MockTransport(handler), rate_limit=0.0, page_delay=0.0)

    return factory


def sync(monkeypatch, conn: psycopg.Connection, seq: int, documents: list[dict]) -> None:
    """Run B4's job for one tender, with PNCP answering `documents`."""
    tid = tender_id(seq)
    monkeypatch.setattr(sync_files_module, "build_client", serving({files_key(seq): documents}))
    job = Job(
        id=-1,
        kind="sync_files",
        key=tid,
        priority=5,
        payload={"tender_id": tid, "force": True},
        attempts=1,
    )
    sync_files(JobContext(job=job, conn=conn, connect=lambda: conn, log=LOG))


def screening_job(tid: str, payload: dict[str, Any]) -> Job:
    return Job(
        id=-1,
        kind=ai_screening.JOB_KIND,
        key=ai_screening.job_key(tid),
        priority=1,
        payload=payload,
        attempts=1,
    )


def screen(conn: psycopg.Connection, tid: str, *, pages: list | None = None) -> None:
    """Run C1's job the way the consumer does — with **no** hash in the payload.

    That is the point of the whole card: the enqueue site knows the tender id
    and nothing else, and the handler is what resolves the key.
    """
    job = screening_job(tid, {"tender_id": tid, "pages": pages if pages is not None else PAGES})
    REGISTRY.get(ai_screening.JOB_KIND)(
        JobContext(job=job, conn=conn, connect=lambda: conn, log=LOG)
    )


def analyses(conn: psycopg.Connection, tid: str) -> list[tuple]:
    return conn.execute(
        "select files_hash, status from ai_analyses where tender_id = %s order by created_at",
        (tid,),
    ).fetchall()


@pytest.fixture
def calls(monkeypatch) -> list[int]:
    """Every OpenRouter call the model layer would have made. Each costs money."""
    spent: list[int] = []

    def answer(*_args, **_kwargs):
        spent.append(1)
        return 200, {
            "choices": [{"message": {"content": json.dumps(ANSWER)}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 18_000, "completion_tokens": 900, "cost": 0.00069},
        }

    monkeypatch.setattr(ai_tender, "call_model", answer)
    return spent


# -- the card ---------------------------------------------------------------


def test_an_amendment_re_analyses_and_an_unamended_tender_does_not(
    fh_conn: psycopg.Connection, monkeypatch, calls: list[int]
) -> None:
    """The acceptance criterion, both halves, with nothing passing a hash by hand.

    Two tenders are carried side by side through the same steps, and only one
    of them is amended. The amended one must be read again; the untouched one
    must stay free, including across a re-sync that returns exactly the same
    list. Asserting only the first half would be satisfied by a screening that
    re-analyses everything, which is the expensive mistake.
    """
    amended = given_tender(fh_conn, 1)
    untouched = given_tender(fh_conn, 2)

    sync(monkeypatch, fh_conn, 1, [EDITAL, TERMO])
    sync(monkeypatch, fh_conn, 2, [EDITAL, TERMO])
    before = files_hash_for(fh_conn, amended)
    quiet = files_hash_for(fh_conn, untouched)

    screen(fh_conn, amended)
    screen(fh_conn, untouched)
    assert len(calls) == 2, "each tender is read once, by the first user to ask"
    assert analyses(fh_conn, amended) == [(before, "ok")]
    # The row was keyed on the list B4 recorded, not on a digest of the text.
    assert before != EMPTY_MANIFEST_DIGEST

    # A second request for either tender, before anything changes, is free.
    screen(fh_conn, amended)
    screen(fh_conn, untouched)
    assert len(calls) == 2

    # The agency publishes an errata on one of them, and PNCP re-serves the
    # other's list unchanged — the ordinary 12 h re-read.
    sync(monkeypatch, fh_conn, 1, [EDITAL, TERMO, ERRATA])
    sync(monkeypatch, fh_conn, 2, [EDITAL, TERMO])
    after = files_hash_for(fh_conn, amended)
    assert after != before
    assert files_hash_for(fh_conn, untouched) == quiet

    screen(fh_conn, amended)
    assert len(calls) == 3, "the superseded analysis must not be served as a hit"
    screen(fh_conn, untouched)
    assert len(calls) == 3, "a tender whose documents did not move must not be paid for twice"

    # Both analyses survive: the old one is still a true reading of the
    # documents it was given and still the record of what was paid (§3.2).
    assert analyses(fh_conn, amended) == [(before, "ok"), (after, "ok")]
    assert analyses(fh_conn, untouched) == [(quiet, "ok")]


def test_a_replaced_edital_re_analyses_although_the_url_never_moves(
    fh_conn: psycopg.Connection, monkeypatch, calls: list[int]
) -> None:
    """The dangerous amendment: same document number, same download address.

    PNCP serves documents at `…/arquivos/{sequencialDocumento}`, so an agency
    re-publishing the edital under the same number changes the bytes without
    changing the URL. Nothing in the file list moves except `titulo` and
    `dataPublicacaoPncp` — which is exactly why B4 digests them.
    """
    tid = given_tender(fh_conn, 3)
    sync(monkeypatch, fh_conn, 3, [EDITAL, TERMO])
    before = files_hash_for(fh_conn, tid)
    screen(fh_conn, tid)
    assert len(calls) == 1

    sync(monkeypatch, fh_conn, 3, [EDITAL_RETIFICADO, TERMO])
    after = files_hash_for(fh_conn, tid)
    assert after != before

    screen(fh_conn, tid)
    assert len(calls) == 2
    assert [row[0] for row in analyses(fh_conn, tid)] == [before, after]


def test_a_withdrawn_document_also_retires_the_analysis(
    fh_conn: psycopg.Connection, monkeypatch, calls: list[int]
) -> None:
    """A revoked edital must not keep an analysis alive either.

    The document stays in the list with `statusAtivo: false`; B4 drops it from
    the manifest, so the digest moves and the screening is read again.
    """
    tid = given_tender(fh_conn, 4)
    sync(monkeypatch, fh_conn, 4, [EDITAL, TERMO])
    before = files_hash_for(fh_conn, tid)
    screen(fh_conn, tid)

    sync(monkeypatch, fh_conn, 4, [EDITAL, document(2, ativo=False)])
    assert files_hash_for(fh_conn, tid) != before

    screen(fh_conn, tid)
    assert len(calls) == 2


def test_the_hash_is_resolved_when_the_job_runs_not_when_it_is_queued(
    fh_conn: psycopg.Connection, monkeypatch, calls: list[int]
) -> None:
    """The reason the resolution lives in the handler.

    A user asks for a screening; the job waits in the queue — priority, backoff,
    whatever is ahead of it — and an errata lands before it is picked up. The
    handler reads the amended documents, so the row it writes must be keyed on
    the amended list. A digest captured at enqueue time would key an analysis of
    the new edital under the old list's hash: a row that misdescribes what it
    read, permanently, because a cached `ok` is never overwritten.
    """
    tid = given_tender(fh_conn, 5)
    sync(monkeypatch, fh_conn, 5, [EDITAL, TERMO])
    at_enqueue = files_hash_for(fh_conn, tid)

    job = screening_job(tid, {"tender_id": tid, "pages": PAGES})
    ai_screening.enqueue(fh_conn, tid)

    # …and only now does the agency amend it.
    sync(monkeypatch, fh_conn, 5, [EDITAL, TERMO, ERRATA])
    at_execution = files_hash_for(fh_conn, tid)
    assert at_execution != at_enqueue

    REGISTRY.get(ai_screening.JOB_KIND)(
        JobContext(job=job, conn=fh_conn, connect=lambda: fh_conn, log=LOG)
    )

    assert analyses(fh_conn, tid) == [(at_execution, "ok")]
    assert len(calls) == 1


def test_the_queue_would_have_dropped_a_second_requests_payload(
    fh_conn: psycopg.Connection, monkeypatch
) -> None:
    """Why a payload could not carry the hash even if it were fresh at enqueue.

    `jobs_dedupe` is unique on `(kind, key)` while a job is queued or running,
    and there is one screening key per tender. The request that arrives *after*
    the amendment therefore enqueues nothing, and a hash in its payload would
    never be seen: the live job would still hold the pre-amendment one.
    """
    tid = given_tender(fh_conn, 6)
    sync(monkeypatch, fh_conn, 6, [EDITAL, TERMO])

    first = ai_screening.enqueue(fh_conn, tid)
    sync(monkeypatch, fh_conn, 6, [EDITAL, TERMO, ERRATA])
    second = ai_screening.enqueue(fh_conn, tid)

    assert first is not None
    assert second is None, "the amended request is de-duplicated onto the queued job"


# -- what must not change ---------------------------------------------------


def test_a_tender_with_no_file_list_still_screens_on_its_own_content(
    fh_conn: psycopg.Connection, calls: list[int]
) -> None:
    """C1's fallback survives: `sync_files` may not have run yet.

    With no active documents on record the resolver returns nothing rather than
    `EMPTY_MANIFEST_DIGEST` — that constant is the same for every tender and
    would claim a file list we do not have — and the job keys on the text it
    actually read, exactly as before this wiring existed.
    """
    tid = given_tender(fh_conn, 7)
    assert files_hash_for(fh_conn, tid) == EMPTY_MANIFEST_DIGEST

    screen(fh_conn, tid)
    stored = analyses(fh_conn, tid)
    assert len(stored) == 1
    assert stored[0][0] not in (EMPTY_MANIFEST_DIGEST, None)
    assert len(calls) == 1

    # And a second run is still a hit: the fallback is stable, not random.
    screen(fh_conn, tid)
    assert len(calls) == 1


def test_an_explicit_payload_hash_still_wins(
    fh_conn: psycopg.Connection, monkeypatch, calls: list[int]
) -> None:
    """The evaluation harness and an operator re-running one file set.

    A caller that computed its own digest knows something the database does not,
    so the pin is honoured — and B4's own acceptance test, which passes the hash
    by hand, keeps meaning what it meant.
    """
    tid = given_tender(fh_conn, 8)
    sync(monkeypatch, fh_conn, 8, [EDITAL, TERMO])
    stored_hash = files_hash_for(fh_conn, tid)

    job = screening_job(tid, {"tender_id": tid, "pages": PAGES, "files_hash": "pinned-by-caller"})
    REGISTRY.get(ai_screening.JOB_KIND)(
        JobContext(job=job, conn=fh_conn, connect=lambda: fh_conn, log=LOG)
    )

    assert analyses(fh_conn, tid) == [("pinned-by-caller", "ok")]
    assert ai_screening.cached(fh_conn, tid, stored_hash) is None
    assert len(calls) == 1


def test_a_scanned_edital_is_keyed_on_the_file_list_and_costs_nothing(
    fh_conn: psycopg.Connection, monkeypatch, calls: list[int]
) -> None:
    """C1's two invariants, under the new key: `no_text` short-circuits, and a
    cached answer is never overwritten.

    `no_text` is a real, permanent answer — "there is nothing here to read" — so
    it has to be keyed on the file list like any other, or the next request
    would pay to discover the same thing. It must also still be decided before
    any API call: the model is stubbed to fail this test loudly if one is made.
    """
    tid = given_tender(fh_conn, 9)
    sync(monkeypatch, fh_conn, 9, [EDITAL, TERMO])
    digest = files_hash_for(fh_conn, tid)

    screen(fh_conn, tid, pages=BLANK_PAGES)
    assert analyses(fh_conn, tid) == [(digest, "no_text")]
    assert calls == []

    # A second attempt reads the row; an amendment is what gives it a new look.
    screen(fh_conn, tid, pages=BLANK_PAGES)
    assert analyses(fh_conn, tid) == [(digest, "no_text")]
    assert calls == []

    sync(monkeypatch, fh_conn, 9, [EDITAL, TERMO, ERRATA])
    screen(fh_conn, tid)
    assert len(calls) == 1, "the amended tender does get read — it may have a text layer now"
    assert [row[1] for row in analyses(fh_conn, tid)] == ["no_text", "ok"]


def test_a_cached_ok_is_never_overwritten_by_a_later_failure(
    fh_conn: psycopg.Connection, monkeypatch, calls: list[int]
) -> None:
    """The cost cap, re-checked now that the key comes from the database.

    Resolving the hash from `tender_files` must not open a path where the same
    key is written twice with a worse answer.
    """
    tid = given_tender(fh_conn, 10)
    sync(monkeypatch, fh_conn, 10, [EDITAL, TERMO])
    digest = files_hash_for(fh_conn, tid)
    screen(fh_conn, tid)

    monkeypatch.setattr(
        ai_tender, "call_model", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no call"))
    )
    screen(fh_conn, tid)

    row = ai_screening.cached(fh_conn, tid, digest)
    assert row is not None
    assert row["status"] == "ok"
    assert analyses(fh_conn, tid) == [(digest, "ok")]
