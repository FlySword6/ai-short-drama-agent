"""Helpers shared by more than one v0.3 domain module."""

from __future__ import annotations

import json
from typing import Any, Mapping
from urllib.parse import quote, urlencode

import typer

from shortdrama_cli.cli.common import invoke, write_body
from shortdrama_cli.i18n import t
from shortdrama_cli.server_api import BusinessServerClient


def _path(
    *segments: str,
    query: Mapping[str, str | int | bool | None] | None = None,
) -> str:
    """Build an API path without allowing values to change its route shape."""

    if not segments or any(segment == "" for segment in segments):
        raise typer.BadParameter(t("path.empty_segment"))
    path = "/" + "/".join(quote(segment, safe="") for segment in segments)
    if query is not None:
        encoded_query = urlencode(
            {key: value for key, value in query.items() if value is not None}
        )
        if encoded_query:
            path += f"?{encoded_query}"
    return path


def _write(action: str, method: str, path: str, key: str | None, **body: Any) -> None:
    invoke(action, method, path, write_body(key, **body))


def _require_human_confirmation(i_mean_it: bool, action_label: str) -> None:
    if not i_mean_it:
        raise typer.BadParameter(f"{action_label}会改变生产事实；请人工确认后提供 --i-mean-it。")


def _json_payload(value: str, flag: str = "--payload") -> dict[str, Any]:
    """解析调用方给的 JSON 对象；报错必须指出实际传坏的那个旗标。"""

    try:
        decoded = json.loads(value)
    except json.JSONDecodeError as error:
        raise typer.BadParameter(f"{flag} 必须是 JSON 对象。") from error
    if not isinstance(decoded, dict):
        raise typer.BadParameter(f"{flag} 必须是 JSON 对象。")
    return decoded


def _business_client() -> BusinessServerClient:
    """Build the business client through the frozen surface module.

    `shortdrama_cli.cli.v030.build_business_client` is the seam the contract
    tests replace, so the name is resolved per call instead of being bound at
    import time inside each domain module.
    """

    from shortdrama_cli.cli import v030

    return v030.build_business_client()


def _login_client(environment: str) -> BusinessServerClient:
    """Build the anonymous login client through the same test seam."""

    from shortdrama_cli.cli import v030

    return v030.build_login_client(environment)
