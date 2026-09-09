"""Acceptance tests for ADR 0001: trusted endpoint catalogue and login policy."""

from __future__ import annotations

import json
import stat
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest
from typer.testing import CliRunner

from tests.support import plain
from shortdrama_cli.main import app
from shortdrama_cli.server_api.endpoints import (
    TRUSTED_ENDPOINTS,
    TrustedEndpoint,
    _validate_catalogue,
)
from shortdrama_cli.storage.session import load_session, session_path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
runner = CliRunner()


class FakeTransport:
    """Transport seam that captures requests instead of touching the network."""

    instances: list["FakeTransport"] = []

    def __init__(self, timeout: float | None = None, debug: bool = False) -> None:
        self.calls: list[dict[str, Any]] = []
        FakeTransport.instances.append(self)

    def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body})
        return {"ok": True, "data": {"id": "ok"}}


def test_catalogue_lists_exactly_the_three_governed_environments() -> None:
    assert set(TRUSTED_ENDPOINTS) == {"prod", "test", "dev"}
    assert TRUSTED_ENDPOINTS["prod"].api_base == "http://101.126.6.208/"
    assert TRUSTED_ENDPOINTS["test"].api_base == "http://shortdrama-main-test.col.com/"
    dev_host = urlsplit(TRUSTED_ENDPOINTS["dev"].api_base).hostname
    assert dev_host in {"127.0.0.1", "localhost", "::1"}
    for entry in TRUSTED_ENDPOINTS.values():
        if urlsplit(entry.api_base).scheme == "http":
            assert entry.plaintext_http is True


def test_catalogue_refuses_unmarked_plaintext_http() -> None:
    with pytest.raises(ValueError, match="plaintext_http"):
        _validate_catalogue([TrustedEndpoint("rogue", "http://rogue.example/")])
    _validate_catalogue([TrustedEndpoint("tls", "https://tls.example/")])
    with pytest.raises(ValueError, match="scheme"):
        _validate_catalogue([TrustedEndpoint("odd", "ftp://odd.example/")])


@pytest.mark.parametrize("args", [
    [],
    ["doctor"],
    ["auth"],
    ["auth", "login"],
    ["auth", "whoami"],
    ["auth", "logout"],
    ["project"],
    ["project", "list"],
    ["script", "paste"],
    ["asset", "register"],
    ["prep", "send"],
    ["generation", "submit"],
    ["queue", "status"],
    ["review", "decide"],
    ["delivery", "download"],
])
def test_help_never_mentions_api_base_or_password_injection(args: list[str]) -> None:
    result = runner.invoke(app, [*args, "--help"])
    assert result.exit_code == 0
    assert "--api-base" not in result.output
    assert "--password" not in result.output
    assert "SHORTDRAMA_API_BASE" not in result.output
    assert "SHORTDRAMA_PASSWORD" not in result.output


def test_command_surface_source_has_no_api_base_or_password_override() -> None:
    source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (PROJECT_ROOT / "src" / "shortdrama_cli" / "cli").rglob("*.py")
    )
    assert "--api-base" not in source
    assert "SHORTDRAMA_API_BASE" not in source
    assert "--password" not in source
    assert "SHORTDRAMA_PASSWORD" not in source


def test_api_base_option_is_rejected_everywhere() -> None:
    result = runner.invoke(app, ["project", "list", "--api-base", "https://attacker.example"])
    assert result.exit_code == 2


def test_password_option_is_rejected() -> None:
    result = runner.invoke(app, [
        "auth",
        "login",
        "--username",
        "director",
        "--password",
        "super-secret-value",
    ])
    assert result.exit_code == 2


def test_env_option_rejects_urls_with_name_only_message() -> None:
    result = runner.invoke(app, [
        "auth",
        "login",
        "--username",
        "director",
        "--env",
        "https://attacker.example",
    ])
    assert result.exit_code == 2
    assert "只接受环境名" in result.output
    assert "URL" in result.output


def test_env_option_rejects_urls_in_english() -> None:
    result = runner.invoke(app, [
        "--lang",
        "en",
        "auth",
        "login",
        "--username",
        "director",
        "--env",
        "https://attacker.example",
    ])
    assert result.exit_code == 2
    assert "environment name" in result.output
    assert "URL" in result.output


def test_login_without_env_targets_prod_and_sticks(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    environments: list[str] = []

    class LoginClient:
        def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            return {"token": "prod-token", "expires_at": None, "user": {"id": "user-1"}}

    def fake_login_client(environment: str) -> LoginClient:
        environments.append(environment)
        return LoginClient()

    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path))
    monkeypatch.setattr("shortdrama_cli.cli.v030.build_login_client", fake_login_client)
    result = runner.invoke(app, ["auth", "login", "--username", "director"], input="pw\n")

    assert result.exit_code == 0, result.output
    assert environments == ["prod"]
    envelope = json.loads(result.stdout)
    assert envelope["data"]["environment"] == "prod"
    assert "密码" in result.stderr
    assert (tmp_path / "environment").read_text(encoding="utf-8") == "prod"
    assert stat.S_IMODE((tmp_path / "environment").stat().st_mode) == 0o600


def test_login_with_no_options_at_all_prompts_for_username_and_password(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The non-technical path: type `auth login`, answer two prompts, done."""

    seen: list[dict[str, Any] | None] = []

    class LoginClient:
        def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            seen.append(body)
            return {"token": "prod-token", "expires_at": None, "user": {"id": "user-1"}}

    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path))
    monkeypatch.setattr("shortdrama_cli.cli.v030.build_login_client", lambda environment: LoginClient())
    result = runner.invoke(app, ["auth", "login"], input="director\npw\n")

    assert result.exit_code == 0, result.output
    assert seen == [{"username": "director", "password": "pw"}]
    assert "账号" in result.stderr
    assert "密码" in result.stderr
    # CliRunner echoes typed input into stdout; the real terminal does not, so
    # read the envelope from the first brace instead of the whole stream.
    envelope = json.loads(result.stdout[result.stdout.index("{"):])
    assert envelope["data"]["environment"] == "prod"


def test_username_prompt_has_english_variant(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class LoginClient:
        def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            return {"token": "prod-token", "expires_at": None, "user": {"id": "user-1"}}

    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path))
    monkeypatch.setattr("shortdrama_cli.cli.v030.build_login_client", lambda environment: LoginClient())
    result = runner.invoke(app, ["--lang", "en", "auth", "login"], input="director\npw\n")

    assert result.exit_code == 0, result.output
    assert "Username" in result.stderr
    assert "Password" in result.stderr


def test_root_env_option_rejects_a_name_outside_the_catalogue() -> None:
    result = runner.invoke(app, ["--env", "staging", "project", "list"])

    assert result.exit_code == 2
    assert "--env" in plain(result.output)


def test_root_env_option_rejects_a_url() -> None:
    result = runner.invoke(app, ["--env", "https://evil.example", "project", "list"])

    assert result.exit_code == 2


def test_root_env_validator_reads_the_catalogue_not_a_second_hardcoded_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Adding a reviewed endpoint must not require a second edit in app.py."""

    from shortdrama_cli.cli import app as app_module

    patched = dict(TRUSTED_ENDPOINTS)
    patched["staging"] = TrustedEndpoint("staging", "https://staging.example/")
    monkeypatch.setattr(app_module, "TRUSTED_ENDPOINTS", patched)

    assert app_module._environment_name("staging") == "staging"


def test_site_root_error_has_english_variant() -> None:
    from shortdrama_cli.api.errors import ApiConfigurationError
    from shortdrama_cli.i18n import set_language
    from shortdrama_cli.server_api import BusinessServerClient

    set_language("en")
    try:
        with pytest.raises(ApiConfigurationError, match="no path"):
            BusinessServerClient("https://shortdrama.example/api/v1")
    finally:
        set_language("zh")
    with pytest.raises(ApiConfigurationError, match="站点根 URL"):
        BusinessServerClient("https://shortdrama.example/api/v1")


def test_plaintext_http_warning_hits_stderr_and_stdout_envelope_is_byte_identical(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SHORTDRAMA_API_TOKEN", "automation-token")
    monkeypatch.setattr("shortdrama_cli.cli.common.UrlLibTransport", FakeTransport)
    result = runner.invoke(app, ["project", "list"])

    assert result.exit_code == 0, result.output
    expected = json.dumps(
        {"status": "succeeded", "action": "project_list", "data": {"id": "ok"}},
        ensure_ascii=False,
        indent=2,
    ) + "\n"
    assert result.stdout == expected
    assert "明文 HTTP" in result.stderr
    assert "http://101.126.6.208/" in result.stderr
    call = FakeTransport.instances[-1].calls[-1]
    assert call["url"] == "http://101.126.6.208/api/v1/projects"
    assert call["headers"]["Authorization"] == "Bearer automation-token"


def test_plaintext_http_warning_has_english_variant(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SHORTDRAMA_API_TOKEN", "automation-token")
    monkeypatch.setattr("shortdrama_cli.cli.common.UrlLibTransport", FakeTransport)
    result = runner.invoke(app, ["--lang", "en", "project", "list"])

    assert result.exit_code == 0, result.output
    assert "plaintext HTTP" in result.stderr
    assert json.loads(result.stdout)["status"] == "succeeded"


def test_automation_token_uses_shortdrama_env_without_login(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("SHORTDRAMA_API_TOKEN", "automation-token")
    monkeypatch.setenv("SHORTDRAMA_ENV", "test")
    monkeypatch.setattr("shortdrama_cli.cli.common.UrlLibTransport", FakeTransport)

    result = runner.invoke(app, ["project", "list"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["status"] == "succeeded"
    assert FakeTransport.instances[-1].calls[-1]["url"] == "http://shortdrama-main-test.col.com/api/v1/projects"


def test_command_env_overrides_automation_env_and_sticky_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("SHORTDRAMA_API_TOKEN", "automation-token")
    monkeypatch.setenv("SHORTDRAMA_ENV", "test")
    (tmp_path / "environment").write_text("prod", encoding="utf-8")
    monkeypatch.setattr("shortdrama_cli.cli.common.UrlLibTransport", FakeTransport)

    result = runner.invoke(app, ["--env", "dev", "project", "list"])

    assert result.exit_code == 0, result.output
    assert FakeTransport.instances[-1].calls[-1]["url"] == "http://127.0.0.1:8000/api/v1/projects"


def test_stale_environment_pointer_returns_json_failure_envelope(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path))
    (tmp_path / "environment").write_text("staging", encoding="utf-8")
    result = runner.invoke(app, ["--lang", "zh", "doctor"])

    assert result.exit_code == 1
    envelope = json.loads(result.stdout)
    assert envelope["status"] == "failed"
    assert envelope["action"] == "doctor"
    assert envelope["error"]["code"] == "doctor_failed"
    assert "staging" in envelope["error"]["message"]
    assert "重新 auth login --env" in envelope["error"]["message"]


def test_sessions_are_isolated_per_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class LoginClient:
        def __init__(self, environment: str) -> None:
            self.environment = environment

        def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            return {"token": f"{self.environment}-token", "expires_at": None, "user": None}

    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path))
    monkeypatch.setattr(
        "shortdrama_cli.cli.v030.build_login_client",
        lambda environment: LoginClient(environment),
    )
    prod = runner.invoke(app, ["auth", "login", "--username", "director"], input="pw\n")
    assert prod.exit_code == 0, prod.output
    test = runner.invoke(app, ["auth", "login", "--username", "director", "--env", "test"], input="pw\n")
    assert test.exit_code == 0, test.output

    assert load_session("prod")["token"] == "prod-token"
    test_session_text = session_path("test").read_text(encoding="utf-8")
    assert "test-token" in test_session_text
    assert "prod-token" not in test_session_text
    assert "test-token" not in session_path("prod").read_text(encoding="utf-8")
    assert (tmp_path / "environment").read_text(encoding="utf-8") == "test"

    monkeypatch.delenv("SHORTDRAMA_API_TOKEN", raising=False)
    monkeypatch.setattr("shortdrama_cli.cli.common.UrlLibTransport", FakeTransport)
    whoami = runner.invoke(app, ["auth", "whoami"])
    assert whoami.exit_code == 0, whoami.output
    call = FakeTransport.instances[-1].calls[-1]
    assert call["url"].startswith("http://shortdrama-main-test.col.com/")
    assert call["headers"]["Authorization"] == "Bearer test-token"


def test_logout_removes_only_the_active_environment_session(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class LoginClient:
        def __init__(self, environment: str) -> None:
            self.environment = environment

        def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            return {"token": f"{self.environment}-token", "expires_at": None, "user": None}

    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path))
    monkeypatch.setattr(
        "shortdrama_cli.cli.v030.build_login_client",
        lambda environment: LoginClient(environment),
    )
    assert runner.invoke(app, ["auth", "login", "--username", "director"], input="pw\n").exit_code == 0
    assert runner.invoke(app, ["auth", "login", "--username", "director", "--env", "test"], input="pw\n").exit_code == 0

    monkeypatch.delenv("SHORTDRAMA_API_TOKEN", raising=False)
    monkeypatch.setattr("shortdrama_cli.cli.common.UrlLibTransport", FakeTransport)
    logout = runner.invoke(app, ["auth", "logout"])
    assert logout.exit_code == 0, logout.output

    assert not session_path("test").exists()
    assert not (tmp_path / "environment").exists()
    assert load_session("prod")["token"] == "prod-token"
