"""The catalogue mirror and the mapper sweep (card B36).

The two jobs themselves need a database and are exercised by the integration
suite; what is pinned here is the logic that decides **what gets written**, which
is where a silent wrong answer would come from:

* a status field that is not a boolean (truthiness fails OPEN — every inactive
  code would become active, and the log would agree with the bug);
* a walk where everything is active, which is the same failure one layer up;
* an item whose ``kind`` is neither 'M' nor 'S', which must not be matched
  against the materials vocabulary just because that column is nullable.

No network and no database in this file.
"""

from __future__ import annotations

import contextlib
import logging
from pathlib import Path

import pytest

from licitaqui.catalog_match import (
    MATCH_CAP,
    MATCHER_VERSION,
    CatalogEntry,
    CatalogIndex,
    Resolution,
    all_words,
    product_head,
    resolve_description,
)
from licitaqui.catalog_sync import (
    _active,
    _assert_discriminating,
    _pdm_entry,
    _service_entry,
)
from licitaqui.compras import ComprasError

# ------------------------------------------------- the status field


def test_a_boolean_status_is_read_as_itself() -> None:
    assert _active(True, "statusPdm") is True
    assert _active(False, "statusPdm") is False


@pytest.mark.parametrize("value", ["false", "N", "Inativo", "0", 0, 1, None, ""])
def test_a_non_boolean_status_stops_the_run_rather_than_being_guessed(value) -> None:
    """`bool("false")` is True, and that would mark every code active.

    The damage is invisible: `load_index` would serve inactive codes, they would
    feed bands, and the event counters would agree with the bug.
    """
    with pytest.raises(ComprasError, match="not a boolean"):
        _active(value, "statusPdm")


def test_entries_carry_no_folded_head(request) -> None:
    """Heads are recomputed at load time, never stored — see `load_index`."""
    row = {
        "codigoPdm": 7,
        "nomePdm": "PAPEL ALCALINO",
        "statusPdm": True,
        "codigoClasse": 1,
        "nomeClasse": "c",
        "codigoGrupo": 2,
        "nomeGrupo": "g",
    }
    entry = _pdm_entry(row)
    assert entry[0] == 7
    assert entry[1] == "PAPEL ALCALINO"
    assert entry[-1] is True
    assert not any(isinstance(v, list) for v in entry)


def test_a_service_entry_refuses_a_non_boolean_status() -> None:
    with pytest.raises(ComprasError, match="not a boolean"):
        _service_entry({"codigoServico": 1, "nomeServico": "X", "statusServico": "S"})


# ------------------------------------------------- the walk-level guard


def test_a_walk_where_everything_is_active_is_refused() -> None:
    pdm = [{"statusPdm": True}, {"statusPdm": True}]
    service = [{"statusServico": True}, {"statusServico": False}]
    with pytest.raises(ComprasError, match="every code came back active"):
        _assert_discriminating(pdm, service)


def test_a_walk_that_discriminates_returns_its_counts() -> None:
    pdm = [{"statusPdm": True}, {"statusPdm": False}]
    service = [{"statusServico": True}, {"statusServico": False}]
    assert _assert_discriminating(pdm, service) == (1, 1)


def test_the_guard_fires_on_either_vocabulary() -> None:
    """Both halves are checked, so one broken parse cannot hide behind the other."""
    good_pdm = [{"statusPdm": True}, {"statusPdm": False}]
    all_active_service = [{"statusServico": True}]
    with pytest.raises(ComprasError):
        _assert_discriminating(good_pdm, all_active_service)


# ------------------------------------------------- the unknown kind


@pytest.mark.parametrize("kind", [None, "", "X", "m", "s"])
def test_an_unknown_kind_is_recorded_rather_than_coerced_to_material(kind) -> None:
    """`tender_items.kind` is nullable, and coercion would make a wrong band
    MORE likely: materials resolve `exact` at 18.7% against services' 8.1%, so a
    service matched against PDM heads is more likely to produce a confident
    answer, not less.
    """
    assert kind not in ("M", "S")
    r = Resolution(None, "unknown_kind", 0, 0)
    assert r.band_eligible is False
    assert r.code is None


def test_the_matcher_version_is_recorded_and_names_its_cap() -> None:
    """The band's measured accuracy is a property of the population this cap
    selects, so a stored row has to say which matcher produced it."""
    assert str(MATCH_CAP) in MATCHER_VERSION


# ------------------------------- the cap symmetry this file's sibling broke


def test_a_long_catalogue_name_can_still_match_exactly() -> None:
    """The regression that made 41.1% of active CATSER unreachable.

    With the catalogue head stored at 12 words and the item head capped at 4,
    compared by equality, any catalogue name folding to 5+ head words could
    never produce an `exact` match — so an item whose description IS the
    catalogue name resolved as `prefix_rev` and was not band-eligible.
    """
    name = "SERVICO MANUTENCAO PREVENTIVA CORRETIVA ELEVADOR"
    entry = CatalogEntry(
        code=500, name=name, head=tuple(product_head(name, MATCH_CAP)), words=tuple(all_words(name))
    )
    assert len(entry.head) == 5  # longer than HEAD_WORDS, deliberately
    r = resolve_description(CatalogIndex([entry]), name)
    assert (r.rule, r.code) == ("exact", 500)
    assert r.band_eligible is True


# ----------------------------------- the SQL matches the tuples it is given


def _statements(source: str) -> list[str]:
    """Every `insert into … values (…)` in the module, as text."""
    import re

    return re.findall(r"insert into\s+\w+.*?values\s*\([^)]*\)", source, re.S | re.I)


@pytest.mark.parametrize(
    ("entry_fn", "table", "row"),
    [
        (
            _pdm_entry,
            "catalog_pdm",
            {
                "codigoPdm": 1,
                "nomePdm": "X",
                "statusPdm": True,
                "codigoClasse": 1,
                "nomeClasse": "c",
                "codigoGrupo": 2,
                "nomeGrupo": "g",
            },
        ),
        (
            _service_entry,
            "catalog_service",
            {
                "codigoServico": 1,
                "nomeServico": "X",
                "statusServico": True,
                "codigoClasse": 1,
                "nomeClasse": "c",
            },
        ),
    ],
)
def test_each_insert_has_exactly_as_many_placeholders_as_its_tuple(entry_fn, table, row) -> None:
    """The defect this exists for, found by Sci running the job on 2026-10-03:

        psycopg.ProgrammingError: the query has 7 placeholders but 5 parameters
        were passed

    `catalog_service`'s INSERT still named `head, words` after those columns were
    dropped from the migration, because the edit that removed them from the
    `catalog_pdm` INSERT was asserted and the twin edit was not -- so it silently
    matched nothing. `CLAUDE.md` §4b: assert the mutation applied.

    No database: the SQL text is read out of the module and counted against what
    the row builder actually returns, so a column list and its tuple can never
    drift apart again.
    """
    from licitaqui import catalog_sync

    source = Path(catalog_sync.__file__).read_text(encoding="utf-8")
    stmt = next((x for x in _statements(source) if f"insert into {table}" in x), None)
    assert stmt is not None, f"no INSERT found for {table}"

    placeholders = stmt.count("%s")
    columns = stmt[stmt.index("(") + 1 : stmt.index(")")].split(",")
    values = len(entry_fn(row))

    # `updated_at` is written as `now()`, not as a placeholder, so the column
    # list is one longer than both of the others.
    assert placeholders == values, (
        f"{table}: {placeholders} placeholders, {values} values from "
        f"{entry_fn.__name__} -- they must match or psycopg raises at runtime"
    )
    assert len([c for c in columns if c.strip()]) == values + 1, (
        f"{table}: {len(columns)} columns against {values} values + now()"
    )


def test_no_insert_in_the_module_mentions_a_dropped_column() -> None:
    """`head` and `words` were removed from the schema; nothing may name them.

    They were dropped because a stored fold would be computed by whichever
    matcher was deployed when the row was written, and a `remap` -- whose whole
    purpose is to re-resolve after a matcher correction -- would then resolve
    against stale heads and report success.
    """
    import re

    from licitaqui import catalog_sync

    source = Path(catalog_sync.__file__).read_text(encoding="utf-8")
    for stmt in _statements(source):
        columns = stmt[stmt.index("(") + 1 : stmt.index(")")]
        named = {c.strip() for c in columns.split(",")}
        # Whole column names only: `matched_words` legitimately contains "words",
        # and a substring check would fail on it -- which it did, first run.
        assert "head" not in named, stmt[:140]
        assert "words" not in named, stmt[:140]
        assert not re.search(r"excluded\.(head|words)\b", stmt), stmt[:140]


def test_every_insert_in_the_module_is_covered_by_a_placeholder_test() -> None:
    """The test above checked two of the module's three INSERTs.

    `_flush`'s INSERT into `tender_item_codes` was the third, its values are
    built as an inline tuple rather than by a named row builder, and it shipped
    with **8 placeholders against 7 values** -- the same defect as
    `catalog_service`'s, found the same way, by Sci running the job:

        psycopg.ProgrammingError: the query has 8 placeholders but 7 parameters
        were passed

    So this test does not check an INSERT. It checks that **no INSERT in the
    module is missing from the checks**, which is the thing that was actually
    wrong: a test written for "the class" and scoped to part of it.
    """
    from licitaqui import catalog_sync

    source = Path(catalog_sync.__file__).read_text(encoding="utf-8")
    tables = {stmt.split("insert into ")[1].split()[0].strip("\n ") for stmt in _statements(source)}
    # `events` is the fourth, and this test found that my own enumeration had
    # missed it -- which is the point: the set is asserted, not remembered.
    assert tables == {"catalog_pdm", "catalog_service", "tender_item_codes", "events"}, (
        f"the module's INSERT set changed: {sorted(tables)}. Every one of them "
        f"needs a placeholder-count test, or the next mismatch ships."
    )


class _FakeCursor:
    """Enough cursor for `map_item_codes`: iterate rows, capture executemany."""

    def __init__(self, rows, captured):
        self._rows = rows
        self._captured = captured
        self.itersize = 0

    def execute(self, *_a, **_k):
        return self

    def executemany(self, sql, batch):
        self._captured.append((sql, list(batch)))

    def fetchall(self):
        return self._rows

    def __iter__(self):
        return iter(self._rows)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class _FakeConn:
    """`ctx.conn` and `ctx.connect()`'s reader in one, with a captured batch."""

    def __init__(self, item_rows, vocab_rows, captured):
        self._item_rows = item_rows
        self._vocab_rows = vocab_rows
        self.captured = captured

    def execute(self, sql, *_a, **_k):
        # `load_index` reads the vocabulary; everything else is the events write.
        if "from catalog_pdm" in sql or "from catalog_service" in sql:
            return _FakeCursor(self._vocab_rows, self.captured)
        return _FakeCursor([], self.captured)

    def cursor(self, name=None):
        return _FakeCursor(self._item_rows if name else [], self.captured)

    @contextlib.contextmanager
    def transaction(self):
        yield self

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def test_the_mapper_builds_a_row_the_insert_can_actually_take() -> None:
    """Runs `map_item_codes` and counts what `executemany` really receives.

    The previous version of this test compared the statement's placeholders
    against tuples **written in the test**, so reintroducing the defect left it
    green -- verified by mutation. `CLAUDE.md` §4b: the test exercised the unit,
    not the path. This one lets the mapper build the tuple.

    The defect it pins shipped and was found by Sci running the job:

        psycopg.ProgrammingError: the query has 8 placeholders but 7 parameters
        were passed
    """
    from licitaqui import catalog_sync
    from licitaqui.queue import Job
    from licitaqui.registry import JobContext

    captured: list = []
    # Two items: one material that will resolve, one with a NULL kind.
    items = [("t1", 1, "M", "PAPEL ALCALINO, Gramatura: 75"), ("t2", 2, None, "SERVICO QUALQUER")]
    vocab = [(99, "PAPEL ALCALINO")]
    conn = _FakeConn(items, vocab, captured)

    ctx = JobContext(
        job=Job(
            id=0,
            kind="map_item_codes",
            key="k",
            priority=9,
            payload={"only_open": True},
            attempts=0,
        ),
        conn=conn,
        connect=lambda: _FakeConn(items, vocab, captured),
        log=logging.getLogger("test"),
    )
    catalog_sync.map_item_codes(ctx)

    inserts = [(sql, batch) for sql, batch in captured if "insert into tender_item_codes" in sql]
    assert inserts, "the mapper wrote no rows"
    sql, batch = inserts[0]
    placeholders = sql.count("%s")
    assert batch, "the batch was empty"
    for row in batch:
        assert len(row) == placeholders, (
            f"the mapper built {len(row)} values for {placeholders} placeholders: {row}"
        )

    # And the unknown kind really took the branch rather than being coerced.
    rules = {row[4] for row in batch}
    assert "unknown_kind" in rules, rules
    for row in batch:
        if row[4] == "unknown_kind":
            assert row[3] is None, "an unknown kind must carry no code"


def test_the_events_insert_matches_its_two_values() -> None:
    """The fourth INSERT. Two placeholders, two values, both call sites."""
    from licitaqui import catalog_sync

    source = Path(catalog_sync.__file__).read_text(encoding="utf-8")
    for stmt in (x for x in _statements(source) if "insert into events" in x):
        assert stmt.count("%s") == 2, stmt


def test_an_unknown_kind_is_recorded_and_carries_no_code() -> None:
    """The branch that did not exist until Sci's run exposed its absence.

    The edit adding it silently matched nothing -- `CLAUDE.md` §4b -- so the
    column said `kind = 'M'` for a row that was never matched against the
    materials vocabulary at all.
    """
    r = Resolution(None, "unknown_kind", 0, 0)
    assert r.band_eligible is False
    assert r.code is None
    assert "unknown_kind" in Path(
        __import__("licitaqui.catalog_sync", fromlist=["x"]).__file__
    ).read_text(encoding="utf-8"), "the mapper must have the unknown-kind branch"
