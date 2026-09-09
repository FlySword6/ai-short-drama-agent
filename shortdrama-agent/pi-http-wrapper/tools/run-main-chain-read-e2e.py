#!/usr/bin/env python3
"""Run the P1 capabilities + project-list chain without printing credentials."""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from shortdrama_cli.server_api.client import BusinessServerClient

from pi_http_wrapper.contract import ToolCall
from pi_http_wrapper.main_chain import CLI_CLIENT_COMMIT, MainChainAdapter
from pi_http_wrapper.trusted_endpoint import resolve_trusted_environment


def main() -> int:
    started_at = datetime.now(UTC)
    environment = os.environ.get("SHORTDRAMA_ENV", "").strip() or "dev"
    summary: dict[str, Any] = {
        "status": "failed",
        "environment": environment,
        "target": None,
        "cli_client_commit": CLI_CLIENT_COMMIT,
        "started_at": started_at.isoformat(),
        "checks": [],
        "temporary_credential_revoked": None,
        "temporary_human_session_revoked": None,
    }
    human_client: BusinessServerClient | None = None
    human_session_issued = False
    credential_id: str | None = None
    try:
        api_base = resolve_trusted_environment(environment).api_base
        summary["target"] = api_base
        values = _effective_values()
        agent_token = values.get("SHORTDRAMA_AGENT_TOKEN")
        if agent_token:
            summary["credential_mode"] = "environment_agent_credential"
        else:
            username = values.get("SHORTDRAMA_E2E_USERNAME") or values.get("DEV_ADMIN_USERNAME") or "admin"
            password = values.get("SHORTDRAMA_E2E_PASSWORD") or values.get("DEV_ADMIN_PASSWORD")
            if not password:
                raise RuntimeError(
                    "缺少 SHORTDRAMA_AGENT_TOKEN，且没有可用于临时签发的 E2E 管理员密码。",
                )
            login = BusinessServerClient(api_base).request(
                "POST",
                "/auth/cli/login",
                {"username": username, "password": password},
            )
            human_token = _required_text(login, "token")
            human_client = BusinessServerClient(api_base, token=human_token)
            human_session_issued = True
            issued = human_client.request(
                "POST",
                "/auth/agent-credentials",
                {
                    "agent_type": "shortdrama-agent",
                    "label": "P1 本地只读 E2E",
                },
            )
            if issued.get("source") != "agent":
                raise RuntimeError("Main 没有把临时凭据标记为 agent，停止 E2E。")
            credential_id = _required_text(issued, "credential_id")
            agent_token = _required_text(issued, "token")
            summary["credential_mode"] = "temporary_agent_credential"
            summary["credential_source_verified"] = True

        adapter = MainChainAdapter.for_environment(environment, agent_token)
        capabilities = _timed_tool(
            adapter,
            "shortdrama_capabilities",
            {},
            summary["checks"],
        )
        projects = _timed_tool(
            adapter,
            "shortdrama_project_list",
            {},
            summary["checks"],
        )
        summary["capabilities_observed"] = {
            "platform_role": capabilities.get("platform_role", "unknown"),
            "project_scope_count": _list_count(capabilities.get("projects")),
            "permission_count": _list_count(capabilities.get("permissions")),
        }
        summary["project_list_observed"] = {
            "count": _response_count(projects),
        }
        summary["status"] = "passed"
    except Exception as error:  # noqa: BLE001 - the report must close and revoke on every failure
        summary["error"] = {
            "type": error.__class__.__name__,
            "message": _safe_error_message(error),
        }
    finally:
        if human_client is not None and credential_id is not None:
            try:
                revoked = human_client.request(
                    "DELETE",
                    f"/auth/agent-credentials/{credential_id}",
                )
                summary["temporary_credential_revoked"] = revoked.get("revoked") is True
                if summary["temporary_credential_revoked"] is not True:
                    summary["status"] = "failed"
            except Exception as error:  # noqa: BLE001
                summary["temporary_credential_revoked"] = False
                summary["revocation_error"] = {"type": error.__class__.__name__}
                summary["status"] = "failed"
        if human_client is not None and human_session_issued:
            try:
                logged_out = human_client.request("POST", "/auth/logout")
                summary["temporary_human_session_revoked"] = logged_out.get("logged_out") is True
                if summary["temporary_human_session_revoked"] is not True:
                    summary["status"] = "failed"
            except Exception as error:  # noqa: BLE001
                summary["temporary_human_session_revoked"] = False
                summary["logout_error"] = {"type": error.__class__.__name__}
                summary["status"] = "failed"
        summary["ended_at"] = datetime.now(UTC).isoformat()
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["status"] == "passed" else 1


def _effective_values() -> dict[str, str]:
    values: dict[str, str] = {}
    env_file = os.environ.get("SHORTDRAMA_E2E_ENV_FILE")
    if env_file:
        for line in Path(env_file).read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    for key in (
        "SHORTDRAMA_AGENT_TOKEN",
        "SHORTDRAMA_E2E_USERNAME",
        "SHORTDRAMA_E2E_PASSWORD",
        "DEV_ADMIN_USERNAME",
        "DEV_ADMIN_PASSWORD",
    ):
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values


def _timed_tool(
    adapter: MainChainAdapter,
    name: str,
    arguments: dict[str, Any],
    checks: list[dict[str, Any]],
) -> dict[str, Any]:
    started = time.monotonic()
    result = adapter.execute(ToolCall(id=f"e2e-{name}", name=name, arguments=arguments))
    duration_ms = round((time.monotonic() - started) * 1000)
    check = {
        "name": name,
        "status": "failed" if result.is_error else "passed",
        "duration_ms": duration_ms,
        "request_id": result.content.get("receipt", {}).get("request_id", "unknown"),
    }
    checks.append(check)
    if result.is_error:
        error = result.content.get("error", {})
        raise RuntimeError(
            f"{name} 失败：{error.get('code', 'unknown')} "
            f"{error.get('message', 'Main 未返回业务说明')}",
        )
    data = result.content.get("data")
    if not isinstance(data, dict):
        raise RuntimeError(f"{name} 没有返回对象数据。")
    return data


def _required_text(value: dict[str, Any], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise RuntimeError(f"Main 响应缺少 {key}，不能继续。")
    return item


def _response_count(value: dict[str, Any]) -> int | str:
    count = value.get("count")
    if isinstance(count, int) and not isinstance(count, bool):
        return count
    items = value.get("items")
    return len(items) if isinstance(items, list) else "unknown"


def _list_count(value: Any) -> int | str:
    return len(value) if isinstance(value, list) else "unknown"


def _safe_error_message(error: Exception) -> str:
    message = " ".join(str(error).split())
    for key in ("SHORTDRAMA_AGENT_TOKEN", "SHORTDRAMA_E2E_PASSWORD", "DEV_ADMIN_PASSWORD"):
        secret = os.environ.get(key)
        if secret:
            message = message.replace(secret, "[redacted]")
    return message[:500] if message else error.__class__.__name__


if __name__ == "__main__":
    sys.exit(main())
