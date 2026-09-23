"""Does the *image* carry what the worker reads from disk? Run it inside one.

## The defect this exists to catch

`worker/Dockerfile` copied `pyproject.toml`, `licitaqui/` and `evaluation/`,
and not `templates/`. :data:`licitaqui.templates.TEMPLATES_DIR` resolves
``Path(__file__).parents[1] / "templates"``, which inside the container is
``/app/templates`` — a directory that did not exist. Every render raised
:class:`~licitaqui.templates.TemplateNotFound`, so for the life of the product
`events` held **zero** `telegram.sent` and **zero** `telegram.dry_run` rows:
not one message ever rendered, on any Telegram path — the linking
confirmation, `/ajuda`, `/pausar`, the weekly digest, the empty-week digest.

Every check was green the whole time, and that is the part worth fixing:

* `pytest` runs against the **working tree**, where `worker/templates` sits
  right next to `worker/licitaqui`. No test that imports this package from a
  checkout can observe a missing `COPY` line.
* `docker build` proves the Dockerfile parses and that `pip install .`
  succeeds. It says nothing about whether the resulting image can do its job.

So the guard has to run **inside the built artefact**, between the build and
the push. `.github/workflows/ci-worker.yml` does exactly that::

    docker run --rm licitaqui-worker:<sha> python -m licitaqui.selfcheck

This module is therefore not a test of the code; it is a test of the image. It
is deliberately runnable anywhere — pointed at no root it checks whatever tree
it was imported from — which is what lets `tests/test_selfcheck.py` exercise
its failure modes without Docker.

## Why it renders rather than just listing files

A missing directory is only the failure that happened. The same step costs
nothing more and also catches a template deleted or renamed out from under the
worker, front matter that no longer matches the body, and a stray `{{ nome }}`
that would be delivered verbatim — each of which ships an image that builds and
cannot send. Every telegram template is rendered twice, once with its
`[[se: …]]` flags on and once off, because both branches are real messages.

Placeholder values are a fixed sample string, never real data: this runs in CI
with no database and nothing here may need one.

## What it does not check

`status: draft` is not a failure — every template is a draft until Sci approves
the set (see `templates.Template.ready_to_send`), and blocking on that would
stop the image that has to ship. An unresolved ``TODO(Sci):`` *is* a failure
for anything the worker can be asked to send; the three e-mail templates and
`whatsapp/optout-confirmation` that carry one on purpose (templates README §7)
are parsed but not rendered, which is the state those channels are already in.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import telegram_alerts, templates

#: Top-level directories under `worker/` that must reach the image. Read by
#: `tests/test_selfcheck.py`, which asserts each one has a `COPY` line — the
#: cheap half of this guard, so a laptop with no Docker still gets the signal.
#: `templates/` is the one that was missing; the other two are listed so that
#: adding a third runtime directory has an obvious place to be registered.
IMAGE_DIRECTORIES = ("licitaqui", "evaluation", "templates")

#: Channel directories the worker loads from.
CHANNELS = ("telegram", "whatsapp", "email")

#: What every placeholder is filled with. Short, and obviously not a person.
SAMPLE_VALUE = "amostra"

_HINT = (
    "The image cannot render a message. Check that worker/Dockerfile copies "
    "every directory in licitaqui.selfcheck.IMAGE_DIRECTORIES: templates/ is "
    "read at run time and resolved relative to the package, so an image "
    "without it builds, starts, passes its health check and sends nothing."
)


@dataclass(frozen=True, slots=True)
class Result:
    """What the check found. ``problems`` is empty on success."""

    root: Path
    checked: int = 0
    problems: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


def check_templates(root: Path | None = None) -> Result:
    """Load and render everything the worker can be asked for.

    ``root`` defaults to the directory this package would use at run time, so
    calling it inside the container checks the container.
    """
    root = Path(root) if root is not None else templates.TEMPLATES_DIR
    if not root.is_dir():
        return Result(root, problems=[f"the templates directory is not in this image: {root}"])

    problems: list[str] = []
    for channel in CHANNELS:
        if not (root / channel).is_dir():
            problems.append(f"channel directory is missing: {root / channel}")

    checked = 0
    for template_id in sorted(telegram_alerts.TEMPLATE_IDS):
        template = _load(telegram_alerts.CHANNEL, template_id, root, problems)
        if template is None:
            continue
        checked += 1
        problems.extend(_render_problems(template))

    # Everything else still has to parse. A malformed WhatsApp or e-mail body
    # is the same class of defect one channel earlier, and finding it here
    # costs one file read.
    for path in sorted(root.glob("*/*.md")):
        channel, template_id = path.parent.name, path.stem
        if channel == telegram_alerts.CHANNEL and template_id in telegram_alerts.TEMPLATE_IDS:
            continue
        if _load(channel, template_id, root, problems) is not None:
            checked += 1

    return Result(root, checked=checked, problems=problems)


def _load(
    channel: str, template_id: str, root: Path, problems: list[str]
) -> templates.Template | None:
    try:
        return templates.load(channel, template_id, root=root)
    except templates.TemplateError as exc:
        problems.append(f"{channel}/{template_id}: {exc}")
        return None


def _render_problems(template: templates.Template) -> list[str]:
    """Render with every flag on, then every flag off. Both are real messages."""
    context = dict.fromkeys(template.placeholders, SAMPLE_VALUE)
    problems: list[str] = []
    for flags_on in (True, False):
        flags = dict.fromkeys(template.flags, flags_on)
        try:
            rendered = template.render(context, **flags)
        except templates.TemplateError as exc:
            problems.append(f"{template.channel}/{template.id} (flags={flags_on}): {exc}")
            continue
        if not rendered.strip():
            problems.append(
                f"{template.channel}/{template.id} (flags={flags_on}): rendered to nothing"
            )
    return problems


def main() -> int:
    result = check_templates()
    if result.ok:
        print(f"self-check ok: {result.checked} templates load and render from {result.root}")
        return 0
    print(f"self-check FAILED: {len(result.problems)} problem(s)", file=sys.stderr)
    for problem in result.problems:
        print(f"  - {problem}", file=sys.stderr)
    print(_HINT, file=sys.stderr)
    return 1


if __name__ == "__main__":  # pragma: no cover - exercised by the CI docker run
    sys.exit(main())
