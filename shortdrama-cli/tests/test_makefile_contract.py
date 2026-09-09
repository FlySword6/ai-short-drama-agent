"""把 Makefile 的现役入口钉成静态契约，避免退役命令重新混入。"""

from __future__ import annotations

import re
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MAKEFILE = PROJECT_ROOT / "Makefile"

RETIRED_VARIABLES = ("SCRIPT", "OUT", "PROMPT", "DURATION", "API_URL", "RUN_ID")
RETIRED_TARGETS = (
    "pipeline",
    "breakdown-script",
    "breakdown-characters",
    "breakdown-storyboard",
    "generate-image",
    "generate-video",
    "runs-sync",
    "runs-status",
)
RETIRED_RECIPES = (
    "shortdrama-cli pipeline run",
    "shortdrama-cli breakdown script",
    "shortdrama-cli breakdown characters",
    "shortdrama-cli breakdown storyboard",
    "shortdrama-cli generate image",
    "shortdrama-cli generate video",
    "shortdrama-cli runs sync",
    "shortdrama-cli runs status",
)


def _makefile_text() -> str:
    return MAKEFILE.read_text(encoding="utf-8")


def _declared_targets(text: str) -> set[str]:
    targets: set[str] = set()
    for line in text.splitlines():
        match = re.match(
            r"^([A-Za-z0-9][A-Za-z0-9_.-]*(?:\s+[A-Za-z0-9_.-]+)*)\s*:(?!=)",
            line,
        )
        if match:
            targets.update(match.group(1).split())
    return targets


def _target_recipe(text: str, target: str) -> str:
    match = re.search(
        rf"(?m)^{re.escape(target)}(?:\s+[^:\n]+)*:[^\n]*\n"
        rf"(?P<recipe>(?:\t[^\n]*(?:\n|$))*)",
        text,
    )
    assert match is not None, f"Makefile 缺少 {target} target"
    return match.group("recipe")


def test_retired_variables_targets_recipes_phony_and_help_are_absent() -> None:
    text = _makefile_text()
    phony_line = next(line for line in text.splitlines() if line.startswith(".PHONY:"))
    phony_targets = set(phony_line.removeprefix(".PHONY:").split())
    declared_targets = _declared_targets(text)
    help_recipe = _target_recipe(text, "help")

    for variable in RETIRED_VARIABLES:
        assert not re.search(rf"(?m)^{re.escape(variable)}\s*[?:+]?=", text), (
            f"Makefile 仍声明旧变量 {variable}"
        )
        assert f"$({variable})" not in text, f"Makefile 仍引用旧变量 {variable}"

    for target in RETIRED_TARGETS:
        assert target not in declared_targets, f"Makefile 仍声明旧 target {target}"
        assert target not in phony_targets, f".PHONY 仍包含旧 target {target}"
        assert target not in help_recipe, f"make help 仍展示旧 target {target}"

    for recipe in RETIRED_RECIPES:
        assert recipe not in text, f"Makefile 仍包含旧 recipe：{recipe}"


def test_test_and_security_test_recipes_stay_frozen() -> None:
    text = _makefile_text()

    assert _target_recipe(text, "test") == "\t$(UV) run pytest -q\n"
    assert _target_recipe(text, "security-test") == (
        "\t$(UV) run --frozen python -m pytest -q tests/test_security_action.py\n"
    )


def test_binary_recipes_keep_modes_entrypoint_and_ca_bundle() -> None:
    text = _makefile_text()
    binary = _target_recipe(text, "binary")
    binary_dir = _target_recipe(text, "binary-dir")

    assert "binary: clean-build" in text
    assert "binary-dir: clean-build" in text

    for recipe, mode, distpath in (
        (binary, "--onefile", "dist/bin"),
        (binary_dir, "--onedir", "dist/app"),
    ):
        assert "$(UV) run pyinstaller" in recipe
        assert mode in recipe
        assert "--name $(BINARY_NAME)" in recipe
        assert "--collect-data shortdrama_cli" in recipe
        assert "--collect-data certifi" in recipe
        assert f"--distpath {distpath}" in recipe
        assert "--workpath build/pyinstaller" in recipe
        assert "--specpath build/pyinstaller" in recipe
        assert "src/shortdrama_cli/__main__.py" in recipe
