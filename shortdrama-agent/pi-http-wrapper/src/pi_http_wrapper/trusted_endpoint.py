"""Trusted backend environments delegated to the shortdrama CLI catalogue.

The wrapper carries no endpoint list of its own: ``server_api/endpoints.py``
inside the commit-pinned ``shortdrama-cli`` dependency is the single source of
truth (CLI repository ADR 0001). Callers select an environment *name* via
``SHORTDRAMA_ENV`` (prod/test/dev); no wrapper configuration surface accepts
a URL.
"""

from __future__ import annotations

import re
import sys

from shortdrama_cli.api.errors import ApiConfigurationError
from shortdrama_cli.i18n import t
from shortdrama_cli.server_api.endpoints import (
    DEFAULT_ENVIRONMENT,
    TRUSTED_ENDPOINTS,
    TrustedEndpoint,
    resolve_endpoint,
)

__all__ = [
    "DEFAULT_ENVIRONMENT",
    "TRUSTED_ENDPOINTS",
    "TrustedEndpoint",
    "is_url_shaped",
    "resolve_trusted_environment",
]

_URL_SHAPED = re.compile(r"^(?:[A-Za-z][A-Za-z0-9+.-]*://|[^\s/:]+[:.]\S*)")


def is_url_shaped(value: str) -> bool:
    """Detect URL-like input so rejection can point operators at names only."""

    return _URL_SHAPED.match(value.strip()) is not None


# One plaintext-HTTP warning per process per environment: the CLI Typer layer
# emits it per client build, which the wrapper never goes through, so the
# wrapper emits the CLI's own wording exactly once at first resolution.
_warned_environments: set[str] = set()


def resolve_trusted_environment(environment: str | None) -> TrustedEndpoint:
    """Resolve an environment name against the CLI trusted catalogue.

    Membership is decided by the CLI's ``resolve_endpoint``; the wrapper only
    replaces the login-oriented hint with operator-facing configuration
    guidance. Unknown names and URL-shaped values fail closed in Chinese.
    """

    name = (environment or "").strip() or DEFAULT_ENVIRONMENT
    try:
        entry = resolve_endpoint(name)
    except ApiConfigurationError as error:
        allowed = "、".join(TRUSTED_ENDPOINTS)
        if is_url_shaped(name):
            raise ApiConfigurationError(
                f"SHORTDRAMA_ENV 不接受 URL（收到：{name}）。后端地址只来自 shortdrama-cli "
                f"内置的受信端点清单，请改用环境名：{allowed}。",
            ) from error
        raise ApiConfigurationError(
            f"未知环境：{name}。SHORTDRAMA_ENV 只接受受信环境名：{allowed}；"
            "新增环境需在 shortdrama-cli 受信端点清单中发版。",
        ) from error
    if entry.plaintext_http and entry.name not in _warned_environments:
        _warned_environments.add(entry.name)
        print(
            t("endpoint.plaintext_warning", name=entry.name, api_base=entry.api_base),
            file=sys.stderr,
        )
    return entry
