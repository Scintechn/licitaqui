"""Loading and rendering the message bodies in ``worker/templates`` (task E0).

E0 owns the copy; this module only loads it and fills the blanks. The contract
it implements is ``worker/templates/README.md``:

* a file is front matter between ``---`` lines, then the body byte for byte —
  blank lines and line breaks are significant, WhatsApp especially;
* placeholders are ``{{nome}}``, Portuguese snake_case, literal substitution;
* one conditional construct, ``[[se: flag]] … [[/se]]``. No loops, no ``else``;
* **a missing placeholder raises.** It never renders an empty string and never
  leaves the raw ``{{…}}`` in the text. README §3: "a half-rendered price notice
  is a legal problem". The same reasoning makes a *blank* value an error too —
  "Oi, !" is a half-rendered message wearing a different disguise.

Three checks exist because the failure they prevent is a message a real person
reads, and there is no way to unsend one:

1. **Declared placeholders must match the body.** A template that uses
   ``{{data_abertura}}`` without declaring it, or declares one it no longer
   uses, fails at load. That is what keeps the front matter usable as the list
   of things a caller has to supply.
2. **A malformed placeholder is an error, not text.** ``{{ nome }}`` and
   ``{{Nome}}`` do not match the substitution pattern, so without this they
   would be delivered verbatim.
3. **An unresolved ``TODO(Sci):`` refuses to render.** README §7 leaves those
   in the copy on purpose — legal wording and addresses that do not exist yet
   (gaps G3, G13) — and they sit in the *body*, not in a comment. Rendering one
   would send Sci's open question to a founder. ``whatsapp/optout-confirmation``
   has one today, which is why E2 can record an opt-out but cannot yet confirm
   it; see ``licitaqui/whatsapp.py``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

# worker/licitaqui/templates.py -> worker/licitaqui -> worker
TEMPLATES_DIR = Path(__file__).resolve().parents[1] / "templates"

#: A placeholder as README §3 defines it: double braces, snake_case, no spaces.
PLACEHOLDER_RE = re.compile(r"\{\{([a-z][a-z0-9_]*)\}\}")
#: Anything else between double braces is a typo, and typos get delivered.
ANY_BRACES_RE = re.compile(r"\{\{.*?\}\}", re.DOTALL)
CONDITIONAL_RE = re.compile(r"\[\[se:\s*([a-z][a-z0-9_]*)\s*\]\](.*?)\[\[/se\]\]", re.DOTALL)
ANY_BLOCK_RE = re.compile(r"\[\[.*?\]\]", re.DOTALL)

#: README §7. Left in the copy deliberately; must never reach a recipient.
TODO_MARKER = "TODO(Sci):"

FRONT_MATTER_DELIMITER = "---"


class TemplateError(RuntimeError):
    """A template could not be loaded or rendered. Never carries user data."""


class TemplateNotFound(TemplateError):
    def __init__(self, channel: str, template_id: str) -> None:
        super().__init__(f"no template '{template_id}' for channel '{channel}'")
        self.channel = channel
        self.template_id = template_id


class MissingPlaceholder(TemplateError):
    """The context had no usable value for a placeholder the body needs.

    The placeholder *name* is in the message; the value is not, because the
    values are people's names and seat numbers (§12).
    """

    def __init__(self, template_id: str, placeholder: str, reason: str = "missing") -> None:
        super().__init__(f"template '{template_id}': placeholder '{placeholder}' is {reason}")
        self.template_id = template_id
        self.placeholder = placeholder
        self.reason = reason


class TemplateNotApproved(TemplateError):
    """The body still contains an open decision addressed to Sci (README §7)."""

    def __init__(self, template_id: str) -> None:
        super().__init__(
            f"template '{template_id}' still contains {TODO_MARKER!r}: "
            "an open decision for Sci, not copy to send"
        )
        self.template_id = template_id


@dataclass(frozen=True, slots=True)
class Template:
    """One parsed template file."""

    id: str
    channel: str
    status: str
    body: str
    placeholders: tuple[str, ...]
    flags: tuple[str, ...]
    subject: str | None
    path: Path

    @property
    def approved(self) -> bool:
        """Whether Sci has signed the copy off (front matter ``status``)."""
        return self.status == "approved"

    @property
    def ready_to_send(self) -> bool:
        """Whether :meth:`render` can succeed at all.

        ``status: draft`` does **not** make it false: every template is a draft
        until Sci approves the set, and blocking on that would mean E2 ships
        with nothing to render. An unresolved ``TODO(Sci):`` does, because that
        text is a question for Sci sitting in the middle of the message.
        """
        return TODO_MARKER not in self.body

    def render(self, context: dict[str, Any] | None = None, **extra: Any) -> str:
        """Fill the body. Raises rather than rendering anything incomplete."""
        values: dict[str, Any] = {**(context or {}), **extra}
        if not self.ready_to_send:
            raise TemplateNotApproved(self.id)

        text = self._resolve_conditionals(self.body, values)
        text = self._substitute(text, values)

        # Defence in depth: whatever the patterns above missed must not ship.
        leftover = ANY_BRACES_RE.search(text) or ANY_BLOCK_RE.search(text)
        if leftover:
            raise TemplateError(f"template '{self.id}': {leftover.group(0)!r} survived rendering")
        return text

    def _resolve_conditionals(self, text: str, values: dict[str, Any]) -> str:
        def replace(match: re.Match[str]) -> str:
            flag = match.group(1)
            if flag not in values:
                raise MissingPlaceholder(self.id, flag, "an undefined [[se: …]] flag")
            return match.group(2) if values[flag] else ""

        return CONDITIONAL_RE.sub(replace, text)

    def _substitute(self, text: str, values: dict[str, Any]) -> str:
        def replace(match: re.Match[str]) -> str:
            name = match.group(1)
            if name not in values:
                raise MissingPlaceholder(self.id, name)
            value = values[name]
            if value is None:
                raise MissingPlaceholder(self.id, name, "null")
            rendered = str(value)
            if not rendered.strip():
                raise MissingPlaceholder(self.id, name, "blank")
            return rendered

        return PLACEHOLDER_RE.sub(replace, text)


def parse(text: str, *, template_id: str, path: Path | None = None) -> Template:
    """Parse the contents of one template file. See README §2."""
    front, body = _split_front_matter(text, template_id)

    declared = tuple(_as_list(front.get("placeholders")))
    flags = tuple(_as_list(front.get("flags")))
    subject = front.get("subject")
    searchable = body if subject is None else f"{subject}\n{body}"

    used = _placeholders_in(searchable, template_id)
    _check_declaration(template_id, declared, used)

    return Template(
        id=str(front.get("id") or template_id),
        channel=str(front.get("channel") or ""),
        status=str(front.get("status") or "draft"),
        body=body,
        placeholders=declared,
        flags=flags,
        subject=subject,
        path=path or Path(template_id),
    )


def load(channel: str, template_id: str, *, root: Path | None = None) -> Template:
    """Read ``<root>/<channel>/<template_id>.md``.

    Cached per (channel, id, root): templates are read-only at run time, and a
    send should not pay a file read. ``load.cache_clear()`` in a test that
    writes one.
    """
    return _load_cached(channel, template_id, root or TEMPLATES_DIR)


@lru_cache(maxsize=64)
def _load_cached(channel: str, template_id: str, root: Path) -> Template:
    # Neither part may traverse: these come from a job payload.
    if not re.fullmatch(r"[a-z0-9-]+", channel) or not re.fullmatch(r"[a-z0-9-]+", template_id):
        raise TemplateNotFound(channel, template_id)
    path = root / channel / f"{template_id}.md"
    if not path.is_file():
        raise TemplateNotFound(channel, template_id)
    template = parse(path.read_text(encoding="utf-8"), template_id=template_id, path=path)
    if template.channel and template.channel != channel:
        raise TemplateError(
            f"template '{template_id}' is in {channel}/ but declares channel '{template.channel}'"
        )
    return template


def cache_clear() -> None:
    """Forget every loaded template. For tests that write template files."""
    _load_cached.cache_clear()


def render(channel: str, template_id: str, context: dict[str, Any], **extra: Any) -> str:
    """Load and render in one call."""
    return load(channel, template_id).render(context, **extra)


def _split_front_matter(text: str, template_id: str) -> tuple[dict[str, str], str]:
    lines = text.replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != FRONT_MATTER_DELIMITER:
        raise TemplateError(f"template '{template_id}' does not start with '---'")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == FRONT_MATTER_DELIMITER)
    except StopIteration:
        raise TemplateError(f"template '{template_id}' has an unterminated front matter") from None

    front: dict[str, str] = {}
    for line in lines[1:end]:
        if not line.strip():
            continue
        key, sep, value = line.partition(":")
        if not sep:
            raise TemplateError(f"template '{template_id}': front matter line {line!r} has no ':'")
        front[key.strip()] = value.strip()

    # "Everything after the closing --- is the body, byte for byte" — minus the
    # one blank line the format puts between them, and any trailing newlines a
    # text editor added. A WhatsApp message must not end in blank lines.
    body = "\n".join(lines[end + 1 :]).strip("\n")
    return front, body


def _as_list(value: str | None) -> list[str]:
    """``[a, b, c]`` (README's one inline list) or an empty list."""
    if not value:
        return []
    raw = value.strip()
    if raw.startswith("[") and raw.endswith("]"):
        raw = raw[1:-1]
    return [item.strip() for item in raw.split(",") if item.strip()]


def _placeholders_in(text: str, template_id: str) -> tuple[str, ...]:
    """Every well-formed placeholder, having rejected malformed ones."""
    for candidate in ANY_BRACES_RE.finditer(text):
        if not PLACEHOLDER_RE.fullmatch(candidate.group(0)):
            raise TemplateError(
                f"template '{template_id}': {candidate.group(0)!r} is not a placeholder "
                "({{snake_case}}, no spaces) and would be delivered verbatim"
            )
    seen: dict[str, None] = {}
    for match in PLACEHOLDER_RE.finditer(text):
        seen.setdefault(match.group(1), None)
    return tuple(seen)


def _check_declaration(template_id: str, declared: tuple[str, ...], used: tuple[str, ...]) -> None:
    undeclared = [name for name in used if name not in declared]
    if undeclared:
        raise TemplateError(
            f"template '{template_id}' uses undeclared placeholders: {', '.join(undeclared)}"
        )
    unused = [name for name in declared if name not in used]
    if unused:
        raise TemplateError(
            f"template '{template_id}' declares placeholders it does not use: {', '.join(unused)}"
        )
