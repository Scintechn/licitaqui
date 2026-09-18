"""Mapping a PNCP item onto a `tender_items` row, and the tender-level roll-up.

Items are where the Radar's two headline answers come from: *can my company
serve this?* (the segment) and *am I allowed to bid?* (ME/EPP). §6.1 keeps the
first per item and the second summarised on the tender, so this module does
both halves: :func:`from_pncp` and :func:`upsert_items` for the rows,
:func:`me_epp_summary`, :func:`favored_treatment` and :func:`tender_segments`
for what the roll-up writes back onto `tenders`.

Two things worth knowing about the payload, both measured over the 8,861 cached
items in the knowledge base:

* ``orcamentoSigiloso`` on an **item** is a real boolean (8,487 false / 374
  true) — it is not the tender-level ``orcamentoSigilosoCodigo`` trap, where 1
  means *sem sigilo*. It is kept in `raw`; §6.1 gives items no column for it.
  What it does affect is money: every one of those 374 sigiloso items reports
  ``valorUnitarioEstimado`` and ``valorTotal`` as 0, so a tender whose budget is
  confidential sums to zero and its value must be read as *unknown*, never as
  "cheap" (:func:`favored_treatment`).
* every item timestamp (17,722 of them) is naive Brasília wall clock, the same
  shape that made B2 store deadlines three hours early. No `tender_items`
  column is a `timestamptz` fed by PNCP — `updated_at` is our own write clock —
  so nothing here can land in that trap, but anything later reading
  ``dataAtualizacao`` out of `raw` must go through
  :func:`licitaqui.tenders.parse_timestamp`.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .segments import OTHER, Classification, classify, segment_for_text

#: PNCP's ``tipoBeneficio`` domain. 2 (subcontracting) is a benefit but not a
#: reservation: it does not stop anyone else bidding, so it counts as open for
#: the summary. 4 (sem benefício) and 5 (não se aplica) are open too.
BENEFIT_EXCLUSIVE = 1
BENEFIT_SUBCONTRACTING = 2
BENEFIT_QUOTA = 3

#: The EPP revenue ceiling (glossary, §6.1). Above it the legal preference for
#: ME/EPP does not apply, which is the whole of the favored-treatment rule.
EPP_REVENUE_CAP = Decimal("4800000")


@dataclass(frozen=True, slots=True)
class TenderItem:
    """One `tender_items` row, classified and ready to upsert."""

    tender_id: str
    number: int
    description: str | None = None
    kind: str | None = None
    quantity: Decimal | None = None
    unit: str | None = None
    unit_estimated_value: Decimal | None = None
    total_value: Decimal | None = None
    ncm: str | None = None
    judgment_criterion: str | None = None
    benefit_id: int | None = None
    benefit_name: str | None = None
    segment: str = OTHER
    relevance: str = "low"
    has_award: bool | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def is_exclusive(self) -> bool:
        return self.benefit_id == BENEFIT_EXCLUSIVE

    @property
    def is_quota(self) -> bool:
        return self.benefit_id == BENEFIT_QUOTA


def _decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def from_pncp(tender_id: str, record: dict[str, Any]) -> TenderItem:
    """Map one ``/api/pncp/v1/.../itens`` record, classifying it on the way in.

    ``numeroItem`` is half the primary key, so a record without one cannot be
    stored idempotently and is rejected rather than renumbered: a made-up
    number would collide with a real item on the next sync.
    """
    number = _int(record.get("numeroItem"))
    if number is None:
        raise ValueError("item has no numeroItem")
    description = _text(record.get("descricao"))
    kind = (_text(record.get("materialOuServico")) or "")[:1].upper() or None
    verdict: Classification = classify(description, record.get("ncmNbsCodigo"), kind)
    return TenderItem(
        tender_id=tender_id,
        number=number,
        description=description,
        kind=kind,
        quantity=_decimal(record.get("quantidade")),
        unit=_text(record.get("unidadeMedida")),
        unit_estimated_value=_decimal(record.get("valorUnitarioEstimado")),
        total_value=_decimal(record.get("valorTotal")),
        ncm=_text(record.get("ncmNbsCodigo")),
        judgment_criterion=_text(record.get("criterioJulgamentoNome")),
        benefit_id=_int(record.get("tipoBeneficio")),
        benefit_name=_text(record.get("tipoBeneficioNome")),
        segment=verdict.segment,
        relevance=verdict.relevance,
        has_award=record.get("temResultado"),
        raw=record,
    )


# -- the tender-level roll-up ---------------------------------------------


def me_epp_summary(items: Sequence[TenderItem]) -> str | None:
    """`exclusive | quota | mixed | none` from the items' ``tipoBeneficio``.

    §3.2: "per-item `tipoBeneficioNome` defines ME/EPP". Rolling those up has
    to answer one question for a small company reading a card — *how much of
    this is reserved for me?*

    ``exclusive``
        every item is reserved for ME/EPP; a larger company cannot bid at all.
    ``quota``
        part of the tender is reserved (cota reservada) and nothing is
        exclusive — the normal shape of LC 123 art. 48 III, where the reserved
        items sit beside open ones.
    ``mixed``
        exclusive items *and* something else, so the answer differs item by
        item and the card must not claim the whole tender either way.
    ``none``
        no item carries a reservation.

    A tender with no items at all returns None: unknown is not the same as
    "no benefit", and §6.1 leaves the column nullable for exactly that.
    """
    if not items:
        return None
    exclusive = sum(1 for item in items if item.is_exclusive)
    quota = sum(1 for item in items if item.is_quota)
    open_items = len(items) - exclusive - quota
    if not exclusive and not quota:
        return "none"
    if exclusive and not quota and not open_items:
        return "exclusive"
    if not exclusive:
        return "quota"
    return "mixed"


def total_estimated_value(
    estimated_value: Decimal | float | None, items: Sequence[TenderItem]
) -> Decimal | None:
    """The tender's value: the header's, or the sum of the items (POC 1).

    POC 1 falls back to summing the items whenever the detail endpoint did not
    give it ``valorTotalEstimado``, and so do we. A sum of zero is *not* a
    value: every sigiloso item reports 0, so that is a confidential budget, and
    returning None keeps :func:`favored_treatment` from reading it as cheap.
    """
    header = _decimal(estimated_value)
    if header is not None and header > 0:
        return header
    total = sum((item.total_value or Decimal(0) for item in items), Decimal(0))
    return total if total > 0 else None


def favored_treatment(
    estimated_value: Decimal | float | None, items: Sequence[TenderItem]
) -> bool | None:
    """Whether ME/EPP's legal preference can apply to this tender.

    The glossary states the rule: *tratamento favorecido* is the legal
    preference for ME/EPP, "not applicable when the value exceeds the EPP
    revenue cap (R$ 4.8M)". PNCP does not publish it, so §6.1 says compute it —
    value at or under the cap, true; above it, false.

    None when the value is unknown (no header value, no items, or a
    confidential budget that sums to zero). A card showing "tratamento
    favorecido" for a tender nobody knows the size of would be a guess
    presented as a fact.
    """
    total = total_estimated_value(estimated_value, items)
    if total is None:
        return None
    return total <= EPP_REVENUE_CAP


def tender_segments(items: Sequence[TenderItem], *, object_text: object = None) -> list[str]:
    """The tender's segments, most money first.

    POC 1 gives an edital one segment: whichever segment its items spend the
    most on, falling back to classifying the object when the items carry no
    value. §6.1 keeps an array instead — a tender can be worth answering for
    two different companies — so this is the same ranking, kept whole:
    ``segments[0]`` is the POC's single answer and the rest follow by value.

    `other` is left out. It is the absence of a segment, and an array used to
    match a company's CNAEs is better empty than full of "não sei".
    """
    by_value: dict[str, Decimal] = {}
    for item in items:
        if item.segment == OTHER:
            continue
        by_value[item.segment] = by_value.get(item.segment, Decimal(0)) + (
            item.total_value or Decimal(0)
        )
    if by_value:
        # Value descending, then the key, so a tender whose items are all zero
        # (confidential budget) still gets a stable order instead of dict luck.
        return [key for key, _ in sorted(by_value.items(), key=lambda kv: (-kv[1], kv[0]))]
    from_object = segment_for_text(object_text)
    return [from_object] if from_object else []


# -- persistence -----------------------------------------------------------


UPSERT_SQL = """
insert into tender_items (
    tender_id, number, description, kind, quantity, unit, unit_estimated_value,
    total_value, ncm, judgment_criterion, benefit_id, benefit_name, segment,
    relevance, has_award, raw, updated_at
) values (
    %(tender_id)s, %(number)s, %(description)s, %(kind)s, %(quantity)s, %(unit)s,
    %(unit_estimated_value)s, %(total_value)s, %(ncm)s, %(judgment_criterion)s,
    %(benefit_id)s, %(benefit_name)s, %(segment)s, %(relevance)s, %(has_award)s,
    %(raw)s, now()
)
on conflict (tender_id, number) do update set
    description          = excluded.description,
    kind                 = excluded.kind,
    quantity             = excluded.quantity,
    unit                 = excluded.unit,
    unit_estimated_value = excluded.unit_estimated_value,
    total_value          = excluded.total_value,
    ncm                  = excluded.ncm,
    judgment_criterion   = excluded.judgment_criterion,
    benefit_id           = excluded.benefit_id,
    benefit_name         = excluded.benefit_name,
    segment              = excluded.segment,
    relevance            = excluded.relevance,
    has_award            = excluded.has_award,
    raw                  = excluded.raw,
    updated_at           = now()
"""

#: An amendment can withdraw an item. Anything under this tender that PNCP no
#: longer lists is deleted, so a cancelled lot stops showing on the card — but
#: only ever within one tender, and only after a *complete* fetch.
PRUNE_SQL = """
delete from tender_items
 where tender_id = %(tender_id)s
   and not (number = any(%(numbers)s))
"""

#: Exactly the expression `db/seed.py` writes, so the seeded fixtures and the
#: synced rows produce the same vector: object plus every item description, in
#: the accent-insensitive Portuguese configuration from migration 0001.
SEARCH_SQL = """
update tenders t set search = to_tsvector('pt_unaccent',
  coalesce(t.object,'') || ' ' ||
  coalesce((select string_agg(i.description, ' ')
              from tender_items i where i.tender_id = t.id), ''))
where t.id = %s
"""

ROLLUP_SQL = """
update tenders
   set me_epp_summary    = %(me_epp_summary)s,
       favored_treatment = %(favored_treatment)s,
       segments          = %(segments)s,
       updated_at        = now()
 where id = %(tender_id)s
"""


def _params(item: TenderItem) -> dict[str, Any]:
    return {
        "tender_id": item.tender_id,
        "number": item.number,
        "description": item.description,
        "kind": item.kind,
        "quantity": item.quantity,
        "unit": item.unit,
        "unit_estimated_value": item.unit_estimated_value,
        "total_value": item.total_value,
        "ncm": item.ncm,
        "judgment_criterion": item.judgment_criterion,
        "benefit_id": item.benefit_id,
        "benefit_name": item.benefit_name,
        "segment": item.segment,
        "relevance": item.relevance,
        "has_award": item.has_award,
        "raw": Jsonb(item.raw),
    }


def upsert_items(
    conn: psycopg.Connection, tender_id: str, items: Sequence[TenderItem], *, prune: bool = True
) -> int:
    """Write this tender's items, removing any the agency has withdrawn.

    Idempotent (§7.2): the primary key is `(tender_id, number)`, so running the
    job twice rewrites the same rows. ``prune=False`` is for a partial fetch —
    deleting on incomplete data would drop live items.
    """
    if items:
        with conn.cursor() as cur:
            cur.executemany(UPSERT_SQL, [_params(item) for item in items])
    if prune:
        conn.execute(
            PRUNE_SQL, {"tender_id": tender_id, "numbers": [item.number for item in items]}
        )
    return len(items)


def refresh_search(conn: psycopg.Connection, tender_id: str) -> None:
    """Rebuild the tender's `search` vector over the object and the items."""
    conn.execute(SEARCH_SQL, (tender_id,))


def roll_up(
    conn: psycopg.Connection,
    tender_id: str,
    items: Sequence[TenderItem],
    *,
    estimated_value: Decimal | float | None,
    object_text: object = None,
) -> dict[str, Any]:
    """Write the item-derived columns of `tenders` and rebuild `search`."""
    values = {
        "tender_id": tender_id,
        "me_epp_summary": me_epp_summary(items),
        "favored_treatment": favored_treatment(estimated_value, items),
        "segments": tender_segments(items, object_text=object_text),
    }
    conn.execute(ROLLUP_SQL, values)
    refresh_search(conn, tender_id)
    return values


def classify_all(tender_id: str, records: Iterable[dict[str, Any]]) -> list[TenderItem]:
    """Map and classify a whole item list, skipping records we cannot key."""
    items: list[TenderItem] = []
    seen: set[int] = set()
    for record in records:
        item = from_pncp(tender_id, record)
        if item.number in seen:
            # PNCP has been seen paging the same item twice under load; the
            # upsert would survive it, but the count in the log should not lie.
            continue
        seen.add(item.number)
        items.append(item)
    return items
