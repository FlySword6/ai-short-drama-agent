"""Retired direct-Agent compatibility surface.

The CLI is a client of the short-drama backend only. It must not carry an
AgentKit/Ark endpoint or credentials, read a token from a local file, or
submit prompts to an Agent gateway itself. Those decisions belong to the
backend's authenticated, project-scoped AI Gateway.

The names remain temporarily so an old import fails safely and clearly instead
of silently falling back to a direct cloud request. Remove this module once
all downstream callers have migrated to ``server_api``.
"""

from typing import Any, NoReturn


class AgentGatewayError(RuntimeError):
    """Raised when legacy direct Agent invocation is requested."""


def _disabled() -> NoReturn:
    raise AgentGatewayError(
        "Direct Agent/Ark invocation is disabled in the CLI. "
        "Use the authenticated short-drama backend API instead."
    )


class AgentGateway:
    """Compatibility stub for the removed direct Agent gateway client."""

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        _disabled()


def resolve_agent_token(*_args: Any, **_kwargs: Any) -> str:
    """Do not read a direct Agent credential from argv, environment, or files."""

    _disabled()


def decode_flexible_response(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
    """Prevent legacy callers from handling an untrusted direct-Agent response."""

    _disabled()


def normalize_agent_response(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
    """Prevent legacy callers from emitting a direct-Agent response."""

    _disabled()


def agent_envelope(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
    """Prevent legacy callers from emitting a direct-Agent response."""

    _disabled()


def agent_error(*_args: Any, **_kwargs: Any) -> str | None:
    """Prevent legacy callers from exposing a direct-Agent error body."""

    _disabled()
