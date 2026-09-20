M0 — done

Foundation: repo, CI, Neon project + roles + extensions, migrations, seed. The only remainder is the A2 tail — Neon dev branch, preview-branch automation, pg_dump stub — all of which need Neon API/console access you haven't provided.

M1 — code-complete, not live

This is the important distinction. Everything M1 needs in code is merged: the Offer page (D2), the founders API with the proven seat race (F1), the WhatsApp welcome (E2, built and deliberately silent), the message texts (E0).

But M1 is "Offer live 09-24", and it isn't live because:
- G3 — privacy policy and terms still carry TODO(Sci): markers, and the Offer page's privacy/terms links still anchor to #topo rather than real routes
- E2 has no LicitaQui Evolution instance — the only one belongs to FlowDeski
- G10 — E0's drafts still need your approval

So M1 is blocked on you, not on engineering.

M2 — essentially done, ahead of schedule

Radar: B0–B6, C1, R1 all merged; G6 closed; D3 sitting in PR #28. On engineering you're through M2 and working into M3 territory (D4, U1, E1, O2), roughly 2½ weeks early.

Parallel work — what's actually safe

Current collision surface: the regression-fix lane is in worker/licitaqui/sync_tenders.py / pncp.py / the B2 test file, and three open PRs all touch worker/tests/conftest.py, worker/README.md and docs/STATUS.md.

Genuinely low-collision:

1. The download card — mostly new files in worker/licitaqui/ (fetch PDF, extract text via pdfplumber, store per §3.2). Different files from the regression lane. Highest value: it's the last link in the core flow and unblocks D4. Only the routine conftest/README append-conflicts we've resolved five times now.
2. Neon preview-branch cleanup Action (rest of A2) — .github/workflows/ only, zero overlap with any lane. But it needs a Neon API key you haven't set.
3. .env.example gaps — WHATSAPP_DELIVERY and the newer test-DB names. Trivial, one file nobody else touches.

Looks parallel but isn't:

- PWA manifest / SEO (part of H1) — touches app/layout.tsx, which D3's PR #28 already modifies. Cheap after #28 merges, conflict-prone before.
- U1, E1, O2, F2 — all chain through D4 or U1, and F2 additionally needs Asaas keys that aren't in .env.local.
- The conftest statement_timeout fix — one line, but that's the single most contested file; it has to wait for the three PRs.

My honest recommendation

The download card is the right next lane on merit. But main is currently red, three PRs are queued on your review, and plan §2.3 puts your review as the bottleneck rather than generation. Landing the regression fix and merging #27–#29 first would cost you less total time than running a fifth stream against a broken baseline.