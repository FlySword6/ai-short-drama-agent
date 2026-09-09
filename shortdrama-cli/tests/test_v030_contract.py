from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

import pytest
import typer
from typer.testing import CliRunner

from tests.support import plain
from shortdrama_cli.api.errors import ApiConfigurationError, ApiRequestError
from shortdrama_cli.cli.app import _doctor_data
from shortdrama_cli.cli.v030._helpers import _path
from shortdrama_cli.i18n import set_language
from shortdrama_cli.main import app
from shortdrama_cli.server_api.client import BusinessServerClient


runner = CliRunner()


class Transport:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.calls.append({
            "method": method,
            "url": url,
            "headers": headers,
            "body": body,
        })
        return {"ok": True, "data": {"id": "ok"}}

    def upload_file(
        self,
        url: str,
        headers: dict[str, str],
        filename: str,
        content: bytes,
        content_type: str,
        fields: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        self.calls.append({
            "method": "POST",
            "url": url,
            "headers": headers,
            "filename": filename,
            "content_type": content_type,
            "fields": fields,
        })
        return {"ok": True, "data": {"id": "task-1"}}

    def download(
        self,
        url: str,
        headers: dict[str, str],
    ) -> tuple[bytes, dict[str, str]]:
        self.calls.append({"method": "GET", "url": url, "headers": headers})
        return b"artifact", {"content-type": "application/octet-stream"}


def mock_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    class ContractClient:
        def request(
            self,
            method: str,
            path: str,
            body: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            return {"method": method, "path": path, "body": body}

        def upload(
            self,
            path: str,
            _filename: str,
            _content: bytes,
            _content_type: str,
            fields: dict[str, str],
        ) -> dict[str, Any]:
            return {"method": "POST", "path": path, "fields": fields}

    client = ContractClient()
    monkeypatch.setattr("shortdrama_cli.cli.common.build_business_client", lambda: client)
    monkeypatch.setattr("shortdrama_cli.cli.v030.build_business_client", lambda: client)
    monkeypatch.setattr("shortdrama_cli.output.formatter.redact_output", lambda value: value)


def mock_data(result: Any) -> dict[str, Any]:
    assert result.exit_code == 0, result.output
    return json.loads(result.output)["data"]


def test_path_encodes_each_segment_and_builds_query() -> None:
    assert _path(
        "projects",
        "id/with% space?#",
        "reference-tests",
        query={"q": "值 /%?#", "page": 2, "ignored": None},
    ) == (
        "/projects/id%2Fwith%25%20space%3F%23/reference-tests"
        "?q=%E5%80%BC+%2F%25%3F%23&page=2"
    )
    assert _path("already/combined") == "/already%2Fcombined"


@pytest.mark.parametrize("segments", [(), ("",), ("projects", "")])
def test_path_rejects_empty_segments_in_chinese_and_english(
    segments: tuple[str, ...],
) -> None:
    with pytest.raises(typer.BadParameter, match="API 路径段不能为空"):
        _path(*segments)

    set_language("en")
    try:
        with pytest.raises(typer.BadParameter, match="must not be empty"):
            _path(*segments)
    finally:
        set_language("zh")


def test_dynamic_ids_are_encoded_at_transport_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport = Transport()
    client = BusinessServerClient(
        "https://shortdrama.test",
        token="secret",
        transport=transport,
    )
    monkeypatch.setattr("shortdrama_cli.cli.common.build_business_client", lambda: client)
    identifier = "id/with% space?#"
    encoded = "id%2Fwith%25%20space%3F%23"

    project = runner.invoke(app, [
        "project", "get", "--project-id", identifier,
    ])
    reference_result = runner.invoke(app, [
        "reference-test", "result-list",
        "--project-id", identifier,
        "--reference-test-id", identifier,
        "--page", "2",
    ])

    assert project.exit_code == 0, project.output
    assert reference_result.exit_code == 0, reference_result.output
    assert [call["url"] for call in transport.calls] == [
        f"https://shortdrama.test/api/v1/projects/{encoded}",
        (
            f"https://shortdrama.test/api/v1/projects/{encoded}"
            f"/reference-tests/{encoded}/results?page=2"
        ),
    ]


def test_download_path_encodes_dynamic_media_id_at_transport_boundary(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    transport = Transport()
    client = BusinessServerClient(
        "https://shortdrama.test",
        token="secret",
        transport=transport,
    )
    monkeypatch.setattr(
        "shortdrama_cli.cli.v030.build_business_client",
        lambda: client,
    )
    result = runner.invoke(app, [
        "delivery", "download",
        "--media-id", "media/50% ?#",
        "--output", str(tmp_path / "delivery.mp4"),
    ])

    assert result.exit_code == 0, result.output
    assert transport.calls[0]["url"] == (
        "https://shortdrama.test/api/v1/media/media%2F50%25%20%3F%23/download"
    )


def test_client_uses_site_root_v1_envelope_cli_header_and_bearer_auth() -> None:
    transport = Transport()
    client = BusinessServerClient("https://shortdrama.test", token="secret", transport=transport)

    assert client.request("GET", "/projects") == {"id": "ok"}
    assert transport.calls == [{
        "method": "GET",
        "url": "https://shortdrama.test/api/v1/projects",
        "headers": {
            "Accept": "application/json",
            "X-Shortdrama-Client": "cli",
            "Authorization": "Bearer secret",
        },
        "body": None,
    }]


def test_client_uses_cli_login_contract_without_bearer_auth() -> None:
    transport = Transport()
    client = BusinessServerClient("https://shortdrama.test", transport=transport)

    assert client.request("POST", "/auth/cli/login", {"username": "director", "password": "not-a-real-secret"}) == {"id": "ok"}
    assert transport.calls == [{
        "method": "POST",
        "url": "https://shortdrama.test/api/v1/auth/cli/login",
        "headers": {
            "Accept": "application/json",
            "X-Shortdrama-Client": "cli",
        },
        "body": {"username": "director", "password": "not-a-real-secret"},
    }]


def test_client_rejects_non_root_url_and_non_frozen_envelope() -> None:
    with pytest.raises(ApiConfigurationError, match="站点根 URL"):
        BusinessServerClient("https://shortdrama.test/api/v1")

    transport = Transport()
    transport.request = lambda *_args, **_kwargs: {"success": True, "data": {}}  # type: ignore[method-assign]
    with pytest.raises(ApiRequestError, match="ok envelope"):
        BusinessServerClient("https://shortdrama.test", transport=transport).request("GET", "/projects")


def test_login_stores_token_privately_without_printing_credentials(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import stat

    from shortdrama_cli.storage.session import session_path

    class LoginClient:
        def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            assert (method, path) == ("POST", "/auth/cli/login")
            assert body == {"username": "director", "password": "not-a-real-secret"}
            return {
                "token": "example-token",
                "expires_at": "2026-08-03T00:00:00.000Z",
                "user": {"id": "user-1", "display_name": "导演"},
            }

    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path))
    monkeypatch.setattr("shortdrama_cli.cli.v030.build_login_client", lambda _env: LoginClient())
    result = runner.invoke(app, [
        "auth",
        "login",
        "--username",
        "director",
    ], input="not-a-real-secret\n")

    assert result.exit_code == 0, result.output
    assert "not-a-real-secret" not in result.output
    assert "example-token" not in result.output
    session_file = session_path("prod")
    session = json.loads(session_file.read_text(encoding="utf-8"))
    assert session["token"] == "example-token"
    assert session["env"] == "prod"
    assert "api_base" not in session
    assert stat.S_IMODE(session_file.stat().st_mode) == 0o600
    assert (tmp_path / "environment").read_text(encoding="utf-8") == "prod"


def test_login_ignores_shortdrama_password_and_reads_password_interactively(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class LoginClient:
        def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            assert body == {"username": "director", "password": "sample"}
            return {"token": "test-token", "expires_at": None, "user": {"id": "user-1"}}

    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("SHORTDRAMA_PASSWORD", "environment-password")
    monkeypatch.setattr("shortdrama_cli.cli.v030.build_login_client", lambda _env: LoginClient())
    result = runner.invoke(app, [
        "auth",
        "login",
        "--username",
        "director",
    ], input="sample\n")

    assert result.exit_code == 0, result.output
    assert "environment-password" not in result.output
    assert "sample" not in result.output
    assert "test-token" not in result.output


def test_doctor_checks_release_skill_and_optional_authenticated_api(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    skill_dir = tmp_path / "skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text("# test", encoding="utf-8")
    monkeypatch.setenv("SHORTDRAMA_SKILL_DIR", str(skill_dir))
    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path / "config"))

    anonymous = _doctor_data(False)
    assert anonymous["version"] == "0.3.2"
    assert anonymous["environment"] == "prod"
    assert anonymous["api_base"] == "http://101.126.6.208/"
    assert anonymous["skill_installed"] is True
    assert anonymous["authenticated"] is False

    with pytest.raises(ApiConfigurationError, match="还没有登录"):
        _doctor_data(True)

    class MeClient:
        def request(self, method: str, path: str) -> dict[str, Any]:
            assert (method, path) == ("GET", "/auth/me")
            return {"id": "user-1", "display_name": "导演"}

    monkeypatch.setenv("SHORTDRAMA_API_TOKEN", "example-token")
    monkeypatch.setattr("shortdrama_cli.cli.app.build_business_client", lambda: MeClient())
    authenticated = _doctor_data(True)
    assert authenticated["authenticated"] is True
    assert authenticated["user"] == {"id": "user-1", "display_name": "导演"}


def test_production_without_api_fails_closed_as_json(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path))
    monkeypatch.delenv("SHORTDRAMA_API_TOKEN", raising=False)
    result = runner.invoke(app, ["project", "list"])

    assert result.exit_code == 1
    body = json.loads(result.stdout)
    assert body["status"] == "failed"
    assert body["error"]["code"] == "api_unavailable"


def test_all_frozen_domains_are_registered_without_one_click_pipeline() -> None:
    root = runner.invoke(app, ["--help"])
    assert root.exit_code == 0
    for command in ("auth", "project", "script", "asset", "prep", "generation", "queue", "reference-test", "delivery"):
        assert runner.invoke(app, [command, "--help"]).exit_code == 0
    assert "pipeline" not in root.output
    assert "create" not in root.output




def test_reference_control_commands_match_frozen_api_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)

    lanes = mock_data(runner.invoke(app, ["reference", "lanes"]))
    assert lanes == {"method": "GET", "path": "/vocabulary/reference-lanes", "body": None}

    control_package = mock_data(runner.invoke(app, ["reference", "get", "--shot-id", "shot-1"]))
    assert control_package == {
        "method": "GET",
        "path": "/shots/shot-1/control-package",
        "body": None,
    }

    added = mock_data(runner.invoke(app, [
        "reference", "add", "--shot-id", "shot-1", "--lane", "character",
        "--asset-media-id", "media-1", "--note", "主视角", "--client-idempotency-key", "key-1",
    ]))
    assert added == {
        "method": "POST",
        "path": "/shots/shot-1/control-package/refs",
        "body": {
            "lane": "character",
            "asset_media_id": "media-1",
            "note": "主视角",
            "client_idempotency_key": "key-1",
        },
    }

    # 服务端 refBody 的 superRefine 要求两者恰好给一个；本地先拦，别让它变成 400。
    both = runner.invoke(app, [
        "reference", "add", "--shot-id", "shot-1", "--lane", "character",
        "--asset-media-id", "media-1", "--media-result-id", "result-1",
    ])
    assert both.exit_code == 2
    neither = runner.invoke(app, ["reference", "add", "--shot-id", "shot-1", "--lane", "character"])
    assert neither.exit_code == 2

    # 服务端按 ref 删，不按镜头删。
    removed = mock_data(runner.invoke(app, ["reference", "remove", "--ref-id", "ref-1"]))
    assert removed == {
        "method": "DELETE",
        "path": "/control-package-refs/ref-1",
        "body": None,
    }

    ready = mock_data(runner.invoke(app, ["reference", "ready", "--shot-id", "shot-1"]))
    assert ready == {
        "method": "PUT",
        "path": "/shots/shot-1/control-package/ready",
        "body": {"ready": True},
    }
    cancelled = mock_data(runner.invoke(app, ["reference", "ready", "--shot-id", "shot-1", "--cancel"]))
    assert cancelled["body"] == {"ready": False}


def test_reference_missing_reports_only_catalog_minus_bound_lanes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ReferenceClient:
        def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            assert method == "GET"
            assert body is None
            if path == "/vocabulary/reference-lanes":
                return {"lanes": [{"id": "character"}, {"id": "scene"}, {"id": "lighting"}]}
            assert path == "/shots/shot-1/control-package"
            # 服务端把已知栏全部预填成空列表，只有非空才算占上。
            return {"lanes": {"scene": [{"id": "ref-1"}], "character": [], "prop": []}}

    monkeypatch.setattr("shortdrama_cli.cli.v030.build_business_client", lambda: ReferenceClient())

    data = mock_data(runner.invoke(app, ["reference", "missing", "--shot-id", "shot-1"]))
    assert data == {"shot_id": "shot-1", "missing_lanes": ["character", "lighting"]}


def test_reference_missing_uses_the_two_read_contracts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ReferenceClient:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str, dict[str, Any] | None]] = []

        def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            self.calls.append((method, path, body))
            return {"lanes": []} if path == "/vocabulary/reference-lanes" else {"lanes": {}}

    client = ReferenceClient()
    monkeypatch.setattr("shortdrama_cli.cli.v030.build_business_client", lambda: client)

    assert mock_data(runner.invoke(app, ["reference", "missing", "--shot-id", "shot-1"])) == {
        "shot_id": "shot-1", "missing_lanes": [],
    }
    assert client.calls == [
        ("GET", "/vocabulary/reference-lanes", None),
        ("GET", "/shots/shot-1/control-package", None),
    ]


@pytest.mark.parametrize(("catalog", "control_package", "expected"), [
    ({"lanes": []}, {"lanes": {"character": [{"id": "ref-1"}]}}, []),
    ({"lanes": [{"id": "character"}]}, {"lanes": {}}, ["character"]),
    # 预填的空列表不算占用——这一条是 2026-08-12 审查抓到的真缺陷。
    ({"lanes": [{"id": "character"}]}, {"lanes": {"character": []}}, ["character"]),
    # 停用的参考栏不报缺失：词表接口不过滤，但往停用栏加参考服务端必拒。
    ({"lanes": [{"id": "character"}, {"id": "retired", "active": False}]}, {"lanes": {}}, ["character"]),
])
def test_reference_missing_handles_empty_catalog_and_control_package(
    catalog: dict[str, Any],
    control_package: dict[str, Any],
    expected: list[str],
) -> None:
    from shortdrama_cli.cli.v030.reference import _missing_lanes

    assert _missing_lanes(catalog, control_package) == expected


def test_reference_missing_has_no_editorial_requirement_policy() -> None:
    """参考栏该不该补由编导决定，模块的**标识符**不得自带「必须/建议」语义。

    只检查 AST 里的名字，不扫全文——在 docstring 或注释里提到
    required/recommended 来解释边界不该造成误红（#51 复审项）。
    """
    source_path = Path(__file__).parents[1] / "src" / "shortdrama_cli" / "cli" / "v030" / "reference.py"
    program = ast.parse(source_path.read_text(encoding="utf-8"))
    names: list[str] = []
    for node in ast.walk(program):
        if isinstance(node, ast.FunctionDef):
            names.append(node.name)
        elif isinstance(node, ast.Attribute):
            names.append(node.attr)
        elif isinstance(node, ast.Name):
            names.append(node.id)
    assert not any(
        "required" in name or "recommended" in name
        for name in names
    )

@pytest.mark.parametrize(("args", "method", "path"), [
    (["project", "list"], "GET", "/projects"),
    (["project", "get", "--project-id", "p"], "GET", "/projects/p"),
    (["project", "episode-list", "--project-id", "p"], "GET", "/projects/p/episodes"),
    (["project", "episode-get", "--episode-id", "e"], "GET", "/episodes/e"),
    (["project", "scene-list", "--episode-id", "e"], "GET", "/episodes/e/scenes"),
    (["project", "shot-list", "--episode-id", "e"], "GET", "/episodes/e/shots"),
    (["project", "shot-get", "--shot-id", "s"], "GET", "/shots/s"),
    (["project", "shot-media-list", "--shot-id", "s"], "GET", "/shots/s/media"),
    (["project", "episode-production-status", "--episode-id", "e"], "GET", "/episodes/e/production-status"),
    (["project", "episode-playback", "--episode-id", "e"], "GET", "/episodes/e/playback"),
    (["script", "versions", "--episode-id", "e"], "GET", "/episodes/e/script-versions"),
    (["script", "status", "--run-id", "r"], "GET", "/script-breakdowns/r"),
    (["asset", "get", "--asset-id", "a"], "GET", "/assets/a"),
    (["asset", "registration-schema"], "GET", "/assets/registration-schema"),
    (["asset", "register-status", "--task-id", "t"], "GET", "/asset-upload-tasks/t"),
    (["asset", "project-list", "--project-id", "p"], "GET", "/projects/p/assets"),
    (["prep", "list", "--scene-id", "s"], "GET", "/scenes/s/prep-list"),
    (["generation", "models"], "GET", "/generation-models"),
    (
        ["generation", "capability-tiers", "--media-type", "video"],
        "GET",
        "/generation/capability-tiers?media_type=video",
    ),
    (["queue", "list"], "GET", "/generations/in-flight"),
    (["queue", "status", "--generation-id", "g"], "GET", "/generations/g"),
    (
        ["delivery", "manifest", "--episode-id", "e"],
        "GET",
        "/episodes/e/deliverables?partial=false",
    ),
    (["delivery", "history", "--episode-id", "e"], "GET", "/episodes/e/deliveries"),
    (["reference-test", "list", "--project-id", "p"], "GET", "/projects/p/reference-tests"),
    (["reference-test", "get", "--project-id", "p", "--reference-test-id", "r"], "GET", "/projects/p/reference-tests/r"),
    (["reference-test", "result-list", "--project-id", "p", "--reference-test-id", "r"], "GET", "/projects/p/reference-tests/r/results"),
    (
        ["reference-test", "result-list", "--project-id", "p", "--reference-test-id", "r", "--page", "2", "--page-size", "50"],
        "GET",
        "/projects/p/reference-tests/r/results?page=2&page_size=50",
    ),
    (["reference-test", "result-stream", "--project-id", "p"], "GET", "/projects/p/reference-test-results"),
    (
        ["reference-test", "result-stream", "--project-id", "p", "--media-kind", "image", "--page", "2", "--page-size", "50"],
        "GET",
        "/projects/p/reference-test-results?page=2&page_size=50&media_kind=image",
    ),
    (["generation", "default-get", "--project-id", "p"], "GET", "/projects/p/generation-defaults"),
    (["project", "member-list", "--project-id", "p"], "GET", "/projects/p/members"),
    (
        ["project", "member-directory", "--query", "导演 甲"],
        "GET",
        "/users/directory?q=%E5%AF%BC%E6%BC%94+%E7%94%B2",
    ),
    (
        ["project", "costs", "--project-id", "p", "--group-by", "member", "--page", "2"],
        "GET",
        "/projects/p/costs?group_by=member&page=2",
    ),
    (
        ["project", "costs", "--project-id", "p", "--group-by", "day", "--from", "2026-08-01", "--to", "2026-08-15"],
        "GET",
        "/projects/p/costs?group_by=day&from=2026-08-01&to=2026-08-15",
    ),
    (
        ["project", "consumption-records", "--project-id", "p", "--task-type", "video"],
        "GET",
        "/projects/p/consumption/records?task_type=video",
    ),
    (
        ["project", "consumption-records", "--project-id", "p", "--from", "2026-08-01", "--to", "2026-08-15"],
        "GET",
        "/projects/p/consumption/records?from=2026-08-01&to=2026-08-15",
    ),
    (["generation", "project-list", "--project-id", "p"], "GET", "/projects/p/generations"),
    (
        ["generation", "failed-list", "--page", "2", "--page-size", "10"],
        "GET",
        "/generations/failed?page=2&page_size=10",
    ),
])
def test_read_command_method_and_path_contract(

    monkeypatch: pytest.MonkeyPatch,
    args: list[str],
    method: str,
    path: str,
) -> None:
    mock_cli(monkeypatch)
    data = mock_data(runner.invoke(app, args))
    assert data == {"method": method, "path": path, "body": None}


def test_project_member_write_command_contracts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)

    added = mock_data(runner.invoke(app, [
        "project", "member-add", "--project-id", "project-1", "--user-id", "user-1", "--role", "editor",
    ]))
    assert added == {
        "method": "POST",
        "path": "/projects/project-1/members",
        "body": {"user_id": "user-1", "role": "editor"},
    }

    updated = mock_data(runner.invoke(app, [
        "project", "member-update", "--project-id", "project-1", "--user-id", "user-1", "--role", "viewer",
    ]))
    assert updated == {
        "method": "PATCH",
        "path": "/projects/project-1/members/user-1",
        "body": {"role": "viewer"},
    }


def test_project_inventory_removals_require_explicit_human_confirmation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)

    missing_member_confirmation = runner.invoke(app, [
        "project", "member-remove", "--project-id", "project-1", "--user-id", "user-1",
    ])
    assert missing_member_confirmation.exit_code == 2
    assert "移除项目成员会改变生产事实" in plain(missing_member_confirmation.output)

    removed_member = mock_data(runner.invoke(app, [
        "project", "member-remove", "--project-id", "project-1", "--user-id", "user-1", "--i-mean-it",
    ]))
    assert removed_member == {
        "method": "DELETE",
        "path": "/projects/project-1/members/user-1",
        "body": None,
    }

    missing_asset_confirmation = runner.invoke(app, [
        "asset", "remove-from-project", "--project-id", "project-1", "--ref-id", "ref-1",
    ])
    assert missing_asset_confirmation.exit_code == 2
    assert "解绑项目资产会改变生产事实" in plain(missing_asset_confirmation.output)

    removed_asset = mock_data(runner.invoke(app, [
        "asset", "remove-from-project", "--project-id", "project-1", "--ref-id", "ref-1", "--i-mean-it",
    ]))
    assert removed_asset == {
        "method": "DELETE",
        "path": "/projects/project-1/assets/ref-1",
        "body": None,
    }


def test_project_inventory_commands_are_frozen_in_matrix_and_domain_docs() -> None:
    root = Path(__file__).parents[1]
    matrix = (root / "docs" / "v030-command-api-matrix.md").read_text(encoding="utf-8")
    for command in (
        "project member-directory",
        "project member-list",
        "project member-add",
        "project member-update",
        "project member-remove",
        "project costs",
        "project consumption-records",
        "generation project-list",
        "generation failed-list",
        "asset remove-from-project",
    ):
        assert f"`{command}`" in matrix

    domain = (root / "skills" / "shortdrama-cli" / "domains" / "project.md").read_text(encoding="utf-8")
    assert "抽卡师是业务称谓，不是系统角色" in domain
    assert "project member-directory --query <至少两个字符>" in domain


def test_asset_search_uses_browse_v1_query_and_explicit_page_size(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)
    data = mock_data(runner.invoke(app, [
        "asset",
        "search",
        "--query",
        "角色 甲",
        "--scope",
        "common",
    ]))
    assert data["path"] == "/assets?q=%E8%A7%92%E8%89%B2+%E7%94%B2&scope=common&page_size=24"


def test_project_asset_search_requires_and_forwards_project_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)
    missing = runner.invoke(app, ["asset", "search", "--scope", "project"])
    assert missing.exit_code == 2
    data = mock_data(runner.invoke(app, [
        "asset",
        "search",
        "--scope",
        "project",
        "--project-id",
        "project-1",
    ]))
    assert data["path"] == "/assets?scope=project&project_id=project-1&page_size=24"


def test_write_commands_match_existing_api_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)

    project = mock_data(runner.invoke(app, [
        "project", "create", "--name", "项目甲", "--description", "说明",
    ]))
    assert project["path"] == "/projects"
    assert project["body"] == {"name": "项目甲", "description": "说明"}

    episode = mock_data(runner.invoke(app, [
        "project", "episode-create", "--project-id", "p", "--episode-no", "2", "--name", "第二集",
    ]))
    assert episode["body"] == {"episode_no": 2, "name": "第二集"}

    pasted = mock_data(runner.invoke(app, [
        "script",
        "paste",
        "--episode-id",
        "e",
        "--text",
        "剧本正文",
        "--client-idempotency-key",
        "script-key-0001",
    ]))
    assert pasted["body"] == {
        "script_text": "剧本正文",
        "client_idempotency_key": "script-key-0001",
    }

    breakdown = mock_data(runner.invoke(app, [
        "script",
        "breakdown",
        "--episode-id",
        "e",
        "--script-version-id",
        "v",
        "--target-duration-sec",
        "90",
        "--client-idempotency-key",
        "breakdown-key-01",
    ]))
    assert breakdown["body"] == {
        "script_version_id": "v",
        "target_duration_sec": 90,
        "client_idempotency_key": "breakdown-key-01",
    }

    project_asset = mock_data(runner.invoke(app, [
        "asset", "add-to-project", "--project-id", "p", "--asset-id", "a",
    ]))
    assert project_asset["body"] == {"asset_entity_id": "a"}


def test_shot_editing_commands_match_frozen_api_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)

    updated = mock_data(runner.invoke(app, [
        "project", "shot-update", "--shot-id", "shot-1",
        "--framing", "特写", "--camera-movement", "缓慢推进",
        "--duration", "5", "--visual-prompt", "雨夜巷口，电影感",
    ]))
    assert updated == {
        "method": "PATCH",
        "path": "/shots/shot-1",
        "body": {
            "framing": "特写",
            "camera_movement": "缓慢推进",
            "duration": 5,
            "visual_prompt": "雨夜巷口，电影感",
        },
    }

    no_fields = runner.invoke(app, ["project", "shot-update", "--shot-id", "shot-1"])
    assert no_fields.exit_code == 2
    assert "至少提供一个可更新字段" in plain(no_fields.output)

    delete_args = ["project", "shot-delete", "--shot-id", "shot-1"]
    unconfirmed = runner.invoke(app, delete_args)
    assert unconfirmed.exit_code == 2
    assert "删除镜头不可逆" in plain(unconfirmed.output)
    deleted = mock_data(runner.invoke(app, [*delete_args, "--i-mean-it"]))
    assert deleted == {"method": "DELETE", "path": "/shots/shot-1", "body": None}

    for command in ("shot-update", "shot-delete"):
        help_result = runner.invoke(app, ["project", command, "--help"])
        assert help_result.exit_code == 0
        assert "--yes" not in plain(help_result.output)




def test_shot_editing_validation_supports_chinese_and_english(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)

    missing = runner.invoke(app, ["project", "shot-update", "--shot-id", "shot-1"])
    assert missing.exit_code == 2
    assert "至少提供一个可更新字段" in plain(missing.output)

    unconfirmed = runner.invoke(app, ["--lang", "en", "project", "shot-delete", "--shot-id", "shot-1"])
    assert unconfirmed.exit_code == 2
    assert "Deleting a shot is irreversible" in plain(unconfirmed.output)


def test_reference_test_write_commands_match_backend_wire_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """线路契约对着 origin/dev:src/modules/referenceTests/routes.ts 核过。

    那批 body schema 全是 `.strict()`，所以这里断言 body 里**没有**
    client_idempotency_key——注入它就是 400。
    """

    mock_cli(monkeypatch)

    created = mock_data(runner.invoke(app, [
        "reference-test", "create", "--project-id", "p",
        "--name", "主角脸测试", "--media-kind", "image", "--mode", "direct_reference",
        "--model-key", "image-model-1",
        "--payload", json.dumps({"prompt": "初始提示词", "parameters": {"aspect_ratio": "16:9"}}),
    ]))
    assert created == {
        "method": "POST",
        "path": "/projects/p/reference-tests",
        "body": {
            "name": "主角脸测试",
            "media_kind": "image",
            "mode": "direct_reference",
            "model_key": "image-model-1",
            "prompt": "初始提示词",
            "parameters": {"aspect_ratio": "16:9"},
        },
    }

    # strict schema：未知字段本地就拦，不送出去吃 400。
    rejected = runner.invoke(app, [
        "reference-test", "create", "--project-id", "p",
        "--name", "x", "--media-kind", "image", "--mode", "direct_reference",
        "--model-key", "m", "--payload", json.dumps({"model_id": "旧字段"}),
    ])
    assert rejected.exit_code == 2

    # 服务端是 PUT 整体替换 + 乐观锁，不是 PATCH 局部更新。
    updated = mock_data(runner.invoke(app, [
        "reference-test", "update", "--project-id", "p",
        "--reference-test-id", "reference-test-1",
        "--name", "主角脸测试", "--media-kind", "image", "--mode", "direct_reference",
        "--model-key", "image-model-1", "--expected-version", "3",
        "--payload", json.dumps({"prompt": "修改后提示词"}),
    ]))
    assert updated == {
        "method": "PUT",
        "path": "/projects/p/reference-tests/reference-test-1",
        "body": {
            "name": "主角脸测试",
            "media_kind": "image",
            "mode": "direct_reference",
            "model_key": "image-model-1",
            "prompt": "修改后提示词",
            "expected_version": 3,
        },
    }

    # 服务端没有「跑测试」这条路：生成走 generation 三步，产物用 result-attach 挂上来。
    attached = mock_data(runner.invoke(app, [
        "reference-test", "result-attach", "--project-id", "p",
        "--reference-test-id", "reference-test-1",
        "--generation-request-id", "gen-1", "--media-result-id", "media-1",
    ]))
    assert attached == {
        "method": "POST",
        "path": "/projects/p/reference-tests/reference-test-1/results",
        "body": {"generation_request_id": "gen-1", "media_result_id": "media-1"},
    }

    selected = mock_data(runner.invoke(app, [
        "reference-test", "set-default", "--project-id", "p",
        "--reference-test-id", "reference-test-1", "--result-id", "result-1",
        "--expected-version", "0",
    ]))
    assert selected == {
        "method": "POST",
        "path": "/projects/p/reference-tests/reference-test-1/results/result-1/set-default",
        "body": {"expected_version": 0},
    }

    # /generation-defaults 是另一个后端模块，命令挂在 generation 组而非 reference-test 组。
    default_updated = mock_data(runner.invoke(app, [
        "generation", "default-update", "--project-id", "p", "--media-kind", "image",
        "--mode", "direct_reference", "--model-key", "image-model-1",
        "--expected-version", "2", "--parameters", json.dumps({"seed": 7}),
    ]))
    assert default_updated == {
        "method": "PUT",
        "path": "/projects/p/generation-defaults/image",
        "body": {
            "mode": "direct_reference",
            "model_key": "image-model-1",
            "parameters": {"seed": 7},
            "expected_version": 2,
        },
    }

    # --parameters 传坏的报错必须点名 --parameters，不许指到 --payload。
    bad_parameters = runner.invoke(app, [
        "generation", "default-update", "--project-id", "p", "--media-kind", "image",
        "--mode", "direct_reference", "--model-key", "image-model-1",
        "--expected-version", "0", "--parameters", "not-json",
    ])
    assert bad_parameters.exit_code == 2
    assert "--parameters" in plain(bad_parameters.output)

    deleted = mock_data(runner.invoke(app, [
        "reference-test", "delete", "--project-id", "p",
        "--reference-test-id", "reference-test-1", "--expected-version", "3",
    ]))
    assert deleted == {
        "method": "DELETE",
        "path": "/projects/p/reference-tests/reference-test-1",
        "body": {"expected_version": 3},
    }

def test_asset_registration_requires_schema_form_and_uploads_it(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    mock_cli(monkeypatch)
    image = tmp_path / "role.png"
    image.write_bytes(b"png")
    missing = runner.invoke(app, ["asset", "register", "--file", str(image)])
    assert missing.exit_code == 2

    form = {
        "schema_version": "asset-registration-v1",
        "dictionary_version": "asset-factor-v0.2",
        "name": "角色甲",
    }
    data = mock_data(runner.invoke(app, [
        "asset",
        "register",
        "--file",
        str(image),
        "--registration-json",
        json.dumps(form, ensure_ascii=False),
        "--asset-kind",
        "character",
        "--client-idempotency-key",
        "11111111-1111-4111-8111-111111111111",
    ]))
    assert data["path"] == "/asset-upload-tasks"
    assert json.loads(data["fields"]["registration"]) == form
    assert data["fields"]["asset_kind_hint"] == "character"


def test_asset_registration_rejects_non_uuid_idempotency_key(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    mock_cli(monkeypatch)
    image = tmp_path / "role.png"
    image.write_bytes(b"png")
    result = runner.invoke(app, [
        "asset",
        "register",
        "--file",
        str(image),
        "--registration-json",
        "{}",
        "--client-idempotency-key",
        "not-a-uuid",
    ])
    assert result.exit_code == 2


def test_asset_version_and_variant_commands_match_frozen_api_contract(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    mock_cli(monkeypatch)

    versions = mock_data(runner.invoke(app, ["asset", "version-list", "--asset-id", "asset-1"]))
    assert versions == {"method": "GET", "path": "/assets/asset-1/versions", "body": None}

    image = tmp_path / "card.png"
    image.write_bytes(b"png")
    added = mock_data(runner.invoke(app, [
        "asset", "version-add", "--asset-id", "asset-1", "--file", str(image),
        "--title", "正面主视角", "--variant-id", "variant-1", "--is-primary",
    ]))
    assert added["path"] == "/assets/asset-1/media"
    assert added["fields"] == {
        "title": "正面主视角",
        "asset_variant_id": "variant-1",
        "is_primary": "true",
    }

    unconfirmed = runner.invoke(app, [
        "asset", "version-set-primary", "--asset-id", "asset-1", "--media-id", "media-1",
    ])
    assert unconfirmed.exit_code == 2
    primary = mock_data(runner.invoke(app, [
        "asset", "version-set-primary", "--asset-id", "asset-1", "--media-id", "media-1", "--i-mean-it",
    ]))
    assert primary == {"method": "POST", "path": "/assets/asset-1/media/media-1/set-primary", "body": None}

    variants = mock_data(runner.invoke(app, ["asset", "variant-list", "--asset-id", "asset-1"]))
    assert variants == {"method": "GET", "path": "/assets/asset-1/variants", "body": None}

    created = mock_data(runner.invoke(app, [
        "asset", "variant-create", "--asset-id", "asset-1",
        "--name", "3 岁闪回", "--kind", "age",
        "--usage-context", "回忆场景", "--episode-no", "1", "--episode-no", "2",
    ]))
    assert created == {
        "method": "POST",
        "path": "/assets/asset-1/variants",
        "body": {
            "name": "3 岁闪回",
            "variant_kind": "age",
            "is_primary": False,
            "sort_order": 0,
            "usage_context": "回忆场景",
            "episode_nos": [1, 2],
        },
    }


def test_asset_version_add_rejects_more_fields_than_the_server_accepts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    mock_cli(monkeypatch)
    image = tmp_path / "card.png"
    image.write_bytes(b"png")
    result = runner.invoke(app, [
        "asset", "version-add", "--asset-id", "asset-1", "--file", str(image),
        "--title", "t", "--description", "d", "--variant-id", "v", "--is-primary",
    ])
    assert result.exit_code == 2


def test_prep_pull_and_send_freeze_three_state_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)
    pulled = mock_data(runner.invoke(app, [
        "prep",
        "pull",
        "--scene-id",
        "scene",
        "--lane",
        "character",
        "--asset-id",
        "asset",
        "--asset-media-id",
        "media",
        "--client-idempotency-key",
        "prep-pull-0001",
    ]))
    assert pulled["body"] == {
        "lane": "character",
        "asset_entity_id": "asset",
        "asset_media_id": "media",
        "client_idempotency_key": "prep-pull-0001",
    }

    base = [
        "prep",
        "send",
        "--scene-id",
        "scene",
        "--item",
        "item",
        "--client-idempotency-key",
        "prep-send-0001",
    ]
    scene = mock_data(runner.invoke(app, base))["body"]
    shots = mock_data(runner.invoke(app, [*base, "--shot", "shot-1", "--shot", "shot-2"]))["body"]
    blocked = runner.invoke(app, [*base, "--all-shots"])
    all_shots = mock_data(runner.invoke(app, [*base, "--all-shots", "--i-mean-it"]))["body"]

    assert scene == {"item_ids": ["item"], "client_idempotency_key": "prep-send-0001"}
    assert shots["shot_ids"] == ["shot-1", "shot-2"]
    assert blocked.exit_code == 2
    assert all_shots["all_shots"] is True
    assert all_shots["i_mean_it"] is True


def test_generation_and_retry_never_collapse_confirm_and_submit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)
    for command in (
        ["generation", "estimate"],
        ["generation", "confirm"],
        ["generation", "submit"],
        ["generation", "batch-estimate"],
        ["generation", "batch-confirm"],
        ["generation", "batch-submit"],
    ):
        help_result = runner.invoke(app, [*command, "--help"])
        assert help_result.exit_code == 0
        assert "--yes" not in plain(help_result.output)

    batch = mock_data(runner.invoke(app, [
        "generation",
        "batch-submit",
        "--authorization-id",
        "auth-1",
    ]))
    assert batch["path"] == "/generation-batches/auth-1/submit"
    assert batch["body"] is None

    retry_estimate = mock_data(runner.invoke(app, [
        "queue", "retry-estimate", "--generation-id", "generation-1",
    ]))
    assert retry_estimate["path"] == "/generations/estimate"
    assert retry_estimate["body"] == {
        "action": "retry",
        "original_request_id": "generation-1",
    }

    retry_submit = mock_data(runner.invoke(app, [
        "queue",
        "retry-submit",
        "--generation-id",
        "generation-1",
        "--quote-id",
        "quote-1",
        "--client-idempotency-key",
        "retry-submit-01",
    ]))
    assert retry_submit["path"] == "/generations/generation-1/retry"
    assert retry_submit["body"] == {
        "generation_quote_id": "quote-1",
        "client_idempotency_key": "retry-submit-01",
    }


def test_review_decision_requires_explicit_human_confirmation_and_valid_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)
    base = [
        "review",
        "decide",
        "--project-id",
        "project-1",
        "--media-result-id",
        "media-result-1",
    ]

    unconfirmed = runner.invoke(app, [*base, "--action", "approve"])
    assert unconfirmed.exit_code == 2
    assert "会改变生产事实" in unconfirmed.output
    assert "--i-mean-it" in plain(unconfirmed.output)

    missing_reason = runner.invoke(app, [
        *base,
        "--action",
        "reject",
        "--i-mean-it",
    ])
    assert missing_reason.exit_code == 2
    assert "拒绝媒体必须提供" in missing_reason.output

    invalid_approve = runner.invoke(app, [
        *base,
        "--action",
        "approve",
        "--rejection-reason",
        "不应随通过提交",
        "--i-mean-it",
    ])
    assert invalid_approve.exit_code == 2
    assert "通过媒体时不能提供" in invalid_approve.output

    approved = mock_data(runner.invoke(app, [
        *base,
        "--action",
        "approve",
        "--i-mean-it",
    ]))
    assert approved == {
        "method": "POST",
        "path": "/projects/project-1/media-reviews/decisions",
        "body": {
            "decisions": [{
                "media_result_id": "media-result-1",
                "action": "approve",
            }],
        },
    }

    rejected = mock_data(runner.invoke(app, [
        *base,
        "--action",
        "reject",
        "--rejection-reason",
        "人物口型与台词不一致",
        "--i-mean-it",
    ]))
    assert rejected["body"]["decisions"] == [{
        "media_result_id": "media-result-1",
        "action": "reject",
        "rejection_reason": "人物口型与台词不一致",
    }]


def test_set_primary_requires_explicit_human_confirmation_and_uses_shot_media_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)
    base = [
        "review",
        "set-primary",
        "--shot-id",
        "shot-1",
        "--media-id",
        "media-1",
    ]

    unconfirmed = runner.invoke(app, base)
    assert unconfirmed.exit_code == 2
    assert "设置镜头主版本会改变生产事实" in unconfirmed.output
    data = mock_data(runner.invoke(app, [*base, "--i-mean-it"]))
    assert data == {
        "method": "POST",
        "path": "/shots/shot-1/media/media-1/set-primary",
        "body": None,
    }

    for command in ("decide", "set-primary"):
        help_result = runner.invoke(app, ["review", command, "--help"])
        assert help_result.exit_code == 0
        assert "--yes" not in plain(help_result.output)


def test_review_server_rejection_stays_nonzero_and_uses_safe_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class RejectingClient:
        def request(
            self,
            method: str,
            path: str,
            body: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            assert (method, path, body) == (
                "POST",
                "/shots/shot-1/media/media-1/set-primary",
                None,
            )
            raise ApiRequestError("api_rejected: 后端拒绝了此请求")

    monkeypatch.setattr(
        "shortdrama_cli.cli.common.build_business_client",
        lambda: RejectingClient(),
    )
    result = runner.invoke(app, [
        "review",
        "set-primary",
        "--shot-id",
        "shot-1",
        "--media-id",
        "media-1",
        "--i-mean-it",
    ])

    assert result.exit_code == 1
    envelope = json.loads(result.output)
    assert envelope["status"] == "failed"
    assert envelope["error"]["message"] == "api_rejected: 后端拒绝了此请求"


def test_generation_estimate_preserves_simple_and_full_server_shapes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)
    simple_payload = {
        "media_kind": "image",
        "tier_id": "tier",
        "parameters": {},
        "quantity": 1,
    }
    simple = mock_data(runner.invoke(app, [
        "generation",
        "estimate",
        "--payload",
        json.dumps(simple_payload),
    ]))
    assert simple["body"] == simple_payload
    assert "client_idempotency_key" not in simple["body"]

    full_payload = {
        **simple_payload,
        "project_id": "project",
        "shot_id": "shot",
    }
    full = mock_data(runner.invoke(app, [
        "generation",
        "estimate",
        "--payload",
        json.dumps(full_payload),
        "--client-idempotency-key",
        "estimate-key-001",
    ]))
    assert full["body"] == {
        **full_payload,
        "client_idempotency_key": "estimate-key-001",
    }


def test_delivery_record_uses_episode_delivery_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_cli(monkeypatch)
    data = mock_data(runner.invoke(app, [
        "delivery",
        "record",
        "--episode-id",
        "episode-1",
        "--purpose",
        "内审交付",
        "--partial",
    ]))
    assert data["method"] == "POST"
    assert data["path"] == "/episodes/episode-1/deliveries"
    assert data["body"] == {"purpose": "内审交付", "partial": True}


def test_delivery_download_uses_authorized_media_endpoint_and_writes_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class DownloadClient:
        def download(self, path: str) -> tuple[bytes, dict[str, str]]:
            assert path == "/media/media-1/download"
            return b"video", {"content-type": "video/mp4"}

    monkeypatch.setattr("shortdrama_cli.cli.v030.build_business_client", lambda: DownloadClient())
    output = tmp_path / "delivery.mp4"
    result = runner.invoke(app, [
        "delivery",
        "download",
        "--media-id",
        "media-1",
        "--output",
        str(output),
    ])

    assert result.exit_code == 0, result.output
    assert output.read_bytes() == b"video"
    assert json.loads(result.output)["data"]["byte_length"] == 5


def test_cli_has_no_database_dependency() -> None:
    project = Path(__file__).parents[1] / "pyproject.toml"
    text = project.read_text(encoding="utf-8").lower()
    for forbidden in ("psycopg", "asyncpg", "sqlalchemy", "supabase"):
        assert forbidden not in text
