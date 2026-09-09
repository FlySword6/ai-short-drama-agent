"""Regression tests for client-side error redaction."""

from io import BytesIO
from urllib.error import HTTPError, URLError

import pytest

from shortdrama_cli.api.client import UrlLibTransport
from shortdrama_cli.api.errors import ApiRequestError
from shortdrama_cli.server_api.client import _unwrap_response


def test_http_error_never_returns_or_logs_vendor_error_body(monkeypatch, capsys) -> None:
    private_body = b'{"error":"test-private-prompt", "opaque":"test-vendor-response"}'
    error = HTTPError(
        "https://api.test/generate",
        422,
        "unprocessable",
        hdrs=None,
        fp=BytesIO(private_body),
    )

    class FailingOpener:
        def open(self, request, timeout):  # type: ignore[no-untyped-def]
            raise error

    monkeypatch.setattr(
        "shortdrama_cli.api.client.build_opener",
        lambda *_handlers: FailingOpener(),
    )
    transport = UrlLibTransport(debug=True)

    with pytest.raises(ApiRequestError, match="HTTP 422") as raised:
        transport.request(
            "POST",
            "https://api.test/generate",
            {},
            {"prompt": "test-local-prompt"},
        )

    output = f"{raised.value}\n{capsys.readouterr().err}"
    for private_value in (
        "test-private-prompt",
        "test-vendor-response",
        "test-local-prompt",
    ):
        assert private_value not in output


def test_transport_error_never_returns_or_logs_network_reason(monkeypatch, capsys) -> None:
    private_reason = "test-proxy-password"
    error = URLError(private_reason)

    class FailingOpener:
        def open(self, request, timeout):  # type: ignore[no-untyped-def]
            raise error

    monkeypatch.setattr(
        "shortdrama_cli.api.client.build_opener",
        lambda *_handlers: FailingOpener(),
    )
    transport = UrlLibTransport(debug=True)

    with pytest.raises(ApiRequestError, match="could not reach") as raised:
        transport.request("GET", "https://api.test/status", {})

    assert private_reason not in f"{raised.value}\n{capsys.readouterr().err}"


def test_server_error_envelope_never_exposes_backend_message() -> None:
    private_message = "test-private-prompt-and-vendor-trace"

    with pytest.raises(ApiRequestError, match="quota_exhausted") as raised:
        _unwrap_response({
            "ok": False,
            "error": {
                "code": "quota_exhausted",
                "message": private_message,
                "raw_response": "test-opaque-provider-body",
            },
        })

    rendered = str(raised.value)
    assert private_message not in rendered
    assert "test-opaque-provider-body" not in rendered
    assert rendered == "quota_exhausted: 后端拒绝了此请求"


def test_unknown_server_error_code_is_not_reflected_to_cli() -> None:
    private_code = "test-internal-vendor-rejection"

    with pytest.raises(ApiRequestError, match="api_rejected") as raised:
        _unwrap_response({"ok": False, "error": {"code": private_code, "message": "test-private-message"}})

    assert private_code not in str(raised.value)


def test_download_rejects_redirect_before_contacting_location() -> None:
    authorization_header = "Authorization"
    bearer_value = "Bearer " + "test-token"

    class Response:
        status = 302
        headers = {"Location": "http://127.0.0.1/private"}

        def read(self) -> bytes:
            return b""

        def close(self) -> None:
            return None

    from shortdrama_cli.api.client import _RejectRedirectHandler
    from urllib.request import Request

    handler = _RejectRedirectHandler()
    with pytest.raises(HTTPError) as raised:
        handler.http_error_302(
            Request("https://assets.test/download", headers={authorization_header: bearer_value}),
            Response(),
            302,
            "Found",
            {"Location": "http://127.0.0.1/private"},
        )

    assert "127.0.0.1" not in str(raised.value)
