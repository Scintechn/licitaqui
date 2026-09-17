# LicitaQui · UI reference

Exported from the approved "Wireframes LicitaQui" canvas on 2026-09-17. Claude Code cannot open the canvas on claude.ai, so these files are the UI source of truth.

## How to read the files

- Each `wireframes/*.dc.html` is one screen. Read the markup between `<x-dc>` and `</x-dc>`; all styling is inline. Ignore `<script src="./support.js">`, `<helmet>` and the `DCLogic` script (canvas runtime only).
- Frame sizes: mobile 390 × 844, web 1280 × 800, design system 1600 × 1180.
- Text in `[brackets]` (`[Nº]`, `[Sua empresa]`, `[n] CNAEs`) is dynamic data, never literal copy.
- Tender examples (Campinas batteries, Mário Gatti hospital supplies, Americana SaaS) are real PNCP tenders from 2026-09-16 and match the seed fixtures in `gabaritos/`. "13 dias" is relative to 2026-09-17.
- Rebuild with React components and the design tokens below; do not copy inline styles.
- Offer and Landing pages are separate, final HTML files: `../paginas/oferta_fundadores.html` and `../paginas/landing_radar.html`.

## Design tokens (from `wireframes/DesignSystem.dc.html`)

| Token | Value |
|---|---|
| Ivory (page background) | `#FBF7F3` |
| White (surfaces) | `#FFFFFF` |
| Graphite (text) | `#171717` |
| Gray (secondary text) | `#6B6B67` |
| Blue (primary, "Compatível") | `#2457D6` · soft `#E8EEFB` · hover `#1A43A8` |
| Success | `#18794E` · soft `#E3F1EA` |
| Attention ("Verificar") | `#A15C00` · soft `#F7EBDD` |
| Error | `#B42318` · soft `#F8E4E1` |
| Lines / field borders / muted fill | `#E7E1D9` / `#D6CFC5` / `#F3EEE8` |
| Display font | Archivo (titles, big numbers; wordmark 800, width 85%, −3%) |
| Body font | IBM Plex Sans |
| Data font | IBM Plex Mono (labels, codes, page refs) |
| Touch targets | ≥ 44 px; buttons 48 px high, radius 8 px; cards radius 12 px |

## Screens

### v1.01 · Free Radar (mobile first) — Phase 0

| # | File | Screen | Suggested route | Task |
|---|---|---|---|---|
| 01 | `Main.dc.html` | Entry: CNPJ, state, keyword (visitor) | `/` (inside the Landing hero on mobile) | D3 |
| 02 | `Editais.dc.html` | Radar list: Compatíveis / Verificar / Palavras, visitor banner | `/radar` | D3 |
| 03 | `Oportunidade.dc.html` | Tender summary: deadline, value, why you can bid, delivery/payment | `/radar/edital/[id]` | D3 |
| 04 | `Triagem.dc.html` | AI screening with page references ("1 de 2 sem conta") | `/radar/edital/[id]/triagem` | D4 |
| 05 | `Preco.dc.html` | Price and margin — locked, leads to the plan | `/radar/edital/[id]/preco` | D4 |
| 06 | `Cadastro.dc.html` | Create free account (Básico): Google + email link | `/conta/criar` | U1 |
| 07 | `Telegram.dc.html` | Connect Telegram + alert example | `/conta/alertas` | E1 |
| 08 | `Plano.dc.html` | Promocional R$ 26 (6 months) / Essencial R$ 57 + Asaas checkout | `/conta/plano` | F2 |
| 09 | `Menu.dc.html` | Menu with Básico usage (3 de 5 triagens) | global drawer | U1 |

### v1 · Essencial (web, R$ 57) — after Gate 0

| # | File | Screen |
|---|---|---|
| 10 | `Painel.dc.html` | Tender dashboard with filters |
| 11 | `Edital.dc.html` | Tender: winning price band and margin calculator |
| 12 | `Alertas.dc.html` | Alerts by CNAE and keyword |

### v2 · Pro (R$ 98)

| # | File | Screen |
|---|---|---|
| 13 | `Analise.dc.html` | Deep analysis with citations (deep analysis job starts in Phase 0, task C2) |
| 14 | `Concorrentes.dc.html` | Competitors and opportunity |

### Design system

`DesignSystem.dc.html` — palette, typography, components, status badges, icons, states (analyzing, opportunity found, empty, visitor limit) and the Telegram alert. Build it first as `/dev/components` (task D1).

## Product rules shown on the canvas (decided)

**Access**
- Visitor (no account, up to 3 days, counted per device **and** per CNPJ): search by CNPJ or keyword, 2 AI screenings; tender files and alerts locked.
- Básico (R$ 0, with account): search, tender files, **5 AI screenings/month**, 1 Telegram alert per week (1 keyword, 1 state).
- Locked price block → Promocional R$ 26 for 6 months (48 founder seats, then R$ 57) or Essencial R$ 57 → Asaas checkout.
- Login: Google + email magic link (email link enabled when a sending domain is verified).
- No customer invoice (NF) promise anywhere in the UI for now.

**Essencial (v1):** saved filters = saved alert; winning price band X–Y without the winner's name; margin calculator with target price; alerts by automatic CNAE + up to 10 keywords; "Verificar" group and smart triggers stay locked as upsell.

**Pro (v2):** every risk with excerpt and page checked against the PDF; score for micro and small companies; ready-made questions for the agency; competitors with name and CNPJ, discount, top winner share and categories with less competition.
