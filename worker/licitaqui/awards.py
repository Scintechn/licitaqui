"""Mapping a PNCP award onto an `awards` row — and the CPF that must never reach it.

POC 3 built the price base this module persists: for every item that has a
result, *valor estimado* against *valor homologado*, the discount the winner
offered, and the four-way judgement about whether that discount is usable
(`OK`, cancelled, confidential, out of range). All of that is ported here
unchanged, including both thresholds.

One thing is not ported, because POC 3 wrote to a spreadsheet on a laptop and
this writes to a database: **the winner's identity is personal data as often as
not**, and spec §12 is unambiguous about it —

    PNCP awards may include the CPF (personal tax id) of individual winners:
    mask on write, show only CNPJ.

## Masking happens on the way in, not on the way out

A raw CPF in `awards` is an LGPD incident whether or not some query hides it:
the breach is the storage, and every backup, every `pg_dump` to S3 (§12), every
future read path and every accidental `select *` inherits it. So the mask is
applied in :func:`from_pncp`, before a row object exists, and there is no code
path in this module that can write an unmasked document. :func:`upsert_awards`
takes :class:`Award` values and nothing else.

Three columns carry the risk, not one:

``supplier_doc``
    ``niFornecedor`` — a 14-digit CNPJ for a company, an 11-digit CPF for a
    natural person. A CPF is stored in §6.1's shape, ``***.456.789-**``: the
    first three digits and both check digits gone.
``supplier_name``
    ``nomeRazaoSocialFornecedor`` — a razão social for a company, somebody's
    full name for a natural person. §6.1: *natural person: initials only*.
``raw``
    the whole payload, which contains both of the above verbatim. This is the
    one that is easy to miss: masking the two columns and then storing the
    unedited JSON beside them stores the CPF anyway, just one key deeper.
    :func:`redact_record` rewrites the payload so the raw document and the raw
    name are gone from **every** string in it, wherever they appear — the MEI
    convention of putting the proprietor's name in the razão social means the
    two are not always in separate fields.

## Fail closed

The classification is deliberately lopsided. A document is stored in the clear
only when it is *provably* a company: exactly 14 digits **and** PNCP did not
say ``tipoPessoa: "PF"``. Everything else — 11 digits, a length nobody
recognises, a missing document, a ``PF`` flag that contradicts the digits — is
treated as personal and masked. Masking a company by mistake costs a row of
supplier analytics. Not masking a person costs an LGPD breach, and it is not
recoverable by a later migration: the value is already in the backups.

Measured over the 420 cached award records in the knowledge base: all 420 are
``tipoPessoa: "PJ"`` with a 14-digit ``niFornecedor``, so nothing in the POC's
own sample would have exercised the masking. That is exactly why it is written
against the rule rather than against the sample.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .tenders import BRT, parse_timestamp

# -- POC 3's discount band -------------------------------------------------

#: POC 3, verbatim: "homologado até 5% acima do estimado ainda é plausível".
DISCOUNT_MIN_VALID = Decimal("-0.05")
#: POC 3, verbatim: ">90% de desconto costuma ser erro de unidade/valor".
DISCOUNT_MAX_VALID = Decimal("0.90")

#: §6.1's vocabulary for the same four classes POC 3 spells in Portuguese
#: ("OK", "Cancelado", "Sem estimado (sigiloso?)", "Suspeito"). Only `OK` rows
#: belong in a price band — that is POC 3's rule and it is why the column
#: exists rather than the rows being dropped.
QUALITY_OK = "OK"
QUALITY_CANCELLED = "cancelled"
QUALITY_CONFIDENTIAL = "confidential"
QUALITY_OUT_OF_RANGE = "out_of_range"

#: `awards.discount_pct` is `numeric(6,2)`, so ±9999.99 percentage points is
#: everything it can hold. A discount outside that is a data error by
#: definition (POC 3 caps *usable* ones at 90%), and it is stored as NULL
#: rather than clamped: a clamped −9999.99% would look like a measurement.
#: `quality` still says `out_of_range`, so nothing is lost but a number that
#: was never meaningful.
DISCOUNT_PCT_LIMIT = Decimal("9999.99")

# -- the CPF rule (§12) ----------------------------------------------------

CNPJ_DIGITS = 14
CPF_DIGITS = 11

#: A document we cannot classify keeps nothing at all. Not "the last four", not
#: a length-preserving run of stars: an unrecognised id is as likely to be a
#: person's as a company's, and the length of a document is itself a hint.
MASKED_UNKNOWN = "***"

_NON_DIGITS = re.compile(r"\D+")

#: Portuguese name particles carry no initial. "João da Silva" is "J. S.", not
#: "J. D. S." — which is both what a person would write and one letter less of
#: a personal datum.
_NAME_PARTICLES = frozenset(
    {"da", "de", "do", "das", "dos", "e", "di", "du", "del", "della", "la", "le", "van", "von"}
)

#: Payload keys that hold the supplier's document or name. They are rewritten
#: by key as well as by value, so a field that happens to be empty in the
#: sample cannot smuggle the original through on some other record.
_DOC_KEYS = frozenset({"niFornecedor"})
_NAME_KEYS = frozenset({"nomeRazaoSocialFornecedor"})


def digits(value: Any) -> str:
    """Just the digits of a document, however PNCP punctuated it."""
    if value is None:
        return ""
    return _NON_DIGITS.sub("", str(value))


def mask_cpf(cpf: str) -> str:
    """``12345678901`` -> ``***.456.789-**``, the shape §6.1 prescribes.

    The first three digits and both check digits go. What is left cannot be
    reversed into a CPF: the missing five digits are not derivable from the six
    kept (the two check digits are a function of the *first nine*, not the
    other way round), so recovering one means brute-forcing 1,000 candidates
    and having no way to tell them apart.
    """
    known = digits(cpf)
    if len(known) != CPF_DIGITS:
        return MASKED_UNKNOWN
    return f"***.{known[3:6]}.{known[6:9]}-**"


def initials(name: Any) -> str | None:
    """``"João da Silva Souza"`` -> ``"J. S. S."``. §6.1: *initials only*.

    Particles are dropped, and so is anything that does not start with a
    letter, so a razão social that leads with a CNPJ fragment ("68.117.429
    FULANO DE TAL", the MEI convention) cannot leak the digits through the
    initials.
    """
    if name is None:
        return None
    parts = [part for part in re.split(r"\s+", str(name).strip()) if part]
    letters = [
        part[0].upper()
        for part in parts
        if part[0].isalpha() and part.lower().strip(".,") not in _NAME_PARTICLES
    ]
    if not letters:
        return None
    return " ".join(f"{letter}." for letter in letters)


@dataclass(frozen=True, slots=True)
class Supplier:
    """The winner, already masked. There is no unmasked form of this object."""

    doc: str | None
    name: str | None
    person_type: str | None
    #: True when the row was treated as a natural person — because PNCP said so,
    #: because the document is CPF-shaped, or because we could not tell.
    personal: bool


def classify_supplier(record: dict[str, Any]) -> Supplier:
    """Read the winner out of a PNCP result, masking anything personal.

    ``tipoPessoa`` is PNCP's own answer ("PJ"/"PF") and is believed when it says
    PF. It is *not* believed on its own when it says PJ: a PJ flag on an
    11-digit document is a contradiction, and the safe reading of a
    contradiction about personal data is the one that masks.
    """
    declared = str(record.get("tipoPessoa") or "").strip().upper()[:2] or None
    ni = digits(record.get("niFornecedor"))
    raw_name = record.get("nomeRazaoSocialFornecedor")

    is_company = len(ni) == CNPJ_DIGITS and declared != "PF"
    if is_company:
        name = str(raw_name).strip() if raw_name not in (None, "") else None
        return Supplier(doc=ni, name=name or None, person_type=declared or "PJ", personal=False)

    doc = mask_cpf(ni) if len(ni) == CPF_DIGITS else (MASKED_UNKNOWN if ni else None)
    person_type = declared if declared else ("PF" if len(ni) == CPF_DIGITS else None)
    return Supplier(doc=doc, name=initials(raw_name), person_type=person_type, personal=True)


def redact_record(record: dict[str, Any], supplier: Supplier) -> dict[str, Any]:
    """The payload with the winner's document and name replaced, everywhere.

    Two passes, and both are needed. By **key**, so the canonical fields hold
    the masked values whatever they contained; and by **value**, so the same
    strings are gone from anywhere else in the payload — a free-text field, a
    nested object, a name embedded in another string. `str.replace` on the
    exact original is precise: it cannot damage an unrelated field, because
    nothing else in the record equals a value that is not there.

    A company's payload is returned unchanged. A CNPJ and a razão social are
    public register data, and §12 asks for the opposite of hiding them.
    """
    if not supplier.personal:
        return record
    originals: list[tuple[str, str]] = []
    raw_doc = record.get("niFornecedor")
    if raw_doc not in (None, ""):
        replacement = supplier.doc or MASKED_UNKNOWN
        originals.append((str(raw_doc), replacement))
        bare = digits(raw_doc)
        if bare and bare != str(raw_doc):
            originals.append((bare, replacement))
    raw_name = record.get("nomeRazaoSocialFornecedor")
    if raw_name not in (None, ""):
        originals.append((str(raw_name), supplier.name or MASKED_UNKNOWN))
    return _scrub(record, originals, supplier)


def _scrub(value: Any, originals: Sequence[tuple[str, str]], supplier: Supplier) -> Any:
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, child in value.items():
            if key in _DOC_KEYS:
                out[key] = supplier.doc
            elif key in _NAME_KEYS:
                out[key] = supplier.name
            else:
                out[key] = _scrub(child, originals, supplier)
        return out
    if isinstance(value, list):
        return [_scrub(child, originals, supplier) for child in value]
    if isinstance(value, str):
        scrubbed = value
        for needle, replacement in originals:
            if needle:
                scrubbed = scrubbed.replace(needle, replacement)
        return scrubbed
    return value


# -- the row ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Award:
    """One `awards` row. Already masked: see :func:`from_pncp`."""

    tender_id: str
    item_number: int
    sequence: int = 1
    supplier_doc: str | None = None
    supplier_name: str | None = None
    person_type: str | None = None
    company_size: str | None = None
    unit_awarded_value: Decimal | None = None
    awarded_quantity: Decimal | None = None
    discount_pct: Decimal | None = None
    awarded_on: date | None = None
    quality: str = QUALITY_OK
    raw: dict[str, Any] = field(default_factory=dict)


def _decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def award_date(value: Any) -> date | None:
    """``dataResultado`` -> the Brasília calendar date PNCP meant.

    B2's trap, one column over. PNCP sends naive Brasília wall clock, so
    :func:`licitaqui.tenders.parse_timestamp` attaches the offset — but
    `awards.awarded_on` is a **date**, and handing Postgres an aware
    *timestamp* to store in it casts through the session's TimeZone, which for
    the worker is UTC. A result published at 23:30 BRT would land on the
    following day: not three hours early, a whole day late.

    So the conversion happens here, in Brasília, and a real `date` goes to the
    driver. ``dataResultado`` is date-only in all 420 cached records, which is
    precisely why this has to be defended by a test rather than by the sample.
    """
    parsed = parse_timestamp(value)
    if parsed is None:
        return None
    return parsed.astimezone(BRT).date()


def discount_fraction(
    unit_estimated_value: Decimal | float | None, unit_awarded_value: Decimal | None
) -> Decimal | None:
    """POC 3's ``1 - (homologado / estimado)``, or None when it cannot be known.

    None on a missing or **zero** estimate, which is POC 3's ``if estimado
    and …`` reproduced deliberately rather than by accident: B3 measured every
    one of the 374 sigiloso items reporting ``valorUnitarioEstimado`` as 0, so
    a zero here means *orçamento sigiloso*, not a free item. Dividing by it, or
    treating it as a real estimate, would manufacture a 100% discount out of a
    confidential budget and put it in a price band.
    """
    estimated = _decimal(unit_estimated_value)
    if estimated is None or estimated <= 0 or unit_awarded_value is None:
        return None
    return Decimal(1) - (unit_awarded_value / estimated)


def quality_of(discount: Decimal | None, *, cancelled: bool) -> str:
    """POC 3's four-way judgement, in §6.1's words and in POC 3's order.

    Cancelled first: a cancelled result is not a price at any discount. Then a
    missing estimate (confidential), then POC 3's −5%…90% band.
    """
    if cancelled:
        return QUALITY_CANCELLED
    if discount is None:
        return QUALITY_CONFIDENTIAL
    if discount < DISCOUNT_MIN_VALID or discount > DISCOUNT_MAX_VALID:
        return QUALITY_OUT_OF_RANGE
    return QUALITY_OK


def discount_pct(discount: Decimal | None) -> Decimal | None:
    """The fraction as percentage points, or None when the column cannot hold it."""
    if discount is None:
        return None
    points = (discount * 100).quantize(Decimal("0.01"))
    if abs(points) > DISCOUNT_PCT_LIMIT:
        return None
    return points


def is_cancelled(record: dict[str, Any]) -> bool:
    """POC 3's signal, unchanged: a ``dataCancelamento`` means cancelled.

    PNCP also has ``situacaoCompraItemResultadoNome``, and it was checked
    rather than assumed: across the 420 cached records it reads "Cancelado" on
    2, and both of those also carry a ``dataCancelamento`` — which 18 further
    records carry on their own. The date is the strictly broader signal, so
    POC 3's choice needs no help.
    """
    return bool(record.get("dataCancelamento"))


def from_pncp(
    tender_id: str,
    record: dict[str, Any],
    *,
    item_number: int | None = None,
    unit_estimated_value: Decimal | float | None = None,
) -> Award:
    """Map one ``/…/itens/{n}/resultados`` record, masked, into an `awards` row.

    ``item_number`` comes from the payload when it is there — it always is in
    the 420 cached records — and from the caller otherwise, because the item is
    half the primary key and a row that cannot be keyed cannot be idempotent.

    ``unit_estimated_value`` is the **item's** estimate, which this endpoint
    does not return: it lives on `tender_items` and the caller passes it in.
    Without it every row would be `confidential` and the price base would be
    empty.
    """
    number = item_number if item_number is not None else _int(record.get("numeroItem"))
    if number is None:
        raise ValueError("award has no numeroItem")

    supplier = classify_supplier(record)
    unit_awarded = _decimal(record.get("valorUnitarioHomologado"))
    discount = discount_fraction(unit_estimated_value, unit_awarded)
    return Award(
        tender_id=tender_id,
        item_number=number,
        sequence=_int(record.get("sequencialResultado")) or 1,
        supplier_doc=supplier.doc,
        supplier_name=supplier.name,
        person_type=supplier.person_type,
        company_size=_text(record.get("porteFornecedorNome")),
        unit_awarded_value=unit_awarded,
        awarded_quantity=_decimal(record.get("quantidadeHomologada")),
        discount_pct=discount_pct(discount),
        awarded_on=award_date(record.get("dataResultado")),
        quality=quality_of(discount, cancelled=is_cancelled(record)),
        raw=redact_record(record, supplier),
    )


def map_all(
    tender_id: str,
    records: Iterable[dict[str, Any]],
    *,
    item_number: int,
    unit_estimated_value: Decimal | float | None,
) -> list[Award]:
    """Map one item's whole result list, dropping duplicate sequences."""
    awards: list[Award] = []
    seen: set[int] = set()
    for record in records:
        award = from_pncp(
            tender_id,
            record,
            item_number=item_number,
            unit_estimated_value=unit_estimated_value,
        )
        if award.sequence in seen:
            continue
        seen.add(award.sequence)
        awards.append(award)
    return awards


# -- persistence -----------------------------------------------------------


UPSERT_SQL = """
insert into awards (
    tender_id, item_number, sequence, supplier_doc, supplier_name, person_type,
    company_size, unit_awarded_value, awarded_quantity, discount_pct, awarded_on,
    quality, raw
) values (
    %(tender_id)s, %(item_number)s, %(sequence)s, %(supplier_doc)s, %(supplier_name)s,
    %(person_type)s, %(company_size)s, %(unit_awarded_value)s, %(awarded_quantity)s,
    %(discount_pct)s, %(awarded_on)s, %(quality)s, %(raw)s
)
on conflict (tender_id, item_number, sequence) do update set
    supplier_doc       = excluded.supplier_doc,
    supplier_name      = excluded.supplier_name,
    person_type        = excluded.person_type,
    company_size       = excluded.company_size,
    unit_awarded_value = excluded.unit_awarded_value,
    awarded_quantity   = excluded.awarded_quantity,
    discount_pct       = excluded.discount_pct,
    awarded_on         = excluded.awarded_on,
    quality            = excluded.quality,
    raw                = excluded.raw
"""


def _params(award: Award) -> dict[str, Any]:
    return {
        "tender_id": award.tender_id,
        "item_number": award.item_number,
        "sequence": award.sequence,
        "supplier_doc": award.supplier_doc,
        "supplier_name": award.supplier_name,
        "person_type": award.person_type,
        "company_size": award.company_size,
        "unit_awarded_value": award.unit_awarded_value,
        "awarded_quantity": award.awarded_quantity,
        "discount_pct": award.discount_pct,
        "awarded_on": award.awarded_on,
        "quality": award.quality,
        "raw": Jsonb(award.raw),
    }


def upsert_awards(conn: psycopg.Connection, awards: Sequence[Award]) -> int:
    """Write award rows. Idempotent on `(tender_id, item_number, sequence)`.

    There is no prune here, unlike :func:`licitaqui.items.upsert_items`. §3.2
    makes an award **permanent once awarded**, and an empty answer from an
    endpoint measured to time out for hours at a time must never be allowed to
    delete the winner of an item that was settled last month.

    It takes :class:`Award` values only. That is the whole enforcement of the
    CPF rule: the masking lives in :func:`from_pncp`, which is the only way to
    build one from a payload, so there is no call that writes an unmasked
    document by forgetting a step.
    """
    if not awards:
        return 0
    with conn.cursor() as cur:
        cur.executemany(UPSERT_SQL, [_params(award) for award in awards])
    return len(awards)
