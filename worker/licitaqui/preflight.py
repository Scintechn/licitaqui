"""Does the *running container* carry the configuration its switches ask for?

## The morning this exists to prevent

On 2026-09-26 the founders welcome took **three deploy cycles** to send, and
every fault was configuration rather than code:

1. the image predated E6, so `send_email` had no handler at all;
2. `EMAIL_DELIVERY` was unset, so the job rendered, logged ``dry_run`` and
   finished **``done``** — indistinguishable from a send unless you read
   ``delivery_mode``;
3. `AUTH_EMAIL_FROM` was unset, so the first real attempt raised;
4. and `RESEND_API_KEY` would have been next.

Each surfaced only once the one before it was fixed, because each was found by
*running a job* — one attempt, one missing variable, one redeploy. Nothing ever
looked at the whole picture, and `selfcheck` could not: it asks whether the
image carries its **files**, which is a property of the build. This asks
whether the container carries its **secrets**, which is a property of the
deployment, and no CI job can know it.

## Why this logs rather than exits

Refusing to start would be louder, and wrong. A worker with a misconfigured
e-mail channel still syncs tenders, still titles them, still sends WhatsApp —
on 2026-09-26 it did exactly that while e-mail was broken. Killing the process
would have taken all of it down to punish one channel, and the queue would have
stopped draining.

So the trade is deliberate: **one ERROR line at startup naming every missing
variable at once**, and the per-job failures stay as they are. The fault
already fails loudly per job (`status: queued`, the exception in `jobs.error`);
what was missing was seeing all of it *before* spending a deploy to find the
next one.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

from . import evolution, resend, telegram

#: ``(human name, switch variable, required variables)``. Each inner tuple is a
#: set of alternatives — any one of them satisfies it, which is how the Resend
#: key can arrive as either name the web app might already have set.
CHANNELS: tuple[tuple[str, str, tuple[tuple[str, ...], ...]], ...] = (
    (
        "WhatsApp",
        evolution.DELIVERY_VAR,
        ((evolution.API_URL_VAR,), (evolution.API_KEY_VAR,), (evolution.INSTANCE_VAR,)),
    ),
    (
        "e-mail",
        resend.DELIVERY_VAR,
        ((resend.FROM_VAR,), resend.API_KEY_VARS),
    ),
    (
        "Telegram",
        telegram.DELIVERY_VAR,
        ((telegram.BOT_TOKEN_VAR,),),
    ),
)

#: The one value that turns a channel on, in every transport this worker has.
SEND = "send"


def _missing(env: Mapping[str, str], alternatives: tuple[str, ...]) -> bool:
    return not any((env.get(name) or "").strip() for name in alternatives)


def delivery_problems(env: Mapping[str, str] | None = None) -> list[str]:
    """Every misconfigured **enabled** channel, as sentences a person can act on.

    A channel that is off is not a problem: dry run is the default everywhere
    — CI, a laptop, a fresh container — and demanding credentials for it would
    make the safe state the inconvenient one.
    """
    environ = os.environ if env is None else env
    problems: list[str] = []

    for label, switch, required in CHANNELS:
        if (environ.get(switch) or "").strip() != SEND:
            continue
        missing = [" or ".join(alt) for alt in required if _missing(environ, alt)]
        if missing:
            problems.append(
                f"{label} delivery is on ({switch}={SEND}) but "
                f"{', '.join(missing)} {'is' if len(missing) == 1 else 'are'} unset"
            )
    return problems
