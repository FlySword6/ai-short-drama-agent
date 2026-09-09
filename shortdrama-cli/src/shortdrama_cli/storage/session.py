"""Private local session storage for main client API credentials.

Sessions are stored per environment (ADR 0001): one profile file per
environment name, so credentials can never leak across environments by
construction.  A separate pointer file records the environment chosen at
`auth login` time; it stores only the name, never a URL or token.
"""

import json
import os
from pathlib import Path
from typing import Any


def _config_root() -> Path:
    return Path(os.getenv("SHORTDRAMA_CONFIG_HOME", Path.home() / ".config" / "shortdrama-cli"))


def _active_environment_path() -> Path:
    return _config_root() / "environment"


def session_path(profile: str = "default") -> Path:
    """Resolve one profile path without accepting directory traversal."""

    safe = "".join(character for character in profile if character.isalnum() or character in "-_") or "default"
    root = _config_root()
    return root / "profiles" / f"{safe}.json"


def save_active_environment(environment: str) -> None:
    """Remember the environment chosen at login; stores only the name."""

    path = _active_environment_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(environment, encoding="utf-8")
    path.chmod(0o600)


def load_active_environment() -> str | None:
    """Return the sticky login environment, or None when never logged in."""

    path = _active_environment_path()
    if not path.exists():
        return None
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def clear_active_environment() -> None:
    """Remove the sticky environment pointer on logout."""

    path = _active_environment_path()
    if path.exists():
        path.unlink()


def save_session(value: dict[str, Any], profile: str = "default") -> None:
    """Persist tokens in a user-only file and never return their values for logging."""

    path = session_path(profile)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    path.chmod(0o600)


def load_session(profile: str = "default") -> dict[str, Any]:
    """Load a profile, treating missing or malformed files as logged out."""

    path = session_path(profile)
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def delete_session(profile: str = "default") -> None:
    """Remove only the selected local profile file."""

    path = session_path(profile)
    if path.exists():
        path.unlink()
