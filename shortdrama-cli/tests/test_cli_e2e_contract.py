from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from tests.support import plain
from shortdrama_cli.api.errors import ApiRequestError
from shortdrama_cli.main import app


PROJECT_ROOT = Path(__file__).resolve().parents[1]
runner = CliRunner()


def load_e2e_module(name: str, relative: str):
    file = PROJECT_ROOT / relative
    spec = importlib.util.spec_from_file_location(name, file)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("quote_id", "error_code"),
    [
        ("pending-quote", "GENERATION_QUOTE_UNCONFIRMED"),
        ("expired-quote", "GENERATION_QUOTE_EXPIRED"),
        ("mismatched-quote", "GENERATION_QUOTE_CONFLICT"),
    ],
)
def test_paid_submit_redlines_remain_nonzero_json(
    monkeypatch: pytest.MonkeyPatch,
    quote_id: str,
    error_code: str,
) -> None:
    class RejectingClient:
        def request(
            self,
            method: str,
            path: str,
            body: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            assert (method, path) == ("POST", "/generations")
            assert body and body["generation_quote_id"] == quote_id
            raise ApiRequestError(f"{error_code}: 报价状态不允许提交")

    monkeypatch.setattr(
        "shortdrama_cli.cli.common.build_business_client",
        lambda: RejectingClient(),
    )
    payload = {
        "media_kind": "video",
        "tier_id": "video-tier",
        "project_id": "11111111-1111-4111-8111-111111111111",
        "shot_id": "22222222-2222-4222-8222-222222222222",
        "parameters": {"duration_seconds": 5},
        "quantity": 1,
        "generation_quote_id": quote_id,
    }
    result = runner.invoke(app, [
        "generation",
        "submit",
        "--payload",
        json.dumps(payload),
        "--client-idempotency-key",
        "paid-redline-contract",
    ])

    assert result.exit_code == 1
    envelope = json.loads(result.output)
    assert envelope["status"] == "failed"
    assert error_code in envelope["error"]["message"]


def test_release_command_surface_has_no_yes_or_one_click_paid_path() -> None:
    root_help = runner.invoke(app, ["--help"])
    assert root_help.exit_code == 0
    assert "pipeline" not in root_help.output.lower()
    for domain, command in (
        ("generation", "estimate"),
        ("generation", "confirm"),
        ("generation", "submit"),
        ("generation", "batch-estimate"),
        ("generation", "batch-confirm"),
        ("generation", "batch-submit"),
        ("queue", "retry-estimate"),
        ("queue", "retry-confirm"),
        ("queue", "retry-submit"),
        ("reference-test", "create"),
        ("reference-test", "result-attach"),
        ("reference-test", "set-default"),
        ("generation", "default-update"),
    ):
        help_result = runner.invoke(app, [domain, command, "--help"])
        assert help_result.exit_code == 0
        assert "--yes" not in plain(help_result.output)

    release_source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (PROJECT_ROOT / "src" / "shortdrama_cli" / "cli").rglob("*.py")
    )
    assert "--yes" not in release_source


def test_product_e2e_runner_freezes_release_install_and_full_chain() -> None:
    source = (PROJECT_ROOT / "scripts/e2e/run_cli_product_e2e.py").read_text(encoding="utf-8")
    for needle in (
        "install-shortdrama-cli.sh",
        "doctor_before_login",
        "script_breakdown",
        "asset_register",
        "prep_send",
        "generation_estimate",
        "paid_redline_pending_quote",
        "paid_redline_mismatched_quote",
        "queue_status",
        "delivery_manifest",
        "uv run --frozen pytest -q",
    ):
        assert needle in source


def test_release_e2e_scripts_use_token_and_trusted_environment_instead_of_login_password() -> None:
    product = (PROJECT_ROOT / "scripts/e2e/run_cli_product_e2e.py").read_text(encoding="utf-8")
    skill = (PROJECT_ROOT / "scripts/e2e/run_skill_zero_guidance.py").read_text(encoding="utf-8")

    for source in (product, skill):
        assert "SHORTDRAMA_API_TOKEN" in source
        assert "SHORTDRAMA_ENV" in source
        assert "SHORTDRAMA_PASSWORD" not in source
        assert "SHORTDRAMA_API_BASE" not in source
    assert 'runner.cli("login"' not in product
    assert '"auth", "login"' not in skill


def test_product_e2e_marks_main_service_paid_redlines_deferred() -> None:
    source = (PROJECT_ROOT / "scripts/e2e/run_cli_product_e2e.py").read_text(encoding="utf-8")
    assert '"status": "deferred"' in source
    assert "run_chain(\n" in source
    assert "                False,\n" in source
    assert "--paid-redline-summary" not in source
    assert "GENERATION_QUOTES_TEST_DATABASE_URL" not in source


def test_zero_guidance_gate_is_three_clean_runs_with_median_and_majority() -> None:
    source = (PROJECT_ROOT / "scripts/e2e/run_skill_zero_guidance.py").read_text(encoding="utf-8")
    assert "range(1, 4)" in source
    assert "statistics.median" in source
    assert "len(successful) >= 2" in source
    assert "--ignore-user-config" in source
    assert "--ephemeral" in source
    assert "skills\" / \"shortdrama-cli" in source
    assert '["SKILL.md"]' in source
    assert "cli_command_events" in source
    assert "minimal_codex_env" in source
    assert "capture_output=True" in source
    assert "events.jsonl" not in source


def test_zero_guidance_evidence_requires_real_successful_cli_invocation(tmp_path: Path) -> None:
    load_e2e_module("run_cli_product_e2e", "scripts/e2e/run_cli_product_e2e.py")
    module = load_e2e_module("skill_zero_guidance", "scripts/e2e/run_skill_zero_guidance.py")
    ordinary_text = json.dumps({
        "type": "item.completed",
        "item": {"type": "agent_message", "text": "请执行 shortdrama project list"},
    })
    echoed_text = json.dumps({
        "type": "item.completed",
        "item": {
            "type": "command_execution",
            "command": "echo shortdrama project list",
            "exit_code": 0,
        },
    })
    actual_call = json.dumps({
        "type": "item.completed",
        "item": {
            "type": "command_execution",
            "command": "/bin/bash -lc 'shortdrama project list'",
            "exit_code": 0,
            "status": "completed",
        },
    })

    assert module.command_evidence(ordinary_text) == []
    assert module.command_evidence(echoed_text) == []
    assert module.command_evidence(actual_call)[0]["argv"] == ["shortdrama", "project", "list"]
    chained = json.dumps({
        "type": "item.completed",
        "item": {
            "type": "command_execution",
            "command": "/bin/bash -lc 'shortdrama project list\ntrue'",
            "exit_code": 0,
        },
    })
    assert module.command_evidence(chained) == []
    password_call = json.dumps({
        "type": "item.completed",
        "item": {
            "type": "command_execution",
            "command": "shortdrama auth login --password super-secret-value",
            "exit_code": 0,
        },
    })
    password_evidence = module.command_evidence(password_call)
    assert password_evidence[0]["argv"][-1] == "<redacted>"
    assert "super-secret-value" not in json.dumps(password_evidence)

    csv_file = tmp_path / "delivery.csv"
    csv_file.write_text(
        "project_id,episode_no,shot_code,generation_request_id\np1,1,S1,g1\n",
        encoding="utf-8",
    )
    module.validate_delivery_csv(csv_file)
