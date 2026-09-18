"""`cnae_segments`, the `company_segments` view and the refresh, against Neon.

Skips when ``TEST_DATABASE_URL_B6`` is not configured. Every company these
tests write carries this run's CNPJ prefix and is deleted again by the
``b6_clean_dsn`` fixture, so a concurrent run of the same suite is untouched.
"""

from __future__ import annotations

import pytest

from licitaqui import cnae, company

from .conftest import b6_cnpj

pytestmark = pytest.mark.usefixtures("b6_clean_dsn")


def _insert_company(conn, cnpj: str, main: str | None, secondary: list[str] | None = None):
    conn.execute(
        """
        insert into companies (cnpj, legal_name, main_cnae, secondary_cnaes,
                               size, registration_status)
        values (%s, %s, %s, %s, 'ME', 'ATIVA')
        on conflict (cnpj) do update
           set main_cnae = excluded.main_cnae,
               secondary_cnaes = excluded.secondary_cnaes
        """,
        (cnpj, "EMPRESA DE TESTE B6", main, secondary),
    )


def test_the_seed_is_in_the_database(b6_conn):
    mapping = cnae.load_mapping(b6_conn)
    assert len(mapping) == 555
    assert sum(len(pairs) for pairs in mapping.values()) == 572
    assert mapping["4761003"] == (("Gráfico / Escritório", "compatible"),)


def test_every_row_uses_a_declared_segment(b6_conn):
    rows = b6_conn.execute("select distinct segment from cnae_segments").fetchall()
    assert {segment for (segment,) in rows} <= set(cnae.SEGMENTS)


def test_the_check_constraint_rejects_an_invented_segment(b6_conn):
    with b6_conn.transaction() as tx:  # noqa: SIM117 — the rollback is the point
        with pytest.raises(Exception):  # noqa: B017 — psycopg raises CheckViolation
            b6_conn.execute(
                "insert into cnae_segments (cnae, segment, fit)"
                " values ('4761003', 'Papelaria', 'check')"
            )
        tx.force_rollback = True


def test_the_check_constraint_rejects_a_short_cnae(b6_conn):
    with b6_conn.transaction() as tx:  # noqa: SIM117
        with pytest.raises(Exception):  # noqa: B017
            b6_conn.execute(
                "insert into cnae_segments (cnae, segment, fit)"
                " values ('47610', 'Gráfico / Escritório', 'check')"
            )
        tx.force_rollback = True


def test_papelaria_is_compatible_with_grafico_escritorio(b6_conn):
    cnpj = b6_cnpj("01")
    _insert_company(b6_conn, cnpj, "4761003")
    result = cnae.for_company(b6_conn, cnpj)
    assert result.compatible == ("Gráfico / Escritório",)
    assert result.manual_cnae is False


def test_a_compatible_secondary_does_not_lift_a_check_primary_in_sql_either(b6_conn):
    """The view must apply exactly the rule the module docstring states."""
    cnpj = b6_cnpj("02")
    _insert_company(b6_conn, cnpj, "4647802", ["4761003"])  # check primary, compatible secondary
    result = cnae.for_company(b6_conn, cnpj)
    assert result.fit_for("Gráfico / Escritório") == "check"
    entry = result.segments[0]
    assert entry.from_main_cnae and entry.from_secondary_cnae


def test_a_secondary_only_segment_is_capped_at_check_in_sql_too(b6_conn):
    cnpj = b6_cnpj("09")
    _insert_company(b6_conn, cnpj, "4647802", ["4649408"])
    result = cnae.for_company(b6_conn, cnpj)
    assert result.compatible == ()
    assert result.fit_for("Limpeza / Higiene") == "check"


def test_the_view_and_the_pure_function_agree(b6_conn):
    """One rule, two implementations. This is what stops them drifting apart."""
    mapping = cnae.load_mapping(b6_conn)
    cases = [
        ("4761003", []),
        ("4647802", ["4761003"]),
        ("8121400", ["4649408", "4744099"]),
        ("4744099", ["4744001", "4742300", "9999999"]),
        ("6911701", ["9430800"]),
        ("4751201", ["6201501", "6209100", "4652400"]),
    ]
    for index, (main, secondary) in enumerate(cases):
        cnpj = b6_cnpj(f"1{index}")
        _insert_company(b6_conn, cnpj, main, secondary)
        from_sql = cnae.for_company(b6_conn, cnpj)
        from_python = cnae.combine(main, secondary, mapping)
        assert from_sql.segments == from_python.segments, (main, secondary)
        assert from_sql.unmapped_cnaes == from_python.unmapped_cnaes, (main, secondary)


def test_a_company_whose_cnaes_map_to_nothing_gets_no_segments(b6_conn):
    """Unmapped is a legitimate answer; it must not be dressed up as `check`."""
    cnpj = b6_cnpj("03")
    _insert_company(b6_conn, cnpj, "6911701", ["9430800"])  # advocacia, sindicato
    result = cnae.for_company(b6_conn, cnpj)
    assert result.segments == ()
    assert result.unmapped_cnaes == ("6911701", "9430800")
    assert result.manual_cnae is False


def test_a_manual_cnae_row_is_not_an_empty_segment_set(b6_conn):
    """B5's fallback state: `main_cnae is null`. The user owes us a CNAE."""
    cnpj = b6_cnpj("04")
    b6_conn.execute(
        "insert into companies (cnpj, registration_status) values (%s, %s)",
        (cnpj, company.STATUS_FAILED),
    )
    result = cnae.for_company(b6_conn, cnpj)
    assert result.manual_cnae is True
    assert result.segments == ()


def test_refresh_writes_companies_segments_in_display_order(b6_conn):
    cnpj = b6_cnpj("05")
    _insert_company(b6_conn, cnpj, "8121400", ["4744099", "4761003"])
    result = cnae.refresh_company_segments(b6_conn, cnpj)
    stored = b6_conn.execute("select segments from companies where cnpj = %s", (cnpj,)).fetchone()[
        0
    ]
    assert stored == list(result.names)
    assert stored == [
        "Limpeza / Higiene",  # check, main
        "Construção / Hidráulica",  # check, secondary
        "Elétrica",  # check, secondary
        "Ferragens / Ferramentas",  # check, secondary
        "Gráfico / Escritório",  # check, secondary
    ]


def test_refresh_is_idempotent(b6_conn):
    cnpj = b6_cnpj("06")
    _insert_company(b6_conn, cnpj, "4645101", ["4644301"])
    first = cnae.refresh_company_segments(b6_conn, cnpj)
    second = cnae.refresh_company_segments(b6_conn, cnpj)
    assert first == second
    assert first.compatible == ("Saúde / Hospitalar",)


def test_refresh_clears_segments_when_the_cnaes_stop_matching(b6_conn):
    """A CNAE correction must be able to remove a segment, not only add one."""
    cnpj = b6_cnpj("07")
    _insert_company(b6_conn, cnpj, "4761003")
    assert cnae.refresh_company_segments(b6_conn, cnpj).names == ("Gráfico / Escritório",)
    _insert_company(b6_conn, cnpj, "6911701", [])
    assert cnae.refresh_company_segments(b6_conn, cnpj).names == ()
    stored = b6_conn.execute("select segments from companies where cnpj = %s", (cnpj,)).fetchone()[
        0
    ]
    assert stored == []


def test_the_view_ignores_a_cnae_no_company_has(b6_conn):
    """Sanity: the view is a join, not a cross product."""
    cnpj = b6_cnpj("08")
    _insert_company(b6_conn, cnpj, "4761003")
    rows = b6_conn.execute(
        "select count(*) from company_segments where cnpj = %s", (cnpj,)
    ).fetchone()[0]
    assert rows == 1
