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
* the segment stored is POC 1's **label** ("Alimentos"), not the ASCII key the
  classifier works in. B6 seeded `cnae_segments.segment` with those labels and
  R1 joins the two, so they have to be the same string.
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

from .segments import OTHER, Classification, classify, key_for_label, label, segment_for_text

#: What an unclassified item stores. `tender_items.segment` and
#: `tenders.segments` hold POC 1's **label** ("Saúde / Hospitalar"), not the key
#: this module classifies with, because that is the vocabulary B6 seeded
#: `cnae_segments.segment` with and R1 joins the two. The key stays available on
#: :attr:`TenderItem.segment_key` for code that wants an ASCII slug.
OTHER_LABEL = label(OTHER)

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
    #: POC 1's label, which is what `cnae_segments.segment` holds (B6).
    segment: str = OTHER_LABEL
    relevance: str = "low"
    has_award: bool | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def segment_key(self) -> str:
        """The ASCII key behind :attr:`segment`, for code rather than for joins."""
        return key_for_label(self.segment)

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
        segment=label(verdict.segment),
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


def pick_total(
    header: Decimal | float | None, item_total: Decimal | float | None
) -> Decimal | None:
    """Which of the two figures is the tender's value — the whole rule, once.

    The header wins whenever it is positive, because it is PNCP's own
    ``valorTotalEstimado`` and Sci's rule is that we show what the portal shows.
    The item total is what a tender gets *instead of nothing*: measured across
    production, it reproduces the header to the cent on 94.7 % of the tenders
    where both are known, and where it differs it over-counts — never
    under-counts — because grouped lots and ME/EPP cotas are listed beside the
    items they are carved from. See :mod:`licitaqui.tender_value`.

    A non-positive figure is **not** a value on either side. Every sigiloso item
    reports 0, so a confidential budget sums to zero, and 108 production tenders
    carry a header of exactly ``0.00``; returning None for both keeps
    :func:`favored_treatment` from reading a tender nobody knows the size of as
    cheap, and keeps the card off "R$ 0,00".

    Split out of :func:`total_estimated_value` so the backfill can apply the
    same precedence to a sum Postgres computed, without rebuilding the item
    rows in Python to get a number it already has.
    """
    head = _decimal(header)
    if head is not None and head > 0:
        return head
    total = _decimal(item_total)
    return total if total is not None and total > 0 else None


def total_estimated_value(
    estimated_value: Decimal | float | None, items: Sequence[TenderItem]
) -> Decimal | None:
    """The tender's value: the header's, or the sum of the items (POC 1).

    POC 1 falls back to summing the items whenever the detail endpoint did not
    give it ``valorTotalEstimado``, and so do we. The precedence itself lives in
    :func:`pick_total`; this is the form that takes the item rows.
    """
    return pick_total(
        estimated_value, sum((item.total_value or Decimal(0) for item in items), Decimal(0))
    )


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

    "Outros" is left out. It is the absence of a segment, and an array used to
    match a company's CNAEs is better empty than full of "não sei".
    """
    by_value: dict[str, Decimal] = {}
    for item in items:
        if item.segment == OTHER_LABEL:
            continue
        by_value[item.segment] = by_value.get(item.segment, Decimal(0)) + (
            item.total_value or Decimal(0)
        )
    if by_value:
        # Value descending, then the name, so a tender whose items are all zero
        # (confidential budget) still gets a stable order instead of dict luck.
        return [name for name, _ in sorted(by_value.items(), key=lambda kv: (-kv[1], kv[0]))]
    from_object = segment_for_text(object_text)
    return [label(from_object)] if from_object else []


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
 where (tender_items.description, tender_items.kind, tender_items.quantity,
        tender_items.unit, tender_items.unit_estimated_value, tender_items.total_value,
        tender_items.ncm, tender_items.judgment_criterion, tender_items.benefit_id,
        tender_items.benefit_name, tender_items.segment, tender_items.relevance,
        tender_items.has_award, tender_items.raw)
    is distinct from
       (excluded.description, excluded.kind, excluded.quantity,
        excluded.unit, excluded.unit_estimated_value, excluded.total_value,
        excluded.ncm, excluded.judgment_criterion, excluded.benefit_id,
        excluded.benefit_name, excluded.segment, excluded.relevance,
        excluded.has_award, excluded.raw)
"""

#: The payload columns the guard above compares — everything except the conflict
#: key and `updated_at`. Kept beside the statement so a new column added to one
#: and not the other is a visible omission rather than a silent one; a test
#: reconciles this list against the INSERT's column list.
#:
#: **Why the columns are named out rather than compared as whole rows.** The
#: obvious spelling is ``where tender_items is distinct from excluded``, and it
#: is a silent no-op: `updated_at = now()` sits in the SET list, so `excluded`
#: always carries a fresh timestamp, the row comparison is therefore always
#: `true`, and every row is rewritten exactly as before. It does not fail, it
#: does not warn, and a measurement taken against it shows a 0 % skip rate with
#: no indication why. The conflict key is excluded for the opposite reason: it
#: is what `on conflict` matched on, so it can never differ.
GUARDED_COLUMNS: tuple[str, ...] = (
    "description",
    "kind",
    "quantity",
    "unit",
    "unit_estimated_value",
    "total_value",
    "ncm",
    "judgment_criterion",
    "benefit_id",
    "benefit_name",
    "segment",
    "relevance",
    "has_award",
    "raw",
)

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

#: The roll-up already computed the tender's value to decide
#: `favored_treatment`; until now it threw the number away and left
#: `estimated_value` null, which is the other half of why 5,080 tenders showed
#: "Valor não informado" while we could answer perfectly well.
#:
#: It only ever **fills a gap**. `case` rather than `coalesce` because a stored
#: `0.00` is as absent as a NULL (:func:`pick_total`), and the guard lives in
#: the statement so no caller can get the precedence wrong: a header value from
#: `/atualizacao` or from the detail re-read always survives an item sum.
ROLLUP_SQL = """
update tenders
   set me_epp_summary    = %(me_epp_summary)s,
       favored_treatment = %(favored_treatment)s,
       segments          = %(segments)s,
       estimated_value   = case
                             when estimated_value is null or estimated_value <= 0
                               then %(estimated_value)s
                             else estimated_value
                           end,
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


@dataclass(frozen=True, slots=True)
class UpsertItemsResult:
    """What a batch of item upserts actually did.

    ``offered`` is how many items PNCP gave us; ``written`` is how many rows
    Postgres actually inserted or updated. The gap between them is the whole
    point of the guard on :data:`UPSERT_SQL`, and it is the number §14.1 asks
    for — the storage saving follows from it rather than the other way round,
    because Neon's history retention makes the table size lag behind.
    """

    offered: int = 0
    written: int = 0
    pruned: int = 0

    @property
    def skipped(self) -> int:
        """Rows PNCP re-sent unchanged, which we therefore did not rewrite."""
        return max(self.offered - self.written, 0)

    @property
    def skip_rate(self) -> float:
        return 0.0 if not self.offered else self.skipped / self.offered

    def log_fields(self) -> dict[str, Any]:
        return {
            "items_offered": self.offered,
            "items_written": self.written,
            "items_skipped": self.skipped,
            "skip_rate": round(self.skip_rate, 3),
            "items_pruned": self.pruned,
        }


def upsert_items(
    conn: psycopg.Connection, tender_id: str, items: Sequence[TenderItem], *, prune: bool = True
) -> UpsertItemsResult:
    """Write this tender's items, removing any the agency has withdrawn.

    Idempotent (§7.2): the primary key is `(tender_id, number)`, so running the
    job twice rewrites the same rows — except that since the guard on
    :data:`UPSERT_SQL` it does not rewrite them at all when nothing changed,
    which is the same idempotency expressed in storage rather than only in
    results. ``prune=False`` is for a partial fetch — deleting on incomplete
    data would drop live items.

    Returns what was actually written, not what was offered. ``executemany``
    accumulates `rowcount` across the whole batch in psycopg 3, so a guarded
    statement reports precisely the rows that changed; a test pins that
    behaviour, because the count silently becoming -1 or a per-statement value
    would turn the measurement into a fiction without failing anything.
    """
    written = 0
    if items:
        with conn.cursor() as cur:
            cur.executemany(UPSERT_SQL, [_params(item) for item in items])
            written = max(cur.rowcount, 0)
    pruned = 0
    if prune:
        with conn.cursor() as cur:
            cur.execute(
                PRUNE_SQL, {"tender_id": tender_id, "numbers": [item.number for item in items]}
            )
            pruned = max(cur.rowcount, 0)
    return UpsertItemsResult(offered=len(items), written=written, pruned=pruned)


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
    """Write the item-derived columns of `tenders` and rebuild `search`.

    ``estimated_value`` is the header we already hold. What goes back is
    :func:`total_estimated_value` of it and the items — the same number
    ``favored_treatment`` is derived from, so the value on the card and the
    ME/EPP claim beside it cannot disagree — and it is written only where the
    tender has none (see :data:`ROLLUP_SQL`).
    """
    total = total_estimated_value(estimated_value, items)
    values = {
        "tender_id": tender_id,
        "me_epp_summary": me_epp_summary(items),
        "favored_treatment": favored_treatment(estimated_value, items),
        "segments": tender_segments(items, object_text=object_text),
        "estimated_value": total,
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


# -- the "we looked, and there was nothing" marker -------------------------
#
# `tender_items` has a row-level `updated_at`, which answers "when did we last
# look?" for every tender that *has* items — and for no other. A tender with
# zero rows is indistinguishable from one never fetched, so `sync_items` read
# it as stale on every sweep and went back to PNCP forever. That is the half of
# the 404 bug the 404 itself does not explain: even once the job completes,
# without a marker nothing records that it did.
#
# B4 hit the same wall on `tender_files` and solved it in `events` rather than
# with a column, because a migration is its own PR (CLAUDE.md) and `events` is
# writable by the worker's DML-only `app` role. This follows that precedent
# exactly, down to putting the tender id in `name` so the lookup is an index
# hit on `events_name_created_idx (name, created_at)` rather than a scan of
# every tender's marker, and rewriting the row rather than appending so it
# stays one row per tender.
#
# A column on `tenders` would be the better home — see `docs/STATUS.md` for the
# migration this proposes.

SYNC_EVENT_PREFIX = "sync_items:"


def sync_event_name(tender_id: str) -> str:
    return f"{SYNC_EVENT_PREFIX}{tender_id}"


DELETE_MARKER_SQL = "delete from events where name = %s"
INSERT_MARKER_SQL = "insert into events (name, props) values (%s, %s)"


def mark_synced(conn: psycopg.Connection, tender_id: str, props: dict[str, Any]) -> None:
    """Record that PNCP's item list was read for this tender just now.

    Rewritten rather than appended: it is a marker, not a metric. Nothing here
    is personal data (§12) — a tender id and counts.

    The two statements are not one transaction and do not need to be: losing
    between them loses the marker, which reads as `never` and costs one extra
    fetch. The reverse — a marker for a sync that did not happen — is not
    reachable.
    """
    name = sync_event_name(tender_id)
    conn.execute(DELETE_MARKER_SQL, (name,))
    conn.execute(INSERT_MARKER_SQL, (name, Jsonb({"tender_id": tender_id, **props})))


# -- the cutover backfill -------------------------------------------------
#
# `read_state` in :mod:`licitaqui.sync_items` falls back to
# `min(tender_items.updated_at)` for a tender that has no marker yet, so the
# behaviour change is correct with or without this statement. It exists to make
# the fallback branch go cold sooner: once every tender that has items also has
# a marker, freshness is answered by one signal instead of two, and nothing
# depends on a row timestamp that the upsert guard has stopped moving.
#
# Three things it must get right, and each is enforced by the statement rather
# than by remembering:
#
# * **`min`, not `max`.** A fetch that died half way leaves some rows fresh and
#   some old, and the old ones are the truth about whether the set is complete.
#   `max` would record a partially-synced tender as fully fresh and freeze it
#   there — worse than a re-fetch, because nothing would ever correct it.
# * **Never invent a marker for a tender with no items.** Those already use the
#   marker, and the PNCP-404 lane's "synced, empty" state is deliberate and
#   correct for them. The `join` makes this structural — a tender with no
#   `tender_items` rows produces no group, so it cannot appear — and
#   `not exists` makes it true again if the join shape is ever changed.
# * **Never overwrite an existing marker.** On production there is exactly one
#   zero-item tender carrying a deliberate marker; six rows is small enough
#   that the join is the only thing protecting it, and join shapes change.
#
# `created_at` is written to the tender's own `min(updated_at)` rather than to
# `now()`, which is the entire point: `now()` would mark the whole corpus fresh
# and defer every re-read by one TTL, which is the same thundering herd moved
# twelve hours into the future rather than avoided.
BACKFILL_MARKERS_SQL = """
insert into events (name, props, created_at)
select %(prefix)s || t.id,
       jsonb_build_object(
           'tender_id', t.id,
           'items', count(i.*),
           'backfilled', true
       ),
       min(i.updated_at)
  from tenders t
  join tender_items i on i.tender_id = t.id
 where not exists (
           select 1 from events e where e.name = %(prefix)s || t.id
       )
 group by t.id
"""


def backfill_markers(conn: psycopg.Connection) -> int:
    """Give every tender that holds items a sync marker. Returns rows written.

    Idempotent: the `not exists` means a second run writes nothing, so this is
    safe to re-run and safe to run before *or* after the deploy — which is what
    makes it an optimisation rather than a step the cutover depends on.
    """
    with conn.cursor() as cur:
        cur.execute(BACKFILL_MARKERS_SQL, {"prefix": SYNC_EVENT_PREFIX})
        return max(cur.rowcount, 0)
