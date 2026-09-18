"""Does the search index's `data_atualizacao_pncp` move when only items or files change?

ADR-0001 "What would change this decision" leaves exactly one question open, and it is the
one that could invert the decision: if the search index tracks child (item / file) changes
as well as `/contratacoes/atualizacao` does, the simpler single-path search design wins.

Method — three timestamps per tender, compared:

1. `/api/consulta/v1/contratacoes/atualizacao` gives, per record, both
   `dataAtualizacaoGlobal` (the record **or any of its children** changed) and
   `dataAtualizacao` (the header row itself). A record where global > header is one whose
   header did not change in the window: the change was in a child.
2. `/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/arquivos` and `/itens` confirm what the
   child change actually was, by their own `dataAtualizacao` / `dataPublicacaoPncp`.
3. `/api/search/` gives that same tender's `data_atualizacao_pncp`, the field a search-only
   sweep would window on.

If (3) tracks (1), the search index sees child changes and the ADR's main correctness
argument collapses. If (3) tracks the header timestamp instead, the ADR stands.

    python3 worker/scripts/probe_search_change_detection.py --day 20260917 --sample 12

**`--from-cache` runs the same comparison without `/api/consulta` at all**, which is how
the question was actually settled on 2026-09-18: the consulta service was down for over
three hours, so the two consulta timestamps came from the knowledge base's cached detail
responses and only the (healthy) search index was called live.

    python3 worker/scripts/probe_search_change_detection.py \
        --from-cache "/Users/sci/Documents/POC Licitacao/cache_pncp"

Stdlib only, so it runs without installing the worker's dependencies. Unlike
`probe_pncp_endpoints.py` this one *does* retry: it is characterising behaviour, not
measuring availability.
"""

from __future__ import annotations

import argparse
import gzip
import json
import pathlib
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

BASE = "https://pncp.gov.br"
SEARCH = BASE + "/api/search/"
ATUALIZACAO = BASE + "/api/consulta/v1/contratacoes/atualizacao"
ITENS = BASE + "/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens"
ARQUIVOS = BASE + "/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/arquivos"

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
TIMEOUT = 30.0
PAUSE = 0.6


def get(url: str, params: dict | None = None, attempts: int = 4) -> tuple[int, object]:
    full = url + ("?" + urllib.parse.urlencode(params, safe="|") if params else "")
    last = ""
    for attempt in range(attempts):
        req = urllib.request.Request(full, headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT, context=SSL_CTX) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                if resp.status == 204 or not raw.strip():
                    return resp.status, None
                return resp.status, json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code in (204, 404):
                return exc.code, None
            last = f"http_{exc.code}"
            if exc.code < 500:
                break
        except Exception as exc:  # noqa: BLE001 - probe: any failure is just a retry
            last = type(exc).__name__
        time.sleep(2**attempt)
    print(f"    ! {last} on {full[:110]}", file=sys.stderr)
    return 0, None


def parts(numero_controle: str) -> tuple[str, str, str]:
    """'51885242000140-1-000744/2026' -> ('51885242000140', '2026', '744')."""
    left, _, year = numero_controle.partition("/")
    cnpj, _, rest = left.partition("-")
    _, _, seq = rest.partition("-")
    return cnpj, year, str(int(seq))


def ts(value: str | None) -> datetime | None:
    if not value:
        return None
    for length, fmt in ((19, "%Y-%m-%dT%H:%M:%S"), (16, "%Y-%m-%dT%H:%M"), (10, "%Y-%m-%d")):
        try:
            return datetime.strptime(str(value)[:length], fmt)
        except ValueError:
            continue
    return None


def search_one(numero_controle: str) -> dict | None:
    """The search index's row for one tender, or None when it is not indexed."""
    status, body = get(
        SEARCH,
        {"tipos_documento": "edital", "q": numero_controle, "pagina": 1, "tam_pagina": 10},
    )
    if status != 200 or not isinstance(body, dict):
        return None
    for item in body.get("items") or []:
        if item.get("numero_controle_pncp") == numero_controle:
            return item
    return None


def child_change(cnpj: str, year: str, seq: str) -> dict:
    """Latest child timestamps: newest item update and newest file publication."""
    out: dict[str, object] = {}
    url = ITENS.format(cnpj=cnpj, ano=year, seq=seq)
    status, items = get(url, {"pagina": 1, "tamanhoPagina": 500})
    if status == 200 and isinstance(items, list):
        stamps = [ts(i.get("dataAtualizacao")) for i in items]
        stamps = [s for s in stamps if s]
        out["items_n"] = len(items)
        out["items_max"] = max(stamps).isoformat() if stamps else None
    time.sleep(PAUSE)
    status, files = get(ARQUIVOS.format(cnpj=cnpj, ano=year, seq=seq))
    if status == 200 and isinstance(files, list):
        stamps = [ts(f.get("dataPublicacaoPncp")) for f in files]
        stamps = [s for s in stamps if s]
        out["files_n"] = len(files)
        out["files_max"] = max(stamps).isoformat() if stamps else None
    return out


def records_from_cache(directory: str) -> list[dict]:
    """Consulta records from POC 1's local cache, for when the service is down.

    Each cached file is ``{"det": <consulta record>, "itens": [...]}``. Only the
    record is needed: it carries both timestamps the comparison rests on.
    """
    records = []
    for path in sorted(pathlib.Path(directory).glob("*.json")):
        try:
            blob = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        record = blob.get("det") if isinstance(blob, dict) else None
        if isinstance(record, dict) and record.get("numeroControlePNCP"):
            records.append(record)
    return records


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", default=(date.today() - timedelta(days=1)).strftime("%Y%m%d"))
    ap.add_argument("--modalidade", type=int, default=6)
    ap.add_argument("--pages", type=int, default=3, help="pages of /atualizacao to scan")
    ap.add_argument("--sample", type=int, default=12, help="child-changed tenders to check")
    ap.add_argument(
        "--from-cache",
        default=None,
        metavar="DIR",
        help="read the consulta records from POC 1's cache instead of calling the "
        "(frequently unavailable) consulta service; only /api/search/ is called live",
    )
    ap.add_argument(
        "--no-children",
        dest="children",
        action="store_false",
        default=None,
        help="skip the item/file endpoints (they share the consulta service's fate)",
    )
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if args.from_cache:
        records = records_from_cache(args.from_cache)
        print(f"{len(records)} cached consulta records in {args.from_cache}", flush=True)
        if args.children is None:
            args.children = False  # the child endpoints are on the same sick service
    else:
        print(f"scanning /atualizacao {args.day} modality {args.modalidade}", flush=True)
        records = []
        for page in range(1, args.pages + 1):
            status, body = get(
                ATUALIZACAO,
                {
                    "dataInicial": args.day,
                    "dataFinal": args.day,
                    "codigoModalidadeContratacao": args.modalidade,
                    "pagina": page,
                    "tamanhoPagina": 50,
                },
            )
            if status != 200 or not isinstance(body, dict):
                continue
            data = body.get("data") or []
            records.extend(data)
            total = body.get("totalRegistros")
            print(f"  page {page}: {len(data)} records (total {total})", flush=True)
            if body.get("paginasRestantes", 0) == 0:
                break
            time.sleep(PAUSE)
    if args.children is None:
        args.children = True

    # A record whose header timestamp is older than its global one changed in a child.
    child_changed, header_changed = [], []
    for rec in records:
        g, h = ts(rec.get("dataAtualizacaoGlobal")), ts(rec.get("dataAtualizacao"))
        (child_changed if g and h and g > h else header_changed).append(rec)
    print(
        f"\n{len(records)} records: {len(child_changed)} with global > header "
        f"(child-only change), {len(header_changed)} with global == header",
        flush=True,
    )

    rows = []
    for rec in child_changed[: args.sample]:
        ncp = rec["numeroControlePNCP"]
        cnpj, year, seq = parts(ncp)
        print(f"\n{ncp}", flush=True)
        print(
            f"  atualizacao: global={rec.get('dataAtualizacaoGlobal')} "
            f"header={rec.get('dataAtualizacao')}"
        )
        children = child_change(cnpj, year, seq) if args.children else {}
        if children:
            print(f"  children:    {children}")
        time.sleep(PAUSE)
        hit = search_one(ncp)
        if hit is None:
            print("  search:      NOT INDEXED (closed tenders leave the open-tender index)")
        else:
            print(
                f"  search:      data_atualizacao_pncp={hit.get('data_atualizacao_pncp')} "
                f"data_publicacao_pncp={hit.get('data_publicacao_pncp')}"
            )
        rows.append(
            {
                "numero_controle_pncp": ncp,
                "global": rec.get("dataAtualizacaoGlobal"),
                "header": rec.get("dataAtualizacao"),
                "situacao": rec.get("situacaoCompraNome"),
                "encerramento": rec.get("dataEncerramentoProposta"),
                **children,
                "search_indexed": hit is not None,
                "search_atualizacao": (hit or {}).get("data_atualizacao_pncp"),
                "search_publicacao": (hit or {}).get("data_publicacao_pncp"),
            }
        )
        time.sleep(PAUSE)

    print("\n" + "=" * 78)
    indexed = [r for r in rows if r["search_indexed"]]
    tracks_global = [r for r in indexed if ts(r["search_atualizacao"]) == ts(r["global"])]
    tracks_header = [r for r in indexed if ts(r["search_atualizacao"]) == ts(r["header"])]
    print(f"child-changed tenders sampled: {len(rows)}; indexed by search: {len(indexed)}")
    print(f"  search timestamp == dataAtualizacaoGlobal: {len(tracks_global)}")
    print(f"  search timestamp == dataAtualizacao (header only): {len(tracks_header)}")
    print(f"  neither: {len(indexed) - len(tracks_global) - len(tracks_header)}")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(
                {"day": args.day, "modalidade": args.modalidade, "rows": rows},
                fh,
                ensure_ascii=False,
                indent=2,
            )
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
