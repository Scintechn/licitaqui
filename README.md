# LicitaQui

Progressive web app that helps Brazilian MEI and ME companies find public tenders they can
fulfil, understand them with AI and know the highest profitable bid. Next.js on Vercel reads
a Postgres (Neon) cache that a Python worker keeps filled from PNCP, so no screen ever waits
on a slow external API.

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js (App Router, PWA) — Vercel Root Directory |
| `worker` | Python 3.12 collector and job runner — Docker on Easypanel |
| `db/migrations` | Versioned SQL, single source of truth for the schema |
| `docs` | Technical spec, development plan, design system and wireframes |

## Run it

```bash
pnpm install          # Node 20+, pnpm 11
pnpm dev              # web on http://localhost:3000

docker compose up -d  # local Postgres on :5432
```

Worker:

```bash
cd worker
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
ruff check && pytest
```

Copy `.env.example` to `.env` and fill it from Vercel / Easypanel. Never commit values.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # web
cd worker && ruff check && pytest          # worker
```
