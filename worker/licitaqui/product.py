"""The product's numbers, for the worker's message templates.

## Why this repeats `docs/product.json` instead of reading it

The worker ships as a Docker image whose **build context is `worker/`**
(`docker build … worker/` in `ci-worker.yml`), and the Dockerfile copies
`pyproject.toml`, `licitaqui/`, `evaluation/` and `templates/`. `docs/` is not
in the context at all, so a runtime read of `docs/product.json` would work in
every test and on every laptop and raise `FileNotFoundError` in production.

That is precisely the shape of the defect `licitaqui.selfcheck` exists to
catch: before 2026-09-23 the Dockerfile omitted `COPY templates/`, every check
was green, and not one message ever rendered. Widening the build context to
the repository root to avoid retyping four numbers would be a much larger
change — every layer cache, every `.dockerignore` assumption — for a worse
trade.

So the values live here too, and `tests/test_product.py` asserts they match
`docs/product.json`. Same principle as the legal documents: the duplication
cannot be removed, so it is **proven** instead. Change `docs/product.json`,
the test names this file, and you copy the number across once.
"""

from __future__ import annotations

from datetime import date
from typing import Final

#: Whole BRL per month, by plan. `promocional` is the first-months price.
PLAN_PRICES: Final[dict[str, int]] = {
    "basico": 0,
    "promocional": 57,
    "essencial": 75,
    "pro": 129,
}

#: How many months the founder price lasts, and what it becomes afterwards.
PROMO_MONTHS: Final = 3
PROMO_THEN_BRL: Final = PLAN_PRICES["essencial"]

#: Contractual total (terms §6), released in two lots of 17 then 8. The
#: **open** cap is a row in `app_settings`, not a constant — opening lot 2 is
#: an UPDATE, never a deploy. Templates quote this number, not the open one.
FOUNDER_SEATS_TOTAL: Final = 25

#: **The founders opening, and the one fact this module did not hold.**
#:
#: Sci moved the opening to **2026-10-17 12:00 BRT** on 2026-10-03 and cancelled
#: the broadcast queued for 08/10 (`events.founders_opening_broadcast_cancelled`,
#: *"new date pending"*). `docs/product.json` moved, `apps/web` moved with it —
#: and the worker did not, because these two values were the only product facts
#: kept **outside this module**, in `whatsapp.py`'s own constants, where
#: `test_product.py` could not see them.
#:
#: Everything else here is duplicated-and-asserted on purpose: the worker cannot
#: read `docs/product.json` at runtime, since `docs/` is outside the Docker build
#: context. The date and the hour now take the same bargain. Run against the old
#: value, `broadcast_at()` returned an instant in the **past**, and `run_after <=
#: now()` makes such a job claimable **immediately** — so the stale constant was
#: not inert, it was early.
#:
#: They stay **two** values, not one: the date is copy (`{{data_abertura}}`, on
#: the welcome and the waitlist e-mail) and the hour belongs to the broadcast
#: sweep alone. Moving one must not silently move the other.
OPENING_DATE: Final = date(2026, 10, 17)
OPENING_HOUR_BRT: Final = "12:00"

#: Days of warning owed before a charge changes (terms §6, §13).
PRICE_CHANGE_NOTICE_DAYS: Final = 30


def brl(amount: int) -> str:
    """``26`` → ``"R$ 26"`` — the form running copy uses."""
    return f"R$ {amount}"


def brl_exact(amount: int) -> str:
    """``26`` → ``"R$ 26,00"`` — the form receipts and the terms use."""
    return f"R$ {amount},00"


def template_context() -> dict[str, str]:
    """Product facts every template may use, merged into every render context.

    Named in Portuguese to match the placeholders a template author writes, and
    supplied to **every** template rather than per-template: the alternative is
    each sender remembering which of nine templates quotes a price, which is
    the bookkeeping this whole change exists to delete.

    `templates.py` requires that a declared placeholder is used and a used one
    is declared, so a template that does not mention a price simply never
    declares these and is unaffected.
    """
    return {
        "preco_basico": brl(PLAN_PRICES["basico"]),
        "preco_promocional": brl(PLAN_PRICES["promocional"]),
        "preco_essencial": brl(PLAN_PRICES["essencial"]),
        "preco_pro": brl(PLAN_PRICES["pro"]),
        "preco_promocional_exato": brl_exact(PLAN_PRICES["promocional"]),
        "preco_essencial_exato": brl_exact(PLAN_PRICES["essencial"]),
        "meses_promocionais": str(PROMO_MONTHS),
        "vagas": str(FOUNDER_SEATS_TOTAL),
        "dias_aviso_preco": str(PRICE_CHANGE_NOTICE_DAYS),
    }
