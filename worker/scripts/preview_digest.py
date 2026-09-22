#!/usr/bin/env python3
"""Render a weekly Telegram digest without sending it (task E1).

    python worker/scripts/preview_digest.py --cnae 4761003 --cnae 8121400 --uf SP

Two modes, and both are **read-only** — no row is written, and the Bot API is
never reached whatever ``TELEGRAM_DELIVERY`` says, because nothing here calls
the transport at all:

* ``--user <id>`` renders what that account would actually receive, reading its
  company, its alert and its plan exactly as the job does. For an operator
  answering *"why did they not get an edital this week?"*.
* ``--cnae <code>`` (repeatable) renders for a **fabricated** recipient whose
  main CNAE is that code, against the real `tenders` in whatever database the
  DSN points at. Nothing is written, so this is safe against production and is
  how the digest was demonstrated for E1's exit criterion.

`--dsn-var` picks the connection (default: the worker's own, `WORKER_DATABASE_URL`
falling back to `DATABASE_URL_UNPOOLED`), resolved the way `db/migrate.py`
resolves its own.

§12: the rendered message contains a person's name and their company's, so it
goes to the terminal and nowhere else — never to a log, never to `events`. In
`--cnae` mode the name is a placeholder and no real person is involved at all.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from licitaqui import config, telegram_alerts  # noqa: E402
from licitaqui.telegram_alerts import Recipient, Tender  # noqa: E402

#: A stand-in company for `--cnae` mode. Not in the database, not a real firm.
SAMPLE_NAME = "Fulano de Tal"
SAMPLE_COMPANY = "Empresa Exemplo"

SEGMENTS_SQL = """
select segment
  from cnae_segments
 where cnae = %(cnae)s
   and fit = 'compatible'
"""

TENDERS_BY_SEGMENT_SQL = """
select t.id, t.object, t.agency_name, t.state, t.modality_name,
       t.proposals_close_at, t.me_epp_summary
  from tenders t
 where t.proposals_close_at > now()
   and t.segments && %(segments)s::text[]
   and (%(states)s::text[] is null or t.state = any(%(states)s))
 order by t.proposals_close_at, t.id
 limit %(limit)s
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", type=int, action="append", default=[], help="users.id")
    parser.add_argument("--cnae", action="append", default=[], help="main CNAE of a sample company")
    parser.add_argument("--uf", action="append", default=[], help="restrict to these states")
    parser.add_argument("--dsn-var", default=None, help="env var holding the connection string")
    parser.add_argument(
        "--limit", type=int, default=telegram_alerts.MAX_TENDERS, help="tenders per digest"
    )
    return parser.parse_args()


def segments_for(conn: psycopg.Connection, cnae: str) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(SEGMENTS_SQL, {"cnae": cnae})
        return [row[0] for row in cur.fetchall()]


def tenders_for(
    conn: psycopg.Connection, segments: list[str], states: list[str], limit: int
) -> list[Tender]:
    if not segments:
        return []
    with conn.cursor() as cur:
        cur.execute(
            TENDERS_BY_SEGMENT_SQL,
            {"segments": segments, "states": states or None, "limit": limit},
        )
        return [Tender(*row) for row in cur.fetchall()]


def render(name: str, company_name: str, tenders: list[Tender]) -> str:
    from licitaqui import templates

    template, context = telegram_alerts.build_digest_context(
        name=name, company_name=company_name, tenders=tenders
    )
    return templates.render(telegram_alerts.CHANNEL, template, context)


def preview_sample(conn: psycopg.Connection, cnae: str, states: list[str], limit: int) -> str:
    segments = segments_for(conn, cnae)
    tenders = tenders_for(conn, segments, states, limit)
    header = f"CNAE {cnae} → {', '.join(segments) or 'no compatible segment'}"
    return f"{header}\n{'-' * len(header)}\n{render(SAMPLE_NAME, SAMPLE_COMPANY, tenders)}"


def preview_user(conn: psycopg.Connection, user_id: int, limit: int) -> str:
    who: Recipient | None = telegram_alerts.recipient(conn, user_id)
    if who is None:
        return f"user {user_id}: no such account"
    if not who.cnpj:
        return f"user {user_id}: no CNPJ, so nothing to match ({telegram_alerts.SKIP_NO_COMPANY})"
    tenders = telegram_alerts.select_tenders(
        conn,
        cnpj=who.cnpj,
        keyword=who.keyword,
        states=who.states,
        alert_id=who.alert_id,
        limit=limit,
    )
    header = f"user {user_id} · plan {who.plan} · linked={who.linked} · active={who.alert_active}"
    body = render(who.name or "", who.company_name or "", tenders)
    return f"{header}\n{'-' * len(header)}\n{body}"


def main() -> int:
    args = parse_args()
    if not args.user and not args.cnae:
        print("give at least one --user or --cnae", file=sys.stderr)
        return 2

    dsn = (
        config.require_secret(args.dsn_var)
        if args.dsn_var
        else config.require_secret(*config.WORKER_DSN_VARS)
    )
    with psycopg.connect(dsn, autocommit=True, connect_timeout=30) as conn:
        # Belt and braces: this script only ever reads, and the transaction it
        # would need to write in is refused before it can start.
        conn.execute("set default_transaction_read_only = on")
        for cnae in args.cnae:
            print(preview_sample(conn, cnae, args.uf, args.limit))
            print()
        for user_id in args.user:
            print(preview_user(conn, user_id, args.limit))
            print()
    return 0


if __name__ == "__main__":  # pragma: no cover - operator tool
    raise SystemExit(main())
