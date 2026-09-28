"""The one definition of what `tenders.search` contains.

The vector is **the objeto plus every item description**, in the
accent-insensitive Portuguese configuration migration 0001 installs. Both
halves matter: the objeto alone is often procurement boilerplate that names
nothing, and the item descriptions are where the actual goods appear.

## Why this module exists

The expression was written out twice, identically, in `items.py` and
`db/seed.py` — the second carrying a comment saying it must stay identical to
the first, which is the kind of instruction that survives exactly one edit.
B17 needed a third copy, in `tenders.UPSERT_SQL`, and three is where a
duplicated expression stops being a smell and starts being a bug waiting for
its moment: narrow one of them and a tender becomes unfindable by a word that
is printed on its own card.

Importing this from `db/seed.py` works because `licitaqui/__init__.py` is a
docstring and nothing else — *"importing the package pulls in nothing"* — and
this module imports nothing at all. It stays that way on purpose: `seed.py`
runs from `db/` with only `psycopg` installed, and the worker's Docker context
cannot see `db/`, so the dependency has to point this way round.

## The rule that is easy to get wrong

**Never narrow this to `to_tsvector(object)` alone.** A tender whose items have
already been synced has a vector containing them; recomputing from the objeto
by itself silently *removes* those words. Because every writer here recomputes
the whole expression, the subquery costs one indexed lookup and makes each
write self-correcting instead of order-dependent: whichever of the upsert and
the item roll-up runs last, the vector ends up complete.
"""

from __future__ import annotations

#: The Postgres text-search configuration migration 0001 installs. Named here
#: so a change is one edit rather than a grep across three files.
SEARCH_CONFIG = "pt_unaccent"


def search_vector_sql(object_expr: str, tender_id_expr: str) -> str:
    """The `to_tsvector(...)` expression, for one row.

    :param object_expr: SQL for the objeto — a column reference like
        ``t.object`` or ``excluded.object``, or a placeholder like
        ``%(object)s``.
    :param tender_id_expr: SQL for the tender id, used to reach that tender's
        items. Must identify the **same** row as ``object_expr``; passing
        ``excluded.id`` alongside ``t.object`` would index one tender's words
        under another's.
    """
    return (
        f"to_tsvector('{SEARCH_CONFIG}',\n"
        f"  coalesce({object_expr},'') || ' ' ||\n"
        f"  coalesce((select string_agg(i.description, ' ')\n"
        f"              from tender_items i where i.tender_id = {tender_id_expr}), ''))"
    )


#: Recompute one tender's vector in place, by id. The form `sync_items` and the
#: seed both use, where the row already exists and only the vector is wanted.
UPDATE_SEARCH_SQL = f"""
update tenders t set search = {search_vector_sql("t.object", "t.id")}
where t.id = %s
"""
