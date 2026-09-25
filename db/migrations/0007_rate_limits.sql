-- 0007_rate_limits — a durable rate limiter (spec §3.3), its own PR per
-- CLAUDE.md ("schema changes only via db/migrations, in their own PR").
--
-- apps/web/lib/rate-limit.ts counted in a `Map` on `globalThis`: honest about
-- being "a speed bump, not a quota" (its own comment), but on Vercel each
-- lambda instance holds its own window, and an IP rotation resets it
-- outright. `POST /api/founders` and `POST /api/tenders/:id/screening` both
-- go through it — the first lets a script queue real WhatsApp sends to a
-- stranger faster than one instance's window would catch, the second spends
-- real OpenRouter credit per uncached request. A fixed window keyed by
-- (bucket, window_start) in Postgres survives across instances and IP
-- rotation the way the in-memory map cannot; `rate-limit.ts` keeps the map as
-- a fallback for when this table itself is unreachable, so a database hiccup
-- degrades the limiter rather than the signup or the screening endpoint.
--
-- `bucket` is already a hash (`hashClient()` in rate-limit.ts): never the
-- address itself, so this table cannot become a list of visitor IPs (§12).

create table if not exists rate_limits (
  bucket       text        not null,
  window_start timestamptz not null,
  count        int         not null default 1,
  updated_at   timestamptz not null default now(),
  primary key (bucket, window_start)
);

-- Backs the opportunistic sweep in rate-limit.ts, which deletes windows well
-- past their reset rather than letting the table grow without bound.
create index if not exists rate_limits_window_start_idx on rate_limits (window_start);
