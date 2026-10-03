#!/usr/bin/env python3
"""Regenerate the band's conformance fixture FROM the TypeScript (card B35).

    python worker/scripts/gen_price_band_conformance.py [--out …]

## Why this script exists

:mod:`licitaqui.price_band` is a port of ``apps/web/lib/radar/price-band.ts``,
and that TypeScript is the implementation the band's measured accuracy was
produced by — **hit 56%, median bias +0.2%**, against the ~50% a correct
quartile band scores by construction. Those figures belong to that code and to
nothing else.

The port already pins the four gate constants to the TypeScript with a drift
test. That is not enough, and two defects proved it: the arithmetic was pinned
only to numbers somebody had typed into a test, so

* the band was computed from each purchase's **lower-middle real row** instead
  of its **median** — `priceEvidence`'s choice where `priceBand`'s was wanted,
  a third low on a two-row purchase — and every hand-written expectation
  agreed with it;
* the cutoff was compared as a calendar date against a UTC instant, and the
  hand-written cases never crossed the boundary.

A fixture generated **by the TypeScript** would have caught both.
``catalog_match.py`` had already set exactly this precedent with 418 generated
cases; this module cited it without following it.

So: if the conformance test fails, **the port is wrong.** Only when the
TypeScript has been deliberately changed is regenerating the right answer, and
then `source_sha` records which version the fixture describes.

## What it pins, and why these cases

`priceBand` is a pipeline of four decisions, and a hand-written case tends to
exercise one. The generated set is built to make each one fail loudly if the
port disagrees:

``two_lots``
    the whole reason this fixture exists: median 15 against a lower-middle row
    of 10, and at the measured 1.87 rows per purchase this is the modal
    multi-row shape.
``even_lots`` / ``odd_lots``
    the interpolating median against the exact middle.
``ties``
    equal prices, where a stable sort and an unstable one give the same number
    and a *different* chosen row.
``cutoff``
    purchases dated on, side of, and across :data:`MAX_AGE_MONTHS`, with
    ``now`` pinned, so the age filter is tested and the clock is not.
``month_overflow``
    a ``now`` of the 31st, where JavaScript's ``setMonth`` rolls rather than
    clamps.
``spread_edge``
    IQR/median landing exactly on :data:`MAX_SPREAD`, which `priceBand` admits
    (``>``, not ``>=``).
``floor_edge``
    four and five purchases around :data:`MIN_SAMPLE`.
``lot_heavy``
    `priceBand`'s own worked example — 40 lots at R$ 1,20 beside four purchases
    at R$ 2,40–2,60 — which the per-purchase collapse exists to defuse.
``split_windows``
    a purchase whose lots arrive in two groups. The TypeScript sees them all at
    once, which is the authority the two-stage ingest collapse is measured
    against (see :func:`licitaqui.catalog_prices.merge_with_stored`).

## How it reads the TypeScript

`price-band.ts` imports nothing, so it runs under
``node --experimental-strip-types`` straight from a checkout of the file. Node
22+ required. The script writes a small driver beside a copy of the module,
feeds it the cases as JSON and reads the results back — no bundler, no `pnpm`,
nothing installed. The same mechanism ``gen_catalog_conformance.py`` uses.

The driver calls the **real** `priceBand` and `priceEvidence`, passes an
explicit ``now`` so the comparison is about arithmetic rather than clocks, and
also echoes the four constants, so a regenerated fixture that disagreed with the
drift test would be caught by the drift test too.
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
TS_SOURCE = REPO / "apps" / "web" / "lib" / "radar" / "price-band.ts"
DEFAULT_OUT = REPO / "worker" / "tests" / "fixtures" / "price_band_conformance.json"

#: Pinned, so the fixture is reproducible and the clock is never under test.
NOW = "2026-10-03T12:00:00.000Z"
#: A ``now`` on the 31st, where `setMonth` rolls into the next month.
NOW_31 = "2026-03-31T12:00:00.000Z"


def _lots(tender: str, prices: list[float], on: str | None) -> list[dict]:
    return [
        {
            "tenderId": tender,
            "unitAwardedValue": price,
            "awardedOn": on,
            "description": f"{tender} lot {n}",
        }
        for n, price in enumerate(prices)
    ]


def cases() -> list[dict]:
    """The adversarial set. Each entry is ``{name, now, comparables}``."""
    fresh = "2026-09-01"
    out: list[dict] = []

    def case(name: str, comparables: list[dict], now: str = NOW) -> None:
        out.append({"name": name, "now": now, "comparables": comparables})

    # The modal multi-row shape: median 15, lower-middle row 10.
    case("two_lots", [lot for n in range(5) for lot in _lots(f"t{n}", [10.0, 20.0], fresh)])
    # Interpolating median (even) against the exact middle (odd).
    case(
        "even_lots",
        [lot for n in range(5) for lot in _lots(f"t{n}", [10.0, 12.0, 18.0, 20.0], fresh)],
    )
    case("odd_lots", [lot for n in range(5) for lot in _lots(f"t{n}", [10.0, 15.0, 20.0], fresh)])
    # Equal prices: a stable and an unstable sort agree on the number and
    # disagree on the row.
    case("ties", [lot for n in range(5) for lot in _lots(f"t{n}", [10.0, 10.0, 10.0], fresh)])
    # The age filter, with purchases either side of the 18-month cutoff.
    case(
        "cutoff",
        [
            *_lots("old1", [10.0], "2024-01-01"),
            *_lots("edge", [11.0], "2025-04-03"),  # exactly the cutoff day
            *_lots("edge2", [12.0], "2025-04-02"),  # one day older
            *_lots("f1", [13.0], fresh),
            *_lots("f2", [14.0], fresh),
            *_lots("f3", [15.0], fresh),
            *_lots("f4", [16.0], fresh),
            *_lots("f5", [17.0], fresh),
        ],
    )
    # A null date counts as fresh, as the TypeScript has it.
    case("null_dates", [lot for n in range(5) for lot in _lots(f"t{n}", [10.0 + n], None)])
    # `setMonth` rolls rather than clamps on the 31st.
    case(
        "month_overflow",
        [
            *_lots("a", [10.0], "2024-10-01"),
            *_lots("b", [11.0], "2024-09-30"),
            *_lots("c", [12.0], "2025-01-01"),
            *_lots("d", [13.0], "2025-06-01"),
            *_lots("e", [14.0], "2026-01-01"),
            *_lots("f", [15.0], "2026-03-01"),
        ],
        now=NOW_31,
    )
    # IQR/median exactly MAX_SPREAD, which `priceBand` admits.
    case(
        "spread_edge",
        [
            *_lots("a", [5.0], fresh),
            *_lots("b", [7.5], fresh),
            *_lots("c", [10.0], fresh),
            *_lots("d", [12.5], fresh),
            *_lots("e", [15.0], fresh),
        ],
    )
    case(
        "spread_over",
        [
            *_lots("a", [1.0], fresh),
            *_lots("b", [5.0], fresh),
            *_lots("c", [10.0], fresh),
            *_lots("d", [50.0], fresh),
            *_lots("e", [100.0], fresh),
        ],
    )
    # Either side of MIN_SAMPLE.
    case("floor_four", [lot for n in range(4) for lot in _lots(f"t{n}", [10.0 + n / 2], fresh)])
    case("floor_five", [lot for n in range(5) for lot in _lots(f"t{n}", [10.0 + n / 2], fresh)])
    case("empty", [])
    case("all_stale", [lot for n in range(6) for lot in _lots(f"t{n}", [10.0], "2023-01-01")])
    # `priceBand`'s own worked example: 40 lots at 1.20 against four purchases.
    case(
        "lot_heavy",
        [
            *_lots("rp", [1.20 + n / 10_000 for n in range(40)], fresh),
            *_lots("a", [2.40], fresh),
            *_lots("b", [2.50], fresh),
            *_lots("c", [2.55], fresh),
            *_lots("d", [2.60], fresh),
        ],
    )
    # A purchase whose lots would arrive in two windows. The TypeScript sees
    # them together, which is the authority the ingest collapse is measured
    # against — and where the two-stage collapse has a known residual.
    case(
        "split_windows",
        [
            *_lots("split", [200.0, 1000.0, 250.0], fresh),
            *_lots("a", [240.0], fresh),
            *_lots("b", [250.0], fresh),
            *_lots("c", [255.0], fresh),
            *_lots("d", [260.0], fresh),
        ],
    )
    return out


DRIVER = """\
// Cases arrive as JSON on stdin. We call the REAL priceBand/priceEvidence, with
// an explicit `now`, so what is pinned is the arithmetic and not the clock.
import {
  priceBand, priceEvidence, MIN_SAMPLE, MAX_SPREAD, MAX_AGE_MONTHS,
  MAX_SAMPLES_SHOWN,
} from './price-band.ts'

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { raw += c })
process.stdin.on('end', () => {
  const cases = JSON.parse(raw).map((c) => {
    const comparables = c.comparables.map((x) => ({
      tenderId: x.tenderId,
      unitAwardedValue: x.unitAwardedValue,
      awardedOn: x.awardedOn === null ? null : new Date(x.awardedOn + 'T00:00:00.000Z'),
      description: x.description,
    }))
    const now = new Date(c.now)
    const band = priceBand(comparables, now)
    const evidence = priceEvidence(comparables, now)
    return {
      name: c.name,
      now: c.now,
      comparables: c.comparables,
      band,
      evidence: evidence === null ? null : {
        editais: evidence.editais,
        samples: evidence.samples,
      },
    }
  })
  process.stdout.write(JSON.stringify({
    constants: { MIN_SAMPLE, MAX_SPREAD, MAX_AGE_MONTHS, MAX_SAMPLES_SHOWN },
    cases,
  }))
})
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument(
        "--sha",
        default=None,
        help="the price-band.ts commit these values describe (default: HEAD of this checkout)",
    )
    args = ap.parse_args()

    if not TS_SOURCE.exists():
        print(f"missing {TS_SOURCE}", file=sys.stderr)
        return 1

    sha = (
        args.sha
        or subprocess.run(
            ["git", "-C", str(REPO), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    )

    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "price-band.ts").write_text(TS_SOURCE.read_text(encoding="utf-8"), encoding="utf-8")
        (d / "driver.ts").write_text(DRIVER, encoding="utf-8")
        proc = subprocess.run(
            ["node", "--experimental-strip-types", "driver.ts"],
            cwd=d,
            input=json.dumps(cases()),
            capture_output=True,
            text=True,
        )
    if proc.returncode != 0:
        print(proc.stderr[-3000:], file=sys.stderr)
        return 1

    payload = json.loads(proc.stdout)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "generated_from": "apps/web/lib/radar/price-band.ts",
                "source_sha": sha,
                "generated_at": datetime.now(UTC).date().isoformat(),
                "note": "Expected values were produced BY the TypeScript. If the Python "
                "port disagrees, fix the port -- or, if the TypeScript was "
                "deliberately changed, regenerate with "
                "worker/scripts/gen_price_band_conformance.py.",
                **payload,
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote {out} — {len(payload['cases'])} cases from price-band.ts at {sha[:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
