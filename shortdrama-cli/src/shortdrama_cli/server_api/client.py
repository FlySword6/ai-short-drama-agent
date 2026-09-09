"""Single, authenticated boundary for the frozen shortdrama v0.3 API."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit, urlunsplit

from shortdrama_cli.api.client import ApiTransport, UrlLibTransport
from shortdrama_cli.api.errors import ApiConfigurationError, ApiRequestError
from shortdrama_cli.i18n import t

# Backend error messages can contain prompts, vendor payloads, identifiers, or
# operational details. The CLI exposes only documented machine-readable codes
# and supplies its own stable user-facing message.
_PUBLIC_REJECTION_CODES = frozenset(
    {
        "authentication_required",
        "forbidden",
        "not_found",
        "invalid_request",
        "conflict",
        "quote_not_confirmed",
        "quote_already_consumed",
        "quota_exhausted",
    }
)


class BusinessServerClient:
    """Call only the versioned public API; ``api_base`` is always a site root."""

    def __init__(self, api_base: str, token: str | None = None, transport: ApiTransport | None = None) -> None:
        value = api_base.strip().rstrip("/")
        parsed = urlsplit(value)
        if not parsed.scheme or not parsed.netloc or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ApiConfigurationError(t("client.api_base_must_be_site_root"))
        self.api_base = urlunsplit((parsed.scheme, parsed.netloc, "", "", "")) + "/api/v1"
        self.token = token
        self.transport = transport or UrlLibTransport()

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """Call one frozen API route and unwrap only the documented envelope."""

        if not path.startswith("/"):
            raise ValueError("API path must start with '/'.")
        response = self.transport.request(method, f"{self.api_base}{path}", self._headers(), body)
        return _unwrap_response(response)

    def upload(self, path: str, filename: str, content: bytes, content_type: str, fields: dict[str, str]) -> dict[str, Any]:
        """Upload a multipart asset registration without exposing file bytes in logs."""

        response = self.transport.upload_file(f"{self.api_base}{path}", self._headers(), filename, content, content_type, fields)
        return _unwrap_response(response)

    def download(self, path: str) -> tuple[bytes, dict[str, str]]:
        """Download one authenticated CSV or media artifact."""

        if not path.startswith("/"):
            raise ValueError("API path must start with '/'.")
        return self.transport.download(f"{self.api_base}{path}", self._headers())

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "X-Shortdrama-Client": "cli",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers


def _unwrap_response(response: dict[str, Any]) -> dict[str, Any]:
    """Accept only the main repository's frozen ``ok/data`` envelope."""

    if "ok" not in response:
        raise ApiRequestError("API response is missing the required ok envelope.")
    if response.get("ok") is not True:
        error = response.get("error")
        if isinstance(error, dict):
            value = error.get("code")
            code = value if isinstance(value, str) and value in _PUBLIC_REJECTION_CODES else "api_rejected"
            raise ApiRequestError(f"{code}: 后端拒绝了此请求")
        raise ApiRequestError("API request was rejected.")
    data = response.get("data")
    if not isinstance(data, dict):
        raise ApiRequestError("API response data must be a JSON object.")
    return data
