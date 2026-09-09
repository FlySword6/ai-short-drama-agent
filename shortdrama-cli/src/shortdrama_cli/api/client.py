"""HTTP API client; the CLI never connects to databases directly."""

import json
import sys
import time
from typing import Any, NoReturn, Protocol
from uuid import uuid4
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from shortdrama_cli.api.errors import ApiConfigurationError, ApiRequestError
from shortdrama_cli.api.tls import default_ssl_context

DEFAULT_TIMEOUT_SECONDS = 1200



class _RejectRedirectHandler(HTTPRedirectHandler):
    """Turn every authenticated API redirect into a terminal response."""

    def _reject_redirect(
        self,
        request: Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
    ) -> NoReturn:
        raise HTTPError(request.full_url, code, message, headers, file_pointer)

    http_error_301 = _reject_redirect
    http_error_302 = _reject_redirect
    http_error_303 = _reject_redirect
    http_error_307 = _reject_redirect
    http_error_308 = _reject_redirect


class ApiTransport(Protocol):
    """Small transport seam used by tests without making real network calls."""

    def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Send a JSON request and return a decoded JSON object."""

    def upload_file(
        self,
        url: str,
        headers: dict[str, str],
        filename: str,
        content: bytes,
        content_type: str,
        fields: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Upload one multipart file and return a decoded JSON object."""

    def download(
        self,
        url: str,
        headers: dict[str, str],
    ) -> tuple[bytes, dict[str, str]]:
        """Download a binary or text response and return normalized headers."""


class UrlLibTransport:
    """Standard-library JSON transport for backend API calls."""

    def __init__(self, timeout: float = DEFAULT_TIMEOUT_SECONDS, debug: bool = False) -> None:
        self.timeout = timeout
        self.debug = debug
        self._opener = build_opener(
            _RejectRedirectHandler(),
            HTTPSHandler(context=default_ssl_context()),
        )

    def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers = {**headers, "Content-Type": "application/json"}

        request = Request(url=url, data=data, headers=headers, method=method)
        started_at = time.monotonic()
        self._debug_request(method, url, body)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                self._debug_response(response.status, started_at, raw)
        except HTTPError as error:
            self._raise_http_error(error, started_at)
        except URLError as error:
            self._raise_transport_error(error, started_at)

        try:
            decoded = json.loads(raw) if raw else {}
        except json.JSONDecodeError as error:
            raise ApiRequestError("API response was not valid JSON.") from error
        if not isinstance(decoded, dict):
            raise ApiRequestError("API response must be a JSON object.")
        return decoded

    def upload_file(
        self,
        url: str,
        headers: dict[str, str],
        filename: str,
        content: bytes,
        content_type: str,
        fields: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Upload one binary file without logging its content or filename."""

        boundary = f"----shortdrama-cli-{uuid4().hex}"
        safe_filename = filename.replace("\\", "\\\\").replace('"', "\\\"")
        parts = [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="file"; filename="{safe_filename}"\r\n'.encode(),
                f"Content-Type: {content_type}\r\n\r\n".encode(),
                content,
        ]
        for key, value in (fields or {}).items():
            parts.extend((f"\r\n--{boundary}\r\n".encode(), f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode(), value.encode("utf-8")))
        parts.append(f"\r\n--{boundary}--\r\n".encode())
        data = b"".join(parts)
        request = Request(
            url=url,
            data=data,
            headers={**headers, "Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        started_at = time.monotonic()
        self._debug_request("POST", url, {"file": "[binary]"})
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                self._debug_response(response.status, started_at, raw)
        except HTTPError as error:
            self._raise_http_error(error, started_at)
        except URLError as error:
            self._raise_transport_error(error, started_at)
        try:
            decoded = json.loads(raw) if raw else {}
        except json.JSONDecodeError as error:
            raise ApiRequestError("API response was not valid JSON.") from error
        if not isinstance(decoded, dict):
            raise ApiRequestError("API response must be a JSON object.")
        return decoded

    def download(
        self,
        url: str,
        headers: dict[str, str],
    ) -> tuple[bytes, dict[str, str]]:
        """Download a server-authorized artifact without logging its content."""

        request = Request(url=url, headers=headers, method="GET")
        started_at = time.monotonic()
        self._debug_request("GET", url, None)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                content = response.read()
                response_headers = {key.lower(): value for key, value in response.headers.items()}
                self._debug_response(response.status, started_at, "")
                return content, response_headers
        except HTTPError as error:
            self._raise_http_error(error, started_at)
        except URLError as error:
            self._raise_transport_error(error, started_at)

    def _raise_http_error(self, error: HTTPError, started_at: float) -> NoReturn:
        """Map an HTTP failure without exposing a backend response body."""

        try:
            error.read()
        except OSError:
            pass
        self._debug_response(error.code, started_at, "")
        raise ApiRequestError(f"API request failed with HTTP {error.code}.") from error

    def _raise_transport_error(self, error: URLError, started_at: float) -> NoReturn:
        """Map connection failures without exposing a lower-level network error."""

        if self.debug:
            elapsed_ms = round((time.monotonic() - started_at) * 1000)
            print(f"[debug] http_transport_error duration_ms={elapsed_ms}", file=sys.stderr)
        raise ApiRequestError("API request could not reach the configured backend.") from error


    def _debug_request(self, method: str, url: str, body: dict[str, Any] | None) -> None:
        """Print a request summary without secrets or user-provided content."""

        if not self.debug:
            return
        body_keys = ",".join(sorted(body)) if body else "-"
        print(
            f"[debug] http_request method={method} url={_safe_url(url)} body_keys={body_keys}",
            file=sys.stderr,
        )

    def _debug_response(self, status: int, started_at: float, raw: str) -> None:
        """Print response metadata only; never echo a response body."""

        if not self.debug:
            return
        elapsed_ms = round((time.monotonic() - started_at) * 1000)
        response_keys = _json_object_keys(raw)
        print(
            f"[debug] http_response status={status} duration_ms={elapsed_ms} response_keys={response_keys}",
            file=sys.stderr,
        )


def _safe_url(url: str) -> str:
    """Remove user info and query values from diagnostic URLs."""

    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.hostname or "", parsed.path, "", ""))


def _json_object_keys(raw: str) -> str:
    """Summarize top-level JSON keys without exposing response values."""

    try:
        value = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return "non_json"
    return ",".join(sorted(value)) if isinstance(value, dict) else "non_object"
