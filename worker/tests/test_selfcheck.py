"""The guard that stops an image that builds and cannot send (selfcheck).

These tests exercise :mod:`licitaqui.selfcheck` itself. They are **not** the
guard: no test running from a checkout can see a missing `COPY` line, which is
precisely why the fault shipped with every check green. The guard is
`docker run --rm <image> python -m licitaqui.selfcheck` in ci-worker.yml, and
what is pinned here is that the thing that run invokes actually fails when the
templates are not there, and does not fail when they are.

The one cheap exception is `test_the_dockerfile_copies_every_image_directory`,
which reads the Dockerfile as text. It is the half of the guard that works on a
laptop with no Docker daemon, and on its own it would have failed today.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from licitaqui import selfcheck, telegram_alerts, templates

WORKER_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = WORKER_ROOT / "Dockerfile"
TELEGRAM_DIR = templates.TEMPLATES_DIR / "telegram"


def test_the_working_tree_passes() -> None:
    result = selfcheck.check_templates()
    assert result.problems == []
    assert result.ok
    # Every telegram body plus whatsapp and e-mail: a count that only rises.
    assert result.checked >= len(telegram_alerts.TEMPLATE_IDS)


def test_a_missing_templates_directory_is_the_whole_answer(tmp_path: Path) -> None:
    """The failure that shipped: /app/templates does not exist."""
    result = selfcheck.check_templates(tmp_path / "templates")
    assert not result.ok
    assert len(result.problems) == 1
    assert "not in this image" in result.problems[0]


def test_an_empty_templates_directory_fails_for_every_telegram_body(tmp_path: Path) -> None:
    """A directory that exists and is empty must not read as success."""
    root = tmp_path / "templates"
    root.mkdir()
    result = selfcheck.check_templates(root)
    assert not result.ok
    assert result.checked == 0
    missing = [p for p in result.problems if "no template" in p]
    assert len(missing) == len(telegram_alerts.TEMPLATE_IDS)
    # The three channel directories are reported as well, so the message says
    # what is absent rather than only listing nine template ids.
    assert sum("channel directory is missing" in p for p in result.problems) == len(
        selfcheck.CHANNELS
    )


def test_one_missing_telegram_body_fails(tmp_path: Path) -> None:
    """A template deleted or renamed out from under the worker, not a whole dir."""
    root = tmp_path / "templates"
    for channel in selfcheck.CHANNELS:
        (root / channel).mkdir(parents=True)
    for source in TELEGRAM_DIR.glob("*.md"):
        if source.stem != "start-linked":
            (root / "telegram" / source.name).write_text(
                source.read_text(encoding="utf-8"), encoding="utf-8"
            )
    templates.cache_clear()
    result = selfcheck.check_templates(root)
    assert not result.ok
    assert any("telegram/start-linked" in p and "no template" in p for p in result.problems)


def test_a_body_that_cannot_render_fails(tmp_path: Path) -> None:
    """Front matter and body drifting apart is the same class of defect."""
    root = tmp_path / "templates"
    for channel in selfcheck.CHANNELS:
        (root / channel).mkdir(parents=True)
    for source in TELEGRAM_DIR.glob("*.md"):
        text = source.read_text(encoding="utf-8")
        if source.stem == "help":
            # Declared, never used: `load` refuses it. A person would have got
            # a message with a raw placeholder in it, or none at all.
            text = text.replace("placeholders: [link_app", "placeholders: [nao_usado, link_app")
        (root / "telegram" / source.name).write_text(text, encoding="utf-8")
    templates.cache_clear()
    result = selfcheck.check_templates(root)
    assert not result.ok
    assert any("telegram/help" in p for p in result.problems)


def test_an_unresolved_todo_for_sci_fails(tmp_path: Path) -> None:
    """README §7: that text is a question for Sci, not copy to send."""
    root = tmp_path / "templates"
    for channel in selfcheck.CHANNELS:
        (root / channel).mkdir(parents=True)
    for source in TELEGRAM_DIR.glob("*.md"):
        text = source.read_text(encoding="utf-8")
        if source.stem == "stop":
            text = f"{text}\n\n{templates.TODO_MARKER} qual o prazo?"
        (root / "telegram" / source.name).write_text(text, encoding="utf-8")
    templates.cache_clear()
    result = selfcheck.check_templates(root)
    assert not result.ok
    assert any("telegram/stop" in p and templates.TODO_MARKER in p for p in result.problems)


def test_every_telegram_file_is_declared_and_every_declaration_has_a_file() -> None:
    """Both directions, so neither a new template nor a stale id goes unnoticed."""
    on_disk = {path.stem for path in TELEGRAM_DIR.glob("*.md")}
    assert on_disk == telegram_alerts.TEMPLATE_IDS


def test_the_digest_templates_are_part_of_the_set() -> None:
    assert telegram_alerts.DIGEST_TEMPLATES <= telegram_alerts.TEMPLATE_IDS


@pytest.mark.parametrize("directory", selfcheck.IMAGE_DIRECTORIES)
def test_the_dockerfile_copies_every_image_directory(directory: str) -> None:
    """The cheap half of the guard: it runs without a Docker daemon.

    `templates/` had no COPY line from the first image until 2026-09-23, and
    nothing anywhere said so.
    """
    lines = [
        line.strip()
        for line in DOCKERFILE.read_text(encoding="utf-8").splitlines()
        if line.strip().startswith("COPY ")
    ]
    assert any(f"{directory}/" in line for line in lines), (
        f"worker/Dockerfile never copies {directory}/, so the image will not have it"
    )


def test_main_reports_success_on_the_working_tree(capsys: pytest.CaptureFixture[str]) -> None:
    assert selfcheck.main() == 0
    assert "self-check ok" in capsys.readouterr().out


def test_main_exits_nonzero_and_explains_when_the_directory_is_gone(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """What the CI step does when an image ships without `templates/`."""
    monkeypatch.setattr(templates, "TEMPLATES_DIR", tmp_path / "gone")
    assert selfcheck.main() == 1
    captured = capsys.readouterr()
    assert "self-check FAILED" in captured.err
    assert "worker/Dockerfile" in captured.err


@pytest.fixture(autouse=True)
def _clear_template_cache() -> None:
    """`templates.load` is cached per (channel, id, root); tests write files."""
    templates.cache_clear()
