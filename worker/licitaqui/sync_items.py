"""``sync_items`` — one tender's items, classified, and what they say about it.

B2's sweep enqueues one of these per new or changed tender (§7.1). The job:

1. checks the tender is still worth reading — §3.2 gives items a 12 h TTL, and
   B2 only enqueues when PNCP's ``dataAtualizacaoGlobal`` moved, so a job that
   arrives twice inside the TTL does nothing;
2. reads `/api/pncp/v1/.../itens` through B2's client, its own breaker and its
   own throttle;
3. classifies every item into one of the 14 segments, with the false-positive
   rules (:mod:`licitaqui.segments`);
4. upserts the rows and deletes any item the agency withdrew;
5. rolls the items up onto the tender: `me_epp_summary`, `favored_treatment`,
   `segments`, and the `search` vector that spans the object plus every item
   description.

It is a sibling of :mod:`licitaqui.sync_tenders`, not a second framework: same
``PncpClient``, same breaker discipline, same "the handler is idempotent and the
queue owns retries" contract (§7.2). Registering the kind is also what switches
B2's follow-up enqueue on — that code already asks the registry which kinds have
a handler.

## When PNCP has no items at all

Two things used to make that state unreachable, and between them they kept jobs
going round forever against tenders that would never yield an item.

**A 404 was a hard failure.** It is not: it is ambiguous, and
:mod:`licitaqui.absence` resolves it — an empty list when the contratação is
still published, a withdrawal when Consulta answers 410, and a *regression*
(:class:`licitaqui.absence.DataVanished`, nothing written, nothing deleted) when
we already hold items for the tender.

**Zero items had no "we looked" state.** `tender_items` has a row-level
`updated_at` and no rows to carry it, so a tender with no items read as stale on
every sweep. :func:`licitaqui.items.mark_synced` writes the marker B4 already
writes for the file list, and :func:`read_state` reads it — so "synced, empty"
is a real 12 h state, distinct from "never synced", and the job stops being
re-fetched on every cycle.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import psycopg

from . import absence
from .items import (
    TenderItem,
    classify_all,
    mark_synced,
    roll_up,
    sync_event_name,
    upsert_items,
)
from .pncp import PncpClient, PncpNotFound
from .registry import REGISTRY, JobContext
from .tenders import split_control_number

#: §3.2: items are good for 12 hours while the tender is open.
ITEMS_TTL_HOURS = 12


@dataclass(frozen=True, slots=True)
class TenderState:
    """What the database already knows, and whether that is still good enough."""

    exists: bool
    estimated_value: Decimal | None = None
    object_text: str | None = None
    item_count: int = 0
    #: Why we are (or are not) going back to PNCP — for the log line.
    reason: str = "missing"

    @property
    def stale(self) -> bool:
        return self.reason != "fresh"


STATE_SQL = f"""
select t.estimated_value,
       t.object,
       count(i.tender_id) as item_count,
       case
         when count(i.tender_id) > 0
              and min(i.updated_at) < now() - interval '{ITEMS_TTL_HOURS} hours'
                                                                  then 'ttl'
         when count(i.tender_id) > 0
              and t.pncp_updated_at is not null
              and min(i.updated_at) < t.pncp_updated_at            then 'tender_changed'
         when count(i.tender_id) > 0                               then 'fresh'
         when m.synced_at is null                                  then 'never'
         when m.synced_at < now() - interval '{ITEMS_TTL_HOURS} hours'
                                                                   then 'ttl'
         when t.pncp_updated_at is not null
              and m.synced_at < t.pncp_updated_at                  then 'tender_changed'
         else 'fresh'
       end as reason
  from tenders t
  left join tender_items i on i.tender_id = t.id
 cross join (select max(created_at) as synced_at from events where name = %(event)s) m
 where t.id = %(tender_id)s
 group by t.id, m.synced_at
"""


def read_state(conn: psycopg.Connection, tender_id: str) -> TenderState:
    """Whether this tender's items need fetching, and what the roll-up needs.

    ``min(updated_at)`` rather than ``max``: a fetch that died half way through
    leaves some rows fresh and some old, and the old ones are the truth about
    whether the set is complete.

    **Zero rows is not the same question.** A tender with no `tender_items` has
    no `updated_at` to age, so freshness there comes from the marker
    :func:`licitaqui.items.mark_synced` writes — *when did we last read PNCP*,
    not *when did a row change*. Without it a tender that genuinely has no items
    (or whose items endpoint 404s) reads as stale forever and is re-fetched on
    every sweep. `max()` over no rows still returns a row holding NULL, so the
    cross join cannot hide the tender.
    """
    row = conn.execute(
        STATE_SQL, {"tender_id": tender_id, "event": sync_event_name(tender_id)}
    ).fetchone()
    if row is None:
        return TenderState(exists=False)
    estimated_value, object_text, item_count, reason = row
    return TenderState(
        exists=True,
        estimated_value=estimated_value,
        object_text=object_text,
        item_count=int(item_count),
        reason=reason,
    )


def build_client() -> PncpClient:
    """The client one run uses. A seam, exactly as in :mod:`licitaqui.sync_tenders`."""
    return PncpClient()


@REGISTRY.job("sync_items")
def sync_items(ctx: JobContext) -> None:
    """Fetch, classify and roll up one tender's items.

    Payload:

    ``tender_id``
        The `numeroControlePNCP`. Defaults to the job's ``key``, which is what
        B2's follow-up sets it to, so a hand-enqueued job needs only the key.
    ``force``
        Ignore the 12 h TTL. For operators re-running a tender by hand, and for
        the tests.
    """
    payload = ctx.payload
    tender_id = str(payload.get("tender_id") or ctx.job.key)
    force = bool(payload.get("force"))

    state = read_state(ctx.conn, tender_id)
    if not state.exists:
        # The sweep enqueues by id, so this only happens if the tender was
        # deleted between the two. Failing would retry four times over 40
        # minutes against a row that is never coming back.
        ctx.log.warning("sync_items: unknown tender, nothing to do", extra={"tender_id": tender_id})
        return
    if not state.stale and not force:
        ctx.log.info(
            "sync_items: items are fresh",
            extra={"tender_id": tender_id, "items": state.item_count, "ttl_hours": ITEMS_TTL_HOURS},
        )
        return

    cnpj, year, sequence = split_control_number(tender_id)
    absent: absence.Absence | None = None
    with build_client() as client:
        try:
            records = list(client.iter_items(cnpj, year, sequence))
        except PncpNotFound as exc:
            # Ambiguous by itself; :mod:`licitaqui.absence` has the rule and
            # makes at most one more request to settle it.
            absent = absence.classify(
                client,
                tender_id=tender_id,
                cnpj=cnpj,
                year=year,
                sequence=sequence,
                stored_rows=state.item_count,
                error=exc,
            )
            records = []

    if absent is not None and absent.is_regression:
        # Nothing has been written. Fail loudly rather than pruning rows PNCP
        # has merely stopped admitting to.
        ctx.log.error(
            "sync_items: stored items vanished from PNCP",
            extra={"tender_id": tender_id, **absent.log_fields()},
        )
        raise absence.DataVanished(absent.detail)

    items: list[TenderItem] = classify_all(tender_id, records)
    upsert_items(ctx.conn, tender_id, items)
    summary = roll_up(
        ctx.conn,
        tender_id,
        items,
        estimated_value=state.estimated_value,
        object_text=state.object_text,
    )
    # The marker is what stops the next sweep re-enqueuing a tender whose item
    # list is legitimately empty — see :func:`read_state`.
    marker = {"items": len(items), "removed": max(state.item_count - len(items), 0)}
    if absent is not None:
        marker |= absent.log_fields()
    mark_synced(ctx.conn, tender_id, marker)

    extra = {
        "tender_id": tender_id,
        "reason": state.reason if not force else "forced",
        "fetched": len(records),
        "stored": len(items),
        "removed": max(state.item_count - len(items), 0),
        **_summary_extra(summary),
        **(absent.log_fields() if absent is not None else {}),
    }
    if absent is None:
        ctx.log.info("sync_items finished", extra=extra)
    else:
        # Worth a warning: this tender is on the Radar with no items at all,
        # and one of the reasons that can be is that it no longer exists.
        ctx.log.warning("sync_items: PNCP has no items for this tender", extra=extra)


def _summary_extra(summary: dict[str, Any]) -> dict[str, Any]:
    return {
        "me_epp_summary": summary["me_epp_summary"],
        "favored_treatment": summary["favored_treatment"],
        "segments": summary["segments"],
    }
