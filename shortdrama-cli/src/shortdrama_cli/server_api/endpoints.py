"""Trusted endpoint catalogue decided by ADR 0001.

The catalogue is code, not configuration: adding or changing an entry goes
through code review and a release.  CLI arguments, environment variables and
local files can only select an environment *name* — never a URL.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable
from urllib.parse import urlsplit


from shortdrama_cli.api.errors import ApiConfigurationError
from shortdrama_cli.i18n import t

@dataclass(frozen=True)
class TrustedEndpoint:
    """One reviewed backend destination.

    ``plaintext_http`` must be set explicitly before an ``http://`` entry is
    accepted, so plaintext transport stays visible in code review instead of
    hiding in runtime behaviour.
    """

    name: str
    api_base: str
    plaintext_http: bool = False


TRUSTED_ENDPOINTS: dict[str, TrustedEndpoint] = {
    entry.name: entry
    for entry in (
        TrustedEndpoint("prod", "http://101.126.6.208/", plaintext_http=True),
        TrustedEndpoint("test", "http://shortdrama-main-test.col.com/", plaintext_http=True),
        TrustedEndpoint("dev", "http://127.0.0.1:8000/", plaintext_http=True),
    )
}

DEFAULT_ENVIRONMENT = "prod"


def resolve_endpoint(environment: str) -> TrustedEndpoint:
    """Return a trusted endpoint or reject a stale/untrusted environment name."""

    try:
        return TRUSTED_ENDPOINTS[environment]
    except KeyError as error:
        raise ApiConfigurationError(t("endpoint.untrusted_environment", environment=environment)) from error


def _validate_catalogue(entries: Iterable[TrustedEndpoint]) -> None:
    """Refuse a catalogue that smuggles in plaintext HTTP without a marker."""

    for entry in entries:
        scheme = urlsplit(entry.api_base).scheme
        if scheme not in {"http", "https"}:
            raise ValueError(f"受信端点 {entry.name} 的地址缺少 http/https scheme：{entry.api_base}")
        if scheme == "http" and not entry.plaintext_http:
            raise ValueError(f"受信端点 {entry.name} 是明文 HTTP，必须显式标注 plaintext_http=True。")


_validate_catalogue(TRUSTED_ENDPOINTS.values())
