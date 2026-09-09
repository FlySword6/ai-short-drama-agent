"""Issue #31 的发布分支处置结论必须与现役运行时合同保持一致。"""

from __future__ import annotations

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
REPORT = PROJECT_ROOT / "docs" / "adr" / "0002-v030-release-branch-reconciliation.md"

RELEASE_ONLY_COMMITS = (
    "cf400a9bdd4c08a9a600654adf2b1d584616db5c",
    "8e777e77e3457db4129cb5131bec0e7299d1e442",
    "6ac4c9926b374b90c8b984a68747b39e2f56854e",
    "988bd34573a3594d356c695104e3b963b5dcf869",
)


def test_reconciliation_report_covers_every_release_only_commit() -> None:
    text = REPORT.read_text(encoding="utf-8")

    for commit in RELEASE_ONLY_COMMITS:
        assert text.count(commit) == 1, f"处置报告未唯一覆盖提交 {commit}"

    assert "不直接 cherry-pick" in text
    assert "不回流" in text


def test_architecture_defines_release_snapshot_relationship() -> None:
    text = (PROJECT_ROOT / "ARCHITECTURE.md").read_text(encoding="utf-8")

    assert "发布标签与发版分支是不可变发布快照而不是长期开发主线" in text
    assert "不得把发版分支整体合回主干" in text


def test_python_floor_matches_runtime_and_lock_contract() -> None:
    project = (PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    lock = (PROJECT_ROOT / "uv.lock").read_text(encoding="utf-8")

    assert 'requires-python = ">=3.11"' in project
    assert lock.splitlines()[2] == 'requires-python = ">=3.11"'
