"""Re-measure PNCP's search API against the Consulta API period endpoints (gap G7).

Committed so the ADR-0001 decision can be re-tested cheaply: run it again and compare the
failure rates. It deliberately does NOT retry — the number we care about is how often a
single call fails, which is what the collector will experience per job attempt.

    python3 worker/scripts/probe_pncp_endpoints.py --days 2 --pages 2 --out /tmp/g7.json

Stdlib only, so it runs without installing the worker's dependencies.
"""

from __future__ import annotations

import argparse
import gzip
import json
import ssl
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta

SEARCH = "https://pncp.gov.br/api/search/"
PUBLICACAO = "https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao"
ATUALIZACAO = "https://pncp.gov.br/api/consulta/v1/contratacoes/atualizacao"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Accept-Encoding": "gzip",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Referer": "https://pncp.gov.br/app/editais",
}
SSL_CTX = ssl.create_default_context()
TIMEOUT = 30.0  # TECHNICAL_SPEC.md 7.2: query timeout 30 s
MODALIDADES = (6, 8)  # Pregao Eletronico, Dispensa


def call(url: str, params: dict) -> dict:
    """One request, no retry. Returns a row describing the outcome."""
    full = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers=HEADERS)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=SSL_CTX) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            elapsed = time.monotonic() - started
            try:
                body = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return {"ok": False, "status": resp.status, "err": "bad_json", "s": elapsed}
            return {"ok": True, "status": resp.status, "s": elapsed, "bytes": len(raw),
                    "body": body}
    except urllib.error.HTTPError as exc:
        elapsed = time.monotonic() - started
        try:
            msg = exc.read()[:200].decode("utf-8", "replace")
        except OSError:
            msg = ""
        return {"ok": False, "status": exc.code, "err": f"http_{exc.code}", "s": elapsed,
                "msg": msg}
    except (TimeoutError, urllib.error.URLError, ssl.SSLError, OSError) as exc:
        elapsed = time.monotonic() - started
        err = "timeout" if elapsed >= TIMEOUT - 1 else type(exc).__name__
        return {"ok": False, "status": 0, "err": err, "s": elapsed, "msg": str(exc)[:160]}


def arm_search(pages: int, delay: float) -> list[dict]:
    rows = []
    for page in range(1, pages + 1):
        row = call(SEARCH, {"tipos_documento": "edital", "status": "recebendo_proposta",
                            "ordenacao": "-data", "pagina": page, "tam_pagina": 50})
        row |= {"arm": "search", "page": page}
        rows.append(row)
        print(f"  search p{page:<3} {row['status']:>4} {row['s']:6.2f}s {row.get('err', '')}",
              flush=True)
        time.sleep(delay)
    return rows


def arm_period(base: str, name: str, pages: int, delay: float, days: int) -> list[dict]:
    """One request per (day, modality, page) triple, the way an incremental sync would."""
    rows = []
    for offset in range(days):
        day = (date.today() - timedelta(days=offset + 1)).strftime("%Y%m%d")
        for modalidade in MODALIDADES:
            for page in range(1, pages + 1):
                row = call(base, {"dataInicial": day, "dataFinal": day,
                                  "codigoModalidadeContratacao": modalidade,
                                  "pagina": page, "tamanhoPagina": 50})
                row |= {"arm": name, "day": day, "mod": modalidade, "page": page}
                rows.append(row)
                print(f"  {name} {day} mod{modalidade} p{page} {row['status']:>4} "
                      f"{row['s']:6.2f}s {row.get('err', '')} {row.get('msg', '')[:60]}",
                      flush=True)
                time.sleep(delay)
    return rows


def summarise(rows: list[dict]) -> dict:
    if not rows:
        return {}
    ok = [r for r in rows if r["ok"]]
    lat = sorted(r["s"] for r in ok)
    errors: dict[str, int] = {}
    for row in rows:
        if not row["ok"]:
            errors[row["err"]] = errors.get(row["err"], 0) + 1
    out = {
        "n": len(rows),
        "ok": len(ok),
        "failed": len(rows) - len(ok),
        "failure_rate_pct": round(100 * (len(rows) - len(ok)) / len(rows), 1),
        "errors": errors,
    }
    if lat:
        out["latency_ok_s"] = {
            "min": round(lat[0], 2),
            "median": round(statistics.median(lat), 2),
            "p95": round(lat[min(len(lat) - 1, int(0.95 * len(lat)))], 2),
            "max": round(lat[-1], 2),
        }
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--search-pages", type=int, default=12)
    parser.add_argument("--pages", type=int, default=2)
    parser.add_argument("--days", type=int, default=2)
    parser.add_argument("--delay", type=float, default=1.5, help="seconds between requests")
    parser.add_argument("--out", default="pncp_probe.json")
    args = parser.parse_args()

    rows: list[dict] = []
    print("arm A: /api/search/ (the endpoint the POCs use)")
    rows += arm_search(args.search_pages, args.delay)
    print("arm B: /api/consulta/v1/contratacoes/publicacao")
    rows += arm_period(PUBLICACAO, "publicacao", args.pages, args.delay, args.days)
    print("arm C: /api/consulta/v1/contratacoes/atualizacao")
    rows += arm_period(ATUALIZACAO, "atualizacao", args.pages, args.delay, args.days)

    report = {}
    for arm in ("search", "publicacao", "atualizacao"):
        subset = [r for r in rows if r["arm"] == arm]
        report[arm] = summarise(subset)
        first = next((r for r in subset if r["ok"]), None)
        body = first.get("body") if first else None
        if isinstance(body, dict):
            report[arm]["envelope_keys"] = sorted(body.keys())
            records = body.get("data") or body.get("items") or []
            if records:
                report[arm]["record_keys"] = sorted(records[0].keys())

    with open(args.out, "w") as handle:
        json.dump({"report": report,
                   "rows": [{k: v for k, v in r.items() if k != "body"} for r in rows]},
                  handle, indent=2, ensure_ascii=False)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
