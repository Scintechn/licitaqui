#!/usr/bin/env python3
"""Regenerate the mapper's conformance fixture FROM the TypeScript (card B36).

    python worker/scripts/gen_catalog_conformance.py --descriptions a.txt [--out …]

## Why this script exists

``licitaqui.catalog_match`` is a port of ``apps/web/lib/radar/product-key.ts``,
and that TypeScript is the implementation the price band's measured accuracy was
produced by. ``tests/test_catalog_match.py`` therefore asserts the two agree
character-for-character on 418 real PNCP descriptions plus the edge cases — and
those expected values must come out of the **TypeScript**, never out of Python,
or the test proves only that Python equals itself.

So: if the conformance test fails, the port is wrong. Only when the TypeScript
has been deliberately changed is regenerating the right answer, and then the new
`source_sha` records which version the fixture now describes.

## How it reads the TypeScript

`product-key.ts` imports nothing, so it runs under ``node --experimental-strip-types``
directly from a checkout of the file. Node 22+ required. The script writes a
small driver next to a copy of the module, feeds it the descriptions as JSONL and
reads the results back — no bundler, no `pnpm`, nothing installed.

One input rule: **descriptions must be real**. The fixture's value is that it
covers the shapes PNCP actually publishes — `atributo:` scaffolding, the product
name written twice, accents, units inside the name. A hand-written list would
pass while missing exactly the cases the port gets wrong.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TS_SOURCE = REPO / "apps" / "web" / "lib" / "radar" / "product-key.ts"
DEFAULT_OUT = REPO / "worker" / "tests" / "fixtures" / "catalog_head_conformance.json"

DRIVER = """\
// Descriptions arrive as a JSON array on stdin: argv cannot carry a NUL and a
// real description may contain any other separator we might pick.
import { productHead } from './product-key.ts'
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { raw += c })
process.stdin.on('end', () => {
  const out = JSON.parse(raw).map((line) => ({
    description: line,
    head: productHead(line),
    head_cap12: productHead(line, 12),
    // Every word, colons flattened: the disambiguation input, never a gate.
    words: productHead(line.replace(/:/g, ' '), 400),
  }))
  process.stdout.write(JSON.stringify(out))
})
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--descriptions", required=True,
                    help="file of REAL item descriptions, one per line")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--sha", default=None,
                    help="the product-key.ts commit these values describe "
                         "(default: HEAD of this checkout)")
    args = ap.parse_args()

    if not TS_SOURCE.exists():
        print(f"missing {TS_SOURCE}", file=sys.stderr)
        return 1

    lines = [ln.rstrip("\n") for ln in Path(args.descriptions).read_text(
        encoding="utf-8").splitlines()]
    cases = [ln for ln in dict.fromkeys(lines)]
    if len(cases) < 100:
        print(f"only {len(cases)} descriptions — too few to be a conformance "
              f"fixture; the point is coverage of real PNCP shapes",
              file=sys.stderr)
        return 1

    sha = args.sha or subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True).stdout.strip()

    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "product-key.ts").write_text(TS_SOURCE.read_text(encoding="utf-8"),
                                          encoding="utf-8")
        (d / "driver.ts").write_text(DRIVER, encoding="utf-8")
        proc = subprocess.run(
            ["node", "--experimental-strip-types", "driver.ts"],
            cwd=d, input=json.dumps(cases), capture_output=True, text=True,
        )
    if proc.returncode != 0:
        print(proc.stderr[-3000:], file=sys.stderr)
        return 1

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "generated_from": "apps/web/lib/radar/product-key.ts",
        "source_sha": sha,
        "generated_at": datetime.now(UTC).date().isoformat(),
        "note": "Expected values were produced BY the TypeScript. If the Python "
                "port disagrees, fix the port -- or, if the TypeScript was "
                "deliberately changed, regenerate with "
                "worker/scripts/gen_catalog_conformance.py.",
        "cases": json.loads(proc.stdout),
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out} — {len(cases)} cases from product-key.ts at {sha[:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
