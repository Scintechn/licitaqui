"""The item upsert guard, and the freshness signal that had to move with it.

§14.1: "Upserts must not rewrite unchanged rows. On Neon's copy-on-write storage
every rewritten row costs storage twice: the new version plus restore history."
`tender_items` is 127,980 rows rewritten on every sweep whether or not anything
changed.

The guard on its own is a **regression**, and these tests are what pin the pair
together. Freshness for a tender with items used to age on
`min(tender_items.updated_at)`, which only answered "when did we last read PNCP"
because every read rewrote every row. Stop rewriting unchanged rows and that
timestamp freezes, so every unchanged tender reads stale for ever and the
collector re-fetches the whole corpus on every sweep — more PNCP calls, more
breaker pressure, and worse than the bloat it removes.

Nothing here reaches PNCP. The database is real, and every row belongs to the
fictitious agency `conftest.IG_CNPJ`, which carries the per-run id.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

import psycopg
import pytest

from licitaqui.items import (
    GUARDED_COLUMNS,
    UPSERT_SQL,
    backfill_markers,
    classify_all,
    mark_synced,
    sync_event_name,
    upsert_items,
)
from licitaqui.sync_items import ITEMS_TTL_HOURS, read_state
from licitaqui.tenders import from_consulta, upsert_tenders
from tests.conftest import IG_CNPJ, ig_tender_id

# -- fixtures --------------------------------------------------------------


def given_tender(
    conn: psycopg.Connection, seq: int, *, updated: str = "2026-09-20T10:00:00"
) -> str:
    tid = ig_tender_id(seq)
    upsert_tenders(
        conn,
        [
            from_consulta(
                {
                    "numeroControlePNCP": tid,
                    "objetoCompra": "AQUISIÇÃO DE MATERIAL DE CONSUMO",
                    "orgaoEntidade": {"cnpj": IG_CNPJ, "razaoSocial": "ÓRGÃO DE TESTE IG"},
                    "unidadeOrgao": {"ufSigla": "MT", "municipioNome": "Cuiabá"},
                    "modalidadeId": 6,
                    "dataAtualizacaoGlobal": updated,
                }
            )
        ],
    )
    return tid


def item(number: int, **overrides: Any) -> dict[str, Any]:
    record = {
        "numeroItem": number,
        "descricao": f"Arroz branco tipo 1, pacote de 5 kg — lote {number}",
        "materialOuServico": "M",
        "quantidade": 100,
        "valorUnitarioEstimado": 25.0,
        "valorTotal": 2500.0,
        "ncmNbsCodigo": "10063021",
        "tipoBeneficio": 1,
    }
    return record | overrides


def write(conn: psycopg.Connection, tid: str, records: list[dict[str, Any]]):
    return upsert_items(conn, tid, classify_all(tid, records))


def updated_ats(conn: psycopg.Connection, tid: str) -> list[datetime]:
    return [
        r[0]
        for r in conn.execute(
            "select updated_at from tender_items where tender_id = %s order by number", (tid,)
        ).fetchall()
    ]


# -- the guard -------------------------------------------------------------


class TestTheGuardSkipsUnchangedRows:
    def test_re_writing_identical_items_writes_nothing(self, ig_conn):
        tid = given_tender(ig_conn, 1)
        records = [item(n) for n in range(1, 6)]

        first = write(ig_conn, tid, records)
        assert first.offered == 5
        assert first.written == 5, "the first write must actually insert"

        again = write(ig_conn, tid, records)
        assert again.offered == 5
        assert again.written == 0, "PNCP re-sent identical rows and we rewrote them"
        assert again.skipped == 5
        assert again.skip_rate == 1.0

    def test_updated_at_does_not_move_for_an_unchanged_row(self, ig_conn):
        # The storage claim, stated as an observable fact rather than a count.
        tid = given_tender(ig_conn, 2)
        records = [item(n) for n in range(1, 4)]
        write(ig_conn, tid, records)
        before = updated_ats(ig_conn, tid)

        write(ig_conn, tid, records)
        assert updated_ats(ig_conn, tid) == before

    def test_a_changed_row_is_still_written(self, ig_conn):
        # The guard must not be so clever that it stops the job working.
        tid = given_tender(ig_conn, 3)
        write(ig_conn, tid, [item(1), item(2)])

        result = write(ig_conn, tid, [item(1), item(2, valorTotal=9999.0)])
        assert result.written == 1
        assert result.skipped == 1
        stored = ig_conn.execute(
            "select total_value from tender_items where tender_id=%s and number=2", (tid,)
        ).fetchone()[0]
        assert stored == Decimal("9999.00")

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("descricao", "Arroz parboilizado"),
            ("quantidade", 101),
            ("valorUnitarioEstimado", 26.0),
            ("valorTotal", 2600.0),
            ("ncmNbsCodigo", "10063099"),
            ("tipoBeneficio", 3),
            ("materialOuServico", "S"),
        ],
    )
    def test_every_payload_column_the_guard_names_can_still_change(self, ig_conn, field, value):
        # A guard that compared too much would never fire; one that compared too
        # little would drop a real change on the floor. This is the second half.
        tid = given_tender(ig_conn, 4)
        write(ig_conn, tid, [item(1)])
        result = write(ig_conn, tid, [item(1, **{field: value})])
        assert result.written == 1, f"a change to {field} was silently dropped"

    def test_a_null_becoming_a_value_counts_as_a_change(self, ig_conn):
        # `is distinct from`, not `<>`: with `<>` a NULL comparison is NULL,
        # which is not true, so the row would never be written.
        tid = given_tender(ig_conn, 5)
        write(ig_conn, tid, [item(1, ncmNbsCodigo=None)])
        result = write(ig_conn, tid, [item(1, ncmNbsCodigo="10063021")])
        assert result.written == 1

    def test_the_guard_is_not_the_whole_row_form(self):
        # `where tender_items is distinct from excluded` is a silent no-op:
        # `updated_at = now()` is in the SET list, so `excluded` always differs
        # and every row is rewritten exactly as before — no error, no warning,
        # and a 0% skip rate with nothing to explain it.
        assert "tender_items is distinct from excluded" not in UPSERT_SQL
        assert "tender_items.updated_at" not in UPSERT_SQL.split("where", 1)[1]

    def test_the_guard_covers_every_payload_column_the_insert_writes(self):
        """The guard list and the INSERT list must not drift apart.

        A column added to the INSERT but not the guard would be written on the
        first sync and then never updated again — a silent staleness bug in one
        field, which is far harder to find than a loud failure.
        """
        inserted = UPSERT_SQL.split("insert into tender_items (", 1)[1].split(")", 1)[0]
        columns = {c.strip() for c in inserted.split(",")}
        # The conflict key cannot differ, and `updated_at` is the trap above.
        payload = columns - {"tender_id", "number", "updated_at"}
        assert payload == set(GUARDED_COLUMNS), (
            f"guard and INSERT disagree: only in INSERT {sorted(payload - set(GUARDED_COLUMNS))}, "
            f"only in guard {sorted(set(GUARDED_COLUMNS) - payload)}"
        )

    def test_rowcount_really_accumulates_across_the_batch(self, ig_conn):
        """The measurement rests on psycopg's `executemany` rowcount semantics.

        If that ever became -1 or per-statement, `written` would quietly become
        a fiction and every skip-rate number reported from it would be wrong
        without a single test failing.
        """
        tid = given_tender(ig_conn, 6)
        result = write(ig_conn, tid, [item(n) for n in range(1, 8)])
        assert result.written == 7


# -- freshness, both directions -------------------------------------------


class TestFreshnessSurvivesTheGuard:
    def test_an_unchanged_tender_is_not_re_enqueued(self, ig_conn):
        """The regression the guard would cause without the freshness change.

        Sync once, then sync again with identical items: no row is rewritten, so
        `min(updated_at)` does not move. The marker is what records that we
        looked, and it must keep the tender fresh.
        """
        tid = given_tender(ig_conn, 7)
        records = [item(n) for n in range(1, 4)]
        write(ig_conn, tid, records)
        mark_synced(ig_conn, tid, {"items": 3})

        again = write(ig_conn, tid, records)
        assert again.written == 0
        mark_synced(ig_conn, tid, {"items": 3})

        state = read_state(ig_conn, tid)
        assert state.reason == "fresh"
        assert not state.stale

    def test_a_tender_whose_items_aged_out_is_re_enqueued(self, ig_conn):
        # The other direction: freshness must still expire.
        tid = given_tender(ig_conn, 8)
        write(ig_conn, tid, [item(1)])
        mark_synced(ig_conn, tid, {"items": 1})
        _age_marker(ig_conn, tid, hours=ITEMS_TTL_HOURS + 1)

        state = read_state(ig_conn, tid)
        assert state.reason == "ttl"
        assert state.stale

    def test_a_changed_tender_is_re_enqueued_even_inside_the_ttl(self, ig_conn):
        # `pncp_updated_at` moving must beat a fresh marker.
        tid = given_tender(ig_conn, 9)
        write(ig_conn, tid, [item(1)])
        mark_synced(ig_conn, tid, {"items": 1})
        ig_conn.execute(
            "update tenders set pncp_updated_at = now() + interval '1 hour' where id = %s", (tid,)
        )
        state = read_state(ig_conn, tid)
        assert state.reason == "tender_changed"
        assert state.stale


class TestTheCoalesceFallback:
    def test_a_marker_less_tender_falls_back_to_the_item_timestamps(self, ig_conn):
        """The cutover case: 6,473 production tenders have items and no marker.

        Without the fallback every one of them reads `never` — a branch with no
        age, so the TTL cannot stagger it — and they all become eligible on the
        same sweep.
        """
        tid = given_tender(ig_conn, 10)
        write(ig_conn, tid, [item(1)])
        assert _marker_count(ig_conn, tid) == 0

        state = read_state(ig_conn, tid)
        assert state.reason == "fresh", "a freshly-written marker-less tender read as stale"

    def test_a_marker_less_tender_with_old_items_is_still_stale(self, ig_conn):
        # The fallback must preserve ageing, not suppress it.
        tid = given_tender(ig_conn, 11)
        write(ig_conn, tid, [item(1)])
        _age_items(ig_conn, tid, hours=ITEMS_TTL_HOURS + 1)

        assert read_state(ig_conn, tid).reason == "ttl"

    def test_the_marker_wins_once_it_exists(self, ig_conn):
        # Old rows, fresh marker: the marker is the signal that we looked, so
        # the tender is fresh. This is the state every tender reaches after one
        # sync, and the reason the fallback goes cold.
        tid = given_tender(ig_conn, 12)
        write(ig_conn, tid, [item(1)])
        _age_items(ig_conn, tid, hours=ITEMS_TTL_HOURS + 1)
        mark_synced(ig_conn, tid, {"items": 1})

        assert read_state(ig_conn, tid).reason == "fresh"

    def test_a_tender_with_no_items_and_no_marker_is_never(self, ig_conn):
        tid = given_tender(ig_conn, 13)
        assert read_state(ig_conn, tid).reason == "never"


# -- the backfill ----------------------------------------------------------


class TestBackfillMarkers:
    def test_it_writes_a_marker_dated_to_the_oldest_item(self, ig_conn):
        # `now()` would mark the whole corpus fresh and defer every re-read by a
        # TTL — the same herd, moved twelve hours out. The oldest item's
        # timestamp preserves the tender's real age.
        tid = given_tender(ig_conn, 14)
        write(ig_conn, tid, [item(1), item(2)])
        _age_items(ig_conn, tid, hours=ITEMS_TTL_HOURS + 1)

        assert backfill_markers(ig_conn) >= 1
        stamp = ig_conn.execute(
            "select created_at from events where name = %s", (sync_event_name(tid),)
        ).fetchone()[0]
        oldest = min(updated_ats(ig_conn, tid))
        assert abs((stamp - oldest).total_seconds()) < 1
        # …and the tender is therefore still stale, exactly as it was before.
        assert read_state(ig_conn, tid).reason == "ttl"

    def test_it_preserves_a_fresh_tender_as_fresh(self, ig_conn):
        tid = given_tender(ig_conn, 15)
        write(ig_conn, tid, [item(1)])
        backfill_markers(ig_conn)
        assert read_state(ig_conn, tid).reason == "fresh"

    def test_it_never_invents_a_marker_for_a_tender_with_no_items(self, ig_conn):
        # The PNCP-404 lane's "synced, empty" state is deliberate; a backfilled
        # marker for a tender nobody read would assert we looked when we did not.
        tid = given_tender(ig_conn, 16)
        backfill_markers(ig_conn)
        assert _marker_count(ig_conn, tid) == 0

    def test_it_never_overwrites_an_existing_marker(self, ig_conn):
        tid = given_tender(ig_conn, 17)
        write(ig_conn, tid, [item(1)])
        mark_synced(ig_conn, tid, {"items": 1, "sentinel": "keep me"})

        backfill_markers(ig_conn)
        props = ig_conn.execute(
            "select props from events where name = %s", (sync_event_name(tid),)
        ).fetchone()[0]
        assert props.get("sentinel") == "keep me"
        assert _marker_count(ig_conn, tid) == 1

    def test_it_is_idempotent(self, ig_conn):
        tid = given_tender(ig_conn, 18)
        write(ig_conn, tid, [item(1)])
        backfill_markers(ig_conn)
        second = backfill_markers(ig_conn)
        assert second == 0
        assert _marker_count(ig_conn, tid) == 1


# -- helpers ---------------------------------------------------------------


def _age_items(conn: psycopg.Connection, tid: str, *, hours: int) -> None:
    conn.execute(
        "update tender_items set updated_at = now() - make_interval(hours => %s)"
        " where tender_id = %s",
        (hours, tid),
    )


def _age_marker(conn: psycopg.Connection, tid: str, *, hours: int) -> None:
    conn.execute(
        "update events set created_at = now() - make_interval(hours => %s) where name = %s",
        (hours, sync_event_name(tid)),
    )
    # The fallback would keep it fresh otherwise, which is not what is under test.
    _age_items(conn, tid, hours=hours)


def _marker_count(conn: psycopg.Connection, tid: str) -> int:
    return conn.execute(
        "select count(*) from events where name = %s", (sync_event_name(tid),)
    ).fetchone()[0]
