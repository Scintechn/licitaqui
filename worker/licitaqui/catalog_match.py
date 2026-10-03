"""Resolve a tender item's free-text description to a Compras.gov.br catalogue
code (card B36).

## This is a port, and that is the dangerous part

`productHead`, `productGrade` and the folding live in
``apps/web/lib/radar/product-key.ts`` and are what the price band's measured
accuracy was produced by. The mapper runs on the worker, which is Python, so the
logic exists twice -- and two implementations of one rule is exactly the shape
this repository collects defects from.

So ``tests/test_catalog_match.py`` carries a **conformance fixture generated
from the TypeScript** and asserts character-for-character equality on real PNCP
descriptions. If somebody edits either side, that test fails. Do not "fix" a
conformance failure by editing the fixture: regenerate it from the TypeScript,
and only after deciding the TypeScript is right.

## Only an exact match may feed a band

Sci's decision, 2026-10-02, on measured evidence. Over 1 350 back-tested items
with the real winning price known:

===========  =========  ==========  =============
rule         band rate  hit rate    signed bias
===========  =========  ==========  =============
exact        11.8%      56%         **-3.6%**
prefix       5.2%       42%         **+18.6%**
===========  =========  ==========  =============

A prefix match lands on a coarser product that costs more, so the *statistic*
comes out ~19% high -- the same magnitude as the orgao's own estimate, which was
rejected as a price signal for exactly that reason. The individual matched rows
are still honest evidence; it is the computed band that is not. Hence
:data:`BAND_ELIGIBLE_RULES`, which is the single place that rule is written.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# Ported verbatim from product-key.ts. Keep the order and the membership
# identical; the conformance test is what proves they still are.
STOPWORDS = frozenset(
    ["de", "da", "do", "das", "dos", "e", "em", "com", "para", "a", "o", "as", "os", "no", "na"]
)

ATTRIBUTE_KEYS = frozenset([
    "material", "tipo", "aplicacao", "dosagem", "concentracao", "especificacao",
    "especificacoes", "composicao", "apresentacao", "adicionais", "adicional", "modelo",
    "fisico", "minimas", "minima", "referencia", "altura", "embalagem", "capacidade", "cor",
    "tamanho", "dimensoes", "uso", "corpo", "caracteristicas", "estrutura", "descricao",
    "aproximadas", "ativo", "componentes", "prima", "grau", "ingredientes", "comprimento",
    "basica", "catmat", "cabo", "fio", "produto", "largura", "gramatura", "formato",
    "quantidade", "funcionamento", "acabamento", "espessura", "peso", "volume", "tensao",
    "potencia", "unidade", "finalidade", "conteudo", "validade", "classe"
])

HEAD_WORDS = 4
CANDIDATE_WORDS = 12

#: The cap BOTH sides of a comparison are reduced with.
#:
#: This was `HEAD_WORDS` on the item and `CANDIDATE_WORDS` on the catalogue, and
#: the asymmetry was a defect rather than a design: the two were compared with
#: tuple **equality**, so any catalogue name whose folded head is longer than
#: `HEAD_WORDS` could never produce an `exact` match for any item -- an item
#: whose description *is* the catalogue name, character for character, resolved
#: as `prefix_rev` and was therefore not band-eligible. Measured 2026-10-02 over
#: the real vocabularies: **41.1% of active CATSER entries** (1 242 of 3 023)
#: and 4.6% of active PDMs (691 of 15 039) were unreachable that way, which is a
#: mechanical reason services scored 8.1% exact against materials' 18.7%.
#:
#: The TypeScript's asymmetry is correct *there* because `sameProduct` does a
#: directional **subset** test, not an equality test. Ported to equality, the
#: same two numbers became a bug.
MATCH_CAP = CANDIDATE_WORDS

#: Which matcher produced a stored row.
#:
#: The band's measured accuracy (56% hit, -3.6% bias) is a property of the
#: *population* the matcher selects, and that population is defined by this
#: comparison and its cap. Change either and the measurement no longer describes
#: what ships. Stored alongside each resolution so a later run can tell whether
#: the rows it is reading are the ones a figure was measured on.
MATCHER_VERSION = f"head-eq-v2:cap{MATCH_CAP}"

#: The only rule whose match may produce a computed band. See the module
#: docstring for the measurement behind it.
BAND_ELIGIBLE_RULES = frozenset({"exact"})

_NON_WORD = re.compile(r"[^a-z0-9\s]")
_SPACES = re.compile(r"\s+")


def fold(raw: str) -> str:
    """`fold` from product-key.ts.

    NFD, drop the combining range U+0300-U+036F specifically (not every
    combining mark -- the TypeScript strips that range and nothing else),
    lower-case, non-alphanumerics to space, collapse.
    """
    decomposed = unicodedata.normalize("NFD", raw)
    stripped = "".join(c for c in decomposed if not ("̀" <= c <= "ͯ"))
    lowered = stripped.lower()
    return _SPACES.sub(" ", _NON_WORD.sub(" ", lowered)).strip()


def product_head(description: str | None, cap: int = HEAD_WORDS) -> list[str]:
    """`productHead` from product-key.ts: the words before the first ``atributo:``."""
    if description is None:
        return []
    colon = description.find(":")
    structured = colon != -1
    front = description[:colon] if structured else description

    words = [w for w in fold(front).split(" ") if len(w) > 1 and w not in STOPWORDS]

    # Drop the attribute key from the tail -- the word before the colon is the
    # key, not part of the product name.
    if structured:
        while len(words) > 1 and words[-1] in ATTRIBUTE_KEYS:
            words.pop()

    # `Cadeira Escritorio Cadeira Escritorio, Material Estrutura:` -- the name
    # written twice is a real and common shape and the repeat carries no
    # identity. dict.fromkeys preserves order, as the TypeScript Set does.
    words = list(dict.fromkeys(words))
    return words[:cap]


def all_words(description: str | None, cap: int = 400) -> list[str]:
    """Every word of a description, folded, for disambiguation only.

    Colons are flattened first so the walk does not stop at the first
    ``atributo:``. This is never a gate -- it decides *which* of several codes
    sharing a head the description actually supports.
    """
    if description is None:
        return []
    return product_head(description.replace(":", " "), cap)


@dataclass(frozen=True)
class CatalogEntry:
    """One active PDM or CATSER row, with its name folded the same way."""

    code: int
    name: str
    head: tuple[str, ...]
    words: tuple[str, ...]


#: Every rule the mapper may record. `no_match`/`no_head` are the two that carry
#: no code; `unknown_kind` is an item whose `kind` was not 'M' or 'S' (the column
#: is nullable) and which therefore was never matched against any vocabulary.
RULES = frozenset({"exact", "prefix", "prefix_rev", "no_match", "no_head", "unknown_kind"})
CODELESS_RULES = frozenset({"no_match", "no_head", "unknown_kind"})


@dataclass(frozen=True)
class Resolution:
    code: int | None
    rule: str
    matched_words: int
    candidates: int

    def __post_init__(self) -> None:
        """Refuse a resolution that contradicts itself.

        The worker has no type checker -- ``ruff`` and ``pytest`` are the whole
        gate -- so the structural trick `price-band.ts` uses for `LockedEvidence`
        (a type with no price field, checked by `tsc`) is not available here. The
        constructor is the nearest equivalent: a rule outside :data:`RULES`, or a
        code present where the rule says there is none, cannot exist at all.
        """
        if self.rule not in RULES:
            raise ValueError(f"unknown rule {self.rule!r}")
        if (self.code is None) != (self.rule in CODELESS_RULES):
            raise ValueError(
                f"rule {self.rule!r} and code {self.code!r} disagree: "
                f"{sorted(CODELESS_RULES)} carry no code and every other rule must"
            )

    @property
    def band_eligible(self) -> bool:
        """Whether a band may be computed from this match at all."""
        return self.code is not None and self.rule in BAND_ELIGIBLE_RULES


class CatalogIndex:
    """Active catalogue entries, indexed by folded head.

    Built once per run from ``catalog_pdm`` / ``catalog_service``; holds no
    connection and performs no I/O, so the matcher is testable with neither a
    network nor a database.
    """

    def __init__(self, entries: list[CatalogEntry]) -> None:
        self._by_head: dict[tuple[str, ...], list[CatalogEntry]] = {}
        for e in entries:
            if e.head:
                self._by_head.setdefault(e.head, []).append(e)
        # Longest first, so the most specific catalogue head wins a prefix race.
        self._heads = sorted(self._by_head, key=len, reverse=True)

    def __len__(self) -> int:
        return sum(len(v) for v in self._by_head.values())

    def _pick(self, candidates: list[CatalogEntry], desc_words: set[str]
              ) -> tuple[CatalogEntry, int]:
        """Among codes sharing a head, the one the description actually supports.

        Measured 2026-10-02: **4 026 active PDM names are a single word** and
        118 begin with PAPEL, so a head routinely maps to many codes. Picking
        the lowest code is a coin flip, and it produced a real wrong answer --
        ``PAPEL A4 CX C/10`` resolved to a PDM named ``PAPEL R``. Scoring by how
        much of the catalogue name the item's own description contains fixes
        that deterministically. Ties break on the more specific name, then on
        the code, so the result never depends on dict ordering.
        """
        best: tuple[tuple[int, float, int, int], CatalogEntry] | None = None
        for e in sorted(candidates, key=lambda x: x.code):
            hit = sum(1 for w in e.words if w in desc_words)
            share = hit / len(e.words) if e.words else 0.0
            key = (hit, share, len(e.words), -e.code)
            if best is None or key > best[0]:
                best = (key, e)
        assert best is not None
        return best[1], len(candidates)

    def resolve(self, head: list[str], desc_words: set[str]) -> Resolution:
        """Exact, then the longest catalogue head that prefixes the item's head."""
        t = tuple(head)
        if not t:
            return Resolution(None, "no_head", 0, 0)

        if t in self._by_head:
            entry, n = self._pick(self._by_head[t], desc_words)
            return Resolution(entry.code, "exact", len(t), n)

        for k in self._heads:
            if len(k) <= len(t) and t[: len(k)] == k:
                entry, n = self._pick(self._by_head[k], desc_words)
                return Resolution(entry.code, "prefix", len(k), n)

        # The item's head as a leading prefix of a longer catalogue head: a
        # broadening match, kept separate because it is a weaker claim again.
        wider = [e for k in self._heads if len(t) < len(k) and k[: len(t)] == t
                 for e in self._by_head[k]]
        if wider:
            entry, n = self._pick(wider, desc_words)
            return Resolution(entry.code, "prefix_rev", len(t), n)

        return Resolution(None, "no_match", 0, 0)


def resolve_description(index: CatalogIndex, description: str | None) -> Resolution:
    """The whole mapper for one item: head, words, resolution.

    The head is reduced with :data:`MATCH_CAP`, the same cap the catalogue side
    uses, so ``exact`` means the two names reduce to the same words rather than
    "the same words, unless the catalogue's name happened to be longer".
    """
    return index.resolve(product_head(description, MATCH_CAP),
                         set(all_words(description)))
