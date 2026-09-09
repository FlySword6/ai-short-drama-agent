"""Bearer authentication with non-secret audit identities."""

from __future__ import annotations

import hashlib
import hmac


def token_fingerprint(token: str) -> str:
    return "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


def authenticate_bearer(header_value: str | None, allowed_tokens: tuple[str, ...]) -> str | None:
    if not header_value or not header_value.startswith("Bearer "):
        return None
    candidate = header_value.removeprefix("Bearer ").strip()
    for token in allowed_tokens:
        if hmac.compare_digest(candidate, token):
            return token_fingerprint(token)
    return None

