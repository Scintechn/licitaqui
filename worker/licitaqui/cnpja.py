"""CNPJá's open endpoint: the second source ``company_lookup`` asks.

BrasilAPI is the lookup ADR-0002 measured and chose, and it stays first. This
module exists because that choice put the whole Radar behind one free API.
The last lookup that succeeded in production was 2026-10-02 22:10 UTC; the two
after it (2026-10-08 19:23 and 2026-10-09 12:18 UTC) both failed, and on
2026-10-09 BrasilAPI answered ``500`` for every uncached CNPJ tried — its body
naming an upstream ``503``, and minhareceita.org answering ``503`` directly.
Each of those CNPJs landed on the "we could not read this CNPJ" screen. On the
same afternoon ``open.cnpja.com`` answered the same CNPJ in 0.4 s with
the main CNAE, all six secondary CNAEs, porte, Simples/SIMEI, status, UF and
city. It reads the Receita through a different pipeline, so the two do not
share a failure.

So :func:`lookup` here returns the same :class:`~licitaqui.brasilapi.CompanyRecord`
BrasilAPI's does, and ``company.lookup`` calls it only when BrasilAPI could not
answer. Same contract as ``brasilapi``: one request, no retry, sanitised errors.

**Rate limit (inferred, not measured).** The endpoint takes no key and returns
no rate-limit headers; CNPJá's public documentation describes the open API as
limited per IP to a handful of lookups a minute. Its docs page answered ``429``
to the fetch that tried to confirm the number, so :data:`MIN_INTERVAL_SECONDS`
is set to 12 s — five a minute — as the polite figure, not a measured one. The
worker looks up a few CNPJs a week; the spacing only ever costs a second user
in the same minute a short wait.

**LGPD (§12).** The payload carries ``company.members`` (the partners — natural
persons for a small company), phones, e-mails and the street address.
:func:`parse` reads only the fields ``companies`` has columns for, exactly as
``brasilapi.parse`` does, and errors never carry a URL or a body.
"""

from __future__ import annotations

import threading
import time

import httpx

from .brasilapi import PORTE_BY_CODE, USER_AGENT, CompanyRecord, cnae_code

BASE_URL = "https://open.cnpja.com/office/{}"
#: Same budget as BrasilAPI's (spec §7.2).
TIMEOUT_SECONDS = 15.0
#: Five lookups a minute. See the rate-limit note — inferred, not measured.
MIN_INTERVAL_SECONDS = 12.0
#: Its own breaker: BrasilAPI being down must not stop this one being asked.
BREAKER_NAME = "cnpja"

_CALL_LOCK = threading.Lock()
_last_call_at = float("-inf")
_client: httpx.Client | None = None


class CnpjaError(RuntimeError):
    """A lookup that did not produce a usable record. Same shape as ``BrasilApiError``."""

    def __init__(self, reason: str, *, status: int | None = None, not_found: bool = False) -> None:
        super().__init__(reason if status is None else f"{reason} (http {status})")
        self.reason = reason
        self.status = status
        self.not_found = not_found


def _optant(entry: object) -> bool | None:
    """``company.simei`` / ``company.simples`` → three-state, like ``brasilapi.tri_state``.

    CNPJá answers an object with ``optant`` when the company has a registry
    entry and omits it (or sends ``null``) when it has none. Only an explicit
    boolean is a fact; anything else is "no record", never ``False``.
    """
    if not isinstance(entry, dict):
        return None
    value = entry.get("optant")
    return value if isinstance(value, bool) else None


def _upper(value: object, *, limit: int | None = None) -> str | None:
    """Trimmed and upper-cased, to match BrasilAPI's casing in the same columns.

    BrasilAPI writes ``ATIVA`` and ``PLANALTINA``; CNPJá writes ``Ativa`` and
    ``Planaltina``. Two spellings of one status in ``companies`` would make
    every later comparison on it wrong for whichever source it did not expect.
    """
    if value is None:
        return None
    text = str(value).strip().upper()
    if not text:
        return None
    return text[:limit] if limit else text


def _text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def parse(cnpj: str, payload: dict) -> CompanyRecord:
    """Normalise one payload. Raises :class:`CnpjaError` without a main CNAE."""
    main_activity = payload.get("mainActivity")
    main = cnae_code(main_activity.get("id") if isinstance(main_activity, dict) else None)
    if main is None:
        raise CnpjaError("payload has no mainActivity")

    secondary: list[str] = []
    for entry in payload.get("sideActivities") or []:
        code = cnae_code(entry.get("id") if isinstance(entry, dict) else None)
        if code is not None and code != main and code not in secondary:
            secondary.append(code)

    company = payload.get("company") if isinstance(payload.get("company"), dict) else {}
    address = payload.get("address") if isinstance(payload.get("address"), dict) else {}
    status = payload.get("status") if isinstance(payload.get("status"), dict) else {}
    size = company.get("size") if isinstance(company.get("size"), dict) else {}
    # Receita's porte code, the same 1 / 3 / 5 BrasilAPI calls `codigo_porte`.
    size_id = size.get("id")

    return CompanyRecord(
        cnpj=cnpj,
        legal_name=_text(company.get("name")),
        trade_name=_text(payload.get("alias")),
        main_cnae=main,
        secondary_cnaes=tuple(secondary),
        size=PORTE_BY_CODE.get(size_id) if isinstance(size_id, int) else None,
        is_mei=_optant(company.get("simei")),
        is_simples=_optant(company.get("simples")),
        state=_upper(address.get("state"), limit=2),
        city=_upper(address.get("city")),
        registration_status=_upper(status.get("text")),
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
            raise CnpjaError("timeout") from None
        except httpx.HTTPError as exc:
            # `from None`: the original carries the request URL, which is the CNPJ.
            raise CnpjaError(f"transport_error:{type(exc).__name__}") from None
        finally:
            _last_call_at = time.monotonic()

    if response.status_code == 404:
        raise CnpjaError("not_found", status=404, not_found=True)
    if response.status_code == 429:
        raise CnpjaError("rate_limited", status=429)
    if response.status_code != 200:
        raise CnpjaError("unexpected_status", status=response.status_code)
    try:
        payload = response.json()
    except ValueError:
        raise CnpjaError("invalid_json", status=200) from None
    if not isinstance(payload, dict):
        raise CnpjaError("unexpected_payload", status=200)
    return payload


def lookup(cnpj: str, *, client: httpx.Client | None = None) -> CompanyRecord:
    """Fetch and normalise. The only entry point ``company.lookup`` needs."""
    return parse(cnpj, fetch(cnpj, client=client))


def _shared_client() -> httpx.Client:
    """One keep-alive client. Only ever touched while :data:`_CALL_LOCK` is held."""
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
