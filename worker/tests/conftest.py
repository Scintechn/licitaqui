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

KEY_PREFIX = "b1-test-"
KIND_PREFIX = "b1t_"
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
#: cleanup can delete exactly this task's rows and nothing else. It is not a
#: valid CNPJ and matches nothing real in PNCP.
B2_CNPJ = "99000000000102"
#: …and every watermark it writes is scoped to this fictitious UF.
B2_UF = "ZZ"


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
