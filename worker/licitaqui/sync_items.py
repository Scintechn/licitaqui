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
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import psycopg

from .items import TenderItem, classify_all, roll_up, upsert_items
from .pncp import PncpClient
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
         when count(i.tender_id) = 0                              then 'no_items'
         when min(i.updated_at) < now() - interval '{ITEMS_TTL_HOURS} hours' then 'ttl'
         when t.pncp_updated_at is not null
              and min(i.updated_at) < t.pncp_updated_at           then 'tender_changed'
         else 'fresh'
       end as reason
  from tenders t
  left join tender_items i on i.tender_id = t.id
 where t.id = %s
 group by t.id
"""


def read_state(conn: psycopg.Connection, tender_id: str) -> TenderState:
    """Whether this tender's items need fetching, and what the roll-up needs.

    ``min(updated_at)`` rather than ``max``: a fetch that died half way through
    leaves some rows fresh and some old, and the old ones are the truth about
    whether the set is complete.
    """
    row = conn.execute(STATE_SQL, (tender_id,)).fetchone()
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
    with build_client() as client:
        records = list(client.iter_items(cnpj, year, sequence))

    items: list[TenderItem] = classify_all(tender_id, records)
    upsert_items(ctx.conn, tender_id, items)
    summary = roll_up(
        ctx.conn,
        tender_id,
        items,
        estimated_value=state.estimated_value,
        object_text=state.object_text,
    )

    ctx.log.info(
        "sync_items finished",
        extra={
            "tender_id": tender_id,
            "reason": state.reason if not force else "forced",
            "fetched": len(records),
            "stored": len(items),
            "removed": max(state.item_count - len(items), 0),
            **_summary_extra(summary),
        },
    )


def _summary_extra(summary: dict[str, Any]) -> dict[str, Any]:
    return {
        "me_epp_summary": summary["me_epp_summary"],
        "favored_treatment": summary["favored_treatment"],
        "segments": summary["segments"],
    }
