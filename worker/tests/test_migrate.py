"""`db/migrate.py`'s guard — card **B50**, and the afternoon that bought it.

On 2026-10-13 `/conta/favoritos` was 500ing with `column "birth_date" does not
exist`, `pnpm db:migrate` was run, and it printed `0 applied, 15 already
present` while the page stayed broken. Two Neon branches: the dev server read
endpoint `ep-small-cake-ac4lizlb` (branch `staging`, 14 migrations) and the
script resolved `MIGRATOR_DATABASE_URL` to `ep-flat-firefly-acai77cp` (branch
`main`, 15). The variable priority that sent it there is deliberate — it stops
migrations running as the DML-only `app` role — and nobody had thought about
the *database* on the other end of that credential.

**These tests live here because nothing else can see that file.** CI runs ruff
and pytest with `working-directory: worker`, so `db/migrate.py` is linted by
nothing and tested by nothing; loading it by path puts the guard inside the
suite that does run. Only the pure functions are exercised: the connection is
as untested as it was before, which is the honest state and not a claim.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

MIGRATE = Path(__file__).resolve().parents[2] / "db" / "migrate.py"

POOLED = "postgresql://neondb_owner:secret@ep-small-cake-ac4lizlb-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require"
DIRECT = "postgresql://neondb_owner:secret@ep-small-cake-ac4lizlb.sa-east-1.aws.neon.tech/neondb"
OTHER = "postgresql://migrator:secret@ep-flat-firefly-acai77cp.sa-east-1.aws.neon.tech/neondb"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("db_migrate", MIGRATE)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["db_migrate"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def migrate() -> ModuleType:
    return _load()


def test_the_file_is_where_this_test_thinks_it_is() -> None:
    """A rename would otherwise make every test below vacuous."""
    assert MIGRATE.is_file(), MIGRATE


def test_the_pooled_and_direct_doors_are_one_database(migrate: ModuleType) -> None:
    """**The reason this compares endpoints and not hosts.**

    `…-pooler.sa-east-1.aws.neon.tech` and `….sa-east-1.aws.neon.tech` are two
    doors onto one compute. A guard that called them two databases would refuse
    every ordinary run, be switched off within a day, and leave us worse off
    than with no guard at all.
    """
    assert migrate.endpoint_of(POOLED) == migrate.endpoint_of(DIRECT) == "ep-small-cake-ac4lizlb"


def test_the_two_real_endpoints_are_told_apart(migrate: ModuleType) -> None:
    """The actual pair from 2026-10-13, which is the case this exists for."""
    assert migrate.endpoint_of(POOLED) != migrate.endpoint_of(OTHER)


def test_the_database_name_could_not_have_caught_it(migrate: ModuleType) -> None:
    """Both branches are called `neondb`, which is Neon's default — so the name
    is printed for the reader and is useless as a discriminator. Asserted so
    nobody later 'simplifies' the comparison onto it."""
    assert migrate.database_of(POOLED) == migrate.database_of(OTHER) == "neondb"


def test_the_role_is_printed_and_never_compared(migrate: ModuleType) -> None:
    """`migrator` and `neondb_owner` are both right for the same database, so a
    comparison on the role would refuse the correct run."""
    assert migrate.role_of(OTHER) == "migrator"
    assert migrate.role_of(POOLED) == "neondb_owner"


def test_the_line_it_prints_carries_no_credential(migrate: ModuleType) -> None:
    """CLAUDE.md: never log tokens. This line is printed on every single run,
    including in CI logs that outlive the branch."""
    line = migrate.describe(POOLED)
    assert "secret" not in line
    assert "ep-small-cake-ac4lizlb" in line and "neondb" in line and "neondb_owner" in line


def test_a_mismatched_endpoint_stops_the_run(migrate: ModuleType, monkeypatch) -> None:
    """The whole point: migrating a database the application does not read is a
    refusal, not a success message."""
    monkeypatch.setattr(migrate, "app_dsn", lambda: POOLED)
    with pytest.raises(SystemExit) as exit_info:
        migrate.check_target(OTHER, allow_other=False)
    message = str(exit_info.value)
    assert "refusing" in message
    # Both endpoints named, because "wrong database" without "which one" sends
    # the reader back to the same guessing this card came from.
    assert "ep-flat-firefly-acai77cp" in message and "ep-small-cake-ac4lizlb" in message
    assert "--allow-other-database" in message


def test_the_same_endpoint_through_the_pooler_is_allowed(migrate: ModuleType, monkeypatch) -> None:
    monkeypatch.setattr(migrate, "app_dsn", lambda: POOLED)
    migrate.check_target(DIRECT, allow_other=False)


def test_the_flag_is_how_staging_is_migrated_by_hand(migrate: ModuleType, monkeypatch) -> None:
    """Sci migrates `staging` by hand (CLAUDE.md, Schema changes), which *is* a
    deliberate mismatch — so the escape hatch has to exist and has to be
    explicit rather than a default."""
    monkeypatch.setattr(migrate, "app_dsn", lambda: POOLED)
    migrate.check_target(OTHER, allow_other=True)


def test_no_application_url_does_not_block_a_migration(migrate: ModuleType, monkeypatch) -> None:
    """**The case `migrate.yml` runs.** In CI there are no env files and only
    `MIGRATOR_DATABASE_URL` is set, so the comparison is impossible — and a
    guard that turned that into a failure would stop every deploy's migration.
    """
    monkeypatch.setattr(migrate, "app_dsn", lambda: None)
    migrate.check_target(OTHER, allow_other=False)


def test_pending_is_what_is_on_disk_and_not_in_the_table(migrate: ModuleType) -> None:
    files = [Path("db/migrations/0001_a.sql"), Path("db/migrations/0002_b.sql")]
    assert migrate.pending_versions({"0001_a": "digest"}, files) == ["0002_b"]
    assert migrate.pending_versions({}, files) == ["0001_a", "0002_b"]
    assert migrate.pending_versions({"0001_a": "d", "0002_b": "d"}, files) == []


def test_an_unknown_flag_is_refused_rather_than_ignored(migrate: ModuleType) -> None:
    """A typo in `--check` must not silently migrate. Checked before anything
    connects, so this needs no database."""
    with pytest.raises(SystemExit) as exit_info:
        migrate.main(["--cheque"])
    assert "unknown argument" in str(exit_info.value)
