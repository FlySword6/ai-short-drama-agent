import json
from pathlib import Path

from shortdrama_cli.cli.v030 import (
    asset_app,
    auth_app,
    delivery_app,
    generation_app,
    prep_app,
    project_app,
    reference_app,
    queue_app,
    reference_test_app,
    review_app,
    script_app,
)


ROOT = Path(__file__).parents[1] / "skills" / "shortdrama-cli"
PROJECT_ROOT = Path(__file__).parents[1]


def test_skill_manifest_declares_all_external_agent_domains() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["version"] == "0.3.2"
    assert manifest["agent_definitions"] == ["agents/openai.yaml"]
    for name in manifest["domains"]:
        assert (ROOT / "domains" / f"{name}.md").is_file()
    # 反向同样要查：域文档存在而 manifest 漏登记时也必须变红，
    # 否则合冲突漏掉一个域（如 2026-08-12 的 reference）不会被发现。
    documented_domains = {path.stem for path in (ROOT / "domains").glob("*.md")}
    assert documented_domains <= set(manifest["domains"])

def test_skill_keeps_human_review_and_idempotency_boundaries() -> None:
    text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    reference_domain = (ROOT / "domains" / "reference-test.md").read_text(encoding="utf-8")
    assert "先读后写" in text
    assert "人工审阅" in text
    assert "client_idempotency_key" in text
    assert "--all-shots --i-mean-it" in text
    assert "自动确认" in text
    assert "建测试" in reference_domain
    assert "result-attach" in reference_domain
    assert "result-list" in reference_domain
    assert "set-default" in reference_domain


def test_v030_matrix_covers_every_registered_command() -> None:
    matrix = (PROJECT_ROOT / "docs" / "v030-command-api-matrix.md").read_text(encoding="utf-8")
    domains = {
        "auth": auth_app,
        "project": project_app,
        "script": script_app,
        "asset": asset_app,
        "prep": prep_app,
        "generation": generation_app,
        "queue": queue_app,
        "reference": reference_app,
        "reference-test": reference_test_app,
        "review": review_app,
        "delivery": delivery_app,
    }
    for domain, app in domains.items():
        for command in app.registered_commands:
            assert command.name
            assert f"`{domain} {command.name}`" in matrix


def test_release_source_has_no_mock_success_switch() -> None:
    source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (PROJECT_ROOT / "src").rglob("*.py")
    )
    assert "SHORTDRAMA_USE_MOCK" not in source
    assert "mock_response" not in source


def test_zero_guidance_prerequisites_are_discoverable_from_skill() -> None:
    text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    assert "project episode-list" in text
    assert "delivery manifest" in text
    assert "delivery csv" in text


def test_reference_skill_separates_scene_prep_from_shot_control_packages() -> None:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    reference = (ROOT / "domains" / "reference.md").read_text(encoding="utf-8")
    assert "场级备料" in skill
    assert "镜级绑定" in skill
    assert "各改各的" in reference
    assert "不判断该不该补" in reference
