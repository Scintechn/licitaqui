# db/reference/ — the CNAE → segment map

Reference data that ships to every environment, reviewed by people and rendered
mechanically into a migration. Task **B6**, closing gap **G6**.

| File | What it is |
|---|---|
| `cnae_segments.csv` | **The artefact.** One row per (CNAE subclass, segment) with the fit and, for arguable rows, why. Edit this. |
| `cnae_subclasses.csv` | A snapshot of the official IBGE CNAE 2.3 subclass list (1332 codes), captured 2026-09-18 from `https://servicodados.ibge.gov.br/api/v2/cnae/subclasses`. Reference only; never edited by hand. |

## Why the map exists

POC 1 classifies tender **items** into 14 segments by NCM and keyword. B5
resolves a CNPJ into CNAEs. Nothing joined the two, so the "Compatível /
Verificar" badge in spec §10 had nothing to compute — that is gap G6, the one
genuine product gap of Phase 0.

## The two values of `fit`

- **`compatible`** — a reviewer looking at the CNAE and the segment would agree
  without argument. The company trades or manufactures goods of that segment,
  or performs the service those tenders are actually for.
- **`check`** — plausible but arguable. The product says "Verificar" and the
  user decides.

Anything between the two is `check` on purpose. A wrong `compatible` costs a
small company the effort of chasing a tender it cannot serve; a `check` costs
one extra glance.

Three recurring reasons a row is `check`, all written into the `note` column:

1. **Service, not goods.** Twelve of the fourteen segments are materials
   categories in POC 3's own validation, so a company that only performs a
   service in that field gets `check`. The exceptions, where the service *is*
   what the segment's tenders buy, are `compatible`: construction and
   engineering works (41–43, 7112000), vehicle maintenance (4520, 4543900),
   software and IT services (62, 63), electronic-security monitoring (8020001).
   This is the judgement most likely to need correcting with real data —
   see the review notes below.
2. **Adjacent goods.** Beverages against Alimentos, cosmetics against
   Limpeza / Higiene, consumer electronics against Informática / TI.
3. **`representante comercial`.** The 461x codes intermediate a trade without
   necessarily holding stock.

## Main CNAE versus secondary CNAEs

**`compatible` requires the main CNAE.** A segment reached only through
secondary CNAEs is capped at `check`, so a `compatible` secondary never lifts a
`check` primary, and a `check` secondary never lowers a `compatible` primary.

The obvious rule is the other one — habilitação looks at the registered object
as a whole, so take the strongest claim from any CNAE — and it is what this task
shipped first. Measured over 20 real PNCP-winning suppliers it made the average
company compatible with **5.75 of the 14 segments**, one of them with 13 of 14,
because a small company's secondary list is what its accountant registered, not
what it trades in. The same 20 under the rule above: **0.8**, never above one.

Secondary CNAEs still put the segment on the list at `check` — which is exactly
"you have a CNAE for this, verify it" — and the view reports `from_main_cnae` /
`from_secondary_cnae` so the Radar can sort the main activity first.

## Coverage, and why it is not 100 %

**555 of the 1332 CNAE 2.3 subclasses are mapped; 777 are deliberately not.**
Fourteen segments aimed at what municipalities buy from small suppliers do not
absorb agriculture, mining, metallurgy, finance, insurance, education, culture,
transport or professional services, and pretending they do would put a badge on
a company that cannot serve the tender. An unmapped CNAE contributes **no**
segment — which is not the same as `check`: `check` is a mapping that says
"verify this one", while unmapped says "this activity is outside the fourteen",
and the Radar falls back to keyword search.

One consequence worth knowing: a company whose only CNAE is `4693100`
(*mercadorias em geral, sem predominância*) gets nothing, because a distributor
of anything is compatible with everything and a badge that always says
"Verificar" tells the user nothing.

## Editing the map

The CSV is authoritative. After editing it, re-render the SQL:

```bash
python3 db/cnae_reference.py db/migrations/0004_cnae_segments_review.sql
```

Migrations are immutable once applied (`db/README.md`), so a change after
`0003_cnae_segments.sql` has shipped goes into a **new** numbered file. Every
rendering is declarative — it upserts every row of the CSV and deletes any row
the CSV no longer carries — so applying the newest file always leaves the table
equal to the CSV, whatever ran before it.

`worker/tests/test_cnae_segments.py` fails if the CSV and the shipped migration
disagree, if a code is not a real CNAE 2.3 subclass, if a description does not
match IBGE's, if the file is not sorted, or if a `check` row has no note.

## Where a review should start

Plan §5 asks Sci to review the top 150 CNAEs used by MEI/ME retail and
services. In priority order:

1. **The goods-versus-services line** (reason 1 above). Around 100 rows turn on
   it, and it is the only judgement here with no data behind it. The ones that
   bite hardest: `8121400` *limpeza em prédios* → Limpeza `check`, and the whole
   of divisions 86–87 (health providers) → Saúde `check`. If municipalities in
   the concierge sample put out as many cleaning-service as cleaning-material
   tenders, `8121400` should become `compatible`.
2. **Retail divisions 47 and wholesale 46** — where MEI/ME actually live. 4744x
   (material de construção), 4761003 (papelaria), 4751201 (informática),
   4649408 (limpeza), 4642702 (uniformes), 4771701 (farmácia), 4530703 (peças).
3. **The catch-alls left unmapped**: `4693100`, `4713002`, `4713004`,
   `4649499`, `4759899`, `4789099`. Each is a real MEI/ME code with no honest
   segment. Deciding what the product should do for those users is a product
   decision, not a mapping one.
4. **Beverages.** POC 1's Alimentos segment covers NCM chapters 02–21 and food
   keywords, so **chapter 22 (beverages) lands in "Outros"** and no company is
   ever matched to a water or juice tender. Every beverage CNAE here is `check`
   for that reason. The fix belongs on the item side (B3), not here.
