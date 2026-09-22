"""A short, human title for a tender — deterministic first, the model as the exception.

PNCP has no short-title field. `tenders.object` is the legal "objeto", and its
useful noun is usually buried:

    CONTRATAÇÃO DE EMPRESAS PARA FORNECIMENTO DE MATERIAIS PERMANENTES, para
    Secretaria de Saúde, conforme descrito no Anexo I – Termo de Referência…

This module turns that into "Fornecimento de materiais permanentes". It is the
most-read string in the product, which is why the design is the shape it is.

## The two branches, and why the order matters

:func:`deterministic_title` cuts the objeto at its first legal connector, drops
the portal prefix and un-shouts it. It cannot hallucinate and it costs nothing,
and on a large minority of tenders it is already the right answer — 19% of
production objects are 80 characters or shorter, and things like "Aquisição de
equipamentos e materiais de roçagem" need nothing done to them.

The model is asked **only when that result is still unfit** — see
:func:`needs_model`. That ordering is a correctness constraint, not a cost
optimisation. Measured on 50 production tenders, objeto "Centro Cultural -
Etapa 02" plus its construction line-items came back as "Revestimento cerâmico
montagem e desmontagem alvenaria laje e caixilho": the items swamped a perfectly
good short objeto. A good short objeto must never reach the model.

## The model branch, and the fabrication it is fenced against

The items are what make the model worth calling at all: objeto "Obras comuns"
— useless on its own — became "Obras de manutenção e melhoramentos em aeródromos
e aeroportos", read off the item rows.

But the first prompt measured asked for "o que e **para quem**", and the model
invented a recipient whenever the text had none — "para MEI", "para pequenas
empresas", "para moradores de Rio Claro" — and once replaced what was being
bought with something more specific than the source ("manutenção e conservação
de bens imóveis" → "pintura e reparos"). Under CDC art. 30 advertising binds the
supplier (legal brief §2.2 rule 1): a title claiming a tender is "para MEI" is a
promise the product cannot keep.

:data:`SYSTEM_PROMPT` forbids both, and measured zero recurrences in 50. But a
prompt rule is a request. :func:`validate` is the guarantee: it rejects a title
that uses a content word present in neither the objeto nor the item lines **as
they were sent**, that carries money or dates, or that evaluates the tender. On
rejection the deterministic title ships instead of the model's answer.

## Rate limits

The free OpenRouter pool rate-limits: 7 of 50 probe calls came back 429
`limit_source: upstream_provider_shared_pool`. :func:`model_title` retries with
backoff, and a 429 is reported as :data:`RATE_LIMITED` — which is neither a
titled tender nor a hard failure for the breaker (§7.2), because an open circuit
would leave a slice of the Radar untitled for 15 minutes for no reason.

## Versions

:data:`RULES_VERSION` and :data:`PROMPT_VERSION` are written onto the row and are
half of the staleness test (the other half is :data:`BASIS_SQL`). Bump
:data:`RULES_VERSION` when :func:`deterministic_title` or :func:`needs_model`
would answer differently, and :data:`PROMPT_VERSION` when the prompt or the
validator would. A rules bump re-titles everything; a prompt bump re-titles only
the rows the model actually produced, which is why they are two columns and not
one.
"""

from __future__ import annotations

import random
import re
import time
import unicodedata
from dataclasses import dataclass
from typing import Any

from . import ai_tender
from .ai_tender import SCREENING_MODEL

# ──────────────────────────────────────────────────────────────────────────
# Versions
# ──────────────────────────────────────────────────────────────────────────

#: Bumped when the deterministic branch or the branch predicate would answer
#: differently. Written to `tenders.short_title_rules_version`.
RULES_VERSION = 1

#: Bumped when the prompt or the validator would answer differently. Written to
#: `tenders.short_title_prompt_version`, and null on a row the model never saw.
PROMPT_VERSION = "t1"

#: Sources recorded in `tenders.short_title_source`. ``ai_fallback`` means the
#: model was asked and its answer was not used — rejected by :func:`validate`,
#: or the call failed. It is deliberately distinct from ``deterministic``: it is
#: the only way to see, later, how often the validator is earning its keep.
SOURCE_DETERMINISTIC = "deterministic"
SOURCE_AI = "ai"
SOURCE_AI_FALLBACK = "ai_fallback"

# ──────────────────────────────────────────────────────────────────────────
# The deterministic branch
# ──────────────────────────────────────────────────────────────────────────

#: "[Portal de Compras Públicas] - ", "[LICITANET] - ". 409 + 224 production
#: rows open with one of these. Mirrors PORTAL_PREFIX in
#: `apps/web/lib/radar/format.ts`.
PORTAL_PREFIX = re.compile(r"^\s*\[[^\]]*\]\s*[-–—:·]*\s*")

#: Where the objeto stops describing the purchase and starts citing the process.
#: Extended from the probe's list against the production corpus: the additions
#: are the `em conformidade`, `descrito/especificado/constante`, `tudo`, `para o
#: (a) …`, `com o objetivo`, `a fim de`, `sob demanda`, `de forma`, `cujas`,
#: `visando` and `nas quantidades` families, plus the `– ANEXO`/`- Termo de
#: Referência` dash forms that carry no connective word at all.
CONNECTORS = re.compile(
    r",?\s+(?:"
    r"conforme|através d|atraves d|nos termos|de acordo com|pelo sistema|"
    r"para atender|em atendimento|visando|destinad[oa]s? a[o]?\s+atender|"
    r"mediante|por meio d|na modalidade|objetivando|"
    r"em conformidade|de conformidade|segundo as|"
    r"consoante|conf\.|cfe\.|c/c|"
    r"(?:tudo\s+)?(?:conforme|de acordo)|"
    r"descrit[oa]s?\s+n[oa]|especificad[oa]s?\s+n[oa]|constante[s]?\s+d[oa]|"
    r"conforme\s+especifica|"
    r"com\s+o\s+objetivo|a\s+fim\s+de|"
    r"sob\s+demanda|de\s+forma\s+parcelada|"
    r"cuj[ao]s?\s+|"
    r"nas\s+quantidades|nos\s+quantitativos|"
    r"pelo\s+per[íi]odo\s+de|pelo\s+prazo\s+de|por\s+um\s+per[íi]odo|"
    r"para\s+o\s+per[íi]odo|durante\s+o\s+per[íi]odo|"
    r"em\s+favor\s+d|para\s+uso\s+d|"
    r"de\s+interesse\s+d|"
    r"nos?\s+munic[íi]pios?\s+de|"
    # "destinados ao atendimento das necessidades…" — 418 production rows. The
    # probe's regex only had the `destinados a atender` form.
    r"destinad[oa]s?\s+a[o]?\s+atendimento|"
    r"para\s+(?:o\s+)?atendimento\s+d|em\s+atendimento\s+d|"
    r"para\s+suprir|para\s+manuten[çc][ãa]o\s+das\s+atividades|"
    r"bem\s+como\b|"
    # The beneficiary tail: "… para a Secretaria Municipal de Saúde". Cut at
    # "para" only when an *organ* follows it — "Contratação de empresa para
    # fornecimento de X" keeps its noun on the far side of that same word.
    r"para\s+(?:a|o|as|os)\s+(?:secretaria|secretarias|munic[íi]pio|prefeitura|"
    r"fundo|hospital|unidade|unidades|departamento|gabinete|c[âa]mara|rede|"
    r"pol[íi]cia|autarquia|funda[çc][ãa]o|diretoria|coordenadoria)|"
    r"d[oa]s?\s+secretarias?\s+municipa|"
    r"tud[o]\s+"
    r")\b",
    re.IGNORECASE,
)

#: A dash followed by annex/reference boilerplate — no connective word, so
#: CONNECTORS cannot see it: "… – ANEXO I", "… - Termo de Referência".
DASH_TAIL = re.compile(
    r"\s+[-–—]\s*(?:anexo|termo\s+de\s+refer[êe]ncia|processo|edital|"
    r"conforme|projeto\s+b[áa]sico|memorial)\b.*$",
    re.IGNORECASE,
)

#: A full stop or dangling punctuation the agency typed at the end of a title
#: that is not a sentence.
TRAILING_PUNCT = re.compile(r"[\s.,;:\-–—/]+$")

#: Words that stay lowercase when a shouted title is brought back to sentence
#: case. Kept identical to LOWERCASE_WORDS in `apps/web/lib/radar/format.ts`.
LOWERCASE_WORDS = frozenset(
    [
        "a",
        "ao",
        "aos",
        "as",
        "às",
        "à",
        "com",
        "como",
        "da",
        "das",
        "de",
        "do",
        "dos",
        "e",
        "em",
        "entre",
        "na",
        "nas",
        "no",
        "nos",
        "o",
        "os",
        "ou",
        "para",
        "pela",
        "pelas",
        "pelo",
        "pelos",
        "por",
        "sem",
        "sob",
        "sobre",
        "um",
        "uma",
    ]
)

#: Acronyms that must survive the lowercasing, because they are read as letters
#: and not as words. Kept identical to ACRONYMS in `format.ts`.
ACRONYMS = frozenset(
    [
        "ABNT",
        "ANVISA",
        "CNPJ",
        "CNAE",
        "CRAS",
        "CREAS",
        "EIRELI",
        "EPI",
        "EPIS",
        "EPP",
        "INMETRO",
        "LED",
        "LTDA",
        "ME",
        "MEI",
        "PNAE",
        "PNCP",
        "SAMU",
        "SEBRAE",
        "SENAC",
        "SENAI",
        "SESC",
        "SESI",
        "SIASG",
        "SRP",
        "SUS",
        "TI",
        "UASG",
        "UBS",
    ]
)


def norm(value: Any) -> str:
    """Lowercase, unaccented, single-spaced. Every comparison here goes through it."""
    text = unicodedata.normalize("NFKD", str(value if value is not None else "").lower())
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", text).strip()


def _is_shouted(letters: str) -> bool:
    """True for a token written in block capitals, with at least two letters."""
    return len(letters) >= 2 and letters == letters.upper() and letters != letters.lower()


#: A text is being shouted if half its letters or more are in block capitals.
#: Measured on the 4,760 production objetos: 35.3% are shouted end to end, 3.4%
#: mix prose with a shouted run, and 61.2% are prose.
SHOUT_RATIO = 0.5

#: …or if this many block-capital words stand next to each other. Two
#: consecutive shouted words are a shouted phrase; one on its own, however long,
#: is an acronym. That distinction is the whole point: "…ao IMPG/UFRJ" came back
#: as "…ao impg/ufrj" under a ratio test alone (it scores 0.22), because neither
#: word is short enough to be spared nor on :data:`ACRONYMS` — and no
#: hand-written list of acronyms can ever be complete.
SHOUT_RUN = 2


def is_shouting(text: str) -> bool:
    """Whether ``text`` is shouted, as opposed to prose that contains acronyms.

    Runs are counted over whitespace-separated words, deliberately *not* over
    the slash-split :func:`de_shout` uses: "IMPG/UFRJ" is one acronym the agency
    typed, not a run of two shouted words.
    """
    shouted = total = 0
    run = longest = 0
    for token in re.split(r"\s+", text):
        letters = "".join(ch for ch in token if ch.isalpha())
        if not letters or any(ch.isdigit() for ch in token):
            run = 0
            continue
        total += len(letters)
        if _is_shouted(letters):
            shouted += len(letters)
            run += 1
            longest = max(longest, run)
        elif letters.lower() not in LOWERCASE_WORDS:
            # A lowercase connective does not break a shouted run: "MATERIAL
            # de CONSTRUÇÃO" is still two shouted words in a row.
            run = 0
    if longest >= SHOUT_RUN:
        return True
    return total > 0 and shouted / total >= SHOUT_RATIO


def de_shout(text: str) -> str:
    """Bring a SHOUTED objeto back to sentence case, sparing acronyms and codes.

    Follows ``deShout`` in `apps/web/lib/radar/format.ts` (PR #55) — including
    the split on the slash, so "ME/EPP" is judged as two acronyms and not as the
    five-letter word "MEEPP" — with two deliberate differences, both of them
    defects the production corpus exposed and neither of them safe to fix in
    `format.ts`, which this task must not touch:

    1. It is gated on :func:`is_shouting`, so a prose objeto is left alone and
       keeps its acronyms.
    2. Inside a shouted text a one-letter connective ("E", "A", "O") is
       lowercased too. `format.ts` requires two letters before a token counts as
       shouted, so "EQUIPAMENTOS MÉDICOS E BENS" came back as "equipamentos
       médicos E bens". Outside a shouted text the same token is left alone,
       because there it is "Bloco A" or "Vitamina C".
    """
    if not is_shouting(text):
        return text

    out: list[str] = []
    for token in re.split(r"([\s/]+)", text):
        if not token.strip():
            out.append(token)
            continue
        letters = "".join(ch for ch in token if ch.isalpha())
        if not letters:
            out.append(token)
            continue
        if any(ch.isdigit() for ch in token):  # a code, not a word: "01/2026"
            out.append(token)
            continue
        lower = letters.lower()
        if lower in LOWERCASE_WORDS and letters == letters.upper():
            out.append(token.lower())
            continue
        if not _is_shouted(letters):  # already prose
            out.append(token)
            continue
        if letters in ACRONYMS:
            out.append(token)
            continue
        if len(letters) <= 3:  # SUS, EPI, TI: too short to be a shouted word
            out.append(token)
            continue
        out.append(token.lower())
    return "".join(out)


def deterministic_title(object_text: str) -> str:
    """The free title: portal prefix off, cut at the first legal connector, un-shouted.

    Never invents and never substitutes — every character it returns came from
    the objeto. Returns "" only for an empty objeto.
    """
    clean = re.sub(r"\s+", " ", str(object_text or "")).strip()
    clean = PORTAL_PREFIX.sub("", clean).strip()
    if not clean:
        return ""

    body = DASH_TAIL.sub("", clean)
    cut = CONNECTORS.search(body)
    if cut and cut.start() > 0:
        body = body[: cut.start()]
    body = TRAILING_PUNCT.sub("", body)
    if not body:
        body = TRAILING_PUNCT.sub("", clean) or clean

    cased = de_shout(body)
    # Restore the opening capital only if the source had one, exactly as
    # `cleanTitle` does — a title that deliberately starts lowercase is left be.
    first_letter = next((ch for ch in body if ch.isalpha()), "")
    if first_letter and first_letter.isupper():
        return re.sub(r"[^\W\d_]", lambda m: m.group(0).upper(), cased, count=1)
    return cased


# ──────────────────────────────────────────────────────────────────────────
# The branch predicate
# ──────────────────────────────────────────────────────────────────────────

#: The deterministic title is unfit above this many characters. Set from the
#: production distribution: see the module docstring and the task report — 80
#: characters is where a Radar card stops showing the whole string.
MAX_DETERMINISTIC_CHARS = 80

#: Openings that name the *contract* rather than the purchase. These are the
#: "still opens with procurement boilerplate" half of the predicate, and every
#: one of them is a production opener with a three-figure row count. Note what
#: is deliberately absent: "aquisição de…" and "prestação de serviços de…"
#: already say what is being bought, and Sci's own examples of a good
#: deterministic title are of exactly that shape.
BOILERPLATE_OPENING = re.compile(
    r"^\s*(?:"
    r"contrata[çc][ãa]o\s+de\s+(?:empresa|pessoa|profissional|firma|institui[çc][ãa]o)|"
    r"contrata[çc][ãa]o\s+de\s+servi[çc]os?\s+de\s+empresa|"
    r"registro\s+de\s+pre[çc]os?\b|"
    r"forma[çc][ãa]o\s+de\s+registro\s+de\s+pre[çc]os?\b|"
    r"sistema\s+de\s+registro\s+de\s+pre[çc]os?\b|"
    r"(?:o|a)\s+(?:presente|objeto)\b|"
    r"constitui\s+objeto\b|"
    r"o\s+objeto\s+d[ao]\b|"
    r"trata(?:-se)?\s+d[eo]\b|"
    r"abertura\s+de\s+processo\b|"
    r"futura\s+e\s+eventual\b|"
    r"eventual\s+e\s+futura\b|"
    r"processo\s+(?:licitat[óo]rio|administrativo)\b|"
    r"sele[çc][ãa]o\s+de\s+propostas?\b|"
    r"escolha\s+d[ae]\s+proposta\b"
    r")",
    re.IGNORECASE,
)


#: Words that name a *category* of purchase rather than a purchase. A title
#: made of nothing else says nothing — "Obras comuns", "Aquisição de materiais"
#: — and is the third reason to ask the model, which reads the real thing off
#: the item rows: that exact objeto became "Obras de manutenção e melhoramentos
#: em aeródromos e aeroportos".
#:
#: This is what separates a short objeto that is *uninformative* from one that
#: is merely *short*. "Centro Cultural - Etapa 02" survives it, because "centro"
#: and "cultural" are not on this list, and so it never reaches the model whose
#: construction line-items would swamp it (finding 2).
GENERIC_WORDS = frozenset(
    [
        "obra",
        "obras",
        "comum",
        "comuns",
        "servico",
        "servicos",
        "bem",
        "bens",
        "material",
        "materiais",
        "aquisicao",
        "aquisicoes",
        "contratacao",
        "contratacoes",
        "fornecimento",
        "fornecimentos",
        "prestacao",
        "locacao",
        "compra",
        "compras",
        "diverso",
        "diversos",
        "diversa",
        "diversas",
        "outro",
        "outros",
        "outra",
        "outras",
        "consumo",
        "permanente",
        "permanentes",
        "equipamento",
        "equipamentos",
        "produto",
        "produtos",
        "item",
        "itens",
        "geral",
        "gerais",
        "eventual",
        "eventuais",
        "licitacao",
        "pessoa",
        "juridica",
        "terceiros",
        "especializada",
        "empresa",
        "empresas",
        "registro",
        "preco",
        "precos",
        "objeto",
        "insumo",
        "insumos",
        "generico",
        "genericos",
        "uso",
        "variados",
        "variadas",
    ]
)


def is_generic(title: str) -> bool:
    """True when every content word of ``title`` is a category label."""
    content = [t for t in _tokens(title) if t not in FUNCTION_WORDS and not t.isdigit()]
    if not content:
        return True
    return all(word in GENERIC_WORDS for word in content)


def needs_model(title: str) -> bool:
    """True when the deterministic title is still unfit and the model is worth asking.

    Unfit means one of three things: empty or too long to read on a card; still
    opening with a phrase that names the contract instead of the purchase; or
    made of nothing but category words, which is the "Obras comuns" case.

    Everything else ships free — and, per the Centro Cultural case in the module
    docstring, **must** be kept away from the model, whose item context would
    swamp a perfectly good short objeto.
    """
    stripped = (title or "").strip()
    if not stripped:
        return True
    if len(stripped) > MAX_DETERMINISTIC_CHARS:
        return True
    if BOILERPLATE_OPENING.match(norm(stripped)):
        return True
    return is_generic(stripped)


# ──────────────────────────────────────────────────────────────────────────
# The model branch
# ──────────────────────────────────────────────────────────────────────────

#: This wording is the one that measured zero fabricated recipients in 50 calls.
#: Two things about it are load-bearing beyond the rules themselves:
#:
#: * the provider rejects ``response_format: json_object`` unless the literal
#:   word "json" appears in the messages (`'messages' must contain the word
#:   'json' in some form`) — the last line satisfies that, so keep it;
#: * the bans are phrased as bans, with the exact fabricated strings named.
#:   Softening them to "prefira não…" is what the first prompt did.
SYSTEM_PROMPT = (
    "Você nomeia licitações públicas brasileiras. Receba o objeto oficial e os itens de "
    "maior valor e devolva um título curto que diga O QUE o órgão está comprando.\n"
    "Regras:\n"
    "- 3 a 8 palavras. Sem ponto final.\n"
    "- Comece pelo que está sendo comprado, nunca por 'Contratação de empresas para'.\n"
    "- Use SOMENTE palavras e fatos presentes no texto recebido.\n"
    "- PROIBIDO inventar para quem é, quem usa ou quem se beneficia. Se o texto não disser, "
    "não escreva. Nunca escreva 'para MEI', 'para pequenas empresas', 'para moradores', "
    "'para a população', 'para crianças' ou qualquer destinatário que não esteja escrito.\n"
    "- PROIBIDO trocar o que está escrito por algo mais específico: se o texto diz "
    "'manutenção de imóveis', não escreva 'pintura e reparos'.\n"
    "- Não escreva valores, datas, prazos, números de processo nem nome de portal.\n"
    "- Não avalie nem recomende: nada de 'ótima', 'oportunidade', 'fácil', 'ideal'.\n"
    "- Português do Brasil, tom direto.\n"
    'Responda apenas com JSON no formato {"titulo": "..."}'
)

#: What the model is allowed to see. Five items, descriptions truncated: the
#: measured average is 398 input tokens, and the truncation is what keeps a
#: 40-line furniture item from being the whole prompt.
MAX_ITEMS = 5
MAX_ITEM_CHARS = 180

#: ~60 is twice the longest title the prompt can legally produce; the measured
#: average completion is 16 tokens.
MAX_OUTPUT_TOKENS = 60
TIMEOUT_SECONDS = 60.0

#: Retries for a 429 from the shared free pool. Four attempts over ~14 s of
#: sleep at most; beyond that the tenders comes back on the next sweep rather
#: than holding a worker thread.
RATE_LIMIT_ATTEMPTS = 4
RATE_LIMIT_BACKOFF = (1.0, 4.0, 9.0)

#: Returned instead of a title when the provider rate-limited us. Neither a
#: titled tender nor a breaker failure — see the module docstring.
RATE_LIMITED = "rate_limited"


def item_lines(items: list[dict[str, Any]]) -> str:
    """The item block exactly as the model receives it.

    The validator builds its vocabulary from this string and not from the item
    rows, because a word the truncation cut is a word the model never saw — and
    therefore a word it invented.
    """
    lines = []
    for item in items[:MAX_ITEMS]:
        description = str(item.get("description") or "")[:MAX_ITEM_CHARS]
        quantity = item.get("quantity")
        unit = item.get("unit") or ""
        suffix = f" ({quantity} {unit})".rstrip().rstrip("(") if quantity is not None else ""
        lines.append(f"- {description}{suffix}".strip())
    return "\n".join(lines)


def user_prompt(object_text: str, items_block: str) -> str:
    """The user message: the objeto, then the top items by value."""
    return (
        f"Objeto oficial:\n{object_text}\n\nItens de maior valor:\n{items_block or '(sem itens)'}"
    )


@dataclass(frozen=True, slots=True)
class ModelAnswer:
    """One call to the titling model and what it cost."""

    title: str | None
    rate_limited: bool = False
    error: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cost_brl: float = 0.0
    attempts: int = 0


def _is_rate_limited(status: int, payload: dict[str, Any]) -> bool:
    if status == 429:
        return True
    error = payload.get("error")
    # OpenRouter also reports the shared free pool's limit in the body, with a
    # 200 or a 400 on the envelope: `limit_source: upstream_provider_shared_pool`.
    return isinstance(error, dict) and int(error.get("code") or 0) == 429


def model_title(
    object_text: str,
    items_block: str,
    key: str,
    *,
    model: str = SCREENING_MODEL,
    sleep: Any = time.sleep,
) -> ModelAnswer:
    """Ask the model once, retrying a 429 from the shared pool with backoff.

    Returns the raw title; the caller must still put it through :func:`validate`.
    """
    user = user_prompt(object_text, items_block)
    input_tokens = output_tokens = 0
    cost_brl = 0.0
    last_error: str | None = None

    for attempt in range(RATE_LIMIT_ATTEMPTS):
        status, payload = ai_tender.call_model(
            model,
            SYSTEM_PROMPT,
            user,
            key,
            max_output=MAX_OUTPUT_TOKENS,
            reasoning="off",
            json_mode=True,
            timeout=TIMEOUT_SECONDS,
        )
        if _is_rate_limited(status, payload):
            last_error = "rate_limited"
            if attempt < len(RATE_LIMIT_BACKOFF):
                # Jitter, so a backfill's threads do not retry in lockstep.
                sleep(RATE_LIMIT_BACKOFF[attempt] * (0.5 + random.random()))
                continue
            return ModelAnswer(None, rate_limited=True, error=last_error, attempts=attempt + 1)

        if status != 200:
            return ModelAnswer(
                None,
                error=f"http_{status}",
                attempts=attempt + 1,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_brl=cost_brl,
            )

        usage = payload.get("usage") or {}
        input_tokens = int(usage.get("prompt_tokens") or 0)
        output_tokens = int(usage.get("completion_tokens") or 0)
        cost_brl = float(usage.get("cost") or 0.0) * ai_tender.USD_BRL
        choices = payload.get("choices") or [{}]
        content = (choices[0].get("message") or {}).get("content")
        answer = ai_tender.json_from_answer(content)
        title = (answer or {}).get("titulo")
        title = str(title).strip() if title else None
        return ModelAnswer(
            title or None,
            error=None if title else "no_title_in_answer",
            attempts=attempt + 1,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_brl=cost_brl,
        )

    return ModelAnswer(None, rate_limited=True, error=last_error, attempts=RATE_LIMIT_ATTEMPTS)


# ──────────────────────────────────────────────────────────────────────────
# The validator — the guarantee, where the prompt is only a request
# ──────────────────────────────────────────────────────────────────────────

#: Function words the vocabulary check ignores. A title is allowed to glue
#: source nouns together with these; it is the content words that must be
#: traceable to the text the model was sent.
FUNCTION_WORDS = frozenset(
    [
        "a",
        "ao",
        "aos",
        "as",
        "às",
        "à",
        "com",
        "como",
        "da",
        "das",
        "de",
        "do",
        "dos",
        "e",
        "em",
        "entre",
        "na",
        "nas",
        "no",
        "nos",
        "o",
        "os",
        "ou",
        "para",
        "pela",
        "pelas",
        "pelo",
        "pelos",
        "por",
        "sem",
        "sob",
        "sobre",
        "um",
        "uma",
        "uns",
        "umas",
        "que",
        "se",
        "seus",
        "sua",
        "suas",
        "seu",
        "seja",
        "sendo",
        "ser",
        "à",
        "às",
        "dum",
        "duma",
        "nele",
        "nela",
        "deste",
        "desta",
        "desse",
        "dessa",
        "daquele",
        "daquela",
    ]
)

#: §2.2 rule 1 plus the evaluative vocabulary the prompt bans. A title carrying
#: any of these is rejected outright, whatever the source text says — these are
#: the words that turn a label into advertising, and under CDC art. 30
#: advertising binds the supplier.
EVALUATIVE = frozenset(
    [
        "otima",
        "otimo",
        "otimas",
        "otimos",
        "excelente",
        "excelentes",
        "oportunidade",
        "oportunidades",
        "facil",
        "faceis",
        "ideal",
        "ideais",
        "melhor",
        "melhores",
        "vantajoso",
        "vantajosa",
        "vantajosos",
        "vantajosas",
        "imperdivel",
        "imperdiveis",
        "garantido",
        "garantida",
        "garantidos",
        "garantidas",
        "garanta",
        "garantia",
        "recomendado",
        "recomendada",
        "recomendavel",
        "lucrativo",
        "lucrativa",
        "rentavel",
        "promissor",
        "promissora",
        "simples",
        "rapido",
        "rapida",
        "vantagem",
        "beneficio",
        "venca",
        "vencer",
        "ganhe",
        "ganhar",
        "aprovado",
        "aprovada",
        "sucesso",
        "perfeito",
        "perfeita",
        "unico",
        "unica",
        "imperdivel",
        "barato",
        "barata",
        "acessivel",
    ]
)

#: Money, a percentage or a date, in any of the shapes an objeto writes them.
#: Always a rejection, whatever the source says: a figure in the most-read
#: string in the product reads as a price (§2.2 rule 3), and a date reads as a
#: deadline, whoever first wrote it.
MONEY_OR_DATE = re.compile(
    r"(?:R\$|\bUS\$|%)"
    r"|\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b"
    r"|\b\d{1,3}(?:\.\d{3})+(?:,\d+)?\b"
    r"|\b\d+,\d+\b",
    re.IGNORECASE,
)

#: A bare four-digit year. Rejected only when the source did not write it —
#: "SUMMIT CBCP 2026" is the name of the event the objeto is buying uniforms
#: for, and blanking it made the title less true, not safer.
YEAR = re.compile(r"\b(?:19|20)\d{2}\b")

#: How much of a word must match a source word for the title's word to count as
#: derived from it. Five characters absorbs Portuguese inflection —
#: "material"/"materiais", "manutenção"/"manutenções", "asfáltico"/"asfáltica"
#: — without letting an unrelated noun through.
STEM_CHARS = 5

#: Shape guards against degenerate output — a single word, or the model
#: ignoring the instruction and echoing the whole objeto. Deliberately looser
#: than the prompt's "3 a 8 palavras": the prompt asks for a good title, this
#: only refuses a broken one. Tightening these to the prompt's own numbers
#: rejected two faithful titles in the 150-tender sample and shipped the
#: *identical, longer* deterministic string in their place. 120 characters is
#: also where `trimObject` in the web truncates for display.
MIN_WORDS = 2
MAX_WORDS = 16
MAX_TITLE_CHARS = 120


def _tokens(text: str) -> list[str]:
    return [t for t in re.split(r"[^0-9a-z]+", norm(text)) if t]


def _derivable(token: str, vocabulary: set[str]) -> bool:
    """True when ``token`` is in, or an inflection of, a word the model was sent."""
    if token in vocabulary:
        return True
    stem = token[:STEM_CHARS]
    if len(token) < STEM_CHARS:
        return False
    return any(source.startswith(stem) for source in vocabulary if len(source) >= STEM_CHARS)


def validate(title: str, object_text: str, items_block: str) -> str | None:
    """``None`` when the title may ship, otherwise the reason it may not.

    The reasons, and the measured bug each one exists for:

    ``empty`` / ``too_short`` / ``too_long`` / ``trailing_stop``
        Shape. A title is a label, not a sentence.
    ``money_or_date``
        "Não escreva valores, datas, prazos" — a number that reads as money in
        the most-read string in the product is a price claim (§2.2 rule 3).
    ``evaluative:<word>``
        §2.2 rule 1. The product finds and organises; it does not recommend.
    ``invented:<word>``
        The one that matters. "para MEI", "para moradores", "pintura e reparos"
        — a content word the objeto and the item lines do not contain.
    ``number_not_in_source``
        A digit run the source never wrote: a process number or a quantity the
        model produced from nowhere.
    """
    text = (title or "").strip()
    if not text:
        return "empty"
    if len(text) > MAX_TITLE_CHARS:
        return "too_long"
    if text.endswith("."):
        return "trailing_stop"

    words = [w for w in re.split(r"\s+", text) if w]
    if len(words) < MIN_WORDS:
        return "too_short"
    if len(words) > MAX_WORDS:
        return "too_long"

    if MONEY_OR_DATE.search(text):
        return "money_or_date"

    source = f"{object_text}\n{items_block}"
    vocabulary = set(_tokens(source))

    for year in YEAR.findall(text):
        if year not in vocabulary:
            return "year_not_in_source"

    for token in _tokens(text):
        if token in FUNCTION_WORDS:
            continue
        if token in EVALUATIVE:
            return f"evaluative:{token}"
        if token.isdigit():
            if token not in vocabulary:
                return "number_not_in_source"
            continue
        if not _derivable(token, vocabulary):
            return f"invented:{token}"
    return None


# ──────────────────────────────────────────────────────────────────────────
# What makes a stored title stale
# ──────────────────────────────────────────────────────────────────────────

#: Digest of everything a title was derived from, for the row aliased ``t``.
#: Written to `tenders.short_title_basis`; a title is current only while the
#: stored value still equals this recomputed one. Defined once, here, and used
#: by both the sweep and the handler — the migration is plain DDL on purpose, so
#: there is no second copy of this expression to drift.
#:
#: It covers the objeto, the PNCP revision and the whole item set, which is
#: exactly "invalidate when `pncp_updated_at` moves or the item set changes".
#: It deliberately does *not* cover `tender_items.updated_at`: re-writing an
#: item with identical content must not re-title, or every items sync would
#: re-pay for the whole corpus.
#:
#: Digesting all the items over-invalidates slightly — the model only ever sees
#: the top five by value — and that is the safe direction: an extra call costs
#: R$ 0,0001, a missed one leaves a wrong title on the most-read string in the
#: product.
BASIS_SQL = """md5(
      coalesce(t.object, '') || chr(31)
   || coalesce(t.pncp_updated_at::text, '') || chr(31)
   || coalesce((
        select string_agg(
                 i.number::text || ':' || coalesce(i.description, '')
                   || ':' || coalesce(i.total_value::text, ''),
                 chr(30) order by i.number)
          from tender_items i
         where i.tender_id = t.id), '')
)"""

#: True for a tender whose title is missing, built by rules that have since
#: changed, or derived from inputs that have since moved. Takes the named
#: parameters ``rules_version`` and ``prompt_version``.
#:
#: Note the middle clause: a **deterministic** row is not stale when only the
#: prompt changed. The model never saw it, and re-titling it would re-pay for a
#: quarter of the corpus to arrive at the same string.
STALE_SQL = f"""(
       t.short_title is null
    or t.short_title_rules_version is distinct from %(rules_version)s
    or (t.short_title_source <> '{SOURCE_DETERMINISTIC}'
        and t.short_title_prompt_version is distinct from %(prompt_version)s)
    or t.short_title_basis is distinct from {BASIS_SQL}
)"""


# ──────────────────────────────────────────────────────────────────────────
# Putting the two branches together
# ──────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Title:
    """A short title and where it came from. Maps onto the `short_title_*` columns."""

    text: str
    source: str
    prompt_version: str | None = None
    rules_version: int = RULES_VERSION
    rejected: str | None = None
    rate_limited: bool = False
    input_tokens: int = 0
    output_tokens: int = 0
    cost_brl: float = 0.0


def build(
    object_text: str,
    items: list[dict[str, Any]],
    *,
    key: str | None = None,
    model: str = SCREENING_MODEL,
    sleep: Any = time.sleep,
) -> Title | None:
    """The whole design in one function: deterministic first, model as the exception.

    ``None`` means "no title yet, come back later" and is returned only when the
    model was needed and the provider rate-limited us — writing the
    deterministic title in that case would record an unfit title as final and
    leave it there, because the row would no longer look stale.
    """
    free = deterministic_title(object_text)
    if not needs_model(free):
        return Title(free, SOURCE_DETERMINISTIC)

    if key is None:
        return Title(free, SOURCE_AI_FALLBACK, rejected="no_api_key") if free else None

    block = item_lines(items)
    answer = model_title(object_text, block, key, model=model, sleep=sleep)

    if answer.rate_limited:
        return None
    if not answer.title:
        return (
            Title(
                free,
                SOURCE_AI_FALLBACK,
                prompt_version=PROMPT_VERSION,
                rejected=answer.error or "no_title",
                input_tokens=answer.input_tokens,
                output_tokens=answer.output_tokens,
                cost_brl=answer.cost_brl,
            )
            if free
            else None
        )

    reason = validate(answer.title, object_text, block)
    if reason:
        return (
            Title(
                free,
                SOURCE_AI_FALLBACK,
                prompt_version=PROMPT_VERSION,
                rejected=reason,
                input_tokens=answer.input_tokens,
                output_tokens=answer.output_tokens,
                cost_brl=answer.cost_brl,
            )
            if free
            else None
        )

    return Title(
        answer.title,
        SOURCE_AI,
        prompt_version=PROMPT_VERSION,
        input_tokens=answer.input_tokens,
        output_tokens=answer.output_tokens,
        cost_brl=answer.cost_brl,
    )
