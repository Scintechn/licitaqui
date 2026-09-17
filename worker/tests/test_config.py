"""Secret resolution and redaction."""

from __future__ import annotations

import pytest

from licitaqui import config


def test_environment_wins_over_the_env_file(tmp_path, monkeypatch):
    (tmp_path / ".env.local").write_text("EXAMPLE_VAR=from-file\n")
    monkeypatch.setenv("EXAMPLE_VAR", "from-env")
    assert config.resolve_secret("EXAMPLE_VAR", root=tmp_path, files=(".env.local",)) == "from-env"


def test_falls_back_to_the_env_file(tmp_path, monkeypatch):
    monkeypatch.delenv("EXAMPLE_VAR", raising=False)
    (tmp_path / ".env.local").write_text('EXAMPLE_VAR="from-file"\n')
    assert config.resolve_secret("EXAMPLE_VAR", root=tmp_path, files=(".env.local",)) == "from-file"


def test_names_are_honoured_by_priority_not_by_file_order(tmp_path, monkeypatch):
    """The same trap db/migrate.py documents: a lower-priority name must not win
    just because its line comes first in the file."""
    monkeypatch.delenv("FIRST_CHOICE", raising=False)
    monkeypatch.delenv("SECOND_CHOICE", raising=False)
    (tmp_path / ".env.local").write_text("SECOND_CHOICE=second\nFIRST_CHOICE=first\n")
    resolved = config.resolve_secret(
        "FIRST_CHOICE", "SECOND_CHOICE", root=tmp_path, files=(".env.local",)
    )
    assert resolved == "first"


def test_missing_secret_is_none(tmp_path, monkeypatch):
    monkeypatch.delenv("ABSENT_VAR", raising=False)
    assert config.resolve_secret("ABSENT_VAR", root=tmp_path, files=(".env.local",)) is None


def test_require_secret_names_the_variables_but_no_value(tmp_path, monkeypatch):
    monkeypatch.delenv("ABSENT_VAR", raising=False)
    monkeypatch.setattr(config, "ROOT", tmp_path)
    with pytest.raises(RuntimeError, match="ABSENT_VAR"):
        config.require_secret("ABSENT_VAR")


def test_redact_removes_the_password_from_a_connection_string():
    dsn = "postgresql://app:sup3r-s3cret@ep-x.sa-east-1.aws.neon.tech/licitaqui?sslmode=require"
    redacted = config.redact(f"connection failed: {dsn}")
    assert "sup3r-s3cret" not in redacted
    assert "postgresql://app:***@ep-x.sa-east-1.aws.neon.tech/licitaqui" in redacted


def test_idle_poll_is_two_minutes():
    """Acceptance criterion 3, part one: the default must not be a hot poll.

    Neon Free gives 100 CU-hours and only suspends the compute while nothing is
    connected (spec §5.1).
    """
    assert config.DEFAULT_POLL_INTERVAL_SECONDS == 120.0


def test_retry_budget_matches_the_spec():
    assert config.MAX_ATTEMPTS == 4
    assert config.BACKOFF_SECONDS == (120, 480, 1800)
