# What LicitaQui costs to run, and what we already know about it

**This file is the whole infrastructure cost picture in one place.** Read it
before measuring anything about Neon, compute, storage or CI cost — and before
proposing a card that reduces any of them.

It exists for the same reason `docs/PRICE_BAND.md` does. The cost facts were
spread across **H3, H4, B28, B31, E14, `TECHNICAL_SPEC.md` §14.1 and the
worker's `neon_usage` event**, each one correct and each one buried inside a
card body. Cost was therefore investigated from scratch on **2026-09-27**, again
around **2026-09-30**, and a third time on **2026-10-05** — where the
"discovery" that the 16 test databases share production's compute was a
re-derivation of H3, which had already measured it, costed it, **fixed it on
01/10** and carded the remainder as B31. Nobody was careless. You cannot grep
prose for a conclusion, and that is what this file is for.

The rule that follows from it is the one CLAUDE.md already applies to runbooks,
widened by one word: before measuring, ask **what already measured this**.

---

## 1. What we are billed for

| | |
|---|---|
| Provider | **Neon**, via the Vercel Marketplace integration (org `scintechn`) |
| Plan | **Launch** |
| Project | `neon-bistre-cloud` · `aws-sa-east-1` (São Paulo) · Postgres 18 |
| Branch / compute | one branch `main`, one endpoint `ep-flat-firefly-acai77cp` |
| Billing period | the 1st to the 1st (current: 2026-10-01 → 2026-11-01) |
| Spending alert | **US$ 10**, checked every 15 min, e-mail to Sci |

Two other Neon projects exist and are negligible: `neon-camel-flame` (33.81 MB)
and `neon-orange-flowdeski` (46.84 MB).

**Launch has no storage ceiling.** It prices storage per GB-month and removes
the Free plan's limits. This is why `/admin`'s usage card renders a *cost* and a
nullable limit rather than a ratio and a red bar — see CLAUDE.md §4d, which
records what the false-alarm version of that card would have shown.

| charged | rate | where the rate comes from |
|---|---|---|
| storage | **US$ 0.35 / GB-month** | `LAUNCH_STORAGE_USD_PER_GB_MONTH`, `apps/web/lib/admin/neon.ts` |
| compute | per **CU-hour** | **rate not obtainable — see §4** |
| network transfer | unconfirmed | 1.11 GB in the period; never isolated on an invoice |

---

## 2. What it actually costs

Read from the Neon and Vercel consoles on **2026-10-05**, period 2026-10-01 →
2026-11-01, ~4.5 days elapsed:

| | measured |
|---|---|
| spent this period | **US$ 3.07** (the alert panel said $2.95 of $10) |
| compute | **27.83 CU-hrs** org-wide · 27.16 on production |
| storage | 2.65 GB org · **2.57 GB** production |
| history | 0.17 GB (retention is **6 h**, already minimal) |
| network transfer | 1.11 GB |
| previous period (September) | **≈ US$ 8.70** — read off the usage chart, not an invoice |

Derived from those, and labelled as derived:

- **US$ 0.68/day** this period, against **US$ 0.29/day** in September.
- Storage for the period: 2.65 GB × $0.35 × 4.5/30 = **US$ 0.14**. So
  **~95 % of the bill is compute and transfer.** Storage is a rounding error —
  the full 2.65 GB is **US$ 0.93/month**.
- Implied compute rate ≈ $2.93 / 27.83 = **US$ 0.105/CU-hr**. This quotient
  absorbs transfer and any base fee, so treat it as an **upper bound on the CU
  rate, not the CU rate**.

### Duty cycle — the thing the bill is actually made of

From the worker's own `neon_usage` event (it reads Neon's **operations log**,
for the reason in §4):

| | |
|---|---|
| awake | **14.94 h/day — 62 % of the day** |
| wake cycles | **43.9/day** |
| suspend tail | **3.65 h/day** — 5 min × 43.9, and 300 s is the **floor** |
| CU-hours | ~6.2/day (2026-10-05) · **6.96/day** (2026-09-30, B28) |

Average allocated CU while awake ≈ **0.42** — it autoscales above the 0.25
floor. The CPU panel shows ~1 vCPU *allocated* against ~0.05 *used*, so it
scales on RAM and working set, not CPU.

**CU-hours = allocated CU × hours awake.** Hours dominate. A change to the
autoscaling ceiling bounds the tail; it does not move the mean.

### Storage, by table (2026-10-05, total 2 314.8 MB)

| table | MB | | table | MB |
|---|---|---|---|---|
| `tender_items` | **1 437.8** | | `tender_item_codes` | 104.1 |
| `tenders` | 324.9 | | `events` | 72.4 |
| `catalog_prices` | 149.1 | | `awards` | 49.6 |
| `jobs` | 116.9 | | `tender_files` | 39.4 |

Plus 16 `licitaqui_test_*` databases holding **182.6 MB** (B31).

### Job mix (7-day average, 2026-10-05)

| kind | /day | | kind | /day |
|---|---|---|---|---|
| **`refresh_tender_value`** | **15 408** | | `sync_tender_awards` | 437 |
| `title_tender` | 5 191 | | `refresh_catalog_prices` | 143 |
| `sync_items` | 5 007 | | `sync_open_tenders` | 31 |
| `sync_files` | 4 994 | | everything else | < 35 |

---

## 3. What has already been tried — do not re-propose these

| | what happened |
|---|---|
| **H3 — CI off Neon** | **Done 2026-10-01, and it was the better answer.** Both workflows now run `postgres:18` as a service container (`db/ci_databases.py`); no CI job touches the production endpoint. `integration` **38 min → 1 min**, `ci-web` ~3 min → 1 min. Saved ~2.5 CU-hrs/week. The original plan — a separate Neon project, `worker/scripts/move_test_databases.py` — was superseded and is not needed. |
| **B31 — drop the 16 test databases** | **Deliberately deferred.** Nothing reads them since 01/10. The saving is ~170 MB ≈ **US$ 0.06/month**; the money was always the compute and that is already banked. Cleanup, not cost. |
| **H4 — orphaned Neon preview branches** | **Unverified.** Nothing deletes the branch a Vercel preview creates and 134+ PRs have closed. One screen in the Branches list settles it; not yet looked at. |
| **E14 — `queue.enqueue` per-row loop** | **Explicitly not a cost fix.** The compute runs at 0.02 of 0.25 vCPU, so round trips are not what the bill is made of. It is a throughput card. |
| **Idle poll → `/wake`** | Done in #134. It is *why* costs became visible at all: before it, the compute was awake 24/7 and CI was free-riding on that. |
| **Autoscaling ceiling** | Was `0.25 ↔ 8 CU` (32 GB RAM) on a 2.3 GB database. Set to **`0.25 ↔ 1 CU`** by Sci on **2026-10-05** as a test — 443 direct connections, 10 000 pooled. Expect it to **bound the tail, not lower the mean**; watch the nightly catalogue refresh, which is the one bulk-insert workload, and the compute cache-hit panel. |

---

## 4. What is **not** knowable, and why

**Neon's CU-hour consumption cannot be read from the API on this plan.** On
2026-09-30 its own surfaces disagreed — console **57.08** CU-h, API **19.25**
and then **0** — and `consumption_history` is **Scale-only**. So:

> Awake time is measured from the **operations log** (start/suspend pairs), not
> from a CU figure. That is what `neon_usage` does, and why.

The console's own "Usage since <date>" panel is trustworthy and is the figure to
read by hand. **Do not write a CU-hour number into code or a card without
saying which surface it came from** (CLAUDE.md §4d).

The **September → October increase has not been isolated.** It coincides with
the price-band build (catalogue mirror, 81 556 code mappings, `catalog_prices`,
the nightly refresh) and with two days of back-test traffic against the live
database — all of which are **finite**. That is a hypothesis that fits the
dates, not a measurement. It is deliberately left open rather than guessed.

---

## 5. The standing decision rule

Cost is **not** a standing project. It gets re-read on a date, against a rule
written in advance, so that the answer cannot be decided after seeing the number.

**Next read: Monday 2026-10-13.** By then the price-band backfill is finished
(~4 nights from 05/10) and the 1 CU ceiling has run for a week.

**The check is five minutes**, not an investigation:

1. Neon console → Projects → *Usage since Oct 1* → read **CU-hrs** and
   **storage**; Vercel → Integrations → Neon → **Total Spent**.
2. Divide spend by days elapsed.

| reading | what it means | what to do |
|---|---|---|
| **≤ US$ 0.35/day** | it was the backfill; the structural rate is September's | **close it.** Record the number here and stop. |
| US$ 0.35–0.50/day | ambiguous | re-read at the period close (01/11). Do not open a card. |
| **≥ US$ 0.50/day sustained** | something structural changed after 01/10 | *then* open one card, with this file's §2 as the baseline |

A reading that prompts anything beyond those three outcomes means the rule was
wrong, not that the rule should be ignored. Change it here, in a PR, before
acting on it.

---

## 6. The one open finding that is **not** about cost

`refresh_tender_value` runs ~15 408 jobs/day — about half of all job volume —
and **settles 148 of them**. Measured 2026-10-05:

- **52 113 of 54 513 tenders (95.6 %)** are permanently eligible for re-read,
  because a tender valued from the item sum is marked `items` and stays eligible
  forever (the sum over-counts on ~5 %).
- **22 090** of those are **already closed**; another 5 055 have no deadline.
- Conversion is **1.6 %/pass and falling** (334/day → 73/day). `due_tenders`'
  own docstring says the backlog "drains in well under a day"; at 150/day
  against 52 113 it needs **~347 days**.

This is carded as **B38**. It is a **correctness** card, not a cost card — it
would reduce compute as a side effect, but it should be judged on whether the
product should re-ask PNCP about closed tenders forever. Two product questions
belong to Sci and are in `docs/TO_VALIDATE.md`: whether a closed tender is ever
re-read, and what the attempt bound is.
