"""CNAE → segment: the bridge that makes "Compatível / Verificar" computable.

POC 1 classifies tender **items** into 14 segments by NCM and keyword. B5
resolves a CNPJ into CNAEs and stores them 7-digit zero-padded. Nothing joined
the two, which is gap G6 in the development plan: without it the Radar badge in
spec §10 has nothing to compute. `cnae_segments` (migration 0003) is that join
table and this module is how the worker reads it.

## What `fit` means

- ``compatible`` — a reviewer looking at the CNAE and the segment would agree
  without argument. The company trades or makes goods of that segment, or
  performs the service that segment's tenders are actually for.
- ``check`` — plausible but arguable. Say so and let the user decide.

Anything in between is ``check`` on purpose. A wrong ``compatible`` costs a
small company the effort of chasing a tender it cannot serve; a ``check`` costs
one extra glance. The mapping is also deliberately incomplete: 555 of the 1332
CNAE 2.3 subclasses are mapped and the rest are **not**, because a CNAE that no
segment covers is a real outcome, not a hole to be filled with a guess.

## Primary and secondary CNAEs

**``compatible`` requires the main CNAE.** A segment reached only through
secondary CNAEs is capped at ``check``, however the map rates that pair, so a
``compatible`` secondary never lifts a ``check`` primary — and a ``check``
secondary never lowers a ``compatible`` primary either. The main CNAE decides
the badge; the secondaries can only add segments, at ``check``.

The other rule is more obvious and was tried first: fit belongs to the (CNAE,
segment) pair, habilitação looks at the registered object as a whole, a
secondary CNAE is as registered as the primary one, so take the strongest
claim. Run over 20 real PNCP-winning suppliers it gave each company a mean of
**5.75 of the 14 segments as compatible**, and one of them 13 of 14 — because a
small company's secondary list is what its accountant registered, not what it
trades in. A badge that says "Compatível" to everything says nothing. The same
20 companies under the rule above: mean **0.8**, never more than one.

Secondary CNAEs are not thrown away. They still put the segment on the list at
``check``, which is precisely "you have a CNAE for this, verify it", and
:attr:`SegmentFit.from_main_cnae` tells the Radar which path was taken so it can
sort the main activity first — useful for a company carrying 90 secondary CNAEs
(ADR-0002 measured up to 97).

The same rule lives in the ``company_segments`` view, which is what
:func:`for_company` reads; :func:`combine` is the pure form of it, for tests and
for callers that already hold the CNAEs. ``test_integration_cnae`` asserts the
two agree, so the rule cannot drift between SQL and Python.

## A company with no segments

``main_cnae is null`` is B5's manual-CNAE flag (:data:`company.MANUAL_CNAE_PREDICATE`)
and yields :attr:`CompanySegments.manual_cnae`. A resolved company whose CNAEs
are all unmapped yields an empty segment set with those codes in
:attr:`CompanySegments.unmapped_cnaes` — the honest answer, and the signal that
the Radar must fall back to keyword search for that user rather than invent a
segment.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import psycopg

#: The 14 segments POC 1 classifies items into, and the only values
#: `cnae_segments.segment` accepts. B3 owns the item-side classifier; these
#: names must stay identical to `SEGMENTOS_PALAVRAS` there, because a company
#: can only be compatible with a segment a tender item can land in.
SEGMENTS: tuple[str, ...] = (
    "Alimentos",
    "Construção / Hidráulica",
    "Elétrica",
    "Esportes / Lazer",
    "Ferragens / Ferramentas",
    "Gráfico / Escritório",
    "Informática / TI",
    "Limpeza / Higiene",
    "Mobiliário",
    "Saúde / Hospitalar",
    "Segurança Eletrônica / CFTV",
    "Software / Sistemas",
    "Veículos / Peças",
    "Vestuário / Uniformes",
)

FIT_COMPATIBLE = "compatible"
FIT_CHECK = "check"
FITS: tuple[str, ...] = (FIT_COMPATIBLE, FIT_CHECK)

#: cnae → ((segment, fit), …). One CNAE may reach several segments.
Mapping = dict[str, tuple[tuple[str, str], ...]]

MAPPING_SQL = "select cnae, segment, fit from cnae_segments"
MAPPED_CNAES_SQL = "select distinct cnae from cnae_segments"

COMPANY_SQL = """
select segment, fit, from_main_cnae, from_secondary_cnae
  from company_segments
 where cnpj = %(cnpj)s
"""

COMPANY_CNAES_SQL = """
select main_cnae, coalesce(secondary_cnaes, '{}'::text[])
  from companies
 where cnpj = %(cnpj)s
"""

# `segments` is the only column B6 owns; B5's upsert deliberately leaves it
# alone so a company refresh cannot wipe the mapping (see company.py).
WRITE_SEGMENTS_SQL = "update companies set segments = %(segments)s where cnpj = %(cnpj)s"


@dataclass(frozen=True, slots=True)
class SegmentFit:
    """One segment a company reaches, and how firmly."""

    segment: str
    fit: str
    from_main_cnae: bool
    from_secondary_cnae: bool

    @property
    def compatible(self) -> bool:
        return self.fit == FIT_COMPATIBLE


@dataclass(frozen=True, slots=True)
class CompanySegments:
    """Everything the Radar needs to badge a company's tenders.

    ``segments`` is ordered the way a list should be read: compatible before
    check, main-CNAE before secondary-only, then alphabetically — so the order
    is deterministic and two runs never produce a differently sorted array.
    """

    segments: tuple[SegmentFit, ...]
    unmapped_cnaes: tuple[str, ...]
    manual_cnae: bool = False

    @property
    def names(self) -> tuple[str, ...]:
        """Segment names in display order — what `companies.segments` stores."""
        return tuple(entry.segment for entry in self.segments)

    @property
    def compatible(self) -> tuple[str, ...]:
        return tuple(e.segment for e in self.segments if e.fit == FIT_COMPATIBLE)

    @property
    def check(self) -> tuple[str, ...]:
        return tuple(e.segment for e in self.segments if e.fit == FIT_CHECK)

    def fit_for(self, segment: str) -> str | None:
        """``compatible``, ``check``, or ``None`` when the company misses it."""
        for entry in self.segments:
            if entry.segment == segment:
                return entry.fit
        return None


def _order(entry: SegmentFit) -> tuple[int, int, str]:
    return (0 if entry.compatible else 1, 0 if entry.from_main_cnae else 1, entry.segment)


def load_mapping(conn: psycopg.Connection) -> Mapping:
    """Read the whole table once. 572 rows: cheaper than a query per CNAE."""
    mapping: dict[str, list[tuple[str, str]]] = {}
    with conn.cursor() as cur:
        cur.execute(MAPPING_SQL)
        for cnae, segment, fit in cur.fetchall():
            mapping.setdefault(cnae, []).append((segment, fit))
    return {cnae: tuple(sorted(pairs)) for cnae, pairs in mapping.items()}


def combine(
    main_cnae: str | None,
    secondary_cnaes: Iterable[str] | None,
    mapping: Mapping,
) -> CompanySegments:
    """Segments for one company's CNAEs. The pure form of the view's rule.

    ``main_cnae is None`` is B5's manual-CNAE state: no CNAE, so no segment and
    nothing to verify — the user has to supply a CNAE first.
    """
    if main_cnae is None:
        return CompanySegments(segments=(), unmapped_cnaes=(), manual_cnae=True)

    codes: list[tuple[str, bool]] = [(main_cnae, True)]
    seen = {main_cnae}
    for code in secondary_cnaes or ():
        if code not in seen:
            seen.add(code)
            codes.append((code, False))

    # Per segment: was it reached compatibly *through the main CNAE*, through
    # the main CNAE at all, and through a secondary at all.
    found: dict[str, tuple[bool, bool, bool]] = {}
    unmapped: list[str] = []
    for code, is_main in codes:
        pairs = mapping.get(code)
        if not pairs:
            unmapped.append(code)
            continue
        for segment, fit in pairs:
            compatible, from_main, from_secondary = found.get(segment, (False, False, False))
            found[segment] = (
                compatible or (is_main and fit == FIT_COMPATIBLE),
                from_main or is_main,
                from_secondary or not is_main,
            )

    entries = tuple(
        sorted(
            (
                SegmentFit(
                    segment,
                    FIT_COMPATIBLE if compatible else FIT_CHECK,
                    from_main,
                    from_secondary,
                )
                for segment, (compatible, from_main, from_secondary) in found.items()
            ),
            key=_order,
        )
    )
    return CompanySegments(segments=entries, unmapped_cnaes=tuple(unmapped))


def for_company(conn: psycopg.Connection, cnpj: str) -> CompanySegments:
    """Segments for a stored company, read through the ``company_segments`` view.

    The view is the authority on how fits combine; this only orders the result
    and works out which of the company's CNAEs reached nothing.
    """
    with conn.cursor() as cur:
        cur.execute(COMPANY_CNAES_SQL, {"cnpj": cnpj})
        row = cur.fetchone()
        if row is None or row[0] is None:
            return CompanySegments(segments=(), unmapped_cnaes=(), manual_cnae=True)
        main_cnae, secondary = row[0], list(row[1] or ())

        cur.execute(COMPANY_SQL, {"cnpj": cnpj})
        entries = tuple(
            sorted(
                (SegmentFit(segment, fit, main, sec) for segment, fit, main, sec in cur), key=_order
            )
        )

        cur.execute(MAPPED_CNAES_SQL)
        mapped = {code for (code,) in cur}

    ordered: list[str] = [main_cnae] + [c for c in secondary if c != main_cnae]
    unmapped = tuple(dict.fromkeys(code for code in ordered if code not in mapped))
    return CompanySegments(segments=entries, unmapped_cnaes=unmapped)


def refresh_company_segments(conn: psycopg.Connection, cnpj: str) -> CompanySegments:
    """Recompute `companies.segments` (§6.2) for one company.

    The array holds every segment the company reaches, compatible and check
    alike, in display order: it is the cheap filter, and the fit that decides
    the badge is read back from ``company_segments``, never denormalised here —
    a correction to the map must take effect without a backfill.
    """
    result = for_company(conn, cnpj)
    with conn.cursor() as cur:
        cur.execute(WRITE_SEGMENTS_SQL, {"cnpj": cnpj, "segments": list(result.names)})
    return result
