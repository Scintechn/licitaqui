#!/usr/bin/env python3
"""B6 acceptance check: real CNPJs → CNAEs → segments, expected against actual.

The card's acceptance criterion is "20 hand-picked CNPJs (papelaria, limpeza,
TI, hospitalar…) classified as expected". This runs it end to end on B5's real
path: `company_lookup` against BrasilAPI, then `cnae.refresh_company_segments`
over migration 0003's map.

    python worker/scripts/check_cnae_segments_live.py --sample sample.json

`--sample` is a JSON list of objects, one per company:

    [
      {
        "label": "papelaria · SP",
        "cnpj": "00000000000191",
        "expect": {"segment": "Gráfico / Escritório", "fit": "compatible"}
      }
    ]

Write the `expect` values **before** running. A mismatch that reveals a wrong
mapping is the point of the exercise; fix the map, not the expectation.

The sample file is **not** committed. ADR-0002 set that precedent and §12 is the
reason: a MEI's CNPJ can identify a person. Nothing this script prints or writes
contains a CNPJ, a legal name or an address — companies are identified by their
`label` and by `company.cnpj_ref`, the same digest the worker logs.

Rows are written to the isolated database named by `--dsn-var` (default
`TEST_DATABASE_URL_B6`) and deleted again unless `--keep` is given. They are
keyed by the real CNPJs in the sample, which is a constant natural key, so do
not run two of these against the same database at once — they would delete each
other's rows. `pytest` is safe alongside it: B6's fixtures key their companies
on a per-run prefix that no CNPJ can match.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from licitaqui import brasilapi, cnae, company, config  # noqa: E402
from licitaqui.observability import setup_logging  # noqa: E402


def candidate_roots() -> tuple[Path, ...]:
    """This checkout, then the main one: env files live outside a worktree."""
    roots = [config.ROOT]
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=config.ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return tuple(roots)
    if common:
        main_root = Path(common).parent
        if main_root not in roots:
            roots.append(main_root)
    return tuple(roots)


def resolve_dsn(var: str) -> str:
    for root in candidate_roots():
        dsn = config.resolve_secret(var, root=root)
        if dsn:
            return dsn
    sys.exit(f"{var} is not set (environment, or {', '.join(config.ENV_FILES)})")


def verdict(expected: dict, result: cnae.CompanySegments) -> tuple[str, str]:
    """``(mark, detail)``. A fit that came out stronger or weaker is a miss."""
    segment = expected.get("segment")
    want_fit = expected.get("fit")
    if segment is None:  # the expectation is "no segment at all"
        return ("MATCH", "") if not result.segments else ("MISS", "expected no segment")
    got = result.fit_for(segment)
    if got is None:
        return "MISS", f"{segment} absent"
    if want_fit and got != want_fit:
        return "MISS", f"{segment} is {got}, expected {want_fit}"
    return "MATCH", ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample", required=True, help="JSON list of {label, cnpj, expect}")
    parser.add_argument("--dsn-var", default="TEST_DATABASE_URL_B6")
    parser.add_argument("--out", default="cnae_segments_live.json")
    parser.add_argument("--keep", action="store_true", help="do not delete the rows written")
    args = parser.parse_args()

    setup_logging()
    sample = json.loads(Path(args.sample).read_text(encoding="utf-8"))
    for entry in sample:
        entry["cnpj"] = brasilapi.normalise_cnpj(entry["cnpj"])
    if not sample:
        sys.exit("sample is empty")

    cnpjs = [entry["cnpj"] for entry in sample]
    dsn = resolve_dsn(args.dsn_var)
    rows: list[dict] = []
    started_all = time.monotonic()

    with psycopg.connect(dsn, autocommit=True, connect_timeout=15) as conn:
        conn.execute("delete from companies where cnpj = any(%s)", (cnpjs,))
        width = max(len(e["label"]) for e in sample)
        for index, entry in enumerate(sample, 1):
            cnpj = entry["cnpj"]
            lookup = company.lookup(conn, cnpj)
            result = cnae.refresh_company_segments(conn, cnpj)
            mark, detail = verdict(entry.get("expect") or {}, result)
            main_cnae = conn.execute(
                "select main_cnae from companies where cnpj = %s", (cnpj,)
            ).fetchone()
            rows.append(
                {
                    "n": index,
                    "label": entry["label"],
                    "ref": company.cnpj_ref(cnpj),
                    "lookup": lookup.status,
                    "main_cnae": main_cnae[0] if main_cnae else None,
                    "expected": entry.get("expect"),
                    "compatible": list(result.compatible),
                    "check": list(result.check),
                    "unmapped_cnaes": list(result.unmapped_cnaes),
                    "verdict": mark,
                    "detail": detail,
                }
            )
            print(
                f"  {index:>2}/{len(sample)} {entry['label']:<{width}}  {mark:<5} "
                f"{lookup.status:<11} main={main_cnae[0] if main_cnae else '-'}  "
                f"compatible={result.compatible} check={result.check}"
                f"{'  ← ' + detail if detail else ''}",
                flush=True,
            )
        if not args.keep:
            conn.execute("delete from companies where cnpj = any(%s)", (cnpjs,))

    matches = sum(1 for r in rows if r["verdict"] == "MATCH")
    report = {
        "n": len(rows),
        "matches": matches,
        "misses": len(rows) - matches,
        "wall_s": round(time.monotonic() - started_all, 1),
        "lookup_failures": sum(1 for r in rows if r["lookup"] not in ("resolved", "cached")),
    }
    Path(args.out).write_text(
        json.dumps({"report": report, "rows": rows}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["misses"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
