"""BrasilAPI's CNPJ endpoint: one lookup, sanitised errors, a normalised record.

ADR-0002 measured this endpoint over 45 real supplier CNPJs and chose it for
``company_lookup``, with the manual CNAE form as the fallback path. This module
is the client half of that decision: it performs exactly one request, converts
the payload into :class:`CompanyRecord`, and raises :class:`BrasilApiError` for
anything else. It never retries — a failed lookup is what sends the user to the
manual form (ADR-0002, decision item 5), and retrying in front of a waiting
user only makes them wait longer.

**Rate limit (unmeasured).** B0's burst test replayed CNPJs fetched moments
earlier and measured BrasilAPI's Vercel edge cache (``x-vercel-cache: HIT``),
not the uncached limit. The only uncached evidence is 45 sequential lookups at
~0.5 req/s with no throttling and no rate-limit headers. Until that is measured
properly, every call in this process goes through :data:`_CALL_LOCK` and
:data:`MIN_INTERVAL_SECONDS`: lookups are **single-threaded process-wide and
spaced by at least one second**, whatever ``WORKER_CONCURRENCY`` is set to.
BrasilAPI is free and public; this is the polite rate, not a performance floor.

**LGPD (§12).** The payload carries far more than we need — ``logradouro``,
``cep``, ``email``, ``ddd_telefone_1`` and ``qsa`` (the partner list, which for
a small company is a natural person). :func:`parse` keeps only the fields
``companies`` has columns for; nothing else is returned, so nothing else can be
stored or logged. Errors are sanitised for the same reason: an httpx exception
stringifies its request URL, and a BrasilAPI 404 body quotes the CNPJ back, so
neither is ever propagated or chained.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

import httpx

BASE_URL = "https://brasilapi.com.br/api/cnpj/v1/{}"
USER_AGENT = "licitaqui/0.1 (+https://github.com/Scintechn/licitaqui)"

#: Spec §7.2: connect 15 s. One lookup, one budget — there is no retry to spend.
TIMEOUT_SECONDS = 15.0
#: Minimum gap between two lookups from this process. See the rate-limit note.
MIN_INTERVAL_SECONDS = 1.0
#: Name of the circuit breaker the handler wraps these calls in (§7.2).
BREAKER_NAME = "brasilapi"

# httpx logs 'HTTP Request: GET <url> "HTTP/1.1 200 OK"' at INFO, and the URL
# contains the CNPJ. Keep that below WARNING so raising the root log level can
# never put a company identifier into stdout or Sentry (§12).
logging.getLogger("httpx").setLevel(logging.WARNING)

# Receita Federal's `codigo_porte`. ADR-0002: read this, never `descricao_porte`,
# which the API returns but leaves null on every single lookup (0 / 45).
PORTE_BY_CODE: dict[int, str] = {1: "ME", 3: "EPP", 5: "DEMAIS"}

#: Only ever one request in flight, process-wide. See the module docstring.
_CALL_LOCK = threading.Lock()
_last_call_at = 0.0
_client: httpx.Client | None = None


class BrasilApiError(RuntimeError):
    """A lookup that did not produce a usable company record.

    The message is a short reason code, never a URL and never a response body:
    both quote the CNPJ back (§12).
    """

    def __init__(self, reason: str, *, status: int | None = None, not_found: bool = False) -> None:
        super().__init__(reason if status is None else f"{reason} (http {status})")
        self.reason = reason
        self.status = status
        self.not_found = not_found


@dataclass(frozen=True, slots=True)
class CompanyRecord:
    """The subset of the payload that `companies` (§6.2) has columns for.

    ``is_mei`` and ``is_simples`` are three-state on purpose: ``None`` means the
    company has no Simples/MEI registry entry at all, which ADR-0002 found for
    15 of 45 lookups. It is **not** ``False`` — telling a MEI "you are not a
    MEI" on the strength of a missing record would mislabel exactly the users
    this product is for, and MEI status drives eligibility. ``is_simples`` has
    no column in §6.2, so it is parsed and returned but not persisted.
    """

    cnpj: str
    legal_name: str | None
    trade_name: str | None
    main_cnae: str
    secondary_cnaes: tuple[str, ...]
    size: str | None
    is_mei: bool | None
    is_simples: bool | None
    state: str | None
    city: str | None
    registration_status: str | None


def normalise_cnpj(value: str) -> str:
    """Strip punctuation and check the length. Raises ``ValueError`` otherwise."""
    digits = "".join(ch for ch in str(value) if ch.isdigit())
    if len(digits) != 14:
        raise ValueError("a CNPJ has 14 digits")
    return digits


def has_valid_check_digits(cnpj: str) -> bool:
    """Verify the two mod-11 check digits of a 14-digit CNPJ.

    Cheap enough to run before every lookup, and it keeps a typo from spending a
    request on a free public API — and from writing a fallback row that blames
    BrasilAPI for the user's typing.
    """
    if len(set(cnpj)) == 1:  # 00000000000000 and friends pass mod-11 but are not CNPJs
        return False
    digits = [int(ch) for ch in cnpj]
    for size in (12, 13):
        weights = [(i % 8) + 2 for i in range(size - 1, -1, -1)]
        total = sum(d * w for d, w in zip(digits[:size], weights, strict=True))
        remainder = total % 11
        if digits[size] != (0 if remainder < 2 else 11 - remainder):
            return False
    return True


def tri_state(value: object) -> bool | None:
    """``True`` / ``False`` / ``None``, where ``None`` means "no record".

    BrasilAPI returns ``null`` for ``opcao_pelo_mei`` and ``opcao_pelo_simples``
    on roughly a third of companies. Collapsing that to ``False`` is the bug
    ADR-0002 warns about; this keeps the third state.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"true", "sim", "s", "1"}:
            return True
        if text in {"false", "nao", "não", "n", "0"}:
            return False
        return None
    return bool(value)


def cnae_code(value: object) -> str | None:
    """A CNAE as the 7 digits B6's segment map will join on, or ``None``."""
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if not digits or int(digits) == 0:
        return None
    return digits.zfill(7)[-7:]


def company_size(payload: dict) -> str | None:
    """``ME`` / ``EPP`` / ``DEMAIS`` from ``codigo_porte`` (ADR-0002 item 2)."""
    raw = payload.get("codigo_porte")
    digits = "".join(ch for ch in str(raw if raw is not None else "") if ch.isdigit())
    return PORTE_BY_CODE.get(int(digits)) if digits else None


def parse(cnpj: str, payload: dict) -> CompanyRecord:
    """Normalise one payload. Raises :class:`BrasilApiError` without a CNAE.

    A payload with no ``cnae_fiscal`` cannot feed the segment map, so it counts
    as a failed lookup and goes to the manual form (ADR-0002 item 5).
    """
    main = cnae_code(payload.get("cnae_fiscal"))
    if main is None:
        raise BrasilApiError("payload has no cnae_fiscal")

    secondary: list[str] = []
    for entry in payload.get("cnaes_secundarios") or []:
        code = cnae_code(entry.get("codigo") if isinstance(entry, dict) else entry)
        if code is not None and code != main and code not in secondary:
            secondary.append(code)

    return CompanyRecord(
        cnpj=cnpj,
        legal_name=_text(payload.get("razao_social")),
        trade_name=_text(payload.get("nome_fantasia")),
        main_cnae=main,
        secondary_cnaes=tuple(secondary),
        size=company_size(payload),
        is_mei=tri_state(payload.get("opcao_pelo_mei")),
        is_simples=tri_state(payload.get("opcao_pelo_simples")),
        state=_text(payload.get("uf"), limit=2),
        city=_text(payload.get("municipio")),
        registration_status=_text(payload.get("descricao_situacao_cadastral")),
    )


def fetch(cnpj: str, *, client: httpx.Client | None = None) -> dict:
    """One request, no retry. Serialised and spaced; see the module docstring."""
    global _last_call_at
    url = BASE_URL.format(cnpj)
    with _CALL_LOCK:
        gap = MIN_INTERVAL_SECONDS - (time.monotonic() - _last_call_at)
        if gap > 0:
            time.sleep(gap)
        try:
            response = (client or _shared_client()).get(url)
        except httpx.TimeoutException:
            raise BrasilApiError("timeout") from None
        except httpx.HTTPError as exc:
            # `from None`: the original carries the request URL, and the URL is
            # the CNPJ. Only the exception class name survives.
            raise BrasilApiError(f"transport_error:{type(exc).__name__}") from None
        finally:
            _last_call_at = time.monotonic()

    if response.status_code == 404:
        raise BrasilApiError("not_found", status=404, not_found=True)
    if response.status_code == 429:
        raise BrasilApiError("rate_limited", status=429)
    if response.status_code != 200:
        raise BrasilApiError("unexpected_status", status=response.status_code)
    try:
        payload = response.json()
    except ValueError:
        raise BrasilApiError("invalid_json", status=200) from None
    if not isinstance(payload, dict):
        raise BrasilApiError("unexpected_payload", status=200)
    return payload


def lookup(cnpj: str, *, client: httpx.Client | None = None) -> CompanyRecord:
    """Fetch and normalise. The only entry point a job handler needs."""
    return parse(cnpj, fetch(cnpj, client=client))


def _shared_client() -> httpx.Client:
    """One keep-alive client, reused so we do not re-handshake TLS per lookup.

    Only ever touched while :data:`_CALL_LOCK` is held.
    """
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.Client(
            timeout=TIMEOUT_SECONDS,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        )
    return _client


def close() -> None:
    """Close the shared client. For tests and a clean shutdown."""
    global _client
    with _CALL_LOCK:
        if _client is not None:
            _client.close()
            _client = None


def _text(value: object, *, limit: int | None = None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:limit] if limit else text
