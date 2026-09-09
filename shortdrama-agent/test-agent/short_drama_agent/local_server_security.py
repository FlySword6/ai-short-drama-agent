"""Safe-by-default network settings for the local test-agent harness.

This package is intentionally limited to loopback development.  A production
service must use the platform backend and controlled workers instead of
exposing this harness directly.
"""

from __future__ import annotations

import os
from urllib.parse import urlsplit


DEFAULT_LOCAL_ORIGINS = (
    "http://127.0.0.1:5173",
    "http://localhost:5173",
)
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost"})


def local_cors_origins(environment_variable: str) -> list[str]:
    """Return explicit loopback browser origins, rejecting wildcard CORS."""

    raw_value = os.getenv(environment_variable, ",".join(DEFAULT_LOCAL_ORIGINS))
    origins = [origin.strip().rstrip("/") for origin in raw_value.split(",")]
    origins = [origin for origin in origins if origin]
    if not origins:
        return list(DEFAULT_LOCAL_ORIGINS)

    for origin in origins:
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.hostname.lower() not in LOOPBACK_HOSTS
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise ValueError(
                f"{environment_variable} only accepts explicit loopback origins"
            )
    return origins


def loopback_bind_host(environment_variable: str) -> str:
    """Return a loopback host; public binding is not supported by test-agent."""

    host = os.getenv(environment_variable, "127.0.0.1").strip().lower()
    if host not in LOOPBACK_HOSTS:
        raise ValueError(
            f"{environment_variable} must be 127.0.0.1 or localhost for test-agent"
        )
    return host
