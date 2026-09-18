"""The screening evaluation: run the real path over the three answer keys and score it.

```bash
python -m evaluation                 # live if a key is configured, replay otherwise
python -m evaluation --mode recorded # replay the recorded answers: no API call, no cost
python -m evaluation --mode record   # live, and save each answer for replaying later
python -m evaluation --doc 01_EditalPE221_26 --verbose
```

Exit code 1 when the overall score is below ``--threshold`` (95% — the gate in
spec §13 and the acceptance criterion of task C1). CI runs it whenever
`ai_tender.py`, the job or these files change (`.github/workflows/evaluate-ai.yml`).

## What it actually exercises

Everything the job does with the document, in the production functions: page
selection, the prompt, the call plans, `compute_rules`, `check_citations` and
the scoring. Only the two ends are swapped — the pages come from
`textos/*.json.gz` (the same extraction that `extract_text` produces from the
PDFs, verified byte for byte) instead of from S3, and nothing is written to the
database.

## Live versus recorded

**Recorded** replays a stored OpenRouter response, so it is free, deterministic
and offline — but it cannot see the model drifting. It still catches every
regression on our side: extraction, page selection, the rules, the citation
check, the scoring.

**Live** is the real gate: it sends the current prompt to the current model and
pays for it (about R$ 0,004 per edital with `qwen/qwen3.7-flash`). This is what
must be run — and reported — for any prompt or extraction change (CLAUDE.md).

`--mode auto` picks live when `OPENROUTER_API_KEY` resolves and replay when it
does not, so a fork's CI is not a red X and a misconfigured secret cannot be
mistaken for a passing live run: the report says which mode produced it.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from licitaqui import ai_tender, config
from licitaqui.ai_tender import Document, Screening

from . import scoring
from .scoring import CheckResult

HERE = Path(__file__).resolve().parent
ANSWER_KEYS = HERE / "gabaritos"
TEXTS = HERE / "textos"
RECORDED = HERE / "recorded"

#: Spec §13: screening below 95% correct fails the build.
DEFAULT_THRESHOLD = 95.0

#: The POC's measured baseline on these same three keys, for the report line.
POC_BASELINE = "57/58 (98.3%)"


@dataclass(frozen=True, slots=True)
class Case:
    name: str
    answer_key: dict[str, Any]
    document: Document


@dataclass(slots=True)
class CaseReport:
    name: str
    status: str
    checks: list[CheckResult] = field(default_factory=list)
    citation_check: dict[str, Any] | None = None
    cost_brl: float = 0.0
    seconds: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    pages_sent: int = 0
    replayed: bool = False
    error: str | None = None

    @property
    def passed(self) -> int:
        return sum(1 for check in self.checks if check.ok)

    @property
    def total(self) -> int:
        return len(self.checks)

    @property
    def percentage(self) -> float:
        return 100.0 * self.passed / self.total if self.total else 0.0

    @property
    def failures(self) -> list[CheckResult]:
        return [check for check in self.checks if not check.ok]


def model_slug(model: str) -> str:
    return re.sub(r"[^\w]+", "-", model).strip("-")


def load_case(name: str) -> Case:
    answer_key = json.loads((ANSWER_KEYS / f"{name}.json").read_text(encoding="utf-8"))
    with gzip.open(TEXTS / f"{name}.json.gz", "rt", encoding="utf-8") as handle:
        document = Document.from_dict(json.load(handle))
    return Case(name=name, answer_key=answer_key, document=document)


def case_names() -> list[str]:
    return sorted(path.stem for path in ANSWER_KEYS.glob("*.json"))


def recorded_path(name: str, model: str) -> Path:
    return RECORDED / f"{name}__{model_slug(model)}.json"


def _replaying_call(calls: Sequence[dict[str, Any]]) -> Any:
    """A `call_model` stand-in that hands back the recorded responses in order."""
    remaining = list(calls)

    def call(*_args: Any, **_kwargs: Any) -> tuple[int, dict[str, Any]]:
        entry = remaining.pop(0) if remaining else {"status": 0, "payload": {"error": "no more"}}
        return int(entry["status"]), entry["payload"]

    return call


def _capturing_call(store: list[dict[str, Any]]) -> Any:
    """The real `call_model`, keeping every response so it can be recorded."""

    def call(*args: Any, **kwargs: Any) -> tuple[int, dict[str, Any]]:
        status, payload = ai_tender.call_model(*args, **kwargs)
        store.append({"status": status, "payload": payload})
        return status, payload

    return call


def run_case(case: Case, *, model: str, mode: str, key: str | None) -> CaseReport:
    """Screen one answer-key document and score the answer."""
    captured: list[dict[str, Any]] = []
    if mode == "recorded":
        path = recorded_path(case.name, model)
        if not path.exists():
            return CaseReport(
                name=case.name,
                status="missing",
                replayed=True,
                error=f"no recorded answer at {path.relative_to(HERE.parent)}; run --mode record",
            )
        stored = json.loads(path.read_text(encoding="utf-8"))
        call = _replaying_call(stored["calls"])
    else:
        call = _capturing_call(captured)

    screening: Screening = ai_tender.screen(
        case.document, key=key or "recorded", model=model, call=call
    )

    if mode == "record" and screening.status == "ok":
        recorded_path(case.name, model).parent.mkdir(parents=True, exist_ok=True)
        recorded_path(case.name, model).write_text(
            json.dumps(
                {
                    "document": case.name,
                    "model": model,
                    "prompt_version": ai_tender.PROMPT_VERSION_LITE,
                    "extraction_version": ai_tender.EXTRACTION_VERSION,
                    "recorded_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
                    "calls": captured,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    analysis = screening.analysis
    report = CaseReport(
        name=case.name,
        status=screening.status,
        citation_check=analysis.citation_check if analysis else None,
        cost_brl=analysis.cost_brl if analysis else 0.0,
        seconds=analysis.seconds if analysis else 0.0,
        input_tokens=analysis.input_tokens if analysis else 0,
        output_tokens=analysis.output_tokens if analysis else 0,
        pages_sent=len(screening.selection.kept) if screening.selection else 0,
        replayed=mode == "recorded",
        error=screening.error,
    )
    if screening.status == "ok" and analysis is not None:
        report.checks = scoring.score(case.answer_key, analysis.result)
    return report


def print_report(reports: list[CaseReport], *, model: str, mode: str, threshold: float) -> bool:
    """Print the per-document table and return whether the gate passes."""
    passed = sum(report.passed for report in reports)
    total = sum(report.total for report in reports)
    overall = 100.0 * passed / total if total else 0.0
    cost = sum(report.cost_brl for report in reports)
    citations = sum((r.citation_check or {}).get("citations", 0) for r in reports)
    verified = sum((r.citation_check or {}).get("verified", 0) for r in reports)

    label = {"recorded": "REPLAYED (no API call, nothing spent)", "record": "LIVE + recorded"}
    print()
    print(f"Screening evaluation · model {model} · {label.get(mode, 'LIVE')}")
    print(f"prompt {ai_tender.PROMPT_VERSION_LITE} · extraction v{ai_tender.EXTRACTION_VERSION}")
    print("-" * 92)
    header = f"{'Answer key':32} {'Correct':>9} {'%':>7} {'Citations':>11}"
    print(f"{header} {'R$':>8} {'s':>6} {'status':>8}")
    for report in reports:
        cited = report.citation_check or {}
        cite = (
            f"{cited.get('verified', 0):g}/{cited.get('citations', 0)}"
            if cited.get("citations")
            else "—"
        )
        print(
            f"{report.name[:32]:32} {f'{report.passed}/{report.total}':>9} "
            f"{report.percentage:>6.1f}% {cite:>11} {report.cost_brl:>8.4f} "
            f"{report.seconds:>6.0f} {report.status:>8}"
        )
    print("-" * 92)
    print(
        f"{'TOTAL':32} {f'{passed}/{total}':>9} {overall:>6.1f}% "
        f"{f'{verified:g}/{citations}' if citations else '—':>11} {cost:>8.4f}"
    )
    print(f"POC 4 baseline on these same keys: {POC_BASELINE}")

    for report in reports:
        if report.error:
            print(f"\n  {report.name}: {report.status} — {report.error}")
        for failure in report.failures:
            print(f"  ✗ {report.name} · {failure.name} → {failure.found}")

    ok = total > 0 and overall >= threshold
    print()
    if ok:
        print(f"PASS · {overall:.1f}% ≥ {threshold:.0f}%")
    else:
        print(f"FAIL · {overall:.1f}% < {threshold:.0f}%")
    if mode == "recorded":
        print(
            "Note: this run replayed recorded answers. It proves our own code did not "
            "regress, not that the live model still scores this."
        )
    return ok


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Score the screening against the answer keys")
    parser.add_argument("--mode", choices=("auto", "live", "record", "recorded"), default="auto")
    parser.add_argument("--model", default=ai_tender.SCREENING_MODEL)
    parser.add_argument("--doc", action="append", default=[], help="answer key name; repeatable")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--verbose", action="store_true", help="print every check, not only ✗")
    args = parser.parse_args(argv)

    key = config.resolve_secret(ai_tender.OPENROUTER_KEY_VAR)
    mode = args.mode
    if mode == "auto":
        mode = "live" if key else "recorded"
    if mode in ("live", "record") and not key:
        print(f"{ai_tender.OPENROUTER_KEY_VAR} is not configured; --mode {mode} needs it")
        return 2

    names = args.doc or case_names()
    reports = [run_case(load_case(name), model=args.model, mode=mode, key=key) for name in names]

    if args.verbose:
        for report in reports:
            print(f"\n{report.name}")
            for check in report.checks:
                print(f"  {'✓' if check.ok else '✗'} {check.name:44} {check.found}")

    return 0 if print_report(reports, model=args.model, mode=mode, threshold=args.threshold) else 1


if __name__ == "__main__":
    raise SystemExit(main())
