"""Frozen v0.3 auth commands."""

from __future__ import annotations

from typing import Annotated

import typer

from shortdrama_cli.api.errors import ApiConfigurationError, ApiRequestError
from shortdrama_cli.cli.common import fail, invoke, resolve_active_environment, response
from shortdrama_cli.cli.v030._helpers import _business_client, _login_client, _path
from shortdrama_cli.i18n import t
from shortdrama_cli.output import print_response
from shortdrama_cli.server_api.endpoints import TRUSTED_ENDPOINTS
from shortdrama_cli.storage.session import (
    clear_active_environment,
    delete_session,
    save_active_environment,
    save_session,
)

auth_app = typer.Typer(help="认证：login、whoami、logout。")


def _environment_name(value: str) -> str:
    """Accept only catalogue environment names; never a URL."""

    if value not in TRUSTED_ENDPOINTS:
        raise typer.BadParameter(t("auth.env.invalid"))
    return value


@auth_app.command("login")
def auth_login(
    username: Annotated[str | None, typer.Option("--username")] = None,
    env: Annotated[
        str,
        typer.Option("--env", callback=_environment_name, help=t("auth.env.help")),
    ] = "prod",
) -> None:
    """Log in once against one trusted environment; the choice then sticks.

    A non-technical operator types `shortdrama auth login` with no options and
    answers two prompts.  The password is only ever read interactively so it
    cannot leak into shell history, `ps`, or child processes; the username may
    be passed as an option because it is not a secret.
    """

    if username is None:
        username = typer.prompt(t("auth.username.prompt"), err=True)
    password = typer.prompt(t("auth.password.prompt"), hide_input=True, err=True)
    try:
        value = _login_client(env).request(
            "POST",
            _path("auth", "cli", "login"),
            {"username": username, "password": password},
        )
    except (ApiConfigurationError, ApiRequestError) as error:
        fail("auth_login", error)
    token = value.get("token")
    if not isinstance(token, str) or not token:
        fail("auth_login", ApiRequestError("登录响应缺少会话 token。"), code="invalid_login_response")
    save_session({
        "env": env,
        "token": token,
        "expires_at": value.get("expires_at"),
    }, profile=env)
    save_active_environment(env)
    print_response(response("auth_login", {
        "authenticated": True,
        "environment": env,
        "expires_at": value.get("expires_at"),
        "user": value.get("user"),
    }), "json")


@auth_app.command("whoami")
def auth_whoami() -> None:
    invoke("auth_whoami", "GET", _path("auth", "me"))


@auth_app.command("logout")
def auth_logout() -> None:
    environment = resolve_active_environment()
    try:
        value = _business_client().request("POST", _path("auth", "logout"))
    except (ApiConfigurationError, ApiRequestError) as error:
        delete_session(environment)
        clear_active_environment()
        fail("auth_logout", error)
    delete_session(environment)
    clear_active_environment()
    print_response(response("auth_logout", value), "json")
