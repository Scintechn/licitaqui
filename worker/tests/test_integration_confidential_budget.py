"""`tenders.confidential_budget` must answer "we do not know" by default (B13).

Needs ``TEST_DATABASE_URL`` (see ``worker/README.md``); skips without it.

**These assert a schema property, so they fail until `0009` has been applied to
whichever database they run against.** `migrate.yml` applies migrations to
`MIGRATOR_DATABASE_URL` — production — and to nothing else; the 15
`licitaqui_test_*` databases are migrated by hand. That is worth the red: a
test that skipped when the schema was old would be the blind spot `ci-worker`'s
own "fail fast if the test databases are not configured" step exists to close.
"""

from __future__ import annotations

from collections.abc import Iterator

import psycopg
import pytest

from .conftest import CROSS_RUN_SWEEP_HOURS, RUN_ID

#: `97` + this run's id as digits. Per-run, never per-task: two concurrent runs
#: of this suite must not delete each other's fixtures (CLAUDE.md).
#:
#: **The leading pair is `97`, not `99`, and that is the whole point.** Every
#: other tenders-writing block uses the `99…` family and pairs its exact delete
#: with a crashed-run sweep on `agency_cnpj like '99%'` — but each of those runs
#: against a *different* database. This suite shares the general
#: `TEST_DATABASE_URL`, where the only other tenders block (`TITLE_CNPJ`) chose
#: `98` for exactly this reason: *"a different leading pair keeps this suite's
#: rows out of their cross-run sweeps and theirs out of this one"*
#: (`conftest.py:1308`). A `99…` family here would be swept by nobody and,
#: should any `99` block ever fall back to this DSN, swept by somebody else.
#:
#: Declared here rather than in `conftest.py` because that file is shared and
#: three PRs have collided in it.
CB_CNPJ = f"97{int(RUN_ID, 16):012d}"[:14]


def _tender_id(sequence: int) -> str:
    return f"{CB_CNPJ}-1-{sequence:06d}/2026"


@pytest.fixture
def cb_dsn(test_dsn: str) -> Iterator[str]:
    """The test DSN with this suite's tenders removed before and after.

    `clean_dsn` deletes **jobs** only, so a tender written through it would
    outlive the run and accumulate in a database every other suite shares.
    """

    def sweep() -> None:
        with psycopg.connect(test_dsn, autocommit=True) as conn:
            conn.execute("delete from tenders where agency_cnpj = %s", (CB_CNPJ,))
            # A crashed run's id is unknowable, so age is the only signal — the
            # same argument every block in `conftest.py` makes. Without this, a
            # CI timeout or SIGKILL between the insert and the `finally` would
            # leave this run's rows in a shared database permanently: no `99`
            # sweep runs against this DSN, and the one that does matches
            # `^98[0-9]{12}$`. Matched on the exact 14-digit shape this block
            # generates, so it cannot reach a real agency beginning with 97.
            conn.execute(
                "delete from tenders where agency_cnpj ~ '^97[0-9]{12}$'"
                f"  and updated_at < now() - interval '{CROSS_RUN_SWEEP_HOURS} hours'"
            )

    sweep()
    try:
        yield test_dsn
    finally:
        sweep()


def test_an_omitted_confidential_budget_is_unknown_not_public(cb_dsn: str) -> None:
    """The whole of B13: silence must not be recorded as "orçamento público".

    `false` is a positive claim — that the budget is published — and the
    default made it on no evidence at all. NULL is the only honest answer to a
    question PNCP was never asked.

    The insert omits the column, which is the only shape the default can reach.
    Both production writers name it (`licitaqui/tenders.py:289`, `db/seed.py:68`),
    which is why unknown already survives them. Seven test fixtures omit it,
    and any future writer may.
    """
    tender_id = _tender_id(1)
    with psycopg.connect(cb_dsn, autocommit=True) as conn:
        conn.execute(
            "insert into tenders (id, agency_cnpj, year, sequence, object)"
            " values (%s, %s, %s, %s, %s)",
            (tender_id, CB_CNPJ, 2026, 1, "objeto de teste"),
        )
        stored = conn.execute(
            "select confidential_budget from tenders where id = %s", (tender_id,)
        ).fetchone()

    assert stored is not None, "the fixture row was not written"
    assert stored[0] is None, (
        f"an insert that says nothing about the budget recorded {stored[0]!r},"
        " which claims the budget is public"
    )


def test_the_column_still_accepts_all_three_states(cb_dsn: str) -> None:
    """Dropping the default must not have narrowed the column.

    The card described the fix as "drop the default and allow NULL". NULL was
    already allowed — measured 2026-09-28, production held 21 031 of them — so
    only half that sentence was a change. This pins that the other two states
    still round-trip rather than assuming it.
    """
    with psycopg.connect(cb_dsn, autocommit=True) as conn:
        for sequence, value in ((11, True), (12, False), (13, None)):
            tender_id = _tender_id(sequence)
            conn.execute(
                "insert into tenders"
                " (id, agency_cnpj, year, sequence, object, confidential_budget)"
                " values (%s, %s, %s, %s, %s, %s)",
                (tender_id, CB_CNPJ, 2026, sequence, "objeto de teste", value),
            )
            stored = conn.execute(
                "select confidential_budget from tenders where id = %s", (tender_id,)
            ).fetchone()
            assert stored is not None and stored[0] is value, (
                f"wrote {value!r} and read back {stored and stored[0]!r}"
            )
