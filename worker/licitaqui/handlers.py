"""Every job handler, imported in one place.

A handler registers itself as a side effect of its module being imported
(:mod:`licitaqui.registry`), so the answer to *which kinds exist?* depends on
what has been imported so far. While :mod:`licitaqui.service` was the only
place that assembled the set, that answer quietly varied by import order —
anything reasoning about the queue without loading the whole service saw a
partial registry.

That is not merely untidy. B2's sweep asks the registry which follow-up kinds
have a handler and enqueues only those, precisely so it never queues work
nothing can run::

    kinds = [kind for kind in FOLLOWUP_KINDS if kind in set(REGISTRY.kinds())]

Under a partial registry that check silently answers "none", and a changed
tender gets no ``sync_items`` — no error, no failed job, just items that never
arrive. It showed up as two of B2's tests failing when their file ran on its
own and passing in a full suite, which is the same bug wearing a disguise.

So: **importing this module is what makes the registry complete.**
:mod:`licitaqui.service` does it at start-up, and so should anything else that
needs to reason about the whole queue — a test, a script, an operator REPL —
rather than importing handler modules one at a time and hoping the list is
current. New handler kinds (B8's ``sync_awards``) belong here the moment they
exist.

It stays a separate module rather than moving into ``licitaqui/__init__.py``
because importing the package must stay cheap: ``db/`` tooling and the tests'
conftest import :mod:`licitaqui.config` alone, and they should not pay for
httpx, pdfplumber and every collector to do it.
"""

from __future__ import annotations

from . import company as _company  # noqa: F401 - imported for its registration side effect
from . import jobs as _jobs  # noqa: F401 - registers `noop`
from . import sync_files as _sync_files  # noqa: F401 - registers `sync_files`
from . import sync_items as _sync_items  # noqa: F401 - registers `sync_items`
from . import sync_tenders as _sync_tenders  # noqa: F401 - registers `sync_open_tenders`
from . import whatsapp as _whatsapp  # noqa: F401 - registers `send_whatsapp`, `whatsapp_inbound`


def registered_kinds() -> list[str]:
    """The kinds this build can run, for a log line or an assertion.

    Read off the registry rather than hand-listed, so it cannot drift from the
    imports above.
    """

    from .registry import REGISTRY

    return REGISTRY.kinds()
