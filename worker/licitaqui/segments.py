"""The 14 segments, the false-positive rules, and how an item is classified.

A port of POC 1's `segmento_item` / `segmento_por_texto` / `cita_termo`
(`poc1_licitacoes.py`), which is validated on real PNCP data. The keyword lists,
their order, the NCM prefix table and the false-positive expressions are copied
across term for term — this module exists to *be* that logic in the worker, not
to improve on it. ``tests/test_segments.py`` checks that against 476 real cached
items whose expected segment was produced by running the POC itself.

Three things the port does differently, all deliberate:

**Keys, not labels.** The POC's segment is a display string ("Saúde /
Hospitalar"). What goes in `tender_items.segment` and `tenders.segments` is a
stable ASCII key (`health`), with the POC's string kept as the pt-BR label.
Identifiers are English (CLAUDE.md), the value ends up in URLs, array filters
and a join with B6's `cnae_segments`, and a label can be re-worded without a
migration. :data:`SEGMENTS` is the whole vocabulary, in POC priority order;
:func:`label` and :func:`key_for_label` convert.

**False positives are scrubbed before the keyword match, not only around it.**
The POC applies `FALSOS_POSITIVOS` to the *search term* — it is what stops a
search for "sistema" from matching "sistema de registro de preços", which is a
way of buying, not software. Nothing in the sync has a search term, so the same
list is applied where the same mistake can happen here: the description is
scrubbed of those expressions before the segment keywords are run over it. On
the 8,861 cached items this changes no segment at all (6 descriptions contain
such an expression; none of them classify by it), which is the measurement that
says the rule is defensive rather than divergent.

**Relevance.** §6.1 wants `high | medium | low` per item and §7.1 ties it to the
false positives. It records how the segment was reached, which is precisely the
POC's own order of confidence:

``high``
    the NCM code said so — a structured code from the agency, which the POC
    trusts ahead of any text;
``medium``
    a keyword matched the description after scrubbing;
``low``
    nothing matched (segment `other`), or the only keyword evidence sat inside
    a false-positive expression and did not survive the scrub.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

#: Every segment, in POC 1's priority order: the first keyword list to match
#: wins, so "sistema de gestão" is software before "monitor led" is IT. The
#: order is load-bearing, not alphabetical. ``other`` is the POC's "Outros" and
#: is never matched, only fallen back to.
SEGMENTS: tuple[tuple[str, str], ...] = (
    ("software", "Software / Sistemas"),
    ("security", "Segurança Eletrônica / CFTV"),
    ("it", "Informática / TI"),
    ("electrical", "Elétrica"),
    ("health", "Saúde / Hospitalar"),
    ("food", "Alimentos"),
    ("construction", "Construção / Hidráulica"),
    ("hardware", "Ferragens / Ferramentas"),
    ("vehicles", "Veículos / Peças"),
    ("office", "Gráfico / Escritório"),
    ("apparel", "Vestuário / Uniformes"),
    ("sports", "Esportes / Lazer"),
    ("cleaning", "Limpeza / Higiene"),
    ("furniture", "Mobiliário"),
    ("other", "Outros"),
)

#: The catch-all. Stored, never guessed at: an item with no segment is a fact
#: about the item, and a null would be indistinguishable from "not classified
#: yet".
OTHER = "other"

_LABELS = dict(SEGMENTS)
_KEYS_BY_LABEL = {label: key for key, label in SEGMENTS}

#: Keyword lists, verbatim from POC 1's ``SEGMENTOS_PALAVRAS``. An entry
#: containing a backslash is a regex; everything else is a literal.
SEGMENT_KEYWORDS: dict[str, tuple[str, ...]] = {
    "software": (
        "software",
        "sistema de gestao",
        "sistema informatizado",
        "sistema integrado",
        "sistemas de informacao",
        "locacao de sistema",
        "licenca de uso",
        "licenciamento",
        "saas",
        "aplicativo",
        "banco de dados",
        "antivirus",
        "computacao em nuvem",
        "cloud",
    ),
    "security": (
        "cftv",
        "videomonitoramento",
        "camera de seguranca",
        "camera ip",
        "seguranca eletronica",
        "alarme",
        "controle de acesso",
        "catraca",
        "dvr",
        "nvr",
    ),
    "it": (
        "informatica",
        "computador",
        "notebook",
        "desktop",
        "monitor de video",
        "monitor led",
        "mouse",
        "teclado",
        "impressora",
        "toner",
        "cartucho",
        "servidor de rede",
        "switch",
        "roteador",
        "nobreak",
        "ssd",
        "hd externo",
        "memoria ram",
        "tablet",
        "projetor",
        "webcam",
        "cabo de rede",
        "rede logica",
        "access point",
        "scanner",
        "pen drive",
        "videoconferencia",
        "headset",
        "cabo hdmi",
        "outsourcing de impressao",
    ),
    "electrical": (
        "eletrico",
        "eletrica",
        "lampada",
        "luminaria",
        "disjuntor",
        "cabo flexivel",
        "fio",
        "tomada",
        "interruptor",
        "quadro de distribuicao",
        "reator",
        "led",
        "transformador",
        "iluminacao",
        "poste",
        "eletroduto",
        "conector",
        "fita isolante",
        "rele",
        "contator",
    ),
    "health": (
        "medicament",
        "hospitalar",
        "cirurgic",
        "seringa",
        "luva",
        "odontolog",
        "laboratori",
        "curativo",
        "monitor multiparametr",
        "fisiologic",
        "ambulatori",
        "equipo",
        "cateter",
        "solucao injetavel",
        "solucao oral",
        "comprimido",
        "capsula",
        "ampola",
        "mg/ml",
        r"\d+ ?mg\b",
        r"\d+ ?mcg\b",
        "pomada",
        "xarope",
        "gaze",
        "sonda",
    ),
    "food": (
        "alimenticio",
        "alimento",
        "merenda",
        "carne",
        "arroz",
        "feijao",
        "leite",
        "ovos",
        "hortifruti",
        "frutas",
        "cafe",
        "acucar",
        "biscoito",
        "suco",
    ),
    "construction": (
        "construcao",
        "cimento",
        "areia",
        "tijolo",
        "tinta",
        "obra",
        "obras",
        "engenharia",
        "pavimentacao",
        "asfalt",
        "brita",
        "madeira",
        "hidraulic",
        "sinalizacao viaria",
        "pvc",
        "tubo",
        "cano",
        "conexao para tubos",
        "cotovelo",
        "joelho",
        "registro de gaveta",
        "rolo p/ pintura",
        "rolo de pintura",
        "pincel",
        "massa corrida",
        "argamassa",
    ),
    "hardware": (
        "parafuso",
        "porca",
        "arruela",
        "pino",
        "prego",
        "broca",
        "chave de fenda",
        "alicate",
        "martelo",
        "serrote",
        "cadeado",
        "dobradica",
        "ferramenta",
    ),
    "vehicles": (
        "veiculo",
        "pneu",
        "pecas de reposicao",
        "automotiv",
        "oleo lubrificante",
        "combustivel",
        "maquinas pesadas",
        "onibus",
        "caminhao",
        "motocicleta",
        "filtro de oleo",
    ),
    "office": (
        "papel",
        "escritorio",
        "expediente",
        "grafic",
        "caneta",
        "envelope",
        "bloco",
        "impresso",
        "grampeador",
        "folder",
        "panfleto",
        "banner",
        "cartaz",
        "adesivo",
        "livreto",
        "cartao de visita",
        "etiqueta",
    ),
    "apparel": ("camiseta", "camisa", "uniforme", "calca", "jaleco", "bota", "bone", "agasalho"),
    "sports": ("esportiv", "bola", "rede de volei", "trofeu", "medalha", "colchonete"),
    "cleaning": (
        "limpeza",
        "higiene",
        "sabonete",
        "detergente",
        "desinfetante",
        "papel higienico",
        "saco de lixo",
        "alcool",
        "vassoura",
        "rodo",
    ),
    "furniture": ("mobiliario", "cadeira", "mesa", "armario", "estante", "moveis", "gaveteiro"),
}


def _compile(patterns: tuple[str, ...]) -> re.Pattern[str]:
    """POC 1's construction, unchanged: match at a word boundary.

    The ``\\b`` is why "obra" does not match "dobra". A term that already
    contains a backslash is a regex the POC wrote on purpose (``\\d+ ?mg\\b``)
    and is spliced in raw; everything else is escaped.
    """
    alternatives = "|".join(p if "\\" in p else re.escape(p) for p in patterns)
    return re.compile(r"\b(?:" + alternatives + ")")


_SEGMENT_RE: dict[str, re.Pattern[str]] = {
    key: _compile(words) for key, words in SEGMENT_KEYWORDS.items()
}

#: NCM prefix → segment, from POC 1's ``SEGMENTOS_NCM``. Only consulted for
#: **materials** (`materialOuServico == "M"`): a service carrying an NCM is
#: describing what it maintains, not what is being sold.
_NCM_PREFIXES: list[tuple[str, str]] = [
    ("8471", "it"),
    ("8473", "it"),
    ("8443", "it"),
    ("8517", "it"),
    ("8523", "it"),
    ("8528", "it"),
    ("8504", "electrical"),
    ("8535", "electrical"),
    ("8536", "electrical"),
    ("8537", "electrical"),
    ("8539", "electrical"),
    ("8544", "electrical"),
    ("9405", "electrical"),
    ("3004", "health"),
    ("3005", "health"),
    ("9018", "health"),
    ("9019", "health"),
    ("9021", "health"),
    ("9022", "health"),
    ("4015", "health"),
    ("87", "vehicles"),
    ("4011", "vehicles"),
    ("2710", "vehicles"),
    ("9401", "furniture"),
    ("9403", "furniture"),
    ("4802", "office"),
    ("4820", "office"),
    ("9608", "office"),
    ("4911", "office"),
    ("3401", "cleaning"),
    ("3402", "cleaning"),
    ("4818", "cleaning"),
    ("2523", "construction"),
    ("3208", "construction"),
    ("3209", "construction"),
    ("6810", "construction"),
    ("7308", "construction"),
    ("4407", "construction"),
    ("2517", "construction"),
    ("3917", "construction"),
    ("8525", "security"),
    ("8531", "security"),
    ("8518", "it"),
    ("3006", "health"),
    ("61", "apparel"),
    ("62", "apparel"),
    ("9506", "sports"),
    ("82", "hardware"),
    ("7318", "hardware"),
    ("83", "hardware"),
    ("85", "electrical"),
]
# NCM chapters 02–21 are food, and the longest prefix wins: 8536 beats 85, and
# 3004 (medicines) beats chapter 30 never being listed at all.
_NCM_PREFIXES += [(f"{chapter:02d}", "food") for chapter in range(2, 22)]
_NCM_PREFIXES.sort(key=lambda pair: -len(pair[0]))

#: Expressions that contain a keyword but mean something else, verbatim from
#: POC 1's ``FALSOS_POSITIVOS``. "Sistema de registro de preços" is a way of
#: buying; "sistema de esgoto" is sewerage. Neither is software.
FALSE_POSITIVES: tuple[str, ...] = (
    r"sistema de registro de precos?",
    r"\bsrp\b",
    r"sistema de comodato",
    r"em sistema de comodato",
    r"sistema (de )?aeracao",
    r"sistema de ar condicionado",
    r"sistema de climatizacao",
    r"sistema de abastecimento",
    r"sistema de esgot\w*",
    r"sistema viario",
    r"sistema unico de saude",
    r"sistema eletronico",
    r"sistema de compras",
    r"portal de compras",
)
_FALSE_POSITIVE_RE = re.compile("|".join(FALSE_POSITIVES))

#: What `tender_items.relevance` may hold (§6.1).
HIGH, MEDIUM, LOW = "high", "medium", "low"


def label(key: str) -> str:
    """The pt-BR name a user sees for a segment key."""
    return _LABELS.get(key, _LABELS[OTHER])


def key_for_label(name: str) -> str:
    """Inverse of :func:`label`, for comparing against POC 1's output."""
    return _KEYS_BY_LABEL.get(name, OTHER)


def normalize(text: object) -> str:
    """POC 1's ``normalizar``: strip accents, lowercase, collapse whitespace."""
    folded = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore")
    return re.sub(r"\s+", " ", folded.decode("ascii").lower())


def strip_false_positives(normalized: str) -> str:
    """Blank out the expressions of :data:`FALSE_POSITIVES`.

    Takes already-normalized text, because the expressions are written without
    accents — the same order POC 1's ``cita_termo`` uses.
    """
    return _FALSE_POSITIVE_RE.sub(" ", normalized)


def has_false_positive(text: object) -> bool:
    """Whether the text contains any of the false-positive expressions."""
    return bool(_FALSE_POSITIVE_RE.search(normalize(text)))


def segment_for_text(text: object, *, scrub: bool = True) -> str | None:
    """First segment whose keywords match, or None. POC's ``segmento_por_texto``.

    ``scrub=False`` reproduces the POC exactly, for the parity tests; the sync
    always scrubs.
    """
    normalized = normalize(text)
    if scrub:
        normalized = strip_false_positives(normalized)
    for key in SEGMENT_KEYWORDS:
        if _SEGMENT_RE[key].search(normalized):
            return key
    return None


def segment_for_ncm(ncm: object, kind: object) -> str | None:
    """Segment from the NCM code, for materials only. POC's first branch.

    ``kind`` is PNCP's ``materialOuServico``: only ``M`` consults the table,
    the POC's exact test. Non-digits are stripped first — the codes arrive as
    `8471.30.12`, `84713012` and, occasionally, blank.
    """
    digits = re.sub(r"\D", "", str(ncm or ""))
    if not digits or str(kind or "").strip().upper() != "M":
        return None
    for prefix, key in _NCM_PREFIXES:
        if digits.startswith(prefix):
            return key
    return None


@dataclass(frozen=True, slots=True)
class Classification:
    """One item's segment, how confident we are, and where it came from."""

    segment: str
    relevance: str
    #: ``ncm`` | ``keyword`` | ``false_positive`` | ``none`` — for the log line
    #: and for the tests that assert *why*, not only *what*.
    source: str


def classify(description: object, ncm: object = None, kind: object = None) -> Classification:
    """Classify one item the way POC 1 does, plus the false-positive guard.

    Order is the POC's: the NCM code first for materials, the description
    afterwards. The difference is that the description is scrubbed of
    false-positive expressions before the keywords run over it, and an item
    whose only evidence was inside one of those expressions comes back as
    `other` / `low` instead of being filed under a segment it has nothing to do
    with.
    """
    by_ncm = segment_for_ncm(ncm, kind)
    if by_ncm:
        return Classification(by_ncm, HIGH, "ncm")
    by_keyword = segment_for_text(description, scrub=True)
    if by_keyword:
        return Classification(by_keyword, MEDIUM, "keyword")
    if segment_for_text(description, scrub=False):
        # The keyword is there, but only inside "sistema de registro de
        # preços" or one of its siblings: POC 1 skips exactly this case.
        return Classification(OTHER, LOW, "false_positive")
    return Classification(OTHER, LOW, "none")
