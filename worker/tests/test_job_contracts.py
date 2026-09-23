"""The consumer half of `contracts/jobs/` (2026-09-23).

`jobs.payload` crosses a language boundary — TypeScript writes it, Python reads
it — and nothing type-checks across that line. On 2026-09-23 the two sides were
found to disagree about the *spelling* of every field in a `send_telegram`
payload: the web enqueued `userId` / `chatId`, this worker reads `user_id` /
`chat_id`, and so every Telegram confirmation the product had ever tried to
send died on a ``ValueError`` and retried until its attempts were gone. Two such
jobs (19267, 19268) were sitting in production `queued` with `attempts` spent.

`contracts/jobs/*.json` is the schema neither language owns.
`apps/web/lib/jobs/contract.test.ts` asserts the producer emits exactly those
fields; this file asserts the consumer accepts them.

**Both directions are checked on purpose.** A test that only fed the handler a
correct payload would have passed on 2026-09-23 too — the worker was never the
broken half. What makes this a drift alarm rather than a smoke test is
:func:`test_the_camelcase_spelling_is_rejected`: the moment somebody "helpfully"
teaches the consumer to accept both spellings, this suite says so, and the
decision to stay strict becomes a deliberate one to overturn rather than an
accident to drift through.

Nothing here touches the database: the handlers are called with a stub context
and are expected to fail *validation* before they reach a connection.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from licitaqui import telegram_alerts
from licitaqui.registry import REGISTRY

# worker/tests/test_job_contracts.py -> worker/tests -> worker -> repository root
CONTRACTS_DIR = Path(__file__).resolve().parents[2] / "contracts" / "jobs"

#: Every kind the **web** enqueues. See `contracts/README.md` for why the
#: worker's own follow-up kinds are not here: they never cross a language
#: boundary, so there is nothing for them to drift against.
KINDS = ("send_telegram",)


def contract(kind: str) -> dict[str, Any]:
    path = CONTRACTS_DIR / f"{kind}.json"
    assert path.is_file(), f"no payload contract at {path}"
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass
class StubJob:
    id: int = 1
    attempts: int = 1


class StubContext:
    """Just enough :class:`~licitaqui.registry.JobContext` to reach validation."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.job = StubJob()
        self.conn = None
        self.log = telegram_alerts._log


@pytest.mark.parametrize("kind", KINDS)
def test_every_contract_names_a_kind_the_worker_actually_handles(kind: str) -> None:
    """A contract for a kind nothing runs is a contract nobody is holding to."""
    spec = contract(kind)
    assert spec["kind"] == kind
    assert kind in REGISTRY.kinds(), f"no handler registered for '{kind}'"


@pytest.mark.parametrize("kind", KINDS)
def test_the_contract_is_internally_consistent(kind: str) -> None:
    spec = contract(kind)
    listed = set(spec["required"]) | set(spec["one_of"]) | set(spec["optional"])
    assert listed == set(spec["fields"]), "every field must be documented, and only those"
    assert not set(spec["required"]) & set(spec["one_of"])


def test_send_telegram_accepts_each_payload_the_contract_allows() -> None:
    """One `user_id` payload and one `chat_id` payload, built from the file.

    Reaching the database is a *pass*: it means validation was satisfied. The
    stub connection is ``None``, so anything past the gate raises something
    other than ``ValueError`` and the assertion below catches the regression we
    care about.
    """
    spec = contract("send_telegram")
    for alternative in spec["one_of"]:
        payload = {"template": "start-linked", alternative: 1}
        try:
            telegram_alerts.send_telegram(StubContext(payload))  # type: ignore[arg-type]
        except ValueError as exc:  # pragma: no cover - the regression itself
            pytest.fail(f"the consumer rejected a contract-shaped payload {payload}: {exc}")
        except Exception:
            # Past validation and into the database, which is all this asserts.
            pass


def test_the_camelcase_spelling_is_rejected() -> None:
    """The bug of 2026-09-23, pinned from the consumer's side.

    The producer is the half that was wrong and the producer is the half that
    was fixed (`sendTelegramPayload`). The worker stays **strict** so that the
    next field to drift fails loudly instead of being quietly absorbed — this
    ``ValueError`` is the only reason anyone found the first one.
    """
    for payload in ({"template": "start-linked", "userId": 5}, {"template": "x", "chatId": 958}):
        with pytest.raises(ValueError, match="user_id"):
            telegram_alerts.send_telegram(StubContext(payload))  # type: ignore[arg-type]


def test_a_payload_with_no_recipient_at_all_is_rejected() -> None:
    with pytest.raises(ValueError, match="user_id"):
        telegram_alerts.send_telegram(StubContext({"template": "start-linked"}))  # type: ignore[arg-type]


def test_a_payload_with_no_template_is_rejected() -> None:
    with pytest.raises(ValueError, match="template"):
        telegram_alerts.send_telegram(StubContext({"user_id": 5}))  # type: ignore[arg-type]
