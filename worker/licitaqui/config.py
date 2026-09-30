"""Worker configuration: tunables and secret resolution.

Secrets are resolved the way ``db/migrate.py`` resolves its own connection
string: the process environment wins, then the gitignored env files in the
repository root, strictly by variable priority (never by the order the lines
happen to appear in a file). Resolved values are returned to the caller and are
never logged. Put anything that may embed credentials through :func:`redact`
before it reaches a log line, an error column or Sentry.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

# worker/licitaqui/config.py -> worker/licitaqui -> worker -> repository root
ROOT = Path(__file__).resolve().parents[2]
ENV_FILES = (".env.neon-roles.local", ".env.local")

# The worker talks to Neon over a direct (non-pooled) connection: spec §5.1.
WORKER_DSN_VARS = ("WORKER_DATABASE_URL", "DATABASE_URL_UNPOOLED")
WAKE_TOKEN_VAR = "WORKER_WAKE_TOKEN"
SENTRY_DSN_VAR = "SENTRY_DSN_WORKER"

# Idle poll interval, and the single largest line on the Neon bill.
#
# **Two minutes could never work, and the arithmetic says so.** Neon suspends
# the compute after **five minutes** with no connections (spec §5.1, "scale to
# zero after 5 min"). A consumer that reconnects every 120 s resets that timer
# before it can ever fire, so the endpoint stayed awake 24/7: 0.25 CU × 168 h =
# **42 CU-hours a week**, against the 48.93 actually observed over the seven
# days to 2026-09-27. The design budgeted for sleep — "the database must be
# allowed to sleep" — and its own poll interval prevented it.
#
# The compute ran at 0.02 of 0.25 vCPU throughout. We were never paying for
# queries; we were paying for an endpoint that never slept.
#
# **Why 3600 since 2026-09-30, and why it could not have been 3600 before.**
# The earlier value was 1800, and the note here said 30 minutes was the wake
# floor whatever this said, because `scheduler.py` enqueued `sync_open_tenders`
# and `sweep_tender_values` every 30 minutes and opened a connection each time.
# That was true, and it hid the real problem: the scheduler and the consumers
# were **two independent reasons to wake Neon**, unsynchronised. Neon suspends
# after five minutes with no connections, so every wake costs a five-minute
# tail whether or not there is work in it. Measured on 2026-09-30: 5.5 h/day of
# compute, of which roughly 4 h was tail and 1.5 h was work.
#
# Two changes, and the order matters. `Scheduler.on_enqueue` now notifies the
# same `WakeSignal` that `POST /wake` does, so a tick that enqueues something
# starts the consumer **in the same wake window**. Raising this interval on its
# own would have been the silent degradation this note used to warn about — a
# scheduled sync sitting unprocessed until the next poll, so an hourly sync
# becomes two-hourly. With the notify in place the poll is no longer how
# scheduled work is discovered; it is the safety net under a lost notify.
#
# Then the two half-hourly entries moved to hourly. Wakes drop from roughly 48
# a day to 24, which is about a third off the compute line. Sci, 2026-09-30:
# *"we need to kept the cost tiny - its a new application without paid user
# yet"*.
#
# **What this still costs.** A retry waits for the next poll, and the backoff
# is 120/480/1800, so a retry can now sit up to an hour instead of up to
# thirty minutes. For the kinds that actually retry — `sync_items` and
# `sync_files` behind an open `pncp-*` breaker — a longer wait is if anything
# the kinder behaviour.
#
# **Nobody waiting on screen is affected — and this is now actually true.**
# A priority-1 job is woken by `apps/web/lib/jobs/index.ts`, which posts to
# `/wake` from inside `enqueueJob` itself.
#
# **The sentence above used to be false, and this interval was raised on the
# strength of it.** The wake lived one layer up, in `lib/cache.ts`, so every
# caller that skipped the cache skipped the wake — and `lib/radar/screening.ts`
# is exactly that caller. The AI triagem, the one job a person sits and
# watches, woke nothing and waited for this poll: **24 minutes on 2026-09-30**,
# with "a triagem está demorando mais que o normal" on screen. The
# infrastructure was fine throughout — `POST /wake` answers
# `202 {"woken": true}` — nothing was calling it.
#
# Moving the wake into `enqueueJob` is what makes a long interval safe: that
# is the only place a job can be created, and therefore the only place a
# future caller cannot forget. This interval now bounds **background** work
# only — sweeps and follow-ups, which nobody is waiting for. Idle sleeps; a
# person's request wakes it.
#
# Override with `WORKER_POLL_INTERVAL_SECONDS` (read in `service.py`) to tune
# without a deploy — which is how to shorten it for the evening of 08/10.
DEFAULT_POLL_INTERVAL_SECONDS = 3600.0
# Pause before retrying after the database itself failed, so an outage does not
# turn into a hot reconnect loop.
DEFAULT_ERROR_PAUSE_SECONDS = 30.0

# Timeouts from spec §7.2.
DEFAULT_CONNECT_TIMEOUT_SECONDS = 15
DEFAULT_STATEMENT_TIMEOUT_SECONDS = 30

# Retries: 4 attempts, backing off 2, 8 and 30 minutes, then `failed` (§7.2).
MAX_ATTEMPTS = 4
BACKOFF_SECONDS: tuple[int, ...] = (120, 480, 1800)

# Circuit breaker: 2 consecutive failures on an endpoint open it for 15 min.
BREAKER_FAILURE_THRESHOLD = 2
BREAKER_RESET_SECONDS = 900.0

# A job still `running` after this long belongs to a consumer that died; it is
# put back on the queue. Longer than any job we expect to run (a PNCP download
# was once measured at 929 s).
STALE_RUNNING_SECONDS = 3600

DEFAULT_PORT = 8080

# Consumer threads, and **the only lever on the Neon compute bill** (card B28).
#
# Neon charges for wall-clock time the endpoint is awake, not for query time.
# Measured 2026-09-30 from the System-operations log: awake **61% of the day**
# across ~57 wake cycles, 6.96 CU-h/day — while the whole query board totals
# under a minute. `consumer.drain()` holds **one** connection for the entire
# batch, so the endpoint stays up for each job's PNCP HTTP call, which is
# seconds against 1.7 ms of SQL.
#
# **Closing the connection between jobs makes it worse, not better.** Neon
# bills a five-minute tail after the last connection closes, and **300 s is the
# floor on Launch** — 60/90/120/180/240 s are refused outright ("suspend
# interval is too short for your plan"). Ten thousand short connections would
# be ten thousand tails. Batching inside a drain buys nothing either: anything
# happening inside five minutes keeps the endpoint up regardless.
#
# So the only thing that shortens the awake window is finishing sooner. At 1
# thread the measured rate is 15-24 jobs/min, which made the 10 758-job backlog
# after the 30/09 outage an ~8-hour drain and ~8 hours of billed compute.
#
# **2, not 4.** The ceiling is not CPU, it is PNCP: `pncp-arquivos` and
# `pncp-itens` already open their breakers under one thread, and doubling the
# request rate is the risk this change carries. The breakers and per-endpoint
# throttles are the safety net, and B28's acceptance is that breaker-open
# counts do **not** rise. Raise it further only with that number in hand.
#
# `WORKER_CONCURRENCY` overrides without a deploy, which is how to back this
# out in one Easypanel restart if PNCP complains.
DEFAULT_CONCURRENCY = 2
APPLICATION_NAME = "licitaqui-worker"

_CREDENTIALS_RE = re.compile(r"([a-z][a-z0-9+.-]*://[^:/@\s]+:)[^@\s]*@", re.IGNORECASE)


def redact(text: str) -> str:
    """Replace the password of any connection string embedded in ``text``."""
    return _CREDENTIALS_RE.sub(r"\1***@", text)


def _from_file(path: Path, var: str) -> str | None:
    if not path.exists():
        return None
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith(f"{var}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None


def resolve_secret(
    *names: str, root: Path = ROOT, files: tuple[str, ...] = ENV_FILES
) -> str | None:
    """First value found for ``names``, honouring the order of ``names``.

    Each name is looked up in the environment and then in every env file before
    moving on to the next name, so a variable defined anywhere wins over a
    lower-priority one defined in the same place.
    """
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
        for fname in files:
            value = _from_file(root / fname, name)
            if value:
                return value
    return None


def require_secret(*names: str) -> str:
    value = resolve_secret(*names)
    if not value:
        raise RuntimeError(
            f"set one of {' or '.join(names)} (environment, or {', '.join(ENV_FILES)})"
        )
    return value


def worker_dsn() -> str:
    """Connection string for the worker, as the DML-only `app` role."""
    return require_secret(*WORKER_DSN_VARS)


def wake_token() -> str | None:
    """Shared secret for ``POST /wake``. Unset means the endpoint refuses."""
    return resolve_secret(WAKE_TOKEN_VAR)


def sentry_dsn() -> str | None:
    return resolve_secret(SENTRY_DSN_VAR)


#: Where a link in an outbound message points (spec §9). Overridable so a
#: preview deployment can send links to itself without a code change — the
#: same value `telegram_alerts.py` already resolves on its own. Kept here too,
#: rather than imported from there, so a business-logic module (`whatsapp.py`,
#: `email.py`) never has to reach into a sibling one for a single string.
APP_BASE_URL_VAR = "APP_BASE_URL"
DEFAULT_APP_BASE_URL = "https://www.licitaquiapp.com.br"


def app_base_url() -> str:
    return (os.environ.get(APP_BASE_URL_VAR) or DEFAULT_APP_BASE_URL).rstrip("/")


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return default if raw in (None, "") else int(raw)


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return default if raw in (None, "") else float(raw)


def env_list(name: str) -> tuple[str, ...] | None:
    """Comma-separated list, or ``None`` when the variable is unset or empty."""
    raw = os.environ.get(name, "")
    items = tuple(part.strip() for part in raw.split(",") if part.strip())
    return items or None


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw in (None, ""):
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}
