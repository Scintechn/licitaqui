"""Mapping a PNCP record onto a `tenders` row, and upserting it.

Two shapes arrive here and both have to land in the same columns (§6.1):

- a **Consulta API** record from ``/v1/contratacoes/atualizacao``, camelCase,
  the primary path (ADR-0001);
- a **search index** item from ``/api/search/``, snake_case, the fallback.

The Consulta record is the richer of the two: it carries ``srp``,
``valorTotalEstimado`` and both proposal dates in the header, which POC 1 had to
reach the unstable detail endpoint (or sum the items) to get. The search item
carries neither ``srp`` nor the estimated value, so a row written from the
fallback deliberately leaves those columns alone rather than overwriting good
data with nulls — see :func:`upsert_tenders`.

``me_epp_summary``, ``favored_treatment`` and ``segments`` are derived from
*items*, so they belong to B3 and are never written here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import psycopg
from psycopg.types.json import Jsonb

#: PNCP publishes wall-clock Brasília time with no offset. See
#: :func:`parse_timestamp` for why that has to be fixed at this boundary.
BRT = ZoneInfo("America/Sao_Paulo")

#: §7.1: Pregão Eletrônico, Dispensa, Concorrência Eletrônica.
DEFAULT_MODALITIES: tuple[int, ...] = (6, 8, 4)

#: §6.1 stores one character. The Consulta API already sends one, in
#: ``orgaoEntidade.esferaId``; the search index spells it out in
#: ``esfera_nome``. "Distrital" (the Federal District) has no code of its own in
#: §6.1's three-value column and is filed as estadual, which is what it is
#: administratively.
_SPHERE_CODES = frozenset("MEF")
_SPHERES = {"municipal": "M", "estadual": "E", "federal": "F", "distrital": "E"}

#: `orcamentoSigilosoCodigo` is **not** a boolean, and 1 is not "yes".
#: Measured over the 95 cached PNCP detail responses in the knowledge base:
#: 1 = "Compra sem sigilo" (83 records), 2 = "Compra parcialmente sigilosa" (1),
#: 3 = "Compra totalmente sigilosa" (11). Reading it as a truthy int would mark
#: 83 of those 95 tenders as having a confidential budget.
_CONFIDENTIAL_BUDGET_CODES = frozenset({2, 3})

_MODALITY_NAMES = {
    1: "Leilão - Eletrônico",
    4: "Concorrência - Eletrônica",
    5: "Concorrência - Presencial",
    6: "Pregão - Eletrônico",
    7: "Pregão - Presencial",
    8: "Dispensa",
    9: "Inexigibilidade",
    11: "Pré-qualificação",
    12: "Credenciamento",
    13: "Leilão - Presencial",
}


@dataclass(frozen=True, slots=True)
class Tender:
    """One `tenders` row, ready to upsert. ``pncp_updated_at`` drives everything.

    It holds ``dataAtualizacaoGlobal`` — the record **or any of its children**
    changed — which is both the change trigger for B3/B4 and the value a rerun
    compares against to decide whether the row needs writing at all.
    """

    id: str
    agency_cnpj: str
    year: int
    sequence: int
    object: str
    pncp_updated_at: datetime | None
    agency_name: str | None = None
    unit_name: str | None = None
    city: str | None = None
    state: str | None = None
    sphere: str | None = None
    modality_id: int | None = None
    modality_name: str | None = None
    status: str | None = None
    price_registration: bool | None = None
    proposals_open_at: datetime | None = None
    proposals_close_at: datetime | None = None
    estimated_value: float | None = None
    confidential_budget: bool = False
    bidding_system_url: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


def parse_timestamp(value: Any) -> datetime | None:
    """PNCP's several date shapes -> an **aware** datetime, or None.

    Seen in the wild: ``2026-09-17T14:22:31``, ``2026-09-17T14:22``,
    ``2026-09-17`` and, on some fields, a trailing offset.

    PNCP sends almost all of these with no offset, and they are Brasília wall
    clock time — ``dataEncerramentoProposta`` is the deadline a supplier reads
    off the portal. Every column they land in is `timestamptz`, and Postgres
    resolves a *naive* value using the session's TimeZone, which for the worker
    is UTC: handing it a naive 08:30 would store 05:30 BRT and show every
    deadline three hours early. So the offset is attached here, once, at the
    edge, and everything downstream is aware.
    """
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=BRT)
    text = str(value).strip()
    parsed: datetime | None = None
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        for length, fmt in ((19, "%Y-%m-%dT%H:%M:%S"), (16, "%Y-%m-%dT%H:%M"), (10, "%Y-%m-%d")):
            try:
                parsed = datetime.strptime(text[:length], fmt)
                break
            except ValueError:
                continue
    if parsed is None:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=BRT)


def _number(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _sphere(*values: Any) -> str | None:
    """First recognisable sphere among ``values``: a code, or a spelled-out name."""
    for value in values:
        if not value:
            continue
        text = str(value).strip()
        if len(text) == 1 and text.upper() in _SPHERE_CODES:
            return text.upper()
        code = _SPHERES.get(text.lower())
        if code:
            return code
    return None


def _confidential(record: dict[str, Any]) -> bool:
    """Whether the budget is sigiloso, from the code — never from its truthiness."""
    code = record.get("orcamentoSigilosoCodigo")
    if code is not None:
        try:
            return int(code) in _CONFIDENTIAL_BUDGET_CODES
        except (TypeError, ValueError):
            pass
    return bool(record.get("orcamentoSigiloso"))


def split_control_number(numero: str) -> tuple[str, int, int]:
    """``51885242000140-1-000744/2026`` -> ``('51885242000140', 2026, 744)``.

    The three parts are the natural key §6.1 puts a unique constraint on, and
    the primary key is the whole string, so they must agree.
    """
    left, _, year = str(numero).partition("/")
    cnpj, _, rest = left.partition("-")
    _, _, sequence = rest.partition("-")
    if not (cnpj and year and sequence):
        raise ValueError(f"unrecognised numeroControlePNCP: {numero!r}")
    return cnpj, int(year), int(sequence)


def from_consulta(record: dict[str, Any]) -> Tender:
    """Map a ``/v1/contratacoes/{atualizacao,publicacao}`` record."""
    numero = record.get("numeroControlePNCP")
    if not numero:
        raise ValueError("record has no numeroControlePNCP")
    cnpj, year, sequence = split_control_number(numero)
    unit = record.get("unidadeOrgao") or {}
    agency = record.get("orgaoEntidade") or {}
    modality_id = record.get("modalidadeId")
    return Tender(
        id=str(numero),
        agency_cnpj=cnpj,
        year=year,
        sequence=sequence,
        object=(record.get("objetoCompra") or "").strip() or "(sem objeto)",
        # The whole point of ADR-0001: the timestamp that moves for child changes.
        pncp_updated_at=parse_timestamp(record.get("dataAtualizacaoGlobal"))
        or parse_timestamp(record.get("dataAtualizacao")),
        agency_name=agency.get("razaoSocial"),
        unit_name=unit.get("nomeUnidade"),
        city=unit.get("municipioNome"),
        state=(unit.get("ufSigla") or None),
        sphere=_sphere(agency.get("esferaId"), agency.get("esferaNome")),
        modality_id=modality_id,
        modality_name=record.get("modalidadeNome") or _MODALITY_NAMES.get(modality_id or 0),
        status=record.get("situacaoCompraNome"),
        price_registration=record.get("srp"),
        proposals_open_at=parse_timestamp(record.get("dataAberturaProposta")),
        proposals_close_at=parse_timestamp(record.get("dataEncerramentoProposta")),
        estimated_value=_number(record.get("valorTotalEstimado")),
        confidential_budget=_confidential(record),
        bidding_system_url=record.get("linkSistemaOrigem"),
        raw=record,
    )


def from_search(item: dict[str, Any]) -> Tender:
    """Map an ``/api/search/`` item: the fallback sweep's poorer record."""
    numero = item.get("numero_controle_pncp")
    if not numero:
        raise ValueError("search item has no numero_controle_pncp")
    cnpj, year, sequence = split_control_number(numero)
    modality_id = item.get("modalidade_licitacao_id")
    try:
        modality_id = int(modality_id) if modality_id not in (None, "") else None
    except (TypeError, ValueError):
        modality_id = None
    return Tender(
        id=str(numero),
        agency_cnpj=cnpj,
        year=year,
        sequence=sequence,
        object=(item.get("description") or item.get("title") or "").strip() or "(sem objeto)",
        pncp_updated_at=parse_timestamp(item.get("data_atualizacao_pncp")),
        agency_name=item.get("orgao_nome"),
        unit_name=item.get("unidade_nome"),
        city=item.get("municipio_nome"),
        state=item.get("uf"),
        sphere=_sphere(item.get("esfera_nome")),
        modality_id=modality_id,
        modality_name=item.get("modalidade_licitacao_nome")
        or _MODALITY_NAMES.get(modality_id or 0),
        status=item.get("situacao_nome"),
        # The search index carries neither srp nor the estimated value; leaving
        # them None here is what keeps COALESCE in the upsert from erasing them.
        proposals_open_at=parse_timestamp(item.get("data_inicio_vigencia")),
        proposals_close_at=parse_timestamp(item.get("data_fim_vigencia")),
        raw=item,
    )


# The upsert that makes a rerun free.
#
# Three things are load-bearing:
#
# * ``on conflict (id)`` — the natural key is `numeroControlePNCP`, so a replay
#   of the same sweep updates rather than inserts (§7.2 idempotency).
# * ``where`` on the DO UPDATE — the row is only written when PNCP's timestamp
#   is actually newer (or when we have never seen one). An unchanged tender is
#   left completely alone, so `updated_at` does not churn and the §3.1 freshness
#   clock keeps meaning what it says.
# * ``coalesce(excluded.x, tenders.x)`` on the columns the fallback cannot fill
#   — a search-sourced row must not blank `srp` or `estimated_value` that a
#   consulta-sourced row already established.
#
# ``xmax = 0`` distinguishes an insert from an update in the RETURNING clause:
# it is 0 for a freshly inserted tuple and non-zero for an updated one. That is
# how the caller tells "new tender" from "changed tender" without a second
# query, and how the rerun-creates-no-duplicates measurement is taken.
UPSERT_SQL = """
insert into tenders (
    id, agency_cnpj, year, sequence, object, agency_name, unit_name, city, state,
    sphere, modality_id, modality_name, status, price_registration,
    proposals_open_at, proposals_close_at, estimated_value, confidential_budget,
    bidding_system_url, pncp_updated_at, raw, updated_at
) values (
    %(id)s, %(agency_cnpj)s, %(year)s, %(sequence)s, %(object)s, %(agency_name)s,
    %(unit_name)s, %(city)s, %(state)s, %(sphere)s, %(modality_id)s, %(modality_name)s,
    %(status)s, %(price_registration)s, %(proposals_open_at)s, %(proposals_close_at)s,
    %(estimated_value)s, %(confidential_budget)s, %(bidding_system_url)s,
    %(pncp_updated_at)s, %(raw)s, now()
)
on conflict (id) do update set
    agency_cnpj         = excluded.agency_cnpj,
    year                = excluded.year,
    sequence            = excluded.sequence,
    object              = excluded.object,
    agency_name         = coalesce(excluded.agency_name, tenders.agency_name),
    unit_name           = coalesce(excluded.unit_name, tenders.unit_name),
    city                = coalesce(excluded.city, tenders.city),
    state               = coalesce(excluded.state, tenders.state),
    sphere              = coalesce(excluded.sphere, tenders.sphere),
    modality_id         = coalesce(excluded.modality_id, tenders.modality_id),
    modality_name       = coalesce(excluded.modality_name, tenders.modality_name),
    status              = coalesce(excluded.status, tenders.status),
    price_registration  = coalesce(excluded.price_registration, tenders.price_registration),
    proposals_open_at   = coalesce(excluded.proposals_open_at, tenders.proposals_open_at),
    proposals_close_at  = coalesce(excluded.proposals_close_at, tenders.proposals_close_at),
    estimated_value     = coalesce(excluded.estimated_value, tenders.estimated_value),
    confidential_budget = excluded.confidential_budget,
    bidding_system_url  = coalesce(excluded.bidding_system_url, tenders.bidding_system_url),
    pncp_updated_at     = excluded.pncp_updated_at,
    -- Merge, do not replace. The two sources use disjoint key sets (the
    -- Consulta API is camelCase, the search index snake_case), so a fallback
    -- sweep adds what the index knows without deleting the richer consulta
    -- payload a healthy cycle stored: the same reasoning as the COALESCEs
    -- above, applied to the whole document.
    raw                 = coalesce(tenders.raw, '{}'::jsonb) || excluded.raw,
    updated_at          = now()
  where tenders.pncp_updated_at is distinct from excluded.pncp_updated_at
    and (tenders.pncp_updated_at is null
         or excluded.pncp_updated_at is null
         or excluded.pncp_updated_at > tenders.pncp_updated_at)
returning id, (xmax = 0) as inserted
"""


@dataclass(frozen=True, slots=True)
class UpsertResult:
    """What a batch of upserts did. ``unchanged`` is the rerun's whole story."""

    inserted: tuple[str, ...] = ()
    updated: tuple[str, ...] = ()
    unchanged: int = 0

    @property
    def changed(self) -> tuple[str, ...]:
        """New or changed: exactly the tenders B3 and B4 must revisit (§7.1)."""
        return self.inserted + self.updated

    @property
    def total(self) -> int:
        return len(self.inserted) + len(self.updated) + self.unchanged


def _upsert_params(tender: Tender) -> dict[str, Any]:
    return {
        "id": tender.id,
        "agency_cnpj": tender.agency_cnpj,
        "year": tender.year,
        "sequence": tender.sequence,
        "object": tender.object,
        "agency_name": tender.agency_name,
        "unit_name": tender.unit_name,
        "city": tender.city,
        "state": tender.state,
        "sphere": tender.sphere,
        "modality_id": tender.modality_id,
        "modality_name": tender.modality_name,
        "status": tender.status,
        "price_registration": tender.price_registration,
        "proposals_open_at": tender.proposals_open_at,
        "proposals_close_at": tender.proposals_close_at,
        "estimated_value": tender.estimated_value,
        "confidential_budget": tender.confidential_budget,
        "bidding_system_url": tender.bidding_system_url,
        "pncp_updated_at": tender.pncp_updated_at,
        "raw": Jsonb(tender.raw),
    }


def upsert_tenders(conn: psycopg.Connection, tenders: list[Tender]) -> UpsertResult:
    """Upsert a batch of tenders. Returns what actually changed.

    A row whose ``pncp_updated_at`` has not moved matches no ``DO UPDATE``, so
    it returns nothing and is counted as unchanged: no write, no new
    ``updated_at``, no follow-up job.

    ``executemany(..., returning=True)`` puts psycopg into pipeline mode: the
    whole batch is sent in one flush and the results come back together, instead
    of one network round trip per tender. Measured against Neon in sa-east-1
    that is the difference between roughly 4 and roughly 250 tenders a second —
    a full-state sweep goes from tens of minutes to under one, and the round
    trip, not PNCP, was the whole cost.
    """
    if not tenders:
        return UpsertResult()
    inserted: list[str] = []
    updated: list[str] = []
    with conn.cursor() as cur:
        cur.executemany(UPSERT_SQL, [_upsert_params(t) for t in tenders], returning=True)
        while True:
            # A tender that did not change produces an empty result set, not a
            # missing one: that is exactly the `unchanged` case.
            for row in cur.fetchall() if cur.pgresult is not None else []:
                (inserted if row[1] else updated).append(row[0])
            if not cur.nextset():
                break
    return UpsertResult(
        inserted=tuple(inserted),
        updated=tuple(updated),
        unchanged=len(tenders) - len(inserted) - len(updated),
    )
