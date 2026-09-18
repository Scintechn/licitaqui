#!/usr/bin/env python3
"""Turn `db/reference/cnae_segments.csv` into the SQL a migration applies.

The CSV is the artefact people read and review (`db/reference/README.md`); the
migration is a mechanical rendering of it. Running this module rewrites the
seed block of a migration file, and `worker/tests/test_cnae_segments.py`
asserts the two still agree, so the pair can never drift in silence.

Usage — regenerate the shipped migration after editing the CSV:

    python3 db/cnae_reference.py db/migrations/0003_cnae_segments.sql

Migrations are immutable once applied (`db/README.md`). If 0003 has shipped and
the mapping changes, render a **new** numbered file instead:

    python3 db/cnae_reference.py db/migrations/0004_cnae_segments_review.sql

Every rendering is declarative: it upserts every row of the CSV and deletes any
`cnae_segments` row the CSV no longer contains, so applying the newest one
always leaves the table equal to the CSV, whatever ran before it.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "db" / "reference" / "cnae_segments.csv"
SUBCLASSES_PATH = ROOT / "db" / "reference" / "cnae_subclasses.csv"

FITS = ("compatible", "check")

#: The 14 segments POC 1 classifies tender items into (`SEGMENTOS_PALAVRAS`).
#: A company can only ever be compatible with a segment a tender item can land
#: in, so this list and the worker's `licitaqui.cnae.SEGMENTS` must stay equal —
#: `worker/tests/test_cnae_segments.py` checks that they do.
SEGMENTS = (
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

MARKER_BEGIN = (
    "-- >>> generated from db/reference/cnae_segments.csv — do not edit by hand"
)
MARKER_END = "-- <<< end generated block"


def load_rows(path: Path = CSV_PATH) -> list[dict[str, str]]:
    """Read the mapping CSV, validated. Raises ``ValueError`` on a bad row."""
    with path.open(encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    seen: set[tuple[str, str]] = set()
    for index, row in enumerate(rows, start=2):  # line 1 is the header
        cnae = row.get("cnae") or ""
        segment = row.get("segment") or ""
        fit = row.get("fit") or ""
        if len(cnae) != 7 or not cnae.isdigit():
            raise ValueError(f"{path}:{index}: {cnae!r} is not a 7-digit CNAE subclass")
        if segment not in SEGMENTS:
            raise ValueError(
                f"{path}:{index}: {segment!r} is not one of the 14 segments"
            )
        if fit not in FITS:
            raise ValueError(f"{path}:{index}: fit {fit!r} must be one of {FITS}")
        key = (cnae, segment)
        if key in seen:
            raise ValueError(f"{path}:{index}: {cnae} is mapped to {segment!r} twice")
        seen.add(key)
    return rows


def load_subclasses(path: Path = SUBCLASSES_PATH) -> dict[str, str]:
    """The captured IBGE CNAE 2.3 subclass list: code → official description."""
    with path.open(encoding="utf-8", newline="") as fh:
        return {row["cnae"]: row["description"] for row in csv.DictReader(fh)}


def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def render_seed_sql(rows: list[dict[str, str]]) -> str:
    """The generated block: one values row per mapping, then a reconciling delete."""
    lines = [
        MARKER_BEGIN,
        f"-- {len(rows)} mappings over {len({r['cnae'] for r in rows})} CNAE subclasses.",
        "insert into cnae_segments (cnae, segment, fit, note) values",
    ]
    for index, row in enumerate(rows):
        note = row.get("note") or ""
        values = f"  ({_quote(row['cnae'])}, {_quote(row['segment'])}, {_quote(row['fit'])}, "
        values += ("null" if not note else _quote(note)) + ")"
        lines.append(values + ("," if index < len(rows) - 1 else ""))
    lines += [
        "on conflict (cnae, segment) do update",
        "  set fit  = excluded.fit,",
        "      note = excluded.note;",
        "",
        "-- Declarative: a row the CSV no longer carries must not survive a re-seed.",
        "delete from cnae_segments s",
        " where not exists (",
        "   select 1 from (values",
    ]
    for index, row in enumerate(rows):
        suffix = "," if index < len(rows) - 1 else ""
        lines.append(f"     ({_quote(row['cnae'])}, {_quote(row['segment'])}){suffix}")
    lines += [
        "   ) as seed(cnae, segment)",
        "    where seed.cnae = s.cnae and seed.segment = s.segment",
        " );",
        MARKER_END,
    ]
    return "\n".join(lines) + "\n"


def replace_block(text: str, block: str) -> str:
    """Swap the generated block of a migration file for a freshly rendered one."""
    start = text.index(MARKER_BEGIN)
    end = text.index(MARKER_END) + len(MARKER_END) + 1
    return text[:start] + block + text[end:]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    target = Path(argv[1])
    block = render_seed_sql(load_rows())
    if target.exists() and MARKER_BEGIN in target.read_text(encoding="utf-8"):
        target.write_text(
            replace_block(target.read_text(encoding="utf-8"), block), "utf-8"
        )
    else:
        target.write_text(block, encoding="utf-8")
    print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
