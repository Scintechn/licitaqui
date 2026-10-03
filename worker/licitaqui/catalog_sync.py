"""Mirror the catalogue vocabularies, and map tender items onto them (card B36).

Two jobs, deliberately separate:

``sync_catalog_vocabulary``
    Walks the two closed vocabularies and upserts them. Network, no items.

``map_item_codes``
    Resolves item descriptions to codes. **No network at all** — pure string
    work against the mirrored vocabulary, which is the reason the mirror exists.
    Measured 2026-10-02: the whole open corpus, 450 445 items, resolves in about
    four minutes of CPU.

## Why the mapper is a sweep rather than a hook

Mapping on write in ``sync_items`` would be cheaper per item and is the right
steady state, but it cannot populate the 450 445 items already in the table, and
a sweep is also what re-maps everything after the vocabulary changes or the
matcher is corrected. Both exist; this is the sweep.

## What this job must never do

Write a band, or decide what a screen shows. It records **which code an item
resolved to and how** — and `rule` is what later decides whether a number may be
computed, because only an exact match may feed a band (see
:data:`licitaqui.catalog_match.BAND_ELIGIBLE_RULES` and the measurement in that
module's docstring).
"""

from __future__ import annotations

from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from .catalog_match import (
    MATCH_CAP,
    MATCHER_VERSION,
    CatalogEntry,
    CatalogIndex,
    Resolution,
    all_words,
    product_head,
    resolve_description,
)
from .compras import ComprasClient, ComprasError
from .observability import get_logger
from .registry import REGISTRY, JobContext

_log = get_logger("catalog")

#: Items mapped per transaction. Small enough that a failure costs little and a
#: concurrency-1 worker is never held for long, which is B32's lesson about a
#: long job starving the 30-minute sweep.
BATCH = 2000


def _active(value: Any, field: str) -> bool:
    """Parse a status field explicitly, because truthiness fails OPEN.

    The API sends a JSON boolean today (verified against real payloads walked
    2026-10-02). If it ever sends ``"false"``, ``"N"`` or ``"Inativo"``,
    ``bool()`` would be **True for every row**: every inactive code would become
    active, `load_index` would serve them, and the event counters would agree
    with the bug so the log would look right. An unexpected shape must stop the
    run instead.
    """
    if isinstance(value, bool):
        return value
    raise ComprasError(
        f"{field} arrived as {type(value).__name__} {value!r}, not a boolean — "
        "refusing to guess, because a truthy string would mark every code active"
    )


def _pdm_entry(row: dict[str, Any]) -> tuple:
    name = (row.get("nomePdm") or "").strip()
    return (
        int(row["codigoPdm"]),
        name,
        row.get("codigoClasse"),
        row.get("nomeClasse"),
        row.get("codigoGrupo"),
        row.get("nomeGrupo"),
        _active(row.get("statusPdm"), "statusPdm"),
    )


def _service_entry(row: dict[str, Any]) -> tuple:
    name = (row.get("nomeServico") or "").strip()
    return (
        int(row["codigoServico"]),
        name,
        row.get("codigoClasse"),
        row.get("nomeClasse"),
        _active(row.get("statusServico"), "statusServico"),
    )


def _assert_discriminating(
    pdm: list[dict[str, Any]], service: list[dict[str, Any]]
) -> tuple[int, int]:
    """Count the active codes, and refuse a walk where everything is active.

    Measured 2026-10-02: **15 039 of 20 440** PDM and **3 023 of 3 103** CATSER
    are active, so the field does discriminate. An all-active walk therefore
    means the parse broke rather than the catalogue changing — and the
    consequence is silent: inactive codes would be served by `load_index` and
    would feed bands, which is the one thing `active` exists to prevent, while
    the event counters would agree with the bug so the log would look right.
    """
    active_pdm = sum(1 for r in pdm if r.get("statusPdm") is True)
    active_svc = sum(1 for r in service if r.get("statusServico") is True)
    if active_pdm == len(pdm) or active_svc == len(service):
        raise ComprasError(
            f"every code came back active (pdm {active_pdm}/{len(pdm)}, "
            f"service {active_svc}/{len(service)}) — a parse bug, not a finding"
        )
    return active_pdm, active_svc


@REGISTRY.job("sync_catalog_vocabulary")
def sync_catalog_vocabulary(ctx: JobContext) -> None:
    """Refresh ``catalog_pdm`` and ``catalog_service`` from the API.

    An inactive row is **updated, never deleted**: an item mapped last month may
    still point at it, and a vanishing row would turn a mapped item into an
    unmapped one with no record of why.
    """
    with ComprasClient() as client:
        pdm = client.walk_catalogue("pdm")
        service = client.walk_catalogue("service")

    conn: Connection = ctx.conn
    with conn.transaction():
        conn.cursor().executemany(
            """
            insert into catalog_pdm
              (code, name, class_code, class_name,
               group_code, group_name, active, updated_at)
            values (%s, %s, %s, %s, %s, %s, %s, now())
            on conflict (code) do update set
              name = excluded.name,
              class_code = excluded.class_code, class_name = excluded.class_name,
              group_code = excluded.group_code, group_name = excluded.group_name,
              active = excluded.active, updated_at = now()
            """,
            [_pdm_entry(r) for r in pdm],
        )
        conn.cursor().executemany(
            """
            insert into catalog_service
              (code, name, class_code, class_name, active, updated_at)
            values (%s, %s, %s, %s, %s, now())
            on conflict (code) do update set
              name = excluded.name,
              class_code = excluded.class_code, class_name = excluded.class_name,
              active = excluded.active, updated_at = now()
            """,
            [_service_entry(r) for r in service],
        )

    active_pdm, active_svc = _assert_discriminating(pdm, service)
    _log.info(
        "catalogue mirrored",
        extra={
            "pdm": len(pdm),
            "pdm_active": active_pdm,
            "service": len(service),
            "service_active": active_svc,
        },
    )
    conn.cursor().execute(
        "insert into events (name, props) values (%s, %s)",
        (
            "catalog_vocabulary_synced",
            Jsonb(
                {
                    "pdm": len(pdm),
                    "pdm_active": active_pdm,
                    "service": len(service),
                    "service_active": active_svc,
                }
            ),
        ),
    )


def load_index(conn: Connection, kind: str) -> CatalogIndex:
    """The active vocabulary for one kind, as an in-memory index.

    Only ``active`` rows: an inactive code must stop feeding new matches even
    though existing rows keep pointing at it.

    **The heads are recomputed here, never stored.** Storing them would mean a
    matcher correction left the vocabulary folded by the *previous* matcher,
    and a `remap` run — whose whole purpose is to re-resolve after exactly such
    a correction — would resolve against stale heads and report success. The
    cost of recomputing is 18 062 names, milliseconds.
    """
    table = "catalog_service" if kind == "S" else "catalog_pdm"
    rows = conn.execute(
        f"select code, name from {table} where active"  # noqa: S608 - fixed set
    ).fetchall()
    if not rows:
        raise RuntimeError(
            f"{table} holds no active rows — run sync_catalog_vocabulary first. "
            "An empty index would mark every item `no_match`, which is a broken "
            "run recorded as a finding."
        )
    return CatalogIndex(
        [
            CatalogEntry(
                code=code,
                name=name,
                head=tuple(product_head(name, MATCH_CAP)),
                words=tuple(all_words(name)),
            )
            for code, name in rows
        ]
    )


@REGISTRY.job("map_item_codes")
def map_item_codes(ctx: JobContext) -> None:
    """Resolve unmapped tender items to catalogue codes. No network.

    ``payload.remap`` re-resolves everything rather than only the unmapped,
    which is what a vocabulary refresh or a matcher correction needs.
    """
    conn: Connection = ctx.conn
    remap = bool(ctx.payload.get("remap"))
    only_open = bool(ctx.payload.get("only_open", True))

    index = {kind: load_index(conn, kind) for kind in ("M", "S")}
    _log.info("index loaded", extra={k: len(v) for k, v in index.items()})

    where = ["i.description is not null"]
    if only_open:
        # `proposals_close_at` is nullable, and `null > now()` is null, so a
        # bare `>` silently drops every tender with an unknown close date —
        # invisible in the log and in the event. Treated as open deliberately:
        # an item we cannot date is one a reader may still be looking at, and
        # the mapper writes no band, so the cost of including it is nothing.
        where.append("(t.proposals_close_at is null or t.proposals_close_at > now())")
    if not remap:
        where.append("c.tender_id is null")
    # No ORDER BY: the sweep upserts by primary key and does not care about row
    # order, while a sort over 450 000+ joined rows must finish before the FIRST
    # fetch returns — inside the 30 s `statement_timeout` that `db.factory` sets
    # as a session GUC. `sync_tenders.py` reasons about the same ceiling.
    sql = f"""
        select i.tender_id, i.number, i.kind, i.description
          from tender_items i
          join tenders t on t.id = i.tender_id
          left join tender_item_codes c
            on c.tender_id = i.tender_id and c.item_number = i.number
         where {" and ".join(where)}
    """  # noqa: S608 - `where` is assembled from fixed fragments only

    mapped = 0
    by_rule: dict[str, int] = {}
    # A second, independent connection for the read: `ctx.conn` is autocommit
    # (see JobContext), and a server-side cursor there would be closed at the
    # end of each statement. 450 445 rows must not be materialised in memory, so
    # the cursor is named and lives inside its own transaction.
    with ctx.connect() as reader, reader.transaction(), reader.cursor(name="map_items") as cur:
        cur.itersize = BATCH
        cur.execute(sql)
        batch: list[tuple] = []
        for tender_id, number, kind, description in cur:
            # `tender_items.kind` is nullable. Coercing an unknown kind to 'M'
            # would match a service against the materials vocabulary, where
            # `exact` is more than twice as likely (18.5% against 7.6%,
            # re-measured 2026-10-03) -- so the coercion would make a *wrong*
            # band more likely, not less, under a column a reader believes was
            # copied from `tender_items`. It gets its own rule, carries no
            # code, and is never band-eligible.
            if kind in ("M", "S"):
                r = resolve_description(index[kind], description)
                row = (
                    tender_id,
                    number,
                    kind,
                    r.code,
                    r.rule,
                    r.matched_words,
                    r.candidates,
                    MATCHER_VERSION,
                )
            else:
                r = Resolution(None, "unknown_kind", 0, 0)
                row = (tender_id, number, "M", None, r.rule, 0, 0, MATCHER_VERSION)
            by_rule[r.rule] = by_rule.get(r.rule, 0) + 1
            batch.append(row)
            if len(batch) >= BATCH:
                mapped += _flush(conn, batch)
                batch = []
        if batch:
            mapped += _flush(conn, batch)

    _log.info("items mapped", extra={"mapped": mapped, **by_rule})
    conn.cursor().execute(
        "insert into events (name, props) values (%s, %s)",
        (
            "item_codes_mapped",
            Jsonb(
                {
                    "mapped": mapped,
                    "by_rule": by_rule,
                    "remap": remap,
                    "only_open": only_open,
                    "matcher": MATCHER_VERSION,
                }
            ),
        ),
    )


def _flush(conn: Connection, batch: list[tuple]) -> int:
    with conn.transaction():
        conn.cursor().executemany(
            """
            insert into tender_item_codes
              (tender_id, item_number, kind, code, rule,
               matched_words, candidates, matcher, mapped_at)
            values (%s, %s, %s, %s, %s, %s, %s, %s, now())
            on conflict (tender_id, item_number) do update set
              kind = excluded.kind, code = excluded.code, rule = excluded.rule,
              matched_words = excluded.matched_words,
              candidates = excluded.candidates, matcher = excluded.matcher,
              mapped_at = now()
            """,
            batch,
        )
    return len(batch)
