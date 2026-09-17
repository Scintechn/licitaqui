#!/usr/bin/env python3
"""Load the development fixtures into the database.

Idempotent: every write is an upsert keyed on the natural key, so running it
twice leaves the same rows. Safe to re-run against a seeded database.

Fixtures live in db/seed/fixtures/pncp/ — 20 real PNCP tender payloads captured
by the POCs, kept in the repo so local dev, tests and previews never depend on
the knowledge-base folder or on PNCP being up.

Connection: MIGRATOR_DATABASE_URL, falling back to DATABASE_URL_UNPOOLED.
"""

from __future__ import annotations

import json
from pathlib import Path

import psycopg
from migrate import dsn  # same env resolution, same precedence
from psycopg.types.json import Jsonb

FIXTURES = Path(__file__).resolve().parent / "seed" / "fixtures" / "pncp"

# PNCP "tipoBeneficio" codes that mean the item is reserved for ME/EPP in some form.
BENEFIT_EXCLUSIVE = 1  # Participação exclusiva para ME/EPP
BENEFIT_QUOTA = 2  # Cota reservada para ME/EPP


def me_epp_summary(items: list[dict]) -> str:
    """Derive the tender-level ME/EPP summary from its items (spec §6.1)."""
    codes = {i.get("tipoBeneficio") for i in items}
    has_excl = BENEFIT_EXCLUSIVE in codes
    has_quota = BENEFIT_QUOTA in codes
    if has_excl and has_quota:
        return "mixed"
    if has_excl:
        return "exclusive"
    if has_quota:
        return "quota"
    return "none"


def load_one(cur: psycopg.Cursor, payload: dict) -> int:
    det, items = payload["det"], payload["itens"]
    org = det.get("orgaoEntidade") or {}
    unit = det.get("unidadeOrgao") or {}
    tender_id = det["numeroControlePNCP"]

    cur.execute(
        """
        insert into tenders (
          id, agency_cnpj, year, sequence, object, agency_name, unit_name,
          city, state, modality_id, modality_name, status, price_registration,
          proposals_open_at, proposals_close_at, estimated_value,
          confidential_budget, bidding_system_url, me_epp_summary,
          pncp_updated_at, raw, updated_at
        ) values (
          %(id)s, %(cnpj)s, %(year)s, %(seq)s, %(object)s, %(agency)s, %(unit)s,
          %(city)s, %(state)s, %(mod_id)s, %(mod_name)s, %(status)s, %(srp)s,
          %(open_at)s, %(close_at)s, %(value)s,
          %(secret)s, %(url)s, %(me_epp)s,
          %(pncp_updated)s, %(raw)s, now()
        )
        on conflict (id) do update set
          object             = excluded.object,
          status             = excluded.status,
          proposals_close_at = excluded.proposals_close_at,
          estimated_value    = excluded.estimated_value,
          me_epp_summary     = excluded.me_epp_summary,
          pncp_updated_at    = excluded.pncp_updated_at,
          raw                = excluded.raw,
          updated_at         = now()
        """,
        {
            "id": tender_id,
            "cnpj": org.get("cnpj"),
            "year": det.get("anoCompra"),
            "seq": det.get("sequencialCompra"),
            "object": det.get("objetoCompra") or "",
            "agency": org.get("razaoSocial"),
            "unit": unit.get("nomeUnidade"),
            "city": unit.get("municipioNome"),
            "state": unit.get("ufSigla"),
            "mod_id": det.get("modalidadeId"),
            "mod_name": det.get("modalidadeNome"),
            "status": det.get("situacaoCompraNome"),
            "srp": det.get("srp"),
            "open_at": det.get("dataAberturaProposta"),
            "close_at": det.get("dataEncerramentoProposta"),
            "value": det.get("valorTotalEstimado"),
            # code 1 is "Compra sem sigilo"; anything else withholds the budget
            "secret": det.get("orcamentoSigilosoCodigo") not in (None, 1),
            "url": det.get("linkSistemaOrigem"),
            "me_epp": me_epp_summary(items),
            "pncp_updated": det.get("dataAtualizacaoGlobal")
            or det.get("dataAtualizacao"),
            "raw": Jsonb(det),
        },
    )

    for item in items:
        cur.execute(
            """
            insert into tender_items (
              tender_id, number, description, kind, quantity, unit,
              unit_estimated_value, total_value, ncm, judgment_criterion,
              benefit_id, benefit_name, has_award, raw, updated_at
            ) values (
              %(tid)s, %(num)s, %(desc)s, %(kind)s, %(qty)s, %(unit)s,
              %(unit_value)s, %(total)s, %(ncm)s, %(criterion)s,
              %(benefit_id)s, %(benefit_name)s, %(award)s, %(raw)s, now()
            )
            on conflict (tender_id, number) do update set
              description          = excluded.description,
              quantity             = excluded.quantity,
              unit_estimated_value = excluded.unit_estimated_value,
              total_value          = excluded.total_value,
              has_award            = excluded.has_award,
              raw                  = excluded.raw,
              updated_at           = now()
            """,
            {
                "tid": tender_id,
                "num": item.get("numeroItem"),
                "desc": item.get("descricao"),
                "kind": (item.get("materialOuServico") or "")[:1] or None,
                "qty": item.get("quantidade"),
                "unit": (item.get("unidadeMedida") or "").strip() or None,
                "unit_value": item.get("valorUnitarioEstimado"),
                "total": item.get("valorTotal"),
                "ncm": item.get("ncmNbsCodigo"),
                "criterion": item.get("criterioJulgamentoNome"),
                "benefit_id": item.get("tipoBeneficio"),
                "benefit_name": item.get("tipoBeneficioNome"),
                "award": item.get("temResultado"),
                "raw": Jsonb(item),
            },
        )

    # Portuguese, accent-insensitive search over the object plus every item
    # description — the index the Radar query in §8 relies on.
    cur.execute(
        """
        update tenders t set search = to_tsvector('pt_unaccent',
          coalesce(t.object,'') || ' ' ||
          coalesce((select string_agg(i.description, ' ')
                      from tender_items i where i.tender_id = t.id), ''))
        where t.id = %s
        """,
        (tender_id,),
    )
    return len(items)


def main() -> int:
    files = sorted(FIXTURES.glob("*.json"))
    if not files:
        raise SystemExit(f"no fixtures in {FIXTURES}")

    tenders = items = 0
    with psycopg.connect(dsn(), connect_timeout=30) as conn:
        with conn.cursor() as cur:
            for path in files:
                payload = json.loads(path.read_text(encoding="utf-8"))
                items += load_one(cur, payload)
                tenders += 1
        conn.commit()

    print(f"seeded {tenders} tenders, {items} items (idempotent upsert)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
