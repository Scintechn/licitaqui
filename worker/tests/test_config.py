"""Secret resolution and redaction."""

from __future__ import annotations

import pytest

from licitaqui import config
from licitaqui.scheduler import DEFAULT_SCHEDULE

#: How long Neon waits with **no connections** before suspending the compute
#: (spec §5.1, "scale to zero after 5 min"). Not ours to set from code — it is
#: a project setting in the Neon console — but the number our idle poll has to
#: clear, so it is written down where the assertion that depends on it lives.
NEON_SUSPEND_SECONDS = 300.0


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


def test_the_idle_poll_is_longer_than_neons_suspend_timer():
    """Acceptance criterion 3, part one — restated after it failed in practice.

    The original assertion pinned 120 s, on the reasoning that the compute
    "only suspends while nothing is connected". Both halves were true and the
    conclusion was still wrong: Neon's timer needs **300 s** of no connections
    (spec §5.1), so reconnecting every 120 s reset it forever and the endpoint
    never slept. 0.25 CU × 168 h = 42 CU-hours a week, against 48.93 observed.

    So the property worth pinning is not a number, it is the **relationship**:
    the idle poll must clear the suspend timer with room to spare. A future
    edit that quietly restores 120 s fails here with the reason attached.
    """
    assert config.DEFAULT_POLL_INTERVAL_SECONDS > NEON_SUSPEND_SECONDS, (
        "a poll shorter than Neon's suspend timer keeps the compute awake 24/7"
    )
    # The upper bound used to be 1800, on the reasoning that the scheduler was
    # the wake floor so exceeding it bought nothing and cost freshness. That
    # stopped being true on 2026-09-30, when `Scheduler.on_enqueue` began
    # notifying the same `WakeSignal` as `POST /wake`: scheduled work no longer
    # waits for a poll, so the poll is a safety net rather than the discovery
    # mechanism, and it is allowed to be as long as the longest cadence it
    # backs up.
    #
    # What must still hold is that it is not *shorter* than the schedule —
    # which would put the consumer back to waking Neon between cycles for
    # nothing, the exact cost this was raised to remove.
    slowest = max(e.every_seconds for e in DEFAULT_SCHEDULE if e.every_seconds)
    assert slowest <= config.DEFAULT_POLL_INTERVAL_SECONDS, (
        "a poll shorter than the slowest interval entry wakes Neon between "
        "cycles for work that is not there"
    )


def test_retry_budget_matches_the_spec():
    assert config.MAX_ATTEMPTS == 4
    assert config.BACKOFF_SECONDS == (120, 480, 1800)
