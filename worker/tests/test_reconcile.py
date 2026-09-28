"""B17's partition planner: the sweep must know it can finish before it starts.

No database and no network — these drive `plan_partitions` against a fake
client, because the property under test is arithmetic about PNCP's paging
window and nothing else.
"""

from __future__ import annotations

import pytest

from licitaqui.pncp import SEARCH_WINDOW_CAP
from licitaqui.sync_tenders import (
    PARTITION_SPLIT_RATIO,
    UFS,
    PartitionTooLarge,
    plan_partitions,
)

MODALITIES = (6, 8, 4)


class FakeClient:
    """Answers `search_page` from a table of totals, and counts the asking."""

    def __init__(self, totals: dict[tuple[str, tuple[int, ...]], int], default: int = 10):
        self.totals = totals
        self.default = default
        self.calls: list[tuple[str, tuple[int, ...]]] = []

    def search_page(self, *, uf, modalities, page=1, page_size=1, status="recebendo_proposta"):
        key = (uf, tuple(modalities))
        self.calls.append(key)
        return {"total": self.totals.get(key, self.default), "items": []}


def test_every_uf_is_swept():
    """Completeness is the whole point of this card, so no UF may be skipped.

    Measured 2026-09-28, the 27 UF totals sum to exactly the unpartitioned
    national total (26 036 both ways), which is what makes UF a partition that
    loses nothing rather than merely a convenient one.
    """
    client = FakeClient({})
    partitions, _, _ = plan_partitions(client, MODALITIES, window_cap=SEARCH_WINDOW_CAP)

    assert [uf for uf, _ in partitions] == list(UFS)
    assert len(UFS) == 27


def test_a_comfortable_uf_is_swept_whole():
    """Splitting every UF by modality would triple the request count to buy
    headroom nothing needs. SP is the largest real partition at ~52% of the
    window, measured 2026-09-28."""
    client = FakeClient({("SP", MODALITIES): 5_227})
    partitions, _, largest = plan_partitions(client, MODALITIES, window_cap=SEARCH_WINDOW_CAP)

    assert ("SP", MODALITIES) in partitions
    assert ("SP", (6,)) not in partitions
    assert largest == 5_227


def test_a_uf_near_the_window_is_split_by_modality():
    over = int(SEARCH_WINDOW_CAP * PARTITION_SPLIT_RATIO) + 1
    client = FakeClient(
        {
            ("SP", MODALITIES): over,
            ("SP", (6,)): 4_000,
            ("SP", (8,)): 1_500,
            ("SP", (4,)): 1_000,
        }
    )
    partitions, _, largest = plan_partitions(client, MODALITIES, window_cap=SEARCH_WINDOW_CAP)

    assert ("SP", MODALITIES) not in partitions
    for modality in MODALITIES:
        assert ("SP", (modality,)) in partitions
    # The largest partition is now the biggest *slice*, not the whole UF.
    assert largest == 4_000
    # Every other UF is untouched by one UF splitting.
    assert ("MG", MODALITIES) in partitions


def test_a_partition_that_cannot_be_paged_raises_rather_than_truncating():
    """**The point of the card, restated as a test.**

    Past the window PNCP does not error — it stops answering, so a sweep that
    runs into it returns fewer editais than exist and has no way to know. A
    warning here would let the cycle record itself as complete while holding an
    incomplete set, which is the defect B17 exists to remove, reintroduced with
    a smaller blast radius. The acceptance criterion says *asserted, not
    logged*.
    """
    # Past the *sweep's* limit, not merely past the raw window: a slice checked
    # against the bare 10 000 has no room to grow between the count and page 20.
    over_limit = int(SEARCH_WINDOW_CAP * PARTITION_SPLIT_RATIO) + 1
    client = FakeClient(
        {
            ("SP", MODALITIES): SEARCH_WINDOW_CAP * 2,
            ("SP", (6,)): over_limit,
        }
    )
    with pytest.raises(PartitionTooLarge) as caught:
        plan_partitions(client, MODALITIES, window_cap=SEARCH_WINDOW_CAP)

    message = str(caught.value)
    assert "SP" in message
    assert "B20" in message, "the message should name the card that owns a narrower partition"


def test_the_expected_total_is_the_sum_of_the_partitions():
    """`expected` is what the coverage figure is measured against, so it has to
    be the count PNCP reported rather than the count we managed to store."""
    totals = {(uf, MODALITIES): index * 100 for index, uf in enumerate(UFS)}
    client = FakeClient(totals, default=0)
    _, expected, _ = plan_partitions(client, MODALITIES, window_cap=SEARCH_WINDOW_CAP)

    assert expected == sum(totals.values())


def test_the_planner_asks_once_per_partition():
    """One record per count, one count per partition. The planner runs before
    every sweep, so an extra request here is 27 extra requests a day."""
    client = FakeClient({})
    plan_partitions(client, MODALITIES, window_cap=SEARCH_WINDOW_CAP)

    assert len(client.calls) == len(UFS)
    assert client.calls == [(uf, MODALITIES) for uf in UFS]
