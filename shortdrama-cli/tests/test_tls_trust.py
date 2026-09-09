"""A release must carry its own CA bundle; a clean machine lends it nothing."""

from __future__ import annotations

import json
import ssl
from pathlib import Path
from typing import Any

import certifi
import pytest
from typer.testing import CliRunner

from shortdrama_cli.api.client import UrlLibTransport
from shortdrama_cli.api.errors import ApiConfigurationError
from shortdrama_cli.api.tls import ca_bundle_path, default_ssl_context
from shortdrama_cli.main import app


runner = CliRunner()


class _Response:
    """Minimal stand-in for the object ``urlopen`` returns."""

    status = 200

    def __init__(self, payload: bytes = b"{}") -> None:
        self.payload = payload
        self.headers: dict[str, str] = {}

    def read(self) -> bytes:
        return self.payload

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_: object) -> bool:
        return False


@pytest.fixture(autouse=True)
def clear_host_trust_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start every case from the trust store the release itself ships."""

    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)


def _capture_context(monkeypatch: pytest.MonkeyPatch, module: str, payload: bytes = b"{}") -> dict[str, Any]:
    """Record the TLS context passed to a transport's network boundary."""

    captured: dict[str, Any] = {}

    if module == "shortdrama_cli.api.client":
        class FakeOpener:
            def open(self, request: Any, timeout: float | None = None) -> _Response:
                captured["request"] = request
                return _Response(payload)

        def fake_https_handler(*, context: Any) -> object:
            captured["context"] = context
            return object()

        monkeypatch.setattr(f"{module}.HTTPSHandler", fake_https_handler)
        monkeypatch.setattr(f"{module}.build_opener", lambda *_handlers: FakeOpener())
        return captured

    def fake_urlopen(request: Any, timeout: float | None = None, context: Any = None) -> _Response:
        captured["request"] = request
        captured["context"] = context
        return _Response(payload)

    monkeypatch.setattr(f"{module}.urlopen", fake_urlopen)
    return captured


def _assert_verifies_public_certificates(context: Any) -> None:
    """Assert a context that would reject the self-signed chain from issue #27."""

    assert isinstance(context, ssl.SSLContext)
    assert context.verify_mode is ssl.CERT_REQUIRED
    assert context.check_hostname is True
    assert context.cert_store_stats()["x509_ca"] > 0


def test_default_trust_comes_from_the_bundled_ca_file() -> None:
    bundle = ca_bundle_path()

    assert bundle == certifi.where()
    assert Path(bundle).is_file()
    _assert_verifies_public_certificates(default_ssl_context())


def test_explicit_host_trust_overrides_the_bundled_ca_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    override = tmp_path / "corporate-root.pem"
    override.write_bytes(Path(certifi.where()).read_bytes())
    monkeypatch.setenv("SSL_CERT_FILE", str(override))

    assert ca_bundle_path() == str(override)
    _assert_verifies_public_certificates(default_ssl_context())


def test_unreadable_ca_bundle_names_the_file_instead_of_leaking_an_os_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    missing = tmp_path / "absent.pem"
    monkeypatch.setenv("SSL_CERT_FILE", str(missing))

    with pytest.raises(ApiConfigurationError, match="absent.pem"):
        default_ssl_context()


def test_json_requests_verify_certificates(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_context(monkeypatch, "shortdrama_cli.api.client")

    UrlLibTransport().request("GET", "https://example.test/api/v1/auth/me", {})

    _assert_verifies_public_certificates(captured["context"])


def test_uploads_verify_certificates(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_context(monkeypatch, "shortdrama_cli.api.client")

    UrlLibTransport().upload_file(
        "https://example.test/api/v1/assets",
        {},
        "clip.mp4",
        b"binary",
        "video/mp4",
        {"kind": "video"},
    )

    _assert_verifies_public_certificates(captured["context"])


def test_downloads_verify_certificates(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_context(monkeypatch, "shortdrama_cli.api.client")

    UrlLibTransport().download("https://example.test/api/v1/media/1", {})

    _assert_verifies_public_certificates(captured["context"])




def test_tls_probe_reports_the_bundle_it_trusted_without_needing_a_site(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _capture_context(monkeypatch, "shortdrama_cli.api.tls")

    result = runner.invoke(app, ["doctor", "--tls-probe", "https://example.test/"])
    payload = json.loads(result.stdout)

    assert result.exit_code == 0
    assert payload["status"] == "succeeded"
    assert payload["data"]["tls"] == {
        "probe": "https://example.test/",
        "ca_bundle": certifi.where(),
        "status": 200,
    }
    request = captured["request"]
    assert request.full_url == "https://example.test/"
    assert request.get_method() == "GET"
    assert request.get_header("Authorization") is None
    _assert_verifies_public_certificates(captured["context"])


def test_tls_probe_refuses_a_plaintext_url() -> None:
    result = runner.invoke(app, ["doctor", "--tls-probe", "http://example.test/"])

    assert result.exit_code == 1
    assert json.loads(result.stdout)["error"]["code"] == "doctor_failed"


def test_doctor_reports_a_ca_bundle_it_could_actually_load(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without this, a not-yet-logged-in install passes doctor while unable to reach anything."""

    monkeypatch.setenv("SHORTDRAMA_ENV", "test")

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 0
    assert json.loads(result.stdout)["data"]["ca_bundle"] == certifi.where()


def test_doctor_fails_when_the_release_carries_no_loadable_ca_bundle(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("SHORTDRAMA_ENV", "test")
    monkeypatch.setenv("SSL_CERT_FILE", str(tmp_path / "absent.pem"))

    result = runner.invoke(app, ["doctor"])

    assert result.exit_code == 1
    assert "absent.pem" in json.loads(result.stdout)["error"]["message"]
