"""``coverage_check`` — B17's closure test (card B17).

The assertion that matters most here is the **refusal**. A walk that collects
nothing must raise, not record 0%: PNCP blocks some origins outright — every
attempt from Portugal on 2026-09-29 and 09-30 answered ``Connection reset by
peer``, including the client's own known-good parameter shape — and a row
saying "we hold 0% of the open editais" written from a request that never
arrived would be a measurement of our own blocked connection. This repo has a
standing note for exactly that shape: an empty result may be a broken query
rather than a missing row.
"""

from __future__ import annotations

from typing import Any

import pytest

from licitaqui import coverage_check
from licitaqui.coverage_check import TARGET_RATIO


class FakeConn:
    """Records what the handler writes, and answers the one select it makes."""

    def __init__(self, held: list[str]) -> None:
        self.held = held
        self.writes: list[tuple[str, Any]] = []

    def execute(self, sql: str, params: Any = None):
        if "select id from tenders" in sql:
            wanted = set(params[0])
            return _Rows([(i,) for i in self.held if i in wanted])
        self.writes.append((sql, params))
        return _Rows([])


class _Rows:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows


class FakeCtx:
    def __init__(self, conn: FakeConn, payload: dict[str, Any] | None = None) -> None:
        self.conn = conn
        self.payload = payload or {}
        self.log = _Log()


class _Log:
    def __init__(self) -> None:
        self.records: list[tuple[str, dict[str, Any]]] = []

    def info(self, message: str, extra: dict[str, Any] | None = None) -> None:
        self.records.append((message, extra or {}))


def fake_pncp(monkeypatch: pytest.MonkeyPatch, pages: list[list[str]], total: int | None):
    """Serve `pages` of control numbers, then empty."""
    monkeypatch.setattr(coverage_check, "PncpClient", lambda: object())

    def search(_client, _query, page):
        index = page - 1
        items = [{"numero_controle_pncp": c} for c in pages[index]] if index < len(pages) else []
        return {"total": total, "items": items}

    monkeypatch.setattr(coverage_check, "_search", search)


def test_it_reports_what_share_of_the_open_editais_we_hold(monkeypatch: pytest.MonkeyPatch):
    fake_pncp(monkeypatch, [["a", "b", "c", "d"]], total=4)
    conn = FakeConn(held=["a", "b", "c"])

    coverage_check.coverage_check(FakeCtx(conn))

    assert len(conn.writes) == 1
    sql, params = conn.writes[0]
    assert "insert into events" in sql
    props = params[1].obj
    assert props["collected"] == 4
    assert props["held"] == 3
    assert props["missing"] == 1
    assert props["ratio"] == 0.75
    assert props["met"] is False
    assert props["missing_sample"] == ["d"]


def test_it_passes_once_we_hold_the_target_share(monkeypatch: pytest.MonkeyPatch):
    ids = [f"t{n}" for n in range(100)]
    fake_pncp(monkeypatch, [ids[:50], ids[50:]], total=100)
    conn = FakeConn(held=ids[:96])

    coverage_check.coverage_check(FakeCtx(conn))

    props = conn.writes[0][1][1].obj
    assert props["ratio"] == 0.96
    assert props["met"] is True
    assert props["target"] == TARGET_RATIO


def test_an_empty_walk_raises_rather_than_recording_nought_percent(
    monkeypatch: pytest.MonkeyPatch,
):
    """The one that matters. PNCP refusing us is not the Radar holding nothing."""
    fake_pncp(monkeypatch, [[]], total=0)
    conn = FakeConn(held=["a"])

    with pytest.raises(RuntimeError, match="nothing measured"):
        coverage_check.coverage_check(FakeCtx(conn))

    assert conn.writes == [], "a failed walk must leave no row behind"


def test_duplicate_control_numbers_are_counted_once(monkeypatch: pytest.MonkeyPatch):
    """PNCP paginates by a moving `-data` order, so the same edital can appear
    on two pages. Counting it twice would understate coverage."""
    fake_pncp(monkeypatch, [["a", "b"], ["b", "c"]], total=4)
    conn = FakeConn(held=["a", "b", "c"])

    coverage_check.coverage_check(FakeCtx(conn))

    props = conn.writes[0][1][1].obj
    assert props["collected"] == 3
    assert props["ratio"] == 1.0


def test_the_query_is_configurable_but_defaults_to_the_measured_one(
    monkeypatch: pytest.MonkeyPatch,
):
    """The baseline was measured on `saas`; a re-run on a different keyword is
    a different question and the row has to say which was asked."""
    fake_pncp(monkeypatch, [["a"]], total=1)
    conn = FakeConn(held=["a"])

    coverage_check.coverage_check(FakeCtx(conn, {"q": "limpeza"}))

    assert conn.writes[0][1][1].obj["q"] == "limpeza"


def test_it_is_not_on_the_schedule(monkeypatch: pytest.MonkeyPatch):
    """One-off on purpose: it walks a keyword search to its end, and a cadence
    would be a standing PNCP cost plus a Neon wake to answer a question nobody
    asked that hour."""
    from licitaqui.scheduler import DEFAULT_SCHEDULE

    assert all(entry.kind != "coverage_check" for entry in DEFAULT_SCHEDULE)
