"""Built-in job kinds.

Only the trivial ones the skeleton needs to prove itself. The collector jobs
live in their own modules and register against the same :data:`REGISTRY`:
``sync_open_tenders`` (B2), ``sync_items`` (B3), ``sync_files`` (B4).
"""

from __future__ import annotations

from .registry import REGISTRY, JobContext


@REGISTRY.job("noop")
def noop(ctx: JobContext) -> None:
    """Do nothing successfully.

    Used to exercise the queue end to end — the `/wake` latency check enqueues
    one — and as the smallest possible example of a handler.
    """
    ctx.log.debug("noop", extra={"job_id": ctx.job.id, "key": ctx.job.key})
