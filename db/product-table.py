#!/usr/bin/env python3
"""Render `docs/product.json` as a table to read before changing a number.

    worker/.venv/bin/python db/product-table.py            # print it
    worker/.venv/bin/python db/product-table.py --write    # also write the file

## Why this is generated and not written by hand

Sci asked for a local document listing the current values and when they last
changed. A hand-kept table would be a *second* source of truth for the exact
numbers this work exists to stop duplicating — it would drift from
`docs/product.json`, and it would be trusted anyway, because a table that
looks authoritative is read as authoritative. So it is rendered, never edited.

## Where it lands, and why it is not committed

`--write` puts it at `product-values.local.md`, which `.gitignore` covers with
the rest of the `*.local.*` family. That is Sci's preference and it costs
nothing, because the file is reproducible from one command.

One consequence worth knowing: an uncommitted file has no history, so the
"changed" column below comes from **git** — `git log` on `docs/product.json`
— rather than from anything this script remembers. That is also the honest
answer to "when did this last change", and it is why the canonical file is the
one in version control.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FACTS = ROOT / "docs" / "product.json"
OUT = ROOT / "product-values.local.md"


def last_changed() -> str:
    """When `docs/product.json` was last committed, per git — not per this script."""
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%ad (%h) %s", "--date=short", "--", str(FACTS)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return out.stdout.strip() or "not committed yet"
    except (OSError, subprocess.SubprocessError):
        return "unknown (git unavailable)"


def render() -> str:
    facts = json.loads(FACTS.read_text(encoding="utf-8"))
    plans, founders, notice = facts["plans"], facts["founders"], facts["notice"]

    rows = [
        ("Básico", f"R$ {plans['basico']['brl']}/mês", "free tier"),
        (
            "Promocional (fundadores)",
            f"R$ {plans['promocional']['brl']}/mês",
            f"for {plans['promocional']['months']} months, then "
            f"R$ {plans['promocional']['thenBrl']}",
        ),
        ("Essencial", f"R$ {plans['essencial']['brl']}/mês", "—"),
        ("Pro", f"R$ {plans['pro']['brl']}/mês", "—"),
        ("Founder seats", str(founders["seats"]), "first come, first served"),
        (
            "Founders open",
            f"{founders['opensOn']} at {founders['opensAtBrt']}",
            "BRT — the product's clock",
        ),
        (
            "Price-change notice",
            f"{notice['priceChangeDays']} days",
            "before the promo price ends (terms §6, §13)",
        ),
        (
            "Charge reminder",
            f"{notice['chargeReminderDays']} days",
            "before each charge (terms §7)",
        ),
    ]
    width = max(len(name) for name, _, _ in rows)
    value_width = max(len(value) for _, value, _ in rows)

    lines = [
        "# LicitaQui — current product values",
        "",
        "**Generated. Do not edit.** Source of truth: `docs/product.json`.",
        f"Regenerate: `worker/.venv/bin/python db/product-table.py --write`",
        "",
        f"`docs/product.json` last changed: **{last_changed()}**",
        "",
        f"| {'What':<{width}} | {'Value':<{value_width}} | Note |",
        f"|{'-' * (width + 2)}|{'-' * (value_width + 2)}|------|",
    ]
    lines += [f"| {name:<{width}} | {value:<{value_width}} | {note} |" for name, value, note in rows]
    lines += [
        "",
        "## Before changing any of these",
        "",
        "1. Edit **`docs/product.json`** — that file only.",
        "2. Run `pnpm vitest run lib/product.test.ts` from `apps/web`.",
        "   It goes red and **names every file still carrying the old value**:",
        "   the copy catalogue, the worker templates, and the legal documents.",
        "3. Work through that list. The legal files are Sci's to write (brief §5);",
        "   a price in `termos-de-uso.md` is a contract clause, not a string.",
        "4. Re-run until green, then regenerate this table.",
        "",
        "A price change is never only a copy change: `termos-de-uso.md` is",
        "versioned and published, and §6/§13 promise 30 days' notice before an",
        "increase reaches anyone already subscribed.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    text = render()
    print(text)
    if "--write" in sys.argv:
        OUT.write_text(text, encoding="utf-8")
        print(f"\nwritten to {OUT.relative_to(ROOT)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
