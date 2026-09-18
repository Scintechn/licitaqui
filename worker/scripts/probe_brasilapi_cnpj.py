"""Re-measure BrasilAPI's CNPJ endpoint: field coverage, latency, failure rate (gap G8).

Committed so the ADR-0002 decision can be re-tested cheaply. No retries: the number we care
about is how often a single lookup fails, because that is what decides whether the user is
sent to the manual CNAE form.

    python3 worker/scripts/probe_brasilapi_cnpj.py --sample cnpjs.json --delay 2

`--sample` is a JSON list of CNPJs (14 digits, no punctuation) or an object keyed by CNPJ.
Use CNPJs of real suppliers (e.g. PNCP award winners) — never personal data.

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
import urllib.request

URL = "https://brasilapi.com.br/api/cnpj/v1/{}"
HEADERS = {
    "User-Agent": "licitaqui-spike/0.1 (+https://github.com/Scintechn/licitaqui)",
    "Accept": "application/json",
    "Accept-Encoding": "gzip",
}
SSL_CTX = ssl.create_default_context()
TIMEOUT = 15.0

# The fields LicitaQui needs (TECHNICAL_SPEC.md 3.2: CNPJ -> CNAEs, size, MEI).
NEEDED = (
    "cnae_fiscal",
    "cnae_fiscal_descricao",
    "cnaes_secundarios",
    "porte",
    "descricao_porte",
    "opcao_pelo_mei",
    "opcao_pelo_simples",
    "razao_social",
    "nome_fantasia",
    "descricao_situacao_cadastral",
    "uf",
    "municipio",
)


def fetch(cnpj: str) -> dict:
    """One lookup, no retry."""
    req = urllib.request.Request(URL.format(cnpj), headers=HEADERS)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=SSL_CTX) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return {
                "cnpj": cnpj,
                "ok": True,
                "status": resp.status,
                "s": time.monotonic() - started,
                "body": json.loads(raw.decode("utf-8")),
            }
    except urllib.error.HTTPError as exc:
        try:
            msg = exc.read()[:200].decode("utf-8", "replace")
        except OSError:
            msg = ""
        return {
            "cnpj": cnpj,
            "ok": False,
            "status": exc.code,
            "s": time.monotonic() - started,
            "err": f"http_{exc.code}",
            "msg": msg,
            "retry_after": exc.headers.get("retry-after"),
            "ratelimit": {
                k: v
                for k, v in exc.headers.items()
                if k.lower().startswith(("x-ratelimit", "ratelimit"))
            },
        }
    except (
        TimeoutError,
        urllib.error.URLError,
        ssl.SSLError,
        OSError,
        json.JSONDecodeError,
    ) as exc:
        elapsed = time.monotonic() - started
        err = "timeout" if elapsed >= TIMEOUT - 1 else type(exc).__name__
        return {
            "cnpj": cnpj,
            "ok": False,
            "status": 0,
            "s": elapsed,
            "err": err,
            "msg": str(exc)[:140],
        }


def load_sample(path: str) -> list[str]:
    with open(path) as handle:
        data = json.load(handle)
    return list(data) if isinstance(data, dict) else [str(x) for x in data]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample", required=True)
    parser.add_argument("--delay", type=float, default=2.0, help="seconds between lookups")
    parser.add_argument(
        "--burst", type=int, default=12, help="back-to-back lookups used to probe the rate limit"
    )
    parser.add_argument("--out", default="brasilapi_probe.json")
    args = parser.parse_args()

    cnpjs = load_sample(args.sample)
    rows = []
    for i, cnpj in enumerate(cnpjs, 1):
        row = fetch(cnpj)
        rows.append(row)
        print(
            f"  {i:>3}/{len(cnpjs)} {cnpj} {row['status']:>4} {row['s']:5.2f}s "
            f"{row.get('err', '')} {row.get('msg', '')[:70]}",
            flush=True,
        )
        time.sleep(args.delay)

    ok = [r for r in rows if r["ok"]]
    coverage = dict.fromkeys(NEEDED, 0)
    secondary, portes = [], {}
    mei = simples = 0
    for row in ok:
        body = row["body"]
        for field in NEEDED:
            if body.get(field) not in (None, "", []):
                coverage[field] += 1
        secondary.append(len(body.get("cnaes_secundarios") or []))
        porte = str(body.get("descricao_porte") or body.get("porte"))
        portes[porte] = portes.get(porte, 0) + 1
        mei += 1 if body.get("opcao_pelo_mei") else 0
        simples += 1 if body.get("opcao_pelo_simples") else 0

    errors: dict[str, int] = {}
    for row in rows:
        if not row["ok"]:
            errors[row["err"]] = errors.get(row["err"], 0) + 1
    lat = sorted(r["s"] for r in ok)

    burst = []
    print(f"burst: {args.burst} back-to-back lookups")
    for cnpj in cnpjs[: args.burst]:
        row = fetch(cnpj)
        burst.append(row)
        print(
            f"  burst {cnpj} {row['status']:>4} {row['s']:5.2f}s {row.get('err', '')} "
            f"{row.get('ratelimit', '')}",
            flush=True,
        )

    statuses: dict[str, int] = {}
    for row in burst:
        key = str(row["status"])
        statuses[key] = statuses.get(key, 0) + 1

    report = {
        "sequential": {
            "n": len(rows),
            "ok": len(ok),
            "failed": len(rows) - len(ok),
            "failure_rate_pct": (
                round(100 * (len(rows) - len(ok)) / len(rows), 1) if rows else 0.0
            ),
            "errors": errors,
            "delay_s": args.delay,
            "latency_ok_s": {
                "min": round(lat[0], 2),
                "median": round(statistics.median(lat), 2),
                "p95": round(lat[min(len(lat) - 1, int(0.95 * len(lat)))], 2),
                "max": round(lat[-1], 2),
            }
            if lat
            else {},
        },
        "field_coverage_of_ok": coverage,
        "secondary_cnae_count": {
            "min": min(secondary) if secondary else 0,
            "median": statistics.median(secondary) if secondary else 0,
            "max": max(secondary) if secondary else 0,
            "zero": sum(1 for n in secondary if n == 0),
        },
        "porte_distribution": portes,
        "opcao_pelo_mei_true": mei,
        "opcao_pelo_simples_true": simples,
        "burst": {
            "n": len(burst),
            "statuses": statuses,
            "rate_limited": statuses.get("429", 0),
            "wall_s": round(sum(r["s"] for r in burst), 2),
        },
    }
    with open(args.out, "w") as handle:
        json.dump(
            {
                "report": report,
                "rows": [{k: v for k, v in r.items() if k != "body"} for r in rows],
                "burst_rows": [{k: v for k, v in r.items() if k != "body"} for r in burst],
            },
            handle,
            indent=2,
            ensure_ascii=False,
        )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
