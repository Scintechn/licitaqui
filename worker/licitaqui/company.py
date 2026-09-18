"""The ``company_lookup`` job: CNPJ → CNAEs, size and MEI status (§7.1).

Spec §3.2 caches a company for **30 days**, and says that *on failure the user
enters the CNAE*. ADR-0002 turned that into a measured decision: BrasilAPI is
the lookup, the manual CNAE form is the fallback **path**, not a rescue, and it
has to be a real path rather than a dead branch.

So this handler never raises for a lookup that simply did not work. It writes
what it knows and finishes `done`; retrying four times over forty minutes in
front of a user who could type their CNAE in ten seconds would be the wrong
trade. Only a bug (a malformed payload from our own caller, a database error)
raises and lets B1's retry/backoff do its job.

## How the manual path surfaces

`companies` (§6.2) has no status column and this task adds no migration, so the
fallback state is carried by the columns that already exist:

- **``main_cnae is null`` is the manual-CNAE flag.** It is the one predicate the
  Radar, R1 and B6 need — exported as :data:`MANUAL_CNAE_PREDICATE` so nobody
  has to re-derive it. A row exists (so the CNPJ is known and the job really
  ran), but no CNAE was resolved, so the user must supply one.
- **``registration_status`` says why**, with a namespaced value that cannot
  collide with a Receita status (``ATIVA``, ``SUSPENSA``, ``INAPTA``,
  ``BAIXADA``, ``NULA``): :data:`STATUS_NOT_FOUND` when the CNPJ does not exist
  (a typo — the user should fix the number, not invent a CNAE) and
  :data:`STATUS_FAILED` when BrasilAPI was unreachable, slow, throttled or
  behind an open circuit.

Two consequences worth stating, because they are easy to get wrong:

- A failed lookup **never overwrites a resolved row**. Stale-but-real CNAEs beat
  a placeholder (§3.1 answers with what we have), so the fallback upsert is
  guarded by ``where companies.main_cnae is null``.
- A fallback row expires after :data:`FALLBACK_TTL`, not the 30-day
  :data:`COMPANY_TTL`. "BrasilAPI was down at 09:14" is not a fact worth
  believing for a month.

``is_mei`` is three-state on a resolved row: ``true``, ``false``, and ``null``
for "no Simples/MEI registry entry" (ADR-0002 found this for a third of
companies). ``main_cnae is not null and is_mei is null`` is therefore "resolved,
MEI status genuinely unknown" and must not be rendered as "not a MEI".

## LGPD (§12)

The CNPJ never reaches a log line. B1's consumer logs every job's ``key``, so
the key is :func:`job_key` — a truncated SHA-256 of the CNPJ — and the CNPJ
itself travels in the payload, which is not logged. The same digest is logged as
``cnpj_ref`` so a support request can still be correlated. This is
pseudonymisation, not anonymisation: it keeps company identifiers out of stdout
and Sentry, and is not a defence against someone who already has the database.
Legal name, trade name and city are stored (the product shows them) but never
logged, and the address, phone, e-mail and ``qsa`` partner list in the payload
are never read at all.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from datetime import timedelta
from logging import Logger
from typing import Any

import psycopg

from . import brasilapi, cnae, queue
from .brasilapi import BrasilApiError, CompanyRecord
from .breaker import CircuitOpen, get_breaker
from .observability import get_logger
from .registry import REGISTRY, JobContext

JOB_KIND = "company_lookup"

#: Spec §3.2: a company is good for 30 days.
COMPANY_TTL = timedelta(days=30)
#: A failed lookup is not a 30-day fact. Re-attempt on the next request after this.
FALLBACK_TTL = timedelta(hours=6)

#: `registration_status` on a row that needs the manual CNAE form.
STATUS_NOT_FOUND = "lookup:not_found"
STATUS_FAILED = "lookup:failed"

#: The predicate R1/B6 should use for "this company needs the manual CNAE form".
MANUAL_CNAE_PREDICATE = "main_cnae is null"

_log = get_logger("company")

CACHE_SQL = """
select main_cnae is not null as resolved,
       registration_status,
       updated_at > now() - make_interval(
           secs => case when main_cnae is null then %(fallback_ttl)s else %(ttl)s end
       ) as fresh
  from companies
 where cnpj = %(cnpj)s
"""

# `segments` is deliberately absent from both the column list and the update:
# B6 owns that column and a refresh must not wipe its mapping.
UPSERT_SQL = """
insert into companies (cnpj, legal_name, trade_name, main_cnae, secondary_cnaes,
                       size, is_mei, state, city, registration_status, updated_at)
values (%(cnpj)s, %(legal_name)s, %(trade_name)s, %(main_cnae)s, %(secondary_cnaes)s,
        %(size)s, %(is_mei)s, %(state)s, %(city)s, %(registration_status)s, now())
on conflict (cnpj) do update
   set legal_name          = excluded.legal_name,
       trade_name          = excluded.trade_name,
       main_cnae           = excluded.main_cnae,
       secondary_cnaes     = excluded.secondary_cnaes,
       size                = excluded.size,
       is_mei              = excluded.is_mei,
       state               = excluded.state,
       city                = excluded.city,
       registration_status = excluded.registration_status,
       updated_at          = now()
"""

# The `where` is what stops an outage from replacing good CNAEs with a placeholder.
FALLBACK_SQL = """
insert into companies (cnpj, registration_status, updated_at)
values (%(cnpj)s, %(status)s, now())
on conflict (cnpj) do update
   set registration_status = excluded.registration_status,
       updated_at          = now()
 where companies.main_cnae is null
returning cnpj
"""


@dataclass(frozen=True, slots=True)
class LookupResult:
    """What one call to :func:`lookup` did.

    ``status`` is one of ``cached`` (fresh row, no request made), ``resolved``
    (BrasilAPI answered and the row now has CNAEs), ``manual_cnae`` (a fallback
    row is in place and the user must type their CNAE) or ``stale_kept`` (the
    lookup failed but an older resolved row survives, so §3.1 can still answer).
    """

    status: str
    reason: str | None = None
    called_api: bool = False

    @property
    def manual_cnae(self) -> bool:
        return self.status == "manual_cnae"


def cnpj_ref(cnpj: str) -> str:
    """A log-safe handle for a CNPJ. See the LGPD note in the module docstring."""
    return hashlib.sha256(cnpj.encode("ascii")).hexdigest()[:16]


def job_key(cnpj: str) -> str:
    """Dedupe key for the `jobs` row. Deterministic, and safe to log."""
    return f"company:{cnpj_ref(cnpj)}"


def enqueue(
    conn: psycopg.Connection,
    cnpj: str,
    *,
    priority: int = 1,
    force: bool = False,
) -> int | None:
    """Queue a lookup. Priority 1: a user is on screen waiting (§7.3).

    Returns the job id, or ``None`` when one is already queued or running for
    this CNPJ — which is the dedupe doing its job, not an error.
    """
    normalised = brasilapi.normalise_cnpj(cnpj)
    payload: dict[str, Any] = {"cnpj": normalised}
    if force:
        payload["force"] = True
    return queue.enqueue(conn, JOB_KIND, job_key(normalised), priority=priority, payload=payload)


def lookup(
    conn: psycopg.Connection,
    cnpj: str,
    *,
    force: bool = False,
    log: Logger | None = None,
) -> LookupResult:
    """Resolve one CNPJ against the cache, then BrasilAPI.

    Never raises for a lookup that merely failed; see the module docstring.
    """
    log = log or _log
    normalised = brasilapi.normalise_cnpj(cnpj)
    ref = cnpj_ref(normalised)

    if not force:
        cached = _cache_state(conn, normalised)
        if cached is not None and cached["fresh"]:
            result = LookupResult(
                status="cached" if cached["resolved"] else "manual_cnae",
                reason=None if cached["resolved"] else cached["registration_status"],
            )
            return _finish(log, ref, result, None)

    # A typo would spend a request on a free public API and then write a row
    # that blames BrasilAPI for it. Check the mod-11 digits first instead.
    if not brasilapi.has_valid_check_digits(normalised):
        result = _fallback(conn, normalised, STATUS_NOT_FOUND, "invalid_check_digits")
        return _finish(log, ref, result, None)

    started = time.monotonic()
    outcome: CompanyRecord | BrasilApiError
    try:
        with get_breaker(brasilapi.BREAKER_NAME).guard():
            try:
                outcome = brasilapi.lookup(normalised)
            except BrasilApiError as exc:
                if not exc.not_found:
                    raise
                # A 404 is the endpoint working correctly — this CNPJ does not
                # exist. Letting it out of the guard would open the circuit for
                # everyone after two typos, so it is handled as a result.
                outcome = exc
    except CircuitOpen:
        # Two consecutive failures already opened the circuit (§7.2). Do not
        # spend a timeout budget proving it again; go straight to the form.
        result = _fallback(conn, normalised, STATUS_FAILED, "circuit_open", called_api=False)
        return _finish(log, ref, result, started)
    except BrasilApiError as exc:
        result = _fallback(conn, normalised, STATUS_FAILED, exc.reason)
        return _finish(log, ref, result, started)

    if isinstance(outcome, BrasilApiError):
        result = _fallback(conn, normalised, STATUS_NOT_FOUND, outcome.reason)
        return _finish(log, ref, result, started)

    _upsert(conn, outcome)
    # B6: the CNAEs have just changed, so `segments` (§6.2) is now stale. It is
    # derived, cheap and read by the Radar, so it is refreshed here rather than
    # left for a later job — but never allowed to fail the lookup: a company
    # whose CNAEs were resolved is a good outcome even if the map is missing
    # (a database restored before migration 0003, say).
    # The savepoint matters: without it a failed refresh would abort the whole
    # transaction and take the upsert down with it.
    try:
        with conn.transaction():
            cnae.refresh_company_segments(conn, outcome.cnpj)
    except psycopg.Error as exc:
        log.warning(
            "segment refresh failed; CNAEs were stored",
            extra={"cnpj_ref": ref, "reason": type(exc).__name__},
        )
    return _finish(log, ref, LookupResult(status="resolved", called_api=True), started)


def _fallback(
    conn: psycopg.Connection,
    cnpj: str,
    status: str,
    reason: str | None,
    *,
    called_api: bool = True,
) -> LookupResult:
    """Put the manual-CNAE row in place, unless a resolved row should survive."""
    if _write_fallback(conn, cnpj, status):
        return LookupResult(status="manual_cnae", reason=reason, called_api=called_api)
    return LookupResult(status="stale_kept", reason=reason, called_api=called_api)


def _cache_state(conn: psycopg.Connection, cnpj: str) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            CACHE_SQL,
            {
                "cnpj": cnpj,
                "ttl": COMPANY_TTL.total_seconds(),
                "fallback_ttl": FALLBACK_TTL.total_seconds(),
            },
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {"resolved": row[0], "registration_status": row[1], "fresh": row[2]}


def _upsert(conn: psycopg.Connection, record: CompanyRecord) -> None:
    with conn.cursor() as cur:
        cur.execute(
            UPSERT_SQL,
            {
                "cnpj": record.cnpj,
                "legal_name": record.legal_name,
                "trade_name": record.trade_name,
                "main_cnae": record.main_cnae,
                "secondary_cnaes": list(record.secondary_cnaes),
                "size": record.size,
                "is_mei": record.is_mei,
                "state": record.state,
                "city": record.city,
                "registration_status": record.registration_status,
            },
        )


def _write_fallback(conn: psycopg.Connection, cnpj: str, status: str) -> bool:
    """``True`` when the fallback row is in place.

    ``False`` means the guarded upsert found a resolved row and kept it.
    """
    with conn.cursor() as cur:
        cur.execute(FALLBACK_SQL, {"cnpj": cnpj, "status": status})
        return cur.fetchone() is not None


def _finish(log: Logger, ref: str, result: LookupResult, started: float | None) -> LookupResult:
    extra: dict[str, Any] = {"cnpj_ref": ref, "status": result.status}
    if result.reason:
        extra["reason"] = result.reason
    if started is not None:
        extra["duration_ms"] = int((time.monotonic() - started) * 1000)
    if result.manual_cnae:
        log.warning("company lookup fell back to manual CNAE", extra=extra)
    else:
        log.info("company lookup", extra=extra)
    return result


@REGISTRY.job(JOB_KIND)
def company_lookup(ctx: JobContext) -> None:
    """Handler. Idempotent: the upsert is keyed on the CNPJ (§7.2)."""
    cnpj = ctx.payload.get("cnpj")
    if not cnpj:
        # A caller bug, not a lookup failure: let it retry and be visible.
        raise ValueError("company_lookup payload needs a 'cnpj'")
    lookup(ctx.conn, cnpj, force=bool(ctx.payload.get("force")), log=ctx.log)
