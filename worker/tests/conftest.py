"""Shared fixtures.

Integration tests run against the isolated Neon test database named by
``TEST_DATABASE_URL``, resolved the same way ``db/migrate.py`` resolves its own
connection string. The value is never printed, logged or written anywhere. When
it is not configured (CI, a fresh clone) those tests skip.

Every row a test creates uses a key starting with ``KEY_PREFIX`` and is deleted
again by the ``clean_jobs`` fixture, so tests never touch anyone else's rows.
"""

from __future__ import annotations

import os
import subprocess
import uuid
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest

from licitaqui import config

#: Scopes every row this pytest process creates.
#:
#: It must be per **run**, not per task. These were module constants, so cleanup
#: deleted by task prefix and two concurrent runs of this same suite wiped each
#: other's fixtures mid-test — the intermittent failures in
#: ``test_integration_queue`` and ``test_integration_consumer`` (measured on
#: main: 2 failures in run 1, 0 in runs 2 and 3 of an identical sequence).
#:
#: Anything writing to a shared database must scope its rows this way.
RUN_ID = uuid.uuid4().hex[:8]

KEY_PREFIX = f"b1-test-{RUN_ID}-"
KIND_PREFIX = f"b1t_{RUN_ID}_"
TEST_DSN_VAR = "TEST_DATABASE_URL"

#: B5 has its own isolated database so two tasks' suites cannot collide.
B5_DSN_VAR = "TEST_DATABASE_URL_B5"


class Dsn(str):
    """A connection string that cannot be printed by accident.

    pytest renders fixture values and dataclass fields in tracebacks, which
    would put the test database's credentials in CI output. This behaves as the
    string everywhere it is used and hides itself everywhere it is shown.
    """

    __slots__ = ()

    def __repr__(self) -> str:
        return "'<redacted connection string>'"


def _candidate_roots() -> tuple[Path, ...]:
    """Where an env file may live: this checkout, and the main one.

    The worker resolves its own connection string relative to its checkout, the
    way ``db/migrate.py`` does. Tests may run from a git worktree, where the
    gitignored env files sit in the main checkout, so look there as well rather
    than teaching production code about worktrees.
    """
    roots = [config.ROOT]
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=config.ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return tuple(roots)
    if common:
        main_root = Path(common).parent
        if main_root not in roots:
            roots.append(main_root)
    return tuple(roots)


@pytest.fixture(scope="session")
def test_dsn() -> str:
    for root in _candidate_roots():
        dsn = config.resolve_secret(TEST_DSN_VAR, root=root)
        if dsn:
            return Dsn(dsn)
    pytest.skip(f"{TEST_DSN_VAR} is not configured; skipping database integration tests")


@pytest.fixture(scope="session")
def b5_dsn() -> str:
    """The B5 task's own database. Never printed: see :class:`Dsn`."""
    for root in _candidate_roots():
        dsn = config.resolve_secret(B5_DSN_VAR, root=root)
        if dsn:
            return Dsn(dsn)
    pytest.skip(f"{B5_DSN_VAR} is not configured; skipping database integration tests")


@pytest.fixture
def clean_dsn(test_dsn: str) -> Iterator[str]:
    """The test DSN, with this test's rows deleted before and after it runs."""
    _delete_test_jobs(test_dsn)
    try:
        yield test_dsn
    finally:
        _delete_test_jobs(test_dsn)


@pytest.fixture
def connect(clean_dsn: str):
    """Connection factory bound to the test database."""
    from licitaqui import db

    return db.factory(clean_dsn, application_name=f"licitaqui-test-{os.getpid()}")


@pytest.fixture
def conn(connect) -> Iterator[psycopg.Connection]:
    with connect() as connection:
        yield connection


def _delete_test_jobs(dsn: str) -> None:
    """Remove only rows this task's tests created.

    The test database is shared with other tasks' test runs, so deletes are
    scoped by prefix and never truncate the table.
    """
    with psycopg.connect(dsn, autocommit=True, connect_timeout=15) as conn:
        conn.execute(
            "delete from jobs where starts_with(key, %s) or starts_with(kind, %s)",
            (KEY_PREFIX, KIND_PREFIX),
        )


# -- B2: the sync's own database ------------------------------------------
#
# B2 has an isolated database of its own so a sweep test can write `tenders`
# rows without colliding with B1's queue tests, which share `jobs` in another.
# The variable is resolved and wrapped in `Dsn` exactly like B1's, and for the
# same reason: pytest renders fixture values into tracebacks, and a DSN that
# reaches a transcript is a leaked credential.
B2_TEST_DSN_VAR = "TEST_DATABASE_URL_B2"

#: Every tender a B2 test writes belongs to this fictitious agency, so the
#: cleanup can delete exactly this **run's** rows and nothing else. It is not a
#: valid CNPJ and matches nothing real in PNCP.
#:
#: Per run, not per task. As a constant it scoped cleanup by task, so two
#: concurrent runs of this suite deleted each other's tenders mid-test — the
#: intermittent `test_integration_sync_tenders` failures that cost B5, B2, B6
#: and C1 time apiece. B5's suite writes to this database too, which is how a
#: "B2-only" constant still collided.
B2_CNPJ = f"99{int(RUN_ID, 16):012d}"[:14]
#: …and every watermark it writes is scoped to this fictitious UF.
#:
#: Two letters derived from RUN_ID rather than a constant "ZZ". `tenders.state`
#: is char(2) and `scope_key` builds the watermark key from it, so this is the
#: only run-scoping the column has room for: it takes a collision between two
#: concurrent runs from certain to roughly 1 in 676. Not a real UF in practice,
#: and harmless if it ever matched one — these rows only exist in test
#: databases, and cleanup matches this exact value.
B2_UF = "".join(chr(ord("A") + (int(RUN_ID, 16) >> (5 * i)) % 26) for i in (0, 1))


@pytest.fixture(scope="session")
def b2_dsn() -> str:
    for root in _candidate_roots():
        dsn = config.resolve_secret(B2_TEST_DSN_VAR, root=root)
        if dsn:
            return Dsn(dsn)
    pytest.skip(f"{B2_TEST_DSN_VAR} is not configured; skipping B2 database tests")


@pytest.fixture
def b2_clean_dsn(b2_dsn: str) -> Iterator[str]:
    """B2's test DSN, with this task's rows deleted before and after the test."""
    _delete_b2_rows(b2_dsn)
    try:
        yield b2_dsn
    finally:
        _delete_b2_rows(b2_dsn)


@pytest.fixture
def b2_connect(b2_clean_dsn: str):
    from licitaqui import db

    return db.factory(b2_clean_dsn, application_name=f"licitaqui-b2-test-{os.getpid()}")


@pytest.fixture
def b2_conn(b2_connect) -> Iterator[psycopg.Connection]:
    with b2_connect() as connection:
        yield connection


def _delete_b2_rows(dsn: str) -> None:
    """Remove only the rows B2's tests create. Never truncates."""
    with psycopg.connect(dsn, autocommit=True, connect_timeout=15) as conn:
        conn.execute("delete from tenders where agency_cnpj = %s", (B2_CNPJ,))
        conn.execute(
            "delete from events where name like %s and props ->> 'scope' like %s",
            ("sync_open_tenders.%", f"{B2_UF}:%"),
        )
        conn.execute(
            "delete from jobs where kind in ('sync_items', 'sync_files') and key like %s",
            (f"{B2_CNPJ}-%",),
        )


def unique_key(label: str = "") -> str:
    return f"{KEY_PREFIX}{label}{uuid.uuid4().hex[:12]}"


def unique_kind(label: str = "") -> str:
    """A job kind nobody else is using.

    Consumers in these tests are restricted to their own kind, so a test never
    claims — and never disturbs — a row another task's test run created.
    """
    return f"{KIND_PREFIX}{label}{uuid.uuid4().hex[:10]}"


# -- B3: the items sync's own database ------------------------------------
#
# B3 has an isolated database of its own, for the same reason B2 does, and its
# rows are scoped per **run** rather than by a task constant: `B3_CNPJ` carries
# `RUN_ID`, so two concurrent runs of this suite write under different
# fictitious agencies and neither cleanup can touch the other's fixtures.
B3_TEST_DSN_VAR = "TEST_DATABASE_URL_B3"

#: `99` + this run's id as digits. Not a valid CNPJ and matching nothing in
#: PNCP, so `tenders` written here can never be confused with real data.
B3_CNPJ = f"99{int(RUN_ID, 16):012d}"[:14]


@pytest.fixture(scope="session")
def b3_dsn() -> str:
    for root in _candidate_roots():
        dsn = config.resolve_secret(B3_TEST_DSN_VAR, root=root)
        if dsn:
            return Dsn(dsn)
    pytest.skip(f"{B3_TEST_DSN_VAR} is not configured; skipping B3 database tests")


@pytest.fixture
def b3_clean_dsn(b3_dsn: str) -> Iterator[str]:
    """B3's test DSN, with this run's rows deleted before and after the test."""
    _delete_b3_rows(b3_dsn)
    try:
        yield b3_dsn
    finally:
        _delete_b3_rows(b3_dsn)


@pytest.fixture
def b3_connect(b3_clean_dsn: str):
    from licitaqui import db

    return db.factory(b3_clean_dsn, application_name=f"licitaqui-b3-test-{os.getpid()}")


@pytest.fixture
def b3_conn(b3_connect) -> Iterator[psycopg.Connection]:
    with b3_connect() as connection:
        yield connection


def _delete_b3_rows(dsn: str) -> None:
    """Remove this run's rows, and any a killed run left behind. Never truncates.

    `tender_items` goes with the tender (`on delete cascade`). The second
    statement is the only cross-run delete and it is deliberately narrow: the
    fictitious `99…` agency family belongs to these tests alone, and an hour is
    far longer than the suite takes, so it can only ever catch a crashed run.
    """
    with psycopg.connect(dsn, autocommit=True, connect_timeout=15) as conn:
        conn.execute("delete from tenders where agency_cnpj = %s", (B3_CNPJ,))
        conn.execute(
            "delete from tenders where agency_cnpj like '99%%' "
            "  and updated_at < now() - interval '1 hour'"
        )
        conn.execute(
            "delete from jobs where kind = 'sync_items' and key like %s", (f"{B3_CNPJ}-%",)
        )


# -- B6: the CNAE → segment map's own database -----------------------------
#
# B6 writes `companies` rows to exercise the `company_segments` view, so it
# needs a database where B5's company tests are not writing the same table.
# Resolved and wrapped in `Dsn` exactly like the others: a DSN that reaches a
# traceback is a leaked credential.
B6_TEST_DSN_VAR = "TEST_DATABASE_URL_B6"

#: Every company a B6 test writes has a `cnpj` starting with this prefix, so
#: cleanup deletes exactly this run's rows and never anyone else's.
#:
#: Per **run**, not per task (see RUN_ID above), and deliberately **not all
#: digits**: a run-scoped prefix of digits could in principle prefix-match a
#: real CNPJ, and this same database holds real supplier CNPJs while
#: `scripts/check_cnae_segments_live.py` runs. The leading letters make the
#: delete predicate unable to touch anything but these fixtures.
B6_CNPJ_PREFIX = f"b6t{RUN_ID}"


def b6_cnpj(suffix: str) -> str:
    """A 14-character test company id inside this run's prefix. Not a CNPJ.

    `companies.cnpj` is `char(14)` with no digits-only constraint, which is what
    lets these be unmistakably synthetic.
    """
    return f"{B6_CNPJ_PREFIX}{suffix.rjust(14 - len(B6_CNPJ_PREFIX), '0')}"[:14]


@pytest.fixture(scope="session")
def b6_dsn() -> str:
    for root in _candidate_roots():
        dsn = config.resolve_secret(B6_TEST_DSN_VAR, root=root)
        if dsn:
            return Dsn(dsn)
    pytest.skip(f"{B6_TEST_DSN_VAR} is not configured; skipping B6 database tests")


@pytest.fixture
def b6_clean_dsn(b6_dsn: str) -> Iterator[str]:
    """B6's test DSN, with this run's company rows deleted before and after."""
    _delete_b6_rows(b6_dsn)
    try:
        yield b6_dsn
    finally:
        _delete_b6_rows(b6_dsn)


@pytest.fixture
def b6_conn(b6_clean_dsn: str) -> Iterator[psycopg.Connection]:
    from licitaqui import db

    with db.factory(b6_clean_dsn, application_name=f"licitaqui-b6-test-{os.getpid()}")() as conn:
        yield conn


def _delete_b6_rows(dsn: str) -> None:
    """Remove only the companies this run created. Never truncates."""
    with psycopg.connect(dsn, autocommit=True, connect_timeout=15) as conn:
        conn.execute("delete from companies where starts_with(cnpj, %s)", (B6_CNPJ_PREFIX,))


# -- C1: the AI screening's own database ----------------------------------
#
# Same shape and the same reasons as B2's and B5's blocks above: an isolated
# database so two tasks' suites cannot collide, a `Dsn` wrapper so pytest cannot
# render the credentials into a traceback, and deletes scoped to rows this run
# created. `ai_analyses` rows go away with their tender (`on delete cascade`),
# so deleting the fictitious agency's tenders is enough.
C1_TEST_DSN_VAR = "TEST_DATABASE_URL_C1"

#: Not a valid CNPJ, and per **run** rather than a constant, so two concurrent
#: runs of this suite cannot delete each other's rows. The trailing `3` keeps it
#: distinct from B2's `…2` within the same run.
C1_CNPJ = f"99{int(RUN_ID, 16):011d}3"[:14]

#: Tender ids are scoped by RUN_ID as well, so two concurrent runs of this same
#: suite cannot delete each other's fixtures mid-test.
C1_TENDER_PREFIX = f"c1-test-{RUN_ID}-"


@pytest.fixture(scope="session")
def c1_dsn() -> str:
    for root in _candidate_roots():
        dsn = config.resolve_secret(C1_TEST_DSN_VAR, root=root)
        if dsn:
            return Dsn(dsn)
    pytest.skip(f"{C1_TEST_DSN_VAR} is not configured; skipping C1 database tests")


@pytest.fixture
def c1_clean_dsn(c1_dsn: str) -> Iterator[str]:
    _delete_c1_rows(c1_dsn)
    try:
        yield c1_dsn
    finally:
        _delete_c1_rows(c1_dsn)


@pytest.fixture
def c1_connect(c1_clean_dsn: str):
    from licitaqui import db

    return db.factory(c1_clean_dsn, application_name=f"licitaqui-c1-test-{os.getpid()}")


@pytest.fixture
def c1_conn(c1_connect) -> Iterator[psycopg.Connection]:
    with c1_connect() as connection:
        yield connection


def c1_tender_id(label: str = "") -> str:
    return f"{C1_TENDER_PREFIX}{label}{uuid.uuid4().hex[:8]}"


def _delete_c1_rows(dsn: str) -> None:
    """Remove only the rows *this run* created. Never truncates.

    Scoped by ``RUN_ID``, not by the fictitious CNPJ: deleting everything for
    the CNPJ would look isolated and would not be — two concurrent runs of this
    same suite would delete each other's fixtures mid-test, which is the flake
    described at the top of this file. Rows a crashed run left behind are swept
    by the second statement, which only touches rows too old to belong to a run
    still going. `ai_analyses` cascades from `tenders`.
    """
    with psycopg.connect(dsn, autocommit=True, connect_timeout=15) as conn:
        conn.execute("delete from tenders where starts_with(id, %s)", (C1_TENDER_PREFIX,))
        conn.execute(
            "delete from tenders where agency_cnpj = %s and updated_at < now() - interval '1 day'",
            (C1_CNPJ,),
        )
        conn.execute(
            "delete from jobs where kind = 'ai_screening' and starts_with(key, %s)",
            (f"screening:{C1_TENDER_PREFIX}",),
        )


# -- E2: WhatsApp (Evolution API) -----------------------------------------
#
# Same shape and the same reasons as every block above: an isolated database so
# two tasks' suites cannot collide, a `Dsn` wrapper so pytest cannot render the
# credentials into a traceback, and deletes scoped to rows *this run* created.
#
# E2 writes `founders_list`, which has two unique natural keys — `email citext
# unique` and `seat int unique`, capped at 48 — so run-scoping the rows is not
# optional here in the way it might feel elsewhere:
#
#   * the e-mail carries `RUN_ID`, so two concurrent runs cannot collide on the
#     unique index and cannot delete each other's founders;
#   * **no test takes a seat.** There are only 48 and they are global; two runs
#     both asking for seat 5 would fail on the unique index, and a run that
#     crashed holding seats would leave the next one with fewer. Test founders
#     are waitlisted (`seat is null`) and the seat number a welcome message
#     renders comes from the job payload, which is where F1 puts it anyway.
E2_TEST_DSN_VAR = "TEST_DATABASE_URL_E2"

#: Every founder an E2 test writes has an e-mail starting with this. Per
#: **run**, not per task (see RUN_ID): a task constant looks isolated and is not.
E2_EMAIL_PREFIX = f"e2-test-{RUN_ID}-"

#: The job kinds E2 owns, named here so cleanup cannot drift from the code.
E2_JOB_KINDS = ("send_whatsapp", "whatsapp_inbound")


def e2_email(label: str) -> str:
    """A run-scoped address on a domain reserved for documentation (RFC 2606)."""
    return f"{E2_EMAIL_PREFIX}{label}@example.com"


def e2_whatsapp(n: int) -> str:
    """A run-scoped number in the shape F1 stores (`+55` + area + 9 digits).

    It has to be *shaped* like a real mobile because that shape is what
    `evolution.normalise_number` and `whatsapp.resolve_number` are being tested
    on. Nothing ever dials it: the kill switch is off in this suite (see
    `_whatsapp_delivery_off`) and every send in it runs against an
    `httpx.MockTransport`.
    """
    subscriber = (int(RUN_ID, 16) + n) % 100_000_000
    return f"+5511 9{subscriber:08d}"


@pytest.fixture(autouse=True)
def _whatsapp_delivery_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """No test can send a WhatsApp message, whatever the shell has exported.

    Autouse and suite-wide on purpose. The kill switch (`WHATSAPP_DELIVERY`) is
    already off by default, so this changes nothing in CI; it exists for the
    machine where someone turned it on to send one real message and then ran
    `pytest`. Belt and braces around the only irreversible thing this worker
    does.
    """
    monkeypatch.delenv("WHATSAPP_DELIVERY", raising=False)


@pytest.fixture(scope="session")
def e2_dsn() -> str:
    for root in _candidate_roots():
        dsn = config.resolve_secret(E2_TEST_DSN_VAR, root=root)
        if dsn:
            return Dsn(dsn)
    pytest.skip(f"{E2_TEST_DSN_VAR} is not configured; skipping E2 database tests")


@pytest.fixture
def e2_clean_dsn(e2_dsn: str) -> Iterator[str]:
    """E2's test DSN, with this run's rows deleted before and after the test."""
    _delete_e2_rows(e2_dsn)
    try:
        yield e2_dsn
    finally:
        _delete_e2_rows(e2_dsn)


@pytest.fixture
def e2_connect(e2_clean_dsn: str):
    from licitaqui import db

    return db.factory(e2_clean_dsn, application_name=f"licitaqui-e2-test-{os.getpid()}")


@pytest.fixture
def e2_conn(e2_connect) -> Iterator[psycopg.Connection]:
    with e2_connect() as connection:
        yield connection


def _delete_e2_rows(dsn: str) -> None:
    """Remove this run's founders and everything hanging off them. Never truncates.

    `founders_list` has no cascades, and the delivery log lives in `events`
    keyed by `props ->> 'founders_list_id'`, so the ids have to be read before
    the founders go. The second sweep only catches rows a *crashed* run left
    behind: an hour is far longer than this suite takes.
    """
    with psycopg.connect(dsn, autocommit=True, connect_timeout=15) as conn:
        ids = [
            str(row[0])
            for row in conn.execute(
                "select id from founders_list where starts_with(email::text, %s)",
                (E2_EMAIL_PREFIX,),
            ).fetchall()
        ]
        if ids:
            conn.execute(
                "delete from events where starts_with(name, 'whatsapp.')"
                "   and props ->> 'founders_list_id' = any(%s)",
                (ids,),
            )
            conn.execute(
                "delete from jobs where kind = any(%s) and split_part(key, ':', 2) = any(%s)",
                (list(E2_JOB_KINDS), ids),
            )
        conn.execute(
            "delete from founders_list where starts_with(email::text, %s)", (E2_EMAIL_PREFIX,)
        )
        conn.execute(
            "delete from founders_list where starts_with(email::text, 'e2-test-')"
            "   and created_at < now() - interval '1 hour'"
        )


# -- B4: the file sync's own database --------------------------------------
#
# Same shape and the same reasons as the blocks above: an isolated database so
# two tasks' suites cannot collide, a `Dsn` wrapper so pytest cannot render the
# credentials into a traceback, and deletes scoped to rows *this run* created.
#
# B4 writes three things — `tender_files` (which cascades from `tenders`), the
# per-tender sync marker in `events`, and `ai_analyses` rows in the amendment
# test (which cascades too). Every one of them is reachable from a tender id
# carrying `RUN_ID`, so the cleanup keys on that and never on a task constant:
# a task-scoped prefix looks isolated and is not, and two concurrent runs of
# this suite would delete each other's fixtures mid-test.
B4_TEST_DSN_VAR = "TEST_DATABASE_URL_B4"

#: Not a valid CNPJ, per **run**, and with a trailing `4` so it stays distinct
#: from B2's `…2` and C1's `…3` inside the same run.
B4_CNPJ = f"99{int(RUN_ID, 16):011d}4"[:14]

#: Tender ids are run-scoped too, and the ids B4 uses have to look like real
#: `numeroControlePNCP` values because `split_control_number` parses them. The
#: run id therefore rides in the CNPJ, and this prefix is what cleanup matches.
B4_TENDER_PREFIX = f"{B4_CNPJ}-"


@pytest.fixture(scope="session")
def b4_dsn() -> str:
    for root in _candidate_roots():
        dsn = config.resolve_secret(B4_TEST_DSN_VAR, root=root)
        if dsn:
            return Dsn(dsn)
    pytest.skip(f"{B4_TEST_DSN_VAR} is not configured; skipping B4 database tests")


@pytest.fixture
def b4_clean_dsn(b4_dsn: str) -> Iterator[str]:
    """B4's test DSN, with this run's rows deleted before and after the test."""
    _delete_b4_rows(b4_dsn)
    try:
        yield b4_dsn
    finally:
        _delete_b4_rows(b4_dsn)


@pytest.fixture
def b4_connect(b4_clean_dsn: str):
    from licitaqui import db

    return db.factory(b4_clean_dsn, application_name=f"licitaqui-b4-test-{os.getpid()}")


@pytest.fixture
def b4_conn(b4_connect) -> Iterator[psycopg.Connection]:
    with b4_connect() as connection:
        yield connection


def _delete_b4_rows(dsn: str) -> None:
    """Remove this run's rows, and any a killed run left behind. Never truncates.

    `tender_files` and `ai_analyses` go with the tender (`on delete cascade`);
    the sync markers in `events` have no foreign key, so they are deleted by the
    same run-scoped name prefix `licitaqui.files.sync_event_name` builds. The
    cross-run statements are deliberately narrow — the fictitious `99…` agency
    family belongs to these tests alone, and an hour is far longer than the
    suite takes, so they can only ever catch a crashed run.
    """
    with psycopg.connect(dsn, autocommit=True, connect_timeout=15) as conn:
        conn.execute("delete from tenders where agency_cnpj = %s", (B4_CNPJ,))
        conn.execute(
            "delete from tenders where agency_cnpj like '99%%' "
            "  and updated_at < now() - interval '1 hour'"
        )
        conn.execute(
            "delete from events where starts_with(name, %s)", (f"sync_files:{B4_TENDER_PREFIX}",)
        )
        conn.execute(
            "delete from events where starts_with(name, 'sync_files:99') "
            "  and created_at < now() - interval '1 hour'"
        )
        conn.execute(
            "delete from jobs where kind = 'sync_files' and key like %s", (f"{B4_TENDER_PREFIX}%",)
        )


# -- B4B/DL: the download-and-extract suite's own database ------------------
#
# Same shape and the same reasons as every block above: an isolated database so
# two tasks' suites cannot collide, a `Dsn` wrapper so pytest cannot render the
# credentials into a traceback, and deletes scoped to rows *this run* created.
#
# This suite drives the whole broken path end to end — `tender_files` rows, the
# B4 sync marker in `events`, the `ai_screening` and `extract_text` job rows,
# and the `ai_analyses` row the user is waiting for. Every one of them hangs off
# a tender id carrying `RUN_ID`, so the cleanup keys on that and never on a task
# constant: a task-scoped prefix looks isolated and is not, and two concurrent
# runs of this suite would delete each other's fixtures mid-test.
#
# Nothing in this suite reaches PNCP, S3 or OpenRouter: the PDFs are built by
# `tests/pdfs.py`, the downloads run against an `httpx.MockTransport`, the
# object store is an in-memory fake, and the model call is stubbed.
DL_TEST_DSN_VAR = "TEST_DATABASE_URL_DL"

#: Not a valid CNPJ, per **run**, and with a trailing `5` so it stays distinct
#: from B2's `…2`, C1's `…3` and B4's `…4` inside the same run.
DL_CNPJ = f"99{int(RUN_ID, 16):011d}5"[:14]

#: Tender ids have to look like a real `numeroControlePNCP` — `split_control_number`
#: parses them — so the run id rides in the CNPJ and this prefix is what cleanup
#: matches.
DL_TENDER_PREFIX = f"{DL_CNPJ}-"

#: The job kinds this suite can create, named here so cleanup cannot drift.
DL_JOB_KINDS = ("ai_screening", "extract_text", "sync_files")


def dl_tender_id(sequence: int = 1) -> str:
    """A run-scoped id shaped like `numeroControlePNCP`: `<cnpj>-1-<seq>/<year>`."""
    return f"{DL_TENDER_PREFIX}1-{sequence:06d}/2026"


@pytest.fixture(scope="session")
def dl_dsn() -> str:
    for root in _candidate_roots():
        dsn = config.resolve_secret(DL_TEST_DSN_VAR, root=root)
        if dsn:
            return Dsn(dsn)
    pytest.skip(f"{DL_TEST_DSN_VAR} is not configured; skipping DL database tests")


@pytest.fixture
def dl_clean_dsn(dl_dsn: str) -> Iterator[str]:
    """The DL test DSN, with this run's rows deleted before and after the test."""
    _delete_dl_rows(dl_dsn)
    try:
        yield dl_dsn
    finally:
        _delete_dl_rows(dl_dsn)


@pytest.fixture
def dl_connect(dl_clean_dsn: str):
    from licitaqui import db

    return db.factory(dl_clean_dsn, application_name=f"licitaqui-dl-test-{os.getpid()}")


@pytest.fixture
def dl_conn(dl_connect) -> Iterator[psycopg.Connection]:
    with dl_connect() as connection:
        yield connection


def _delete_dl_rows(dsn: str) -> None:
    """Remove this run's rows, and any a killed run left behind. Never truncates.

    `tender_files` and `ai_analyses` go with the tender (`on delete cascade`).
    The `events` markers and the `jobs` rows have no foreign key, so they are
    deleted by the same run-scoped prefixes the code builds them from. The
    cross-run statements are deliberately narrow — the fictitious `99…` agency
    family belongs to these tests alone, and an hour is far longer than the
    suite takes, so they can only ever catch a crashed run.
    """
    with psycopg.connect(dsn, autocommit=True, connect_timeout=15) as conn:
        conn.execute("delete from tenders where agency_cnpj = %s", (DL_CNPJ,))
        conn.execute(
            "delete from tenders where agency_cnpj like '99%%' "
            "  and updated_at < now() - interval '1 hour'"
        )
        conn.execute(
            "delete from events where starts_with(name, %s)", (f"sync_files:{DL_TENDER_PREFIX}",)
        )
        conn.execute(
            "delete from events where starts_with(name, 'sync_files:99') "
            "  and created_at < now() - interval '1 hour'"
        )
        conn.execute(
            "delete from jobs where kind = any(%s)"
            "   and (starts_with(key, %s) or starts_with(key, %s))",
            (list(DL_JOB_KINDS), DL_TENDER_PREFIX, f"screening:{DL_TENDER_PREFIX}"),
        )
