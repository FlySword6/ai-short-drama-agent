"""One trust decision for every outbound HTTPS request.

A PyInstaller release carries its own Python runtime, and that runtime's
compiled-in CA path points at the build machine rather than the user's. Binding
verification to the CA bundle shipped inside the release is what makes a freshly
installed CLI work on a machine that has never seen a Python toolchain.
"""

from __future__ import annotations

import os
import ssl
from functools import lru_cache
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import certifi

from shortdrama_cli import __version__
from shortdrama_cli.api.errors import ApiConfigurationError, ApiRequestError

CA_BUNDLE_ENVIRONMENT_VARIABLE = "SSL_CERT_FILE"
CA_DIRECTORY_ENVIRONMENT_VARIABLE = "SSL_CERT_DIR"
PROBE_TIMEOUT_SECONDS = 20


def ca_bundle_path() -> str:
    """Return the CA bundle to trust, letting the host override the shipped one."""

    override = os.getenv(CA_BUNDLE_ENVIRONMENT_VARIABLE, "").strip()
    return override or certifi.where()


def default_ssl_context() -> ssl.SSLContext:
    """Build a certificate-verifying context bound to an explicit CA bundle."""

    return _build_context(ca_bundle_path(), os.getenv(CA_DIRECTORY_ENVIRONMENT_VARIABLE, "").strip() or None)


def loadable_ca_bundle_path() -> str:
    """Return the CA bundle only if it actually loads, so a broken release says so."""

    default_ssl_context()
    return ca_bundle_path()


@lru_cache(maxsize=8)
def _build_context(cafile: str, capath: str | None) -> ssl.SSLContext:
    """Cache one context per trust source; reading a bundle costs milliseconds."""

    try:
        return ssl.create_default_context(cafile=cafile, capath=capath)
    except (OSError, ssl.SSLError) as error:
        raise ApiConfigurationError(
            f"无法加载 CA 证书 {cafile}；请检查 {CA_BUNDLE_ENVIRONMENT_VARIABLE} 或重新安装 Release。"
        ) from error


def probe_https(probe_url: str) -> dict[str, Any]:
    """Complete one real HTTPS handshake and report the CA bundle that carried it.

    The request is anonymous on purpose: it proves the release can verify a public
    certificate chain, so it must never carry a session token to an arbitrary host.
    """

    if urlsplit(probe_url).scheme != "https":
        raise ApiConfigurationError("TLS 自检地址必须是 https://。")
    context = default_ssl_context()
    request = Request(url=probe_url, headers={"User-Agent": f"shortdrama-cli/{__version__}"}, method="GET")
    try:
        with urlopen(request, timeout=PROBE_TIMEOUT_SECONDS, context=context) as probed:
            status = probed.status
    except HTTPError as error:
        status = error.code  # The handshake finished; the server simply refused the request.
    except URLError as error:
        raise ApiRequestError(f"TLS 自检失败：{error.reason}") from error
    return {"probe": probe_url, "ca_bundle": ca_bundle_path(), "status": status}
