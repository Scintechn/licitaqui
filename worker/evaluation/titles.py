"""The short-title evaluation: run the real path over hand-checked keys and score it.

```bash
python -m evaluation.titles                  # live if a key is configured, replay otherwise
python -m evaluation.titles --mode recorded  # replay: no API call, no cost
python -m evaluation.titles --mode record    # live, and save each answer for replaying
python -m evaluation.titles --case obras_comuns --verbose
```

Exit code 1 when the score is below ``--threshold``. CLAUDE.md requires this run
— and its score diff — for any change to the prompt, the validator or the
deterministic rules.

## What it exercises

The production functions, end to end: :func:`licitaqui.titles.deterministic_title`,
:func:`licitaqui.titles.needs_model`, the prompt, and
:func:`licitaqui.titles.validate`. Only the HTTP call is swapped in replay mode.
Nothing is written to a database.

## Two kinds of key

**Pipeline keys** (`gabaritos_titles/*.json`) carry a real production objeto and
its real top items, and assert things about the title the pipeline produces:
which branch answered, what the title must mention, and what it must never say.
These are what catch the model — or the prompt — drifting.

**Fabrication keys** carry `"answer"`: a title the model actually produced under
the *first*, broken prompt, which asked for "o que e para quem" and invented a
recipient whenever the text had none. They are fed straight to
:func:`licitaqui.titles.validate` and must be rejected. They exist so that
weakening the validator, or reinstating that prompt, fails this gate rather than
reaching the most-read string in the product — under CDC art. 30 advertising
binds the supplier (legal brief §2.2 rule 1).

The three in `gabaritos_titles/` are the three measured on production:

| objeto | what the broken prompt produced |
|---|---|
| `serviço de coleta de lixo hospitalar` | "… **para MEI e pequenas empresas**" |
| `MANUTENÇÃO E CONSERVAÇÃO DE BENS IMÓVEIS` | "**Pintura e reparos** em imóveis **para MEI**" |
| `… RECAPEAMENTO ASFÁLTICO …` | "… **para moradores de Rio Claro**" |
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from licitaqui import config, titles
from licitaqui.ai_tender import OPENROUTER_KEY_VAR, SCREENING_MODEL

HERE = Path(__file__).resolve().parent
KEYS = HERE / "gabaritos_titles"
RECORDED = HERE / "recorded_titles"

#: A title is the most-read string in the product, so the bar is the screening
#: gate's, not something softer.
DEFAULT_THRESHOLD = 95.0

#: Checks that are not a matter of degree. A fabricated beneficiary is a §2.2
#: violation whether it happens once or ten times — under CDC art. 30 the claim
#: binds the supplier either way — so **one** of these failing fails the gate,
#: whatever the aggregate percentage says.
#:
#: This is what made the difference when the first, broken prompt was re-run
#: live against these keys: it produced "Manutenção predial **para Escola
#: Prudêncio de Pinho**" and still scored 97.0%, comfortably over a 95%
#: threshold. An averaged gate cannot protect a string where one bad instance
#: is the whole problem.
SAFETY_TYPES = frozenset({"proibido", "sem_destinatario"})

#: …and every check on a fabrication key is a safety check, by construction.
FABRICATION_SOURCE = "fabricacao"


@dataclass(frozen=True, slots=True)
class CheckResult:
    name: str
    ok: bool
    found: str
    safety: bool = False


@dataclass(slots=True)
class CaseReport:
    name: str
    title: str | None = None
    source: str | None = None
    checks: list[CheckResult] = field(default_factory=list)
    cost_brl: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    replayed: bool = False
    error: str | None = None

    @property
    def passed(self) -> int:
        return sum(1 for check in self.checks if check.ok)

    @property
    def total(self) -> int:
        return len(self.checks)

    @property
    def failures(self) -> list[CheckResult]:
        return [check for check in self.checks if not check.ok]

    @property
    def safety_failures(self) -> list[CheckResult]:
        return [check for check in self.checks if not check.ok and check.safety]


def model_slug(model: str) -> str:
    return re.sub(r"[^\w]+", "-", model).strip("-")


def case_names() -> list[str]:
    return sorted(path.stem for path in KEYS.glob("*.json"))


def load_case(name: str) -> dict[str, Any]:
    return json.loads((KEYS / f"{name}.json").read_text(encoding="utf-8"))


def recorded_path(name: str, model: str) -> Path:
    return RECORDED / f"{name}__{model_slug(model)}.json"


# ──────────────────────────────────────────────────────────────────────────
# Checks
# ──────────────────────────────────────────────────────────────────────────


def _words(text: str) -> set[str]:
    return set(titles.norm(text).replace(",", " ").split())


#: "… para <alguém>". The vocabulary is of *recipients* — people, bodies and
#: populations — so the pattern does not fire on a purpose clause, which is what
#: a good title legitimately carries: "materiais hospitalares para hemodinâmica"
#: names what the material is for, not who gets it.
RECIPIENT_CLAUSE = re.compile(
    r"\b(?:para|destinad[oa]s?\s+a|em\s+favor\s+de|aos?|[àa]s?)\s+"
    r"(?:o|a|os|as|uma?|seus?|suas?)?\s*"
    r"(?:mei\b|micro|pequen|m[ée]dias?\s+empresas|empres[aá]ri|moradores|"
    r"popula[çc]|cidad[ãa]os|comunidade|crian[çc]|idosos|jovens|alunos|"
    r"estudantes|pacientes|usu[áa]rios|servidores|funcion[áa]rios|"
    r"benefici[áa]rios|fam[íi]lias|escola|creche|hospital|posto|"
    r"secretaria|prefeitura|munic[íi]pio|departamento|unidade|"
    r"fundo|gabinete|c[âa]mara|diretoria)",
    re.IGNORECASE,
)


def run_check(check: dict[str, Any], title: str, source: str | None) -> CheckResult:
    """Evaluate one assertion about one produced title.

    The types, and what each is for:

    ``contem_algum`` / ``contem_todos``
        The title must mention the thing being bought. ``valor`` is a list of
        words; matched on the same stem rule the validator uses, so a plural or
        a gender inflection counts.
    ``proibido``
        The title must contain none of these. This is the fabrication guard:
        "mei", "moradores", "população".
    ``ramo``
        Which branch answered — ``deterministic``, ``ai`` or ``ai_fallback``.
        The Centro Cultural case is a `ramo` check: a good short objeto reaching
        the model at all is the bug.
    ``sem_destinatario``
        The title must not end in a *recipient clause* — "… para MEI", "… para
        a Escola Prudente", "… para moradores". This is what makes the gate
        sensitive to the **prompt** rather than only to the validator: the
        validator can only reject a recipient the source never mentions, but
        the first prompt asked for "o que e PARA QUEM" and so produced the
        clause even where the source did name someone, which is still a title
        about the buyer rather than about the purchase. Re-run with that prompt
        and this check is what goes red.
    ``valido``
        :func:`licitaqui.titles.validate` accepts it against its own sources.
    ``maximo_palavras`` / ``maximo_caracteres``
        Shape.
    """
    kind = check["tipo"]
    expected = check.get("valor")
    found = title

    if kind in ("contem_algum", "contem_todos"):
        vocabulary = _words(title)
        every = all if kind == "contem_todos" else any
        ok = every(titles._derivable(titles.norm(word), vocabulary) for word in expected)
    elif kind == "proibido":
        vocabulary = _words(title)
        hits = [w for w in expected if titles.norm(w) in vocabulary]
        ok = not hits
        found = f"{title}   ← {hits}" if hits else title
    elif kind == "ramo":
        ok = source == expected
        found = str(source)
    elif kind == "sem_destinatario":
        hit = RECIPIENT_CLAUSE.search(titles.norm(title))
        ok = hit is None
        found = f"{title}   ← '{hit.group(0)}'" if hit else title
    elif kind == "maximo_palavras":
        ok = len(title.split()) <= int(expected)
        found = f"{len(title.split())} palavras"
    elif kind == "maximo_caracteres":
        ok = len(title) <= int(expected)
        found = f"{len(title)} caracteres"
    else:  # pragma: no cover - an unknown type is a broken key, not a failing model
        raise ValueError(f"unknown check type {kind!r} in a title answer key")

    return CheckResult(name=check["nome"], ok=ok, found=found, safety=kind in SAFETY_TYPES)


# ──────────────────────────────────────────────────────────────────────────
# Running one case
# ──────────────────────────────────────────────────────────────────────────


def run_fabrication_case(case: dict[str, Any], name: str) -> CaseReport:
    """A recorded fabrication must be rejected, for the recorded reason."""
    answer = case["answer"]
    block = titles.item_lines(case.get("itens", []))
    reason = titles.validate(answer, case["objeto"], block)
    expected = case.get("rejeicao")

    checks = [
        CheckResult(
            name="o validador rejeita",
            ok=reason is not None,
            found=reason or "ACEITOU — a fabricação passaria para o produto",
            safety=True,
        )
    ]
    if expected:
        checks.append(
            CheckResult(
                name=f"rejeitado por {expected}",
                ok=(reason or "").startswith(expected),
                found=reason or "aceitou",
                safety=True,
            )
        )
    return CaseReport(name=name, title=answer, source=FABRICATION_SOURCE, checks=checks)


def run_pipeline_case(
    case: dict[str, Any], name: str, *, model: str, mode: str, key: str | None
) -> CaseReport:
    """Run the real two-branch pipeline over one objeto and score the title."""
    objeto = case["objeto"]
    items = case.get("itens", [])
    captured: list[dict[str, Any]] = []

    free = titles.deterministic_title(objeto)
    will_call = titles.needs_model(free)

    if not will_call:
        result = titles.Title(free, titles.SOURCE_DETERMINISTIC)
    elif mode == "recorded":
        path = recorded_path(name, model)
        if not path.exists():
            return CaseReport(
                name=name,
                replayed=True,
                error=f"no recorded answer at {path.relative_to(HERE.parent)}; run --mode record",
            )
        stored = json.loads(path.read_text(encoding="utf-8"))
        result = _replayed_result(stored, objeto, items)
    else:
        result = titles.build(objeto, items, key=key or "")
        if result is None:
            return CaseReport(name=name, error="rate_limited")
        captured.append(
            {"title": result.text, "source": result.source, "rejected": result.rejected}
        )

    if mode == "record" and captured:
        RECORDED.mkdir(parents=True, exist_ok=True)
        recorded_path(name, model).write_text(
            json.dumps(
                {
                    "case": name,
                    "model": model,
                    "prompt_version": titles.PROMPT_VERSION,
                    "rules_version": titles.RULES_VERSION,
                    "recorded_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
                    "answer": captured[0],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    report = CaseReport(
        name=name,
        title=result.text,
        source=result.source,
        cost_brl=result.cost_brl,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        replayed=mode == "recorded" and will_call,
    )
    report.checks = [run_check(check, result.text, result.source) for check in case["checks"]]
    return report


def _replayed_result(
    stored: dict[str, Any], objeto: str, items: list[dict[str, Any]]
) -> titles.Title:
    """Rebuild a Title from a recorded model answer, re-running the validator.

    The validator is deliberately *not* replayed: a change to it must show up
    here, which is the whole reason a recorded run is worth having.
    """
    raw = stored["answer"]["title"]
    block = titles.item_lines(items)
    free = titles.deterministic_title(objeto)
    recorded_source = stored["answer"].get("source")

    if recorded_source == titles.SOURCE_AI_FALLBACK:
        # The recorded run never got a usable answer; keep that outcome.
        return titles.Title(
            free,
            titles.SOURCE_AI_FALLBACK,
            prompt_version=titles.PROMPT_VERSION,
            rejected=stored["answer"].get("rejected"),
        )
    reason = titles.validate(raw, objeto, block)
    if reason:
        return titles.Title(
            free, titles.SOURCE_AI_FALLBACK, prompt_version=titles.PROMPT_VERSION, rejected=reason
        )
    return titles.Title(raw, titles.SOURCE_AI, prompt_version=titles.PROMPT_VERSION)


def run_case(name: str, *, model: str, mode: str, key: str | None) -> CaseReport:
    case = load_case(name)
    if "answer" in case:
        return run_fabrication_case(case, name)
    return run_pipeline_case(case, name, model=model, mode=mode, key=key)


# ──────────────────────────────────────────────────────────────────────────
# Reporting
# ──────────────────────────────────────────────────────────────────────────


def print_report(reports: list[CaseReport], *, model: str, mode: str, threshold: float) -> bool:
    passed = sum(r.passed for r in reports)
    total = sum(r.total for r in reports)
    overall = 100.0 * passed / total if total else 0.0
    cost = sum(r.cost_brl for r in reports)

    label = {"recorded": "REPLAYED (no API call, nothing spent)", "record": "LIVE + recorded"}
    print()
    print(f"Short-title evaluation · model {model} · {label.get(mode, 'LIVE')}")
    print(f"prompt {titles.PROMPT_VERSION} · rules v{titles.RULES_VERSION}")
    print("-" * 100)
    print(f"{'Answer key':26} {'Correct':>8} {'%':>7} {'branch':>13}  {'title':<36} {'R$':>8}")
    for report in reports:
        pct = 100.0 * report.passed / report.total if report.total else 0.0
        print(
            f"{report.name[:26]:26} {f'{report.passed}/{report.total}':>8} {pct:>6.1f}% "
            f"{str(report.source)[:13]:>13}  {(report.title or '—')[:36]:<36} "
            f"{report.cost_brl:>8.5f}"
        )
    print("-" * 100)
    print(f"{'TOTAL':26} {f'{passed}/{total}':>8} {overall:>6.1f}% {'':>13}  {'':<36} {cost:>8.5f}")

    for report in reports:
        if report.error:
            print(f"\n  {report.name}: {report.error}")
        for failure in report.failures:
            mark = "✗✗" if failure.safety else " ✗"
            print(f"  {mark} {report.name} · {failure.name} → {failure.found}")

    unsafe = [(r.name, c) for r in reports for c in r.safety_failures]
    ok = total > 0 and overall >= threshold and not unsafe
    print()
    if unsafe:
        print(f"{len(unsafe)} safety check(s) failed — §2.2 is not an average:")
        for case_name, check in unsafe:
            print(f"  ✗✗ {case_name} · {check.name}")
    print(
        f"{'PASS' if ok else 'FAIL'} · {overall:.1f}% "
        f"{'≥' if overall >= threshold else '<'} {threshold:.0f}%"
        f"{', but a safety check failed' if unsafe and overall >= threshold else ''}"
    )
    if mode == "recorded":
        print(
            "Note: this run replayed recorded answers. It proves the rules, the "
            "predicate and the validator did not regress, not that the live model "
            "still scores this."
        )
    return ok


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Score the short titles against the keys")
    parser.add_argument("--mode", choices=("auto", "live", "record", "recorded"), default="auto")
    parser.add_argument("--model", default=SCREENING_MODEL)
    parser.add_argument("--case", action="append", default=[], help="key name; repeatable")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    key = config.resolve_secret(OPENROUTER_KEY_VAR)
    mode = args.mode
    if mode == "auto":
        mode = "live" if key else "recorded"
    if mode in ("live", "record") and not key:
        print(f"{OPENROUTER_KEY_VAR} is not configured; --mode {mode} needs it")
        return 2

    names = args.case or case_names()
    reports = [run_case(n, model=args.model, mode=mode, key=key) for n in names]

    if args.verbose:
        for report in reports:
            print(f"\n{report.name}: {report.title!r} [{report.source}]")
            for check in report.checks:
                print(f"  {'✓' if check.ok else '✗'} {check.name:44} {check.found}")

    return 0 if print_report(reports, model=args.model, mode=mode, threshold=args.threshold) else 1


if __name__ == "__main__":
    raise SystemExit(main())
