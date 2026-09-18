"""POC 4 ported: the AI that reads an edital and screens it for a small company.

`ai_screening` (§7.1) is the *lite* half of POC 4 (`poc4_ia_edital.py`): it reads
the pages that decide "is this tender worth opening?" and answers the triage
JSON. The deep dive is C2 and is deliberately absent — only the pieces it will
share (extraction, page selection, the excerpt citation check, the rules) are
here, and they keep the POC's behaviour so C2 does not have to re-derive them.

What is worth knowing before changing anything here:

**The prompt and the extraction are versioned, and the version is a cache key.**
`ai_analyses` is unique on (tender_id, mode, prompt_version, extraction_version,
files_hash) and §3.2 caches the answer **permanently**, shared across users. So
bumping :data:`PROMPT_VERSION_LITE` or :data:`EXTRACTION_VERSION` does not
invalidate anything — it starts a new, parallel cache, and every tender gets
re-analysed at full price the next time somebody asks. Bump them when the answer
really would be different, and run `worker/evaluation` first (CLAUDE.md).

**A scanned PDF never reaches the API.** :func:`Document.has_text` is checked
before the key is even resolved. OCR is out of scope (§16, v2); paying a model to
read an empty string is the bug this prevents, and it is the acceptance criterion
of this task, so :func:`screen` returns `no_text` without a client at all.

**The arithmetic is ours, not the model's.** The POC's battery measured 5 of 12
models getting the minimum capital wrong, because they multiply Brazilian
percentages by Brazilian numbers written as "R$ 4.330.766,67". So the prompt
tells the model *not* to calculate, and :func:`compute_rules` does the two sums
that matter — minimum capital and the contract term in months — in code. That is
also what the `rules` jsonb column in §6.3 is for.

**Citations are checked against the document, not trusted.** Lite claims carry a
page number; :func:`check_citations` verifies that the page exists, that it was
actually one of the pages we sent, and that the page really talks about the thing
being claimed. Deep claims carry a literal excerpt and get the stricter
:func:`check_excerpt_citations`. Neither asks the model to grade itself.

**LGPD (§12).** No page text, no prompt and no model answer ever reaches a log
line: the logs carry the tender id, the versions, the token counts, the cost and
the timings. The API key is resolved the way `db/migrate.py` resolves its
connection string and is never logged, stored or put in an error message.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import time
import unicodedata
import zipfile
from collections import OrderedDict
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from . import config, prompts

# ──────────────────────────────────────────────────────────────────────────
# Versions, models and limits
# ──────────────────────────────────────────────────────────────────────────

#: Bumped when :func:`extract_text` would produce different text for the same
#: PDF. 3 = page text plus small tables (≤ 20 rows) repeated line by line.
#: Part of the `ai_analyses` cache key, so a bump re-analyses everything.
EXTRACTION_VERSION = 3

#: Re-exported from :mod:`licitaqui.prompts`, where the wording lives: callers
#: and the cache key want one name, and the prompt text wants its own file.
PROMPT_VERSION_LITE = prompts.PROMPT_VERSION_LITE
PROMPT_VERSION_DEEP = prompts.PROMPT_VERSION_DEEP
RULES = prompts.RULES
PROMPT_LITE = prompts.PROMPT_LITE
PROMPTS = prompts.PROMPTS

#: Spec §1. The POC's battery scored this 57/58 on the three answer keys at
#: about R$ 0,004 per edital; `worker/evaluation` is how a change is checked.
SCREENING_MODEL = "qwen/qwen3.7-flash"

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_KEY_VAR = "OPENROUTER_API_KEY"
#: Name of the circuit breaker the job wraps the API calls in (§7.2).
BREAKER_NAME = "openrouter"

#: §7.2: AI lite 90 s, deep 240 s. A model slower than that does not fit the
#: product — the user is on screen waiting (§7.3, priority 1).
TIMEOUT_SECONDS = {"lite": 90.0, "deep": 240.0}
CONNECT_TIMEOUT_SECONDS = 15.0

#: Characters sent and answer tokens allowed, per mode (§7.1).
LIMITS = {
    "lite": {"max_chars": 60_000, "max_output": 3_000},
    "deep": {"max_chars": 320_000, "max_output": 16_000},
}

#: A document with less text than this is scanned, not empty-ish: §7.1.
MIN_TEXT_CHARACTERS = 1_500
#: …and so is one averaging less than this per page, however many pages it has.
MIN_CHARACTERS_PER_PAGE = 30

#: OpenRouter bills in US dollars; `cost_brl` in §6.3 is reais. The POC's rate.
USD_BRL = 5.4

#: Tables bigger than this are already readable in the running text; repeating
#: them line by line would just spend the character budget (extraction v3).
MAX_TABLE_ROWS = 20


# ──────────────────────────────────────────────────────────────────────────
# Text
# ──────────────────────────────────────────────────────────────────────────


def norm(value: Any) -> str:
    """Lowercase, unaccented, single-spaced. Every text comparison goes through it."""
    text = unicodedata.normalize("NFKD", str(value if value is not None else "").lower())
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", text).strip()


@dataclass(frozen=True, slots=True)
class Page:
    """One page of the document, numbered from 1 across the whole file set."""

    number: int
    text: str

    def as_dict(self) -> dict[str, Any]:
        return {"page": self.number, "text": self.text}


@dataclass(frozen=True, slots=True)
class Document:
    """Extracted pages plus the extraction version that produced them."""

    pages: tuple[Page, ...]
    extraction_version: int = EXTRACTION_VERSION

    @property
    def page_count(self) -> int:
        return len(self.pages)

    @property
    def characters(self) -> int:
        return sum(len(page.text) for page in self.pages)

    @property
    def has_text(self) -> bool:
        """False for a scanned PDF. Checked before any API call (§7.2).

        Two thresholds, both from the POC: an absolute floor (§7.1 puts it at
        1,500 characters) and a per-page floor, because a 200-page scan with one
        text cover page clears the absolute one and is still unreadable.
        """
        if not self.pages:
            return False
        if self.characters < MIN_TEXT_CHARACTERS:
            return False
        return self.characters >= MIN_CHARACTERS_PER_PAGE * self.page_count

    def text_hash(self) -> str:
        """Digest of the extracted text. A last-resort `files_hash` (see :func:`screen`)."""
        digest = hashlib.sha256()
        digest.update(str(self.extraction_version).encode())
        for page in self.pages:
            digest.update(f"\x00{page.number}\x00{page.text}".encode())
        return digest.hexdigest()

    def as_dict(self) -> dict[str, Any]:
        return {
            "extraction_version": self.extraction_version,
            "pages": [page.as_dict() for page in self.pages],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Document:
        """Rebuild from :meth:`as_dict`, or from the POC's own cache shape."""
        pages = data["pages"] if "pages" in data else data["paginas"]
        return cls(
            pages=tuple(
                Page(int(p.get("page", p.get("pagina"))), p.get("text", p.get("texto")) or "")
                for p in pages
            ),
            extraction_version=int(
                data.get("extraction_version", data.get("versao_extracao", EXTRACTION_VERSION))
            ),
        )


def pdfs_in(data: bytes) -> list[bytes]:
    """The PDFs inside ``data``: itself, or every PDF in the ZIP.

    Many editais are published zipped, edital and annexes together. Anything
    else (.doc, .rar) raises: there is nothing for pdfplumber to read.
    """
    if data.startswith(b"%PDF"):
        return [data]
    if data.startswith(b"PK"):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            pdfs = [
                archive.read(name) for name in archive.namelist() if name.lower().endswith(".pdf")
            ]
        if not pdfs:
            raise ValueError("the ZIP has no PDF inside")
        return pdfs
    raise ValueError("the file is neither a PDF nor a ZIP")


def _page_text(page: Any) -> str:
    """Running text plus, for small tables, one `label: value` line per row.

    Two-column summary boxes ("Benefícios ME/EPP | Sim") come out interleaved in
    the running text, and the model then answers with the neighbouring row's
    value. Repeating each row line by line is extraction v3 and is what made the
    preamble readable; a table over :data:`MAX_TABLE_ROWS` rows is a price list,
    already legible, and only costs characters.
    """
    text = re.sub(r"[ \t]+", " ", (page.extract_text() or "").strip())
    rows: list[str] = []
    try:
        for table in page.extract_tables() or []:
            for row in table:
                cells = [re.sub(r"\s+", " ", c).strip() for c in row if c and c.strip()]
                if len(cells) >= 2:
                    rows.append(f"{cells[0]}: {' | '.join(cells[1:])}")
    except Exception:  # noqa: BLE001 - a table is a bonus; it cannot break the read
        rows = []
    if rows and len(rows) <= MAX_TABLE_ROWS:
        text += "\n[QUADRO/TABELA desta página, linha a linha]\n" + "\n".join(rows)
    return text


def extract_text(source: bytes | str | Path) -> Document:
    """Extract every page of a PDF (or of every PDF in a ZIP), in order.

    Pages are numbered continuously across the files, so a citation to "page 62"
    means the same thing whether the edital arrived as one PDF or as a ZIP.
    """
    import pdfplumber  # imported here: the job needs it, the web process does not

    data = source if isinstance(source, bytes) else Path(source).read_bytes()
    pages: list[Page] = []
    for pdf in pdfs_in(data):
        offset = len(pages)
        with pdfplumber.open(io.BytesIO(pdf)) as document:
            for index, page in enumerate(document.pages, 1):
                pages.append(Page(offset + index, _page_text(page)))
    return Document(pages=tuple(pages))


# ──────────────────────────────────────────────────────────────────────────
# Page selection
# ──────────────────────────────────────────────────────────────────────────

IMPORTANT_WORDS = [
    "termo de referencia", "especifica", "quantidade", "valor estimado", "habilita",
    "qualificacao tecnica", "atestado", "capacidade tecnica", "economico-financeira", "balanco",
    "patrimonio liquido", "capital social", "prazo", "entrega", "execucao", "implantacao",
    "pagamento", "garantia", "multa", "penalidade", "sancao", "amostra", "prova de conceito",
    "visita tecnica", "vistoria", "me/epp", "microempresa", "exclusiv", "subcontrata",
    "consorcio", "sessao", "abertura", "proposta", "lances", "modo de disputa",
    "criterio de julgamento", "vigencia", "suporte", "nivel de servico", "treinamento",
    "certifica", "lote", "item",
]  # fmt: skip

LOW_VALUE_WORDS = [
    "modelo de declaracao", "declaracao de que", "declaramos",
    "termo de ciencia e notificacao", "cadastro do responsavel", "procuracao",
    "carta de credenciamento", "possibilidade de",
]  # fmt: skip

# Groups that decide the triage. Each one looks for the CONCRETE datum (a
# number, a deadline, a "não exigível"), not just the word — so the lite mode
# picks the Termo de Referência page and not the boilerplate clause that every
# edital repeats. They double as the topic test in :func:`check_citations`.
_D = r"\d+ ?\(?[a-z ]*\)? ?"
CRITICAL_GROUPS: OrderedDict[str, str] = OrderedDict(
    [
        ("datas", r"(abertura|sessao publica|proposta).{0,80}\d{2}/\d{2}/\d{4}"),
        (
            "valor",
            r"(valor (total )?estimado|valor da contratacao|valor global|valor total)"
            r".{0,160}r\$ ?[\d.]+,\d{2}",
        ),
        ("itens_precos", r"\d[\d.]*,\d{2} [\d.]+,\d{2}"),
        ("me_epp", r"(exclusiv|reservad|cota|beneficios? me).{0,80}(me\b|epp|microempresa|item)"),
        (
            "habilitacao",
            r"(qualificacao tecnica|habilitacao juridica|economico-financeira|atestado)"
            r".{0,120}(nao exigivel|\d)",
        ),
        ("capital", r"(capital social|patrimonio liquido|capital minimo).{0,120}\d+ ?%"),
        (
            "amostra_poc",
            r"(amostra|prova de conceito).{0,80}(nao exigivel|devera|podera|sera|obrigat|\d)",
        ),
        ("garantia", r"garantia (contratual|de execucao|da proposta).{0,80}(\d+ ?%|nao|sera)"),
        ("visita", r"visita tecnica|vistoria"),
        ("consorcio", r"consorcio|subcontrata"),
        ("entrega", r"(prazo|entrega|fornecimento).{0,60}" + _D + "dias"),
        ("pagamento", r"pagamento.{0,100}" + _D + "dias"),
        ("validade", r"(validade|vida util).{0,80}\d+ ?%"),
        ("vigencia", r"vigencia.{0,80}(\d+|um|doze) ?\(?[a-z]*\)? ?(ano|mes)"),
        ("penalidades", r"multa.{0,80}\d+(,\d+)? ?%"),
        (
            "sanitario",
            r"anvisa|autorizacao de funcionamento|alvara sanitario|licenca sanitaria|inmetro",
        ),
        ("catalogo", r"catalogo|ficha tecnica|literatura tecnica"),
    ]
)
_GROUP_RE: OrderedDict[str, re.Pattern[str]] = OrderedDict(
    (name, re.compile(pattern)) for name, pattern in CRITICAL_GROUPS.items()
)

#: Pages always sent: the preamble carries the dates, the value and the ME/EPP
#: box, and the prompt's "the preâmbulo prevails over boilerplate" rule only
#: means anything if the preamble is in the prompt.
ALWAYS_KEEP_FIRST_PAGES = 3


@dataclass(frozen=True, slots=True)
class Selection:
    """The prompt's document half, and which pages it left out."""

    text: str
    kept: tuple[int, ...]
    dropped: tuple[int, ...]

    @property
    def dropped_count(self) -> int:
        return len(self.dropped)


def select_pages(document: Document, limit: int, mode: str = "lite") -> Selection:
    """Choose the pages that fit in ``limit`` characters, in document order.

    Lite has a 60k budget against editais of 139 pages, so it cannot simply
    truncate: it keeps the first three pages, then buys **coverage** — for every
    critical group, the page with the most concrete hits — and only then fills
    the rest with the densest pages. Truncating instead would answer the triage
    from the first 60k characters, which in a real edital is the boilerplate.

    Deep (C2) has the opposite problem — it wants everything — so it only drops
    the least useful pages until the budget fits.
    """
    by_page = {page.number: page for page in document.pages}
    normalised = {page.number: norm(page.text) for page in document.pages}
    size = {number: len(page.text) + 20 for number, page in by_page.items()}
    density = {}
    for number, text in normalised.items():
        points = sum(text.count(w) for w in IMPORTANT_WORDS)
        points -= 3 * sum(text.count(w) for w in LOW_VALUE_WORDS)
        density[number] = points / max(len(text), 200) * 1000

    mandatory = [page.number for page in document.pages[:ALWAYS_KEEP_FIRST_PAGES]]
    total = sum(size.values())
    keep = set(by_page)

    if total > limit and mode == "lite":
        keep = set(mandatory)
        total = sum(size[number] for number in keep)
        hits = {
            number: {name: len(rx.findall(normalised[number])) for name, rx in _GROUP_RE.items()}
            for number in by_page
        }
        # 1) coverage: one page per critical group that is not covered yet
        for group in _GROUP_RE:
            if any(hits[number][group] for number in keep):
                continue
            candidates = sorted(
                (n for n in by_page if n not in keep and hits[n][group]),
                key=lambda n: (-hits[n][group], size[n]),
            )
            for number in candidates:
                if total + size[number] <= limit:
                    keep.add(number)
                    total += size[number]
                    break
        # 2) fill with the pages covering the most groups, densest first
        for number in sorted(
            by_page, key=lambda n: (-sum(1 for v in hits[n].values() if v), -density[n])
        ):
            if number not in keep and total + size[number] <= limit:
                keep.add(number)
                total += size[number]
    elif total > limit:
        for number in sorted(by_page, key=lambda n: density[n]):
            if total <= limit:
                break
            if number in mandatory:
                continue
            keep.discard(number)
            total -= size[number]

    body = "\n\n".join(
        f"[[página {page.number}]]\n{page.text}" for page in document.pages if page.number in keep
    )
    return Selection(
        text=body[:limit],
        kept=tuple(sorted(keep)),
        dropped=tuple(n for n in sorted(by_page) if n not in keep),
    )


# ──────────────────────────────────────────────────────────────────────────
# OpenRouter
# ──────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Attempt:
    """One call plan and how it ended. Stored on the analysis for debugging."""

    reasoning: str
    json_mode: bool
    http: int
    finish_reason: str | None = None
    error: str | None = None


@dataclass(slots=True)
class Analysis:
    """One model answer, with what it cost to get it."""

    model: str
    mode: str
    prompt_version: str
    ok: bool
    result: dict[str, Any] | None
    input_tokens: int = 0
    output_tokens: int = 0
    cost_brl: float = 0.0
    seconds: float = 0.0
    attempts: tuple[Attempt, ...] = ()
    error: str | None = None
    rules: dict[str, Any] = field(default_factory=dict)
    citation_check: dict[str, Any] | None = None


def api_key() -> str:
    """The OpenRouter key, resolved as `db/migrate.py` resolves its DSN.

    Returned to the caller and never logged, stored or put in an exception (§12).
    """
    return config.require_secret(OPENROUTER_KEY_VAR)


def _post(body: dict[str, Any], key: str, timeout: float) -> tuple[int, dict[str, Any]]:
    """One POST. Returns (status, payload); status 0 means it never answered."""
    try:
        response = httpx.post(
            OPENROUTER_URL,
            json=body,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "X-Title": "LicitaQui",
            },
            timeout=httpx.Timeout(timeout, connect=CONNECT_TIMEOUT_SECONDS),
        )
    except httpx.HTTPError as exc:
        # The exception stringifies the request; the body holds the whole edital.
        return 0, {"error": type(exc).__name__}
    try:
        return response.status_code, response.json()
    except ValueError:
        return response.status_code, {"error": "response was not JSON"}


def call_model(
    model: str,
    system: str,
    user: str,
    key: str,
    *,
    max_output: int,
    reasoning: str = "off",
    json_mode: bool = True,
    timeout: float = 90.0,
) -> tuple[int, dict[str, Any]]:
    """Ask the model once. `temperature: 0` so a re-run of the gate is comparable."""
    body: dict[str, Any] = {
        "model": model,
        "temperature": 0,
        "max_tokens": max_output,
        "usage": {"include": True},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    if reasoning == "off":
        body["reasoning"] = {"enabled": False}
    elif reasoning in ("low", "medium", "high"):
        body["reasoning"] = {"effort": reasoning, "exclude": True}
    return _post(body, key, timeout)


def json_from_answer(content: str | None) -> dict[str, Any] | None:
    """The JSON object in a model answer, tolerating a ```json fence or a preamble."""
    if not content:
        return None
    stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip())
    braced = re.search(r"\{.*\}", stripped, re.S)
    for candidate in (stripped, braced.group(0) if braced else None):
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


#: The call plans, in order (§7.2). A model that will not produce JSON under a
#: response_format sometimes will without one, and a truncated answer sometimes
#: fits in twice the tokens. Each plan costs money, so there are three, not ten.
CALL_PLANS: tuple[tuple[str, bool, int], ...] = (
    ("off", True, 1),
    ("low", True, 1),
    ("low", False, 2),
)


def analyse(
    model: str,
    mode: str,
    text: str,
    key: str,
    *,
    max_output: int | None = None,
    timeout: float | None = None,
    call: Any = None,
) -> Analysis:
    """Run the plans until one returns parseable JSON. Always reports the cost.

    Stops immediately on 401/402/404 (a bad key, no credit, a retired model: the
    next plan cannot fix any of them) and after two hangs, so one dead provider
    cannot burn the job's whole budget.
    """
    prompt_version, prompt = PROMPTS[mode]
    # Resolved here rather than as a default argument so a test (or the
    # evaluation's recorder) can substitute the transport at call time.
    call = call or call_model
    max_output = max_output or LIMITS[mode]["max_output"]
    timeout = timeout or TIMEOUT_SECONDS[mode]
    started = time.monotonic()
    attempts: list[Attempt] = []
    cost_usd = 0.0
    input_tokens = output_tokens = 0
    result: dict[str, Any] | None = None
    hangs = 0

    for reasoning, json_mode, budget_multiplier in CALL_PLANS:
        status, payload = call(
            model,
            RULES,
            prompt + text,
            key,
            max_output=max_output * budget_multiplier,
            reasoning=reasoning,
            json_mode=json_mode,
            timeout=timeout,
        )
        usage = payload.get("usage") or {}
        cost_usd += usage.get("cost") or 0.0
        input_tokens += int(usage.get("prompt_tokens") or 0)
        output_tokens += int(usage.get("completion_tokens") or 0)
        error = payload.get("error")
        if isinstance(error, dict):
            error = error.get("message")
        choice = (payload.get("choices") or [{}])[0] if status == 200 else {}
        content = (choice.get("message") or {}).get("content") or ""
        finish_reason = choice.get("finish_reason")
        result = json_from_answer(content)
        attempts.append(
            Attempt(
                reasoning=reasoning,
                json_mode=json_mode,
                http=status,
                finish_reason=finish_reason,
                error=str(error)[:200] if error else None,
            )
        )
        if result is not None:
            break
        if status in (401, 402, 404):
            break
        if status == 0 or (status == 200 and not finish_reason and not content):
            hangs += 1
            if hangs >= 2:
                break

    last = attempts[-1] if attempts else None
    return Analysis(
        model=model,
        mode=mode,
        prompt_version=prompt_version,
        ok=result is not None,
        result=result,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_brl=round(cost_usd * USD_BRL, 4),
        seconds=round(time.monotonic() - started, 1),
        attempts=tuple(attempts),
        error=None if result is not None else _failure_reason(last),
    )


def _failure_reason(last: Attempt | None) -> str:
    if last is None:
        return "no attempt was made"
    if last.error:
        return last.error
    if last.http != 200:
        return f"http {last.http}"
    return "the answer was not valid JSON"


# ──────────────────────────────────────────────────────────────────────────
# Rules computed in code, never asked of the model
# ──────────────────────────────────────────────────────────────────────────


def parse_number(value: Any) -> float | None:
    """First number in Brazilian notation. `R$ 4.330.766,67` → 4330766.67.

    The POC's `_num`. `12 meses, prorrogável` → 12.0, `05 anos` → 5.0, and a
    bare `1.234` → 1234.0 because a three-digit group after a dot is a thousands
    separator here, not a decimal point.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    match = re.search(r"\d[\d.]*(?:,\d+)?", str(value or ""))
    if not match:
        return None
    text = match.group(0).rstrip(".")
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(\.\d{3})+", text):
        text = text.replace(".", "")
    try:
        return float(text)
    except ValueError:
        return None


#: A number and the unit that qualifies it, tolerating the Brazilian habit of
#: spelling the figure out in brackets: `12 (doze) meses`, `1 (um) ano`.
_TERM_RE = re.compile(r"(\d[\d.]*(?:,\d+)?)\s*(?:\([^)]*\)\s*)?(mes|ano)")


def months(value: Any) -> float | None:
    """The contract term in months. `05 anos` → 60, `12 meses` → 12, `60` → 60.

    The unit is taken from the word that **qualifies a number**, not from any
    word anywhere in the string. The POC took the latter, and a live run of this
    port caught it: the model answered `"12 (1 ano)"` for a twelve-month price
    registry, the string contains "ano" and no "mes", and the term came out as
    144 months. Months win over years when both are qualified, because
    `12 meses (1 ano)` states the same thing twice and the finer unit is right.
    """
    if isinstance(value, bool) or not isinstance(value, str):
        return parse_number(value)
    found = {unit: parse_number(number) for number, unit in _TERM_RE.findall(norm(value))}
    if found.get("mes") is not None:
        return found["mes"]
    if found.get("ano") is not None:
        return found["ano"] * 12
    return parse_number(value)


def compute_rules(result: dict[str, Any] | None, mode: str = "lite") -> dict[str, Any]:
    """Do the arithmetic the prompt forbade the model to do (§7.2).

    Mutates ``result`` — `vigencia_meses_normalizada` and the calculated minimum
    capital are part of the answer the screen renders — and returns the same
    values for the `rules` column in §6.3.
    """
    rules: dict[str, Any] = {}
    if not isinstance(result, dict):
        return rules
    triage = result.get("triagem") if mode == "deep" else result
    if not isinstance(triage, dict):
        return rules

    if triage.get("vigencia_meses") is not None:
        triage["vigencia_meses_normalizada"] = months(triage.get("vigencia_meses"))
        rules["term_months"] = triage["vigencia_meses_normalizada"]

    capital = triage.get("capital_ou_patrimonio_minimo")
    total = parse_number(triage.get("valor_estimado_total"))
    term_months = triage.get("vigencia_meses_normalizada")
    if not (isinstance(capital, dict) and total):
        return rules

    blob = norm(json.dumps(capital, ensure_ascii=False))
    percentage = parse_number(capital.get("percentual"))
    if percentage is None:
        match = re.search(r"(\d+(?:[.,]\d+)?)\s*%", blob)
        percentage = parse_number(match.group(1)) if match else None
    if percentage and percentage > 1:
        percentage = percentage / 100
    if not percentage:
        return rules

    base_text = norm(capital.get("base")) + " " + blob
    yearly = any(token in base_text for token in ("anual", "1 ano", "01 ano", "um ano"))
    if yearly and term_months and term_months > 12:
        base = total * 12 / term_months
        how = f"{percentage:.0%} de (R$ {total:,.2f} × 12 / {term_months:.0f} meses)"
    elif "mensal" in base_text and term_months:
        base = total / term_months
        how = f"{percentage:.0%} de (R$ {total:,.2f} / {term_months:.0f} meses)"
    else:
        base = total
        how = f"{percentage:.0%} de R$ {total:,.2f}"
    capital["valor_minimo_calculado"] = round(base * percentage, 2)
    capital["calculo"] = how
    rules["minimum_capital_brl"] = capital["valor_minimo_calculado"]
    rules["minimum_capital_calculation"] = how
    return rules


# ──────────────────────────────────────────────────────────────────────────
# Citation check — the model must point at the page it read a claim from
# ──────────────────────────────────────────────────────────────────────────

# For lite: is the cited page even *about* the thing being claimed?
#
# Deliberately looser than :data:`CRITICAL_GROUPS`, which hunts for a concrete
# datum in order to pick pages. Here the claim is often a negative — "capital
# mínimo: não exigível" — and the page that says so has no percentage on it. A
# subject-word test still fails a page about delivery deadlines cited as the
# source of a minimum-capital claim, which is the hallucination worth catching.
LITE_CITATION_TOPICS: tuple[tuple[str, str], ...] = (
    (
        "beneficio_me_epp",
        r"me/epp|me / epp|microempresa|pequeno porte|exclusiv|cota reservada|"
        r"lei complementar 123|lc 123|beneficio",
    ),
    (
        "atestado_capacidade_tecnica",
        r"atestado|capacidade tecnica|qualificacao tecnica|habilitacao",
    ),
    (
        "capital_ou_patrimonio_minimo",
        r"capital social|patrimonio liquido|capital minimo|economico-financeira|"
        r"economico financeira|balanco patrimonial",
    ),
    ("amostra_ou_prova_de_conceito", r"amostra|prova de conceito|prototipo|demonstracao"),
    ("garantia_contratual", r"garantia"),
    ("entrega", r"entrega|fornecimento|validade|prazo de execucao"),
    (
        "exigencias_produto",
        r"anvisa|inmetro|alvara|licenca|catalogo|ficha tecnica|literatura tecnica|certifica",
    ),
)
_LITE_TOPIC_RE: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (name, re.compile(pattern)) for name, pattern in LITE_CITATION_TOPICS
)


def _excerpt_matches(excerpt: str, target: str) -> float:
    """1.0 = literal (in chunks); 0.9 = same words, different order; 0 = absent.

    The 0.9 exists because a claim quoted out of a table comes back with the
    cells in a different order than the extracted text puts them.
    """
    parts = [p.strip() for p in re.split(r"\.\.\.|…", excerpt) if len(p.strip()) >= 12] or [excerpt]
    chunks = [part[i : i + 40] for part in parts for i in range(0, max(len(part) - 20, 1), 40)]
    if chunks and sum(1 for chunk in chunks if chunk in target) / len(chunks) >= 0.6:
        return 1.0
    pattern = r"[a-z]{4,}|\d[\d.,]*%?"
    words = re.findall(pattern, excerpt)
    if len(words) >= 4:
        present = set(re.findall(pattern, target))
        if sum(1 for word in words if word in present) / len(words) >= 0.9:
            return 0.9
    return 0.0


def _pages_around(by_page: dict[int, str], page: int | None) -> str:
    """The cited page and its neighbours: a claim often straddles a page break."""
    if page is None:
        return ""
    return " ".join(by_page.get(n, "") for n in (page - 1, page, page + 1))


def _cited_page(item: Any) -> int | None:
    if not isinstance(item, dict):
        return None
    try:
        return int(item.get("pagina"))
    except (TypeError, ValueError):
        return None


def check_citations(
    result: dict[str, Any] | None,
    document: Document,
    *,
    sent_pages: Iterable[int] = (),
    mode: str = "lite",
) -> dict[str, Any] | None:
    """Verify the pages a lite answer points at. Deep goes to :func:`check_excerpt_citations`.

    A lite claim has no literal excerpt to match, so the test is the one that
    can actually be failed: the cited page must exist, must be a page we
    **sent** (a page number the model never saw is invented, not remembered),
    and must match the topic pattern of the claim — the same regexes that chose
    the page in the first place. `pagina_errada` means the document does say
    this somewhere, just not there.
    """
    if mode == "deep":
        return check_excerpt_citations(result, document)
    if not isinstance(result, dict):
        return None

    by_page = {page.number: norm(page.text) for page in document.pages}
    sent = set(sent_pages) or set(by_page)
    total = verified = 0
    findings: dict[str, str] = {}

    def record(label: str, page: int | None, rx: re.Pattern[str] | None) -> None:
        nonlocal total, verified
        if page is None:
            return
        total += 1
        if page not in by_page:
            findings[label] = "pagina inexistente"
        elif page not in sent:
            findings[label] = "pagina nao enviada ao modelo"
        elif rx is None or rx.search(_pages_around(by_page, page)):
            findings[label] = "confere"
            verified += 1
        elif any(rx.search(text) for text in by_page.values()):
            findings[label] = "pagina errada"
        else:
            findings[label] = "assunto nao encontrado na pagina"

    for field_name, topic in _LITE_TOPIC_RE:
        record(field_name, _cited_page(result.get(field_name)), topic)
    for index, blocker in enumerate(result.get("bloqueadores_pequena_empresa") or []):
        record(f"bloqueadores_pequena_empresa[{index}]", _cited_page(blocker), None)

    return {
        "mode": "lite",
        "citations": total,
        "verified": round(verified, 2),
        "rate": round(verified / total, 2) if total else None,
        "findings": findings,
    }


def check_excerpt_citations(
    result: dict[str, Any] | None, document: Document
) -> dict[str, Any] | None:
    """The POC's anti-hallucination brake for deep answers (used by C2).

    Every deep requirement, risk and question carries a literal excerpt. This
    checks it against the page it was attributed to, then against the whole
    document — half credit for a real excerpt on the wrong page, none for one
    that is nowhere.
    """
    if not isinstance(result, dict):
        return None
    by_page = {page.number: norm(page.text) for page in document.pages}
    everything = " ".join(by_page.values())
    total = 0.0
    verified = 0.0
    for key in ("exigencias", "riscos", "pontos_de_esclarecimento"):
        for item in result.get(key) or []:
            if not isinstance(item, dict):
                continue
            total += 1
            excerpt = norm(item.get("trecho"))
            if len(excerpt) < 12:
                item["citacao"] = "sem trecho"
                continue
            target = _pages_around(by_page, _cited_page(item))
            score = _excerpt_matches(excerpt, target) if target else 0.0
            if score:
                item["citacao"] = (
                    "confere" if score == 1 else "confere (palavras fora de ordem, ex.: tabela)"
                )
                verified += 1
            elif _excerpt_matches(excerpt, everything):
                item["citacao"] = "trecho existe, pagina errada"
                verified += 0.5
            else:
                item["citacao"] = "NAO encontrado no documento"
    return {
        "mode": "deep",
        "citations": int(total),
        "verified": round(verified, 2),
        "rate": round(verified / total, 2) if total else None,
    }


# ──────────────────────────────────────────────────────────────────────────
# Screening
# ──────────────────────────────────────────────────────────────────────────

NO_TEXT = "no_text"


@dataclass(slots=True)
class Screening:
    """The outcome of one screening: what to store in `ai_analyses` (§6.3)."""

    status: str  # ok | failed | no_text
    analysis: Analysis | None = None
    document: Document | None = None
    selection: Selection | None = None
    cached: bool = False
    error: str | None = None

    @property
    def called_api(self) -> bool:
        return self.analysis is not None and not self.cached

    def log_fields(self) -> dict[str, Any]:
        """Everything worth logging and nothing that is text from the document."""
        fields: dict[str, Any] = {"status": self.status, "cached": self.cached}
        if self.document is not None:
            fields |= {"pages": self.document.page_count, "characters": self.document.characters}
        if self.selection is not None:
            fields |= {
                "pages_sent": len(self.selection.kept),
                "chars_sent": len(self.selection.text),
            }
        if self.analysis is not None:
            fields |= {
                "model": self.analysis.model,
                "prompt_version": self.analysis.prompt_version,
                "input_tokens": self.analysis.input_tokens,
                "output_tokens": self.analysis.output_tokens,
                "cost_brl": self.analysis.cost_brl,
                "seconds": self.analysis.seconds,
            }
        if self.error:
            fields["error"] = self.error
        return fields


def screen(
    document: Document,
    *,
    key: str | None = None,
    model: str = SCREENING_MODEL,
    max_chars: int | None = None,
    call: Any = None,
) -> Screening:
    """Screen one extracted document. Never calls the API for a scanned PDF.

    The `no_text` branch happens **before** the key is resolved, so a scanned
    edital cannot spend a cent even in a misconfigured process.
    """
    if not document.has_text:
        return Screening(status=NO_TEXT, document=document)

    selection = select_pages(document, max_chars or LIMITS["lite"]["max_chars"], "lite")
    analysis = analyse(model, "lite", selection.text, key or api_key(), call=call)
    if analysis.ok:
        analysis.rules = compute_rules(analysis.result, "lite")
        analysis.citation_check = check_citations(
            analysis.result, document, sent_pages=selection.kept
        )
    return Screening(
        status="ok" if analysis.ok else "failed",
        analysis=analysis,
        document=document,
        selection=selection,
        error=analysis.error,
    )
