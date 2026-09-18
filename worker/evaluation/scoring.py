"""Scoring one model answer against a hand-checked answer key.

Ported from `poc4_avaliar.py`. The answer keys in `gabaritos/` were checked
against the PDFs by hand, so the check *types* here are the contract: changing
what `contem_algum` or `numero` mean silently rescores every key. Add a type
rather than redefining one.

A check is one assertion about one field of the triage JSON:

```json
{"nome": "Vigência da ata 12 meses", "campo": "vigencia_meses_normalizada",
 "tipo": "numero", "valor": 12, "tolerancia": 0, "fonte": "p.44"}
```

`campo` is a dotted path (`beneficio_me_epp.situacao`), or `*` for "look
anywhere in the answer" — a few keys check that a number appears at all, without
caring which field carried it.

Note the deliberate difference from :func:`licitaqui.ai_tender.norm`: this one
does **not** collapse whitespace, because `poc4_avaliar.py` did not, and the
57/58 was measured with these comparisons.
"""

from __future__ import annotations

import json
import unicodedata
from dataclasses import dataclass
from typing import Any

from licitaqui.ai_tender import parse_number


def norm(value: Any) -> str:
    """Lowercase and unaccented. Whitespace is left alone on purpose (see above)."""
    text = unicodedata.normalize("NFKD", str(value if value is not None else "").lower())
    return "".join(ch for ch in text if not unicodedata.combining(ch))


def field_at(data: Any, path: str) -> Any:
    """Follow a dotted path; `*` means the whole answer."""
    if path == "*":
        return data
    for part in path.split("."):
        if not isinstance(data, dict):
            return None
        data = data.get(part)
    return data


@dataclass(frozen=True, slots=True)
class CheckResult:
    name: str
    ok: bool
    found: str


def run_check(check: dict[str, Any], data: dict[str, Any]) -> CheckResult:
    """Evaluate one check of an answer key against one answer."""
    value = field_at(data, check["campo"])
    kind, expected = check["tipo"], check["valor"]

    if kind == "igual":
        ok = norm(value).strip() == norm(expected)
    elif kind in ("contem_todos", "contem_algum"):
        blob = norm(json.dumps(value, ensure_ascii=False)).replace(",", ".")
        every = all if kind == "contem_todos" else any
        ok = value not in (None, "") and every(norm(x).replace(",", ".") in blob for x in expected)
    elif kind == "numero":
        number = parse_number(value)
        tolerance = max(abs(expected) * check.get("tolerancia", 0), 0.001)
        ok = number is not None and abs(number - expected) <= tolerance
    elif kind == "maximo":
        number = parse_number(value)
        ok = number is not None and number <= expected
    elif kind == "minimo":
        number = parse_number(value)
        ok = number is not None and number >= expected
    elif kind == "entre":
        number = parse_number(value)
        ok = number is not None and expected[0] <= number <= expected[1]
    elif kind == "verdadeiro":
        ok = value is True or norm(value) in ("true", "sim")
    elif kind == "nulo_ou_contem":
        ok = (
            value in (None, "")
            or norm(value) in ("null", "nao_informado")
            or all(norm(x) in norm(value) for x in expected)
        )
    elif kind == "falso_ou_nulo":
        ok = value in (False, None) or norm(value) in ("false", "nao", "")
    elif kind == "tamanho":
        ok = isinstance(value, list) and len(value) == expected
    else:
        raise ValueError(f"unknown check type '{kind}' in '{check['nome']}'")

    if check["campo"] == "*":
        shown = "(searched the whole answer)"
    else:
        shown = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return CheckResult(name=check["nome"], ok=bool(ok), found=(shown or "")[:120])


def score(answer_key: dict[str, Any], result: dict[str, Any] | None) -> list[CheckResult]:
    """Every screening check of one answer key. Deep checks belong to C2."""
    data = result if isinstance(result, dict) else {}
    return [run_check(check, data) for check in answer_key["checks"]]
