#!/usr/bin/env python3
"""Rehearse the 08/10 founders-opening send without sending it (task E5).

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
2. both delivery switches, because a dry-run 08/10 and a delivered one differ
   only by an event *name* (card E4);
3. one line per seated founder: the id, the seat, and what each channel would
   do — `would_send`, or the skip reason, or a render error;
4. the summary, the **waitlisted** count (nobody has decided what they receive
   that day — card E5's open question), and the pacing estimate, because a full
   seat list takes 16–24 minutes at §9's cadence and 19:00 BRT is when the
   first message goes, not the last.

## It is also the verification, run again afterwards

E5's first criterion asks that 08/10 be verified *"by a `whatsapp.sent` event
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
        print("                nothing fires on 08/10; run schedule_founders_opening.py --commit")
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
    print(f"whatsapp      : {evolution.DELIVERY_VAR}={evolution.delivery_mode()}")
    print(f"email         : {resend.DELIVERY_VAR}={resend.delivery_mode()}")


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
    print(f"seated        : {len(rows)}; reached on at least one channel: {reached}")
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
    sending = sum(
        1
        for preview in rows
        for one in preview.channels
        if one.channel == whatsapp.CHANNEL and one.would_send
    )
    best, worst = whatsapp.pacing_estimate_seconds(sending)
    print(f"pacing (§9)   : {best / 60:.0f}-{worst / 60:.0f} min for {sending} WhatsApp messages")
    print("                19:00 BRT is when the first one goes, not the last")
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
