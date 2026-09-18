"""LicitaQui worker: the job queue, its consumers and the collector jobs.

Module map (spec §7):

- ``config``        tunables and secret resolution (never logs a value)
- ``observability`` JSON logging and optional Sentry
- ``db``            short-lived psycopg 3 connections
- ``queue``         the `jobs` table: enqueue, claim, retry, fail
- ``registry``      job kind → handler, and the context a handler receives
- ``jobs``          built-in kinds (only ``noop`` so far)
- ``segments``      the 14 segments, false positives, per-item classification
- ``items``         `tender_items` rows and the ME/EPP + value roll-up
- ``sync_items``    the ``sync_items`` job (§7.1)
- ``brasilapi``     BrasilAPI's CNPJ endpoint: one lookup, sanitised errors
- ``company``       the ``company_lookup`` job (§7.1) and its 30-day cache
- ``consumer``      claim/run loop with the 2-minute idle poll
- ``breaker``       circuit breaker for external endpoints
- ``scheduler``     the process that only creates jobs
- ``server``        ``GET /health`` and authenticated ``POST /wake``
- ``service``       wires the above into one process

Submodules are imported explicitly; importing the package pulls in nothing.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
