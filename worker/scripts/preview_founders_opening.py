#!/usr/bin/env python3
"""Rehearse the founders-opening send without sending it (task E5).

    python worker/scripts/preview_founders_opening.py
    python worker/scripts/preview_founders_opening.py --render

E5's second acceptance criterion is *"a dry run of the whole send is possible
before the date"*, and until this existed nothing satisfied it:

* `scripts/schedule_founders_opening.py` without `--commit` dry-runs the
  **scheduling** — whether the row is queued and when it fires. It says nothing
  about who would receive a message.
* Unsetting `WHATSAPP_DELIVERY` makes a *send* a dry run, but that switch is
  global and is **on** in production since 2026-09-26 (`docs/STATUS.md`), so
  running the broadcast early to watch it would send every seated founder a
  real message a month ahead of the date. The rehearsal cannot be the send.
  (`--render` is how you check the bodies instead.)

So this runs the same `check_gates` the send runs and renders the same bodies,
**reading only** — `default_transaction_read_only` is set on the connection, so
a write is refused before it can start, and no transport is constructed at all.
Safe against production, which is the only place the answer is true.

It reports, in this order:

1. the dated run: is the sweep queued, with what status, and for when — in
   **UTC** (as `jobs.run_after` stores it) *and* **BRT** (the clock the product
   and the promise are in). CLAUDE.md's clocks table; mixing the two has
   produced a wrong answer in this repo before;
2. both delivery switches, and which way each one points — because a dry
   run and a delivered send differ only by an event *name* (card E4), and
   because the per-founder verdict below is computed *with* the switch
   rather than printed beside it;
3. one line per seated founder: the id, the seat, and what each channel would
   do — `would_send`, or the skip reason, or a render error;
4. the summary, the **waitlisted** count (nobody has decided what they receive
   that day — card E5's open question), and the pacing estimate, because a full
   seat list takes 16–24 minutes at §9's cadence and the broadcast hour is
   when the first message goes, not the last.

## It is also the verification, run again afterwards

E5's first criterion asks that the opening be verified *"by a `whatsapp.sent` event
per recipient rather than by a job status"*. The already-sent gate is exactly
that read, and it matches `whatsapp.sent` / `email.sent` alone — never
`dry_run` — so running this again **after** the broadcast turns each line into
the per-recipient answer: `already_sent` is a founder the message reached, and
a founder still reading `would_send` is one it did not, whatever the `jobs`
table says about the run.

§12: `--render` prints the actual message bodies, which contain a person's
first name. They go to the terminal and nowhere else — never to a log, never to
`events`. Without it the run names no person at all: a `founders_list` id is a
foreign key, not a recipient.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from datetime import UTC
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from licitaqui import config, evolution, resend, whatsapp  # noqa: E402

BRT = ZoneInfo(whatsapp.BRT_ZONE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsn-var", default=None, help="env var holding the connection string")
    parser.add_argument(
        "--render",
        action="store_true",
        help="also print the rendered bodies (they contain a first name; terminal only)",
    )
    return parser.parse_args()


def report_schedule(conn: psycopg.Connection) -> None:
    key = whatsapp.broadcast_key()
    due_utc = whatsapp.broadcast_at()
    print(f"opening day   : {whatsapp.opening_date().isoformat()} (BRT, the date the copy names)")
    print(
        f"broadcast due : {due_utc.astimezone(BRT):%Y-%m-%d %H:%M} BRT "
        f"= {due_utc.astimezone(UTC):%Y-%m-%d %H:%M} UTC"
    )
    row = whatsapp.scheduled_broadcast(conn, key=key)
    if row is None:
        print(f"dated run     : NOT QUEUED — no {whatsapp.BROADCAST_JOB_KIND} row with key {key}")
        # Interpolated, never a literal. This is the one line an operator acts
        # on, and it named 08/10 for the nine days after Sci moved the opening.
        print(
            f"                nothing fires on {whatsapp.opening_date().isoformat()};"
            " run schedule_founders_opening.py --commit"
        )
        return
    job_id, status, run_after = row
    print(f"dated run     : job {job_id}, status {status}")
    # `jobs.run_after` is `timestamptz`, and psycopg hands it back in the
    # *session* timezone — which is UTC on Neon and need not be anywhere else.
    # Converted explicitly rather than labelled, so the line cannot be a lie.
    print(
        f"                run_after {run_after.astimezone(UTC):%Y-%m-%d %H:%M} UTC "
        f"= {run_after.astimezone(BRT):%Y-%m-%d %H:%M} BRT"
    )
    if abs((run_after - due_utc).total_seconds()) > 60:
        print("                WARNING: the queued row and the configured hour disagree")


def report_switches() -> None:
    """Both kill switches, and **what each one means for the day**.

    They were two unrelated lines above a report whose per-founder verdict
    contradicted them: `would_send` asked the gates only, so a channel whose
    switch was off printed `would_send` for every founder it would never reach.
    The verdict now carries the switch (`whatsapp.ChannelPreview`), and these
    lines say out loud which way they point, because joining two numbers by eye
    is the step a rehearsal exists to remove.
    """
    for label, var, mode in (
        ("whatsapp", evolution.DELIVERY_VAR, evolution.delivery_mode()),
        ("email", resend.DELIVERY_VAR, resend.delivery_mode()),
    ):
        on = mode == evolution.DELIVERY_SEND
        meaning = "delivers" if on else "DRY RUN — renders and sends nothing"
        print(f"{label:<14}: {var}={mode} — {meaning}")
    # **Whose environment this is.** The database half of this report is true of
    # production because it reads production's tables. The *environment* half is
    # not: these two values, `opening_date()` and `opening_link()` all come from
    # `os.environ` in **this** process, so run from a laptop they describe the
    # laptop — and `would_send` therefore means "would this founder receive it
    # if the worker had my environment". `opening_broadcast_check` runs on the
    # worker and records the real pair; `/admin` prints them.
    print("                (these two are THIS process's environment, not the")
    print("                 deployed worker's — /admin's card has the worker's)")


def report_founders(rows: list[whatsapp.OpeningPreview], render: bool) -> None:
    for preview in rows:
        outcomes = "  ".join(f"{channel.channel}={channel.outcome}" for channel in preview.channels)
        print(f"  founder {preview.founders_list_id:>5}  seat {preview.seat:>2}  {outcomes}")
        for channel in preview.channels:
            if channel.render_error is not None:
                print(f"      {channel.channel} render error: {channel.render_error}")
            elif render and channel.body is not None:
                print(f"      --- {channel.channel} ---")
                for line in channel.body.splitlines():
                    print(f"      {line}")


def report_summary(conn: psycopg.Connection, rows: list[whatsapp.OpeningPreview]) -> None:
    reached = sum(1 for preview in rows if preview.reached)
    # `builds` and `reached` are different questions and the gap between them is
    # the kill switch. Printing only the second would have said "0 reached" with
    # no reason; printing only the first is what this report used to do.
    built = sum(1 for preview in rows if any(one.builds for one in preview.channels))
    print(f"seated        : {len(rows)}; message builds for: {built}")
    print(f"              : actually receives it: {reached}")
    if built != reached:
        print("                the difference is a kill switch, not a founder — see above")
    # The channel list is read off the preview rather than written here, so a
    # third channel added to the sweep appears in this summary by itself.
    for channel in dict.fromkeys(one.channel for preview in rows for one in preview.channels):
        counts = Counter(
            one.outcome for preview in rows for one in preview.channels if one.channel == channel
        )
        detail = ", ".join(f"{name}={n}" for name, n in sorted(counts.items())) or "none"
        print(f"  {channel:<9}: {detail}")

    waitlisted = whatsapp.waitlisted_count(conn)
    print(f"waitlisted    : {waitlisted} — this broadcast sends them nothing")
    if waitlisted:
        print("                `email/founders-waitlist.md` promises them the link on the day")
        print("                and no template covers it. Open decision, card E5.")

    # Paced from the **WhatsApp** count, not from `reached`: §9's cadence is
    # Evolution's constraint alone, and a founder who is opted out of WhatsApp
    # but reachable by e-mail is not a message that waits 20-30 s.
    #
    # And from `would_send`, not `builds`: `send()` only takes a pacing slot
    # `if evolution.sending_enabled()` (`whatsapp.py`), so with the switch off
    # the sweep does not wait at all and the honest estimate is zero.
    sending = sum(
        1
        for preview in rows
        for one in preview.channels
        if one.channel == whatsapp.CHANNEL and one.would_send
    )
    best, worst = whatsapp.pacing_estimate_seconds(sending)
    print(f"pacing (§9)   : {best / 60:.0f}-{worst / 60:.0f} min for {sending} WhatsApp messages")
    # The hour interpolated from the configuration, never a literal: this line
    # said 19:00 for the nine days after Sci moved the opening to 12:00 BRT,
    # seven lines under the `broadcast due` line that said 12:00.
    first = whatsapp.broadcast_at().astimezone(BRT)
    print(f"                {first:%H:%M} BRT is when the first one goes, not the last")
    print("after the day : `already_sent` is a founder the message reached (a `*.sent`")
    print("                event, never a dry run); `would_send` is one it did not")


def main() -> int:
    args = parse_args()
    dsn = (
        config.require_secret(args.dsn_var)
        if args.dsn_var
        else config.require_secret(*config.WORKER_DSN_VARS)
    )
    with psycopg.connect(dsn, autocommit=True, connect_timeout=30) as conn:
        # Belt and braces: this script only ever reads, and the transaction a
        # write would need is refused before it can start.
        conn.execute("set default_transaction_read_only = on")
        # **Asserted, not assumed** (CLAUDE.md §4b: put the verification inside
        # the thing that must fail). A session-level `SET` issued under
        # autocommit need not survive to the next statement through a
        # transaction-pooling endpoint — and `WORKER_DSN_VARS` can resolve to
        # Neon's pooled host — in which case the guard this script's docstring
        # and `worker/README.md` both promise would be silently absent. Nothing
        # here writes, so this is the guard failing quietly rather than a live
        # risk; it still must not fail quietly.
        guard = conn.execute("show transaction_read_only").fetchone()
        if guard is None or guard[0] != "on":
            raise SystemExit(
                "refusing to run: the read-only guard did not take "
                f"(transaction_read_only={None if guard is None else guard[0]}). "
                "Use the unpooled DSN."
            )
        report_schedule(conn)
        report_switches()
        print()
        rows = whatsapp.preview_opening(conn)
        if not rows:
            print("no seated founders — the broadcast would reach nobody")
            return 0
        report_founders(rows, args.render)
        print()
        report_summary(conn, rows)
    return 0


if __name__ == "__main__":  # pragma: no cover - operator tool
    raise SystemExit(main())
