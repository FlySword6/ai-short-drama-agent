"""Shared v0.3 CLI runtime policy and safe response helpers.

Backend destinations come only from the release's built-in trusted endpoint
catalogue (ADR 0001). ``--env`` wins, followed by ``SHORTDRAMA_ENV``, the
sticky login environment, and finally production. No source can supply a URL.
"""

from __future__ import annotations

import os
import sys
from typing import Annotated, Any
from uuid import uuid4

import typer

from shortdrama_cli.api.client import DEFAULT_TIMEOUT_SECONDS, UrlLibTransport
from shortdrama_cli.api.errors import ApiConfigurationError, ApiRequestError
from shortdrama_cli.cli.runtime import debug_enabled, selected_environment
from shortdrama_cli.i18n import t
from shortdrama_cli.output import print_response
from shortdrama_cli.server_api import BusinessServerClient
from shortdrama_cli.server_api.endpoints import DEFAULT_ENVIRONMENT, TrustedEndpoint, resolve_endpoint
from shortdrama_cli.storage.session import load_active_environment, load_session

JsonOption = Annotated[bool, typer.Option("--json", help="输出冻结的 JSON 信封（默认）。")]
ClientIdempotencyKey = Annotated[str | None, typer.Option("--client-idempotency-key", help="写操作幂等键；缺省自动生成 UUID。")]


def resolve_active_environment() -> str:
    """Resolve environment precedence without accepting untrusted URLs."""

    return (
        selected_environment()
        or os.getenv("SHORTDRAMA_ENV")
        or load_active_environment()
        or DEFAULT_ENVIRONMENT
    )


def _warn_plaintext(endpoint: TrustedEndpoint) -> None:
    """Warn on stderr for every plaintext-HTTP connection; stdout stays clean."""

    if endpoint.plaintext_http:
        print(t("endpoint.plaintext_warning", name=endpoint.name, api_base=endpoint.api_base), file=sys.stderr)


def _client(endpoint: TrustedEndpoint, token: str | None, timeout: float) -> BusinessServerClient:
    _warn_plaintext(endpoint)
    return BusinessServerClient(endpoint.api_base, token, UrlLibTransport(timeout=timeout, debug=debug_enabled()))


def build_business_client(timeout: float = DEFAULT_TIMEOUT_SECONDS) -> BusinessServerClient:
    """Build an authenticated client for the resolved trusted environment."""

    environment = resolve_active_environment()
    token = os.getenv("SHORTDRAMA_API_TOKEN") or load_session(environment).get("token")
    if not token:
        raise ApiConfigurationError(t("endpoint.not_logged_in"))
    return _client(resolve_endpoint(environment), str(token), timeout)


def build_login_client(environment: str, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> BusinessServerClient:
    """Build an anonymous client for ``auth login`` against one catalogue entry."""

    return _client(resolve_endpoint(environment), None, timeout)


def response(action: str, data: dict[str, Any], *, status: str = "succeeded") -> dict[str, Any]:
    """The agent-facing envelope intentionally uses snake_case only."""

    return {"status": status, "action": action, "data": data}


def fail(action: str, error: Exception, *, code: str = "api_unavailable") -> None:
    print_response({"status": "failed", "action": action, "error": {"code": code, "message": str(error)}}, "json")
    raise typer.Exit(code=1)


def invoke(action: str, method: str, path: str, body: dict[str, Any] | None = None) -> None:
    """Run one production request and fail closed when the API is unavailable."""

    try:
        value = build_business_client().request(method, path, body)
    except (ApiConfigurationError, ApiRequestError) as error:
        fail(action, error)
    print_response(response(action, value), "json")


def write_body(client_idempotency_key: str | None, **fields: Any) -> dict[str, Any]:
    result = {key: value for key, value in fields.items() if value is not None}
    result["client_idempotency_key"] = client_idempotency_key or str(uuid4())
    return result
