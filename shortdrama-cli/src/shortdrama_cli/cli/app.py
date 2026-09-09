"""Root Typer application wiring thin command groups to workflow code."""

import os
import sys
from pathlib import Path
from typing import Annotated, Any

import typer

from shortdrama_cli import __version__
from shortdrama_cli.api.errors import ApiConfigurationError, ApiRequestError
from shortdrama_cli.api.tls import loadable_ca_bundle_path, probe_https
from shortdrama_cli.cli.common import build_business_client, fail, resolve_active_environment, response
from shortdrama_cli.cli.runtime import set_debug_enabled, set_selected_environment
from shortdrama_cli.cli.v030 import (
    asset_app,
    auth_app,
    delivery_app,
    generation_app,
    prep_app,
    project_app,
    queue_app,
    reference_app,
    review_app,
    reference_test_app,
    script_app,
)
from shortdrama_cli.i18n import set_language, t
from shortdrama_cli.output import print_response
from shortdrama_cli.server_api.endpoints import TRUSTED_ENDPOINTS, resolve_endpoint
from shortdrama_cli.storage.session import load_session


def _environment_name(value: str | None) -> str | None:
    """Accept only catalogue environment names for process-wide selection.

    The catalogue is the single source of truth: adding a reviewed endpoint in
    ``server_api/endpoints.py`` must not require a second edit here.
    """

    if value is None:
        return None
    if value not in TRUSTED_ENDPOINTS:
        raise typer.BadParameter(t("auth.env.invalid"))
    return value

app = typer.Typer(help=t("root.help"))
app.add_typer(auth_app, name="auth")
app.add_typer(project_app, name="project")
app.add_typer(asset_app, name="asset")
app.add_typer(script_app, name="script")
app.add_typer(prep_app, name="prep")
app.add_typer(generation_app, name="generation")
app.add_typer(queue_app, name="queue")
app.add_typer(review_app, name="review")
app.add_typer(reference_app, name="reference")
app.add_typer(reference_test_app, name="reference-test")
app.add_typer(delivery_app, name="delivery")


def _skill_candidates() -> list[Path]:
    candidates = [
        Path(sys.executable).resolve().parent / "skills" / "shortdrama-cli" / "SKILL.md",
        Path(__file__).resolve().parents[3] / "skills" / "shortdrama-cli" / "SKILL.md",
    ]
    configured = os.getenv("SHORTDRAMA_SKILL_DIR")
    if configured:
        candidates.insert(0, Path(configured).expanduser().resolve() / "SKILL.md")
    return candidates


def _doctor_data(require_auth: bool) -> dict[str, Any]:
    environment = resolve_active_environment()
    endpoint = resolve_endpoint(environment)
    session = load_session(environment)
    token = os.getenv("SHORTDRAMA_API_TOKEN") or session.get("token")
    skill_file = next((candidate for candidate in _skill_candidates() if candidate.is_file()), None)
    if skill_file is None:
        raise ApiConfigurationError("CLI 技能包不完整，请重新安装同版本 Release。")
    data: dict[str, Any] = {
        "version": __version__,
        "environment": environment,
        "api_base": endpoint.api_base,
        "skill_installed": True,
        # Reporting a loadable bundle fails a release that cannot verify anything, instead
        # of leaving the first real command to report it as a server-side problem.
        "ca_bundle": loadable_ca_bundle_path(),
        "authenticated": False,
        "user": None,
    }
    if token:
        data["user"] = build_business_client().request("GET", "/auth/me")
        data["authenticated"] = True
    elif require_auth:
        raise ApiConfigurationError("当前还没有登录；请先执行 auth login。")
    return data


@app.command("doctor")
def doctor(
    require_auth: Annotated[
        bool,
        typer.Option("--require-auth", help="同时核验当前会话可访问测试站。"),
    ] = False,
    tls_probe: Annotated[
        str | None,
        typer.Option("--tls-probe", help="只验证本机能否完成一次真实 HTTPS 握手；发版冒烟与代理排查用。"),
    ] = None,
) -> None:
    """Verify the installed release, matching Skill and optional login."""

    try:
        data = {"version": __version__, "tls": probe_https(tls_probe)} if tls_probe else _doctor_data(require_auth)
    except (ApiConfigurationError, ApiRequestError) as error:
        fail("doctor", error, code="doctor_failed")
    print_response(response("doctor", data), "json")


def _version_callback(value: bool) -> None:
    """Print the package version for installers and release smoke tests."""

    if value:
        typer.echo(__version__)
        raise typer.Exit()


@app.callback()
def main(
    lang: str | None = typer.Option(None, "--lang", help=t("lang.option")),
    env: str | None = typer.Option(None, "--env", callback=_environment_name, help=t("auth.env.help")),
    debug: bool = typer.Option(False, "--debug", help="输出脱敏后的 HTTP 请求诊断信息到标准错误。"),
    version: bool = typer.Option(
        False,
        "--version",
        callback=_version_callback,
        is_eager=True,
        help=t("version.option"),
    ),
) -> None:
    """Configure process-wide CLI options."""

    set_language(lang)
    set_selected_environment(env)
    set_debug_enabled(debug)
