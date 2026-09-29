-- 0011_favourites — a person can mark a tender and find it again (card D23).
--
-- Sci, 2026-09-29: *"I plan to have another section 'Favorites' when the user
-- marked a tenders as Favorite and we have this section with all followers
-- Tenders"*.
--
-- ## The word, and why it is not "acompanhar"
--
-- `Concorrentes.dc.html` already spends *Acompanhar* on following a **rival
-- company**, and `Alertas.dc.html` promises "Aviso 48 h antes e quando quem
-- você acompanha ganha" — which reads correctly only while *acompanhar* means
-- competitors. Sci chose **Favoritar / Favoritos** for tenders on 2026-09-29,
-- so the two features keep different words and no approved sentence has to be
-- rewritten. The table is named for the product word, not for the gesture.
--
-- ## Why the primary key is the pair
--
-- Marking twice is the same fact, not two. A surrogate id with a separate
-- unique index would allow a race to insert both, and `on conflict do nothing`
-- against the pair is what makes the control idempotent — which matters
-- because the button will be tapped twice by anybody on a slow connection.
--
-- ## `on delete cascade` on both sides, and what that means for the count
--
-- A deleted account takes its favourites with it (LGPD art. 16: the data has
-- no purpose once the account is gone). A tender deleted by a re-sync takes
-- them too, and that is the honest behaviour: a favourite pointing at a row
-- that no longer exists cannot be rendered, and a list that silently drops
-- items is worse than a count that went down.
--
-- ## The index
--
-- The section lists one person's favourites, newest first, which is exactly
-- `(user_id, created_at desc)`. The primary key already serves the "is this
-- one marked?" lookup the button needs, so there are two accesses and two
-- indexes, not one index doing both badly.

create table if not exists favourites (
  user_id    bigint      not null references users(id)   on delete cascade,
  tender_id  text        not null references tenders(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- The pair is the fact. See above.
  constraint favourites_pkey primary key (user_id, tender_id)
);

-- The section's own query: one person, newest first.
create index if not exists favourites_user_recent_idx
  on favourites (user_id, created_at desc);

comment on table favourites is
  'Tenders a person marked with "Favoritar" (card D23). One row per '
  '(user, tender); marking twice is the same fact. Not to be confused with '
  'following a competitor, which the design calls "acompanhar".';
