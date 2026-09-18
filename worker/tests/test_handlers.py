"""The registry is complete once `licitaqui.handlers` is imported.

This is the guard for a bug that does not announce itself. A handler registers
itself when its module is imported, so a kind that nothing imports is simply
absent — and B2's sweep, which enqueues follow-ups only for kinds that have a
handler, then skips it silently: no error, no failed job, just items that never
arrive. It first showed up as two of B2's tests passing in a full suite and
failing when their file ran alone.

So rather than listing the kinds by hand, this reads every ``@REGISTRY.job``
decorator out of the package source and insists the registry knows all of them.
B8's `sync_awards` will be caught by it the day it is written and not wired
into :mod:`licitaqui.handlers`.
"""

from __future__ import annotations

import re
from pathlib import Path

from licitaqui import handlers
from licitaqui.registry import REGISTRY

PACKAGE = Path(__file__).resolve().parent.parent / "licitaqui"

#: Matches `@REGISTRY.job("sync_items")`, with or without keyword arguments.
_DECORATOR = re.compile(r"@REGISTRY\.job\(\s*[\"']([a-z_]+)[\"']")


def kinds_declared_in_source() -> dict[str, str]:
    """Every kind a module in the package registers, and where."""
    found: dict[str, str] = {}
    for path in sorted(PACKAGE.glob("*.py")):
        for kind in _DECORATOR.findall(path.read_text(encoding="utf-8")):
            found[kind] = path.name
    return found


def test_the_source_actually_declares_some_kinds() -> None:
    """A regex that silently matches nothing would make the next test vacuous."""
    declared = kinds_declared_in_source()
    assert {"noop", "sync_open_tenders", "sync_items", "sync_files"} <= set(declared)


def test_importing_handlers_registers_every_kind_in_the_package() -> None:
    declared = kinds_declared_in_source()
    registered = set(REGISTRY.kinds())

    missing = {kind: module for kind, module in declared.items() if kind not in registered}
    assert missing == {}, (
        "these kinds register themselves on import but nothing imports them; "
        f"add the module to licitaqui/handlers.py: {missing}"
    )


def test_registered_kinds_reports_what_the_registry_holds() -> None:
    assert handlers.registered_kinds() == REGISTRY.kinds()
    assert "sync_items" in handlers.registered_kinds()


def test_every_followup_kind_b2_enqueues_has_a_handler() -> None:
    """B4 landed, so both of B2's follow-ups can now actually run.

    This used to be the inverse assertion — `sync_files` is still B4's to write
    — kept so that B2's "no follow-up for a kind with no handler" test had a
    real kind to point at. That test now makes its own missing kind instead,
    and this one states the property that matters from here on: the sweep never
    queues work nothing can run, and it is not skipping a kind either.
    """
    from licitaqui.sync_tenders import FOLLOWUP_KINDS

    assert set(FOLLOWUP_KINDS) <= set(REGISTRY.kinds())
