"""Process-scoped CLI execution settings shared by command groups."""

from contextvars import ContextVar


_debug_enabled: ContextVar[bool] = ContextVar("shortdrama_debug_enabled", default=False)

_selected_environment: ContextVar[str | None] = ContextVar("shortdrama_selected_environment", default=None)


def set_debug_enabled(enabled: bool) -> None:
    """Store the root CLI debug choice for clients built during this invocation."""

    _debug_enabled.set(enabled)


def debug_enabled() -> bool:
    """Return whether safe HTTP diagnostics should be emitted to stderr."""

    return _debug_enabled.get()


def set_selected_environment(environment: str | None) -> None:
    """Store the explicit command-line environment for this invocation."""

    _selected_environment.set(environment)


def selected_environment() -> str | None:
    """Return the explicit command-line environment, if one was supplied."""

    return _selected_environment.get()
