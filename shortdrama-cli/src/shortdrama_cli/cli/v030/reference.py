"""Frozen v0.3 shot-level control-package commands.

线路契约 2026-08-12 对着后端源码核过：`zhongwen-shortdrama-main`
`origin/dev:src/modules/control-packages/routes.ts` —
L41 `GET /shots/:shot_id/control-package`、L46 `PUT .../control-package/ready`、
L52 `POST .../control-package/refs`、L64 `DELETE /control-package-refs/:ref_id`。
"""

from __future__ import annotations

from typing import Annotated, Any

import typer

from shortdrama_cli.api.errors import ApiConfigurationError, ApiRequestError
from shortdrama_cli.cli.common import ClientIdempotencyKey, fail, invoke, response
from shortdrama_cli.cli.v030._helpers import _business_client, _path, _write
from shortdrama_cli.output import print_response

reference_app = typer.Typer(help="镜级参考控制包；只搬运编导指定的参考。")


def _lane_names(catalog: dict[str, Any]) -> set[str]:
    """Extract server-defined reference lanes without assigning requirements."""

    values = catalog.get("lanes", [])
    if not isinstance(values, list):
        return set()
    # 词表接口不过滤停用项（`vocabulary/repository.ts:67-72` 没有 active 条件），
    # 而往停用的栏里加参考会被服务端拒（`control-packages/repository.ts:369`
    # 抛「这个参考栏已停用」）。所以这里自己滤掉，别把编导指到一条必然 422 的路上。
    return {
        value["id"]
        for value in values
        if isinstance(value, dict)
        and isinstance(value.get("id"), str)
        and value.get("active") is not False
    }


def _occupied_lanes(control_package: dict[str, Any]) -> set[str]:
    """Extract only the lanes that already hold at least one binding.

    服务端把 `lanes` 答成一个以参考栏为键的对象，并且把已知的每个栏都预填成
    空列表（`repository.ts:268`）。所以「键存在」什么也不证明——只有非空列表
    才算这一栏已经占上了。
    """

    lanes = control_package.get("lanes", {})
    if not isinstance(lanes, dict):
        return set()
    return {
        lane
        for lane, refs in lanes.items()
        if isinstance(lane, str) and isinstance(refs, list) and refs
    }


def _missing_lanes(catalog: dict[str, Any], control_package: dict[str, Any]) -> list[str]:
    """Return the catalog-minus-bindings difference; no editorial policy belongs here."""

    return sorted(_lane_names(catalog) - _occupied_lanes(control_package))


@reference_app.command("lanes")
def reference_lanes() -> None:
    """Read the server's reference-lane vocabulary."""

    invoke("reference_lanes", "GET", _path("vocabulary", "reference-lanes"))


@reference_app.command("get")
def reference_get(
    shot_id: Annotated[str, typer.Option("--shot-id")],
) -> None:
    """Read one shot's control package."""

    invoke("reference_get", "GET", _path("shots", shot_id, "control-package"))


@reference_app.command("add")
def reference_add(
    shot_id: Annotated[str, typer.Option("--shot-id")],
    lane: Annotated[str, typer.Option("--lane")],
    asset_media_id: Annotated[
        str | None,
        typer.Option("--asset-media-id", help="资产库里的媒体；与 --media-result-id 二选一。"),
    ] = None,
    media_result_id: Annotated[
        str | None,
        typer.Option("--media-result-id", help="生成产物；与 --asset-media-id 二选一。"),
    ] = None,
    note: Annotated[str | None, typer.Option("--note")] = None,
    client_idempotency_key: ClientIdempotencyKey = None,
) -> None:
    """Add one reference binding selected by the director."""

    # 服务端 refBody 的 superRefine 要求两者恰好给一个。在本地就拦下来，
    # 让编导拿到一句中文说明，而不是一条 400。
    if (asset_media_id is None) == (media_result_id is None):
        raise typer.BadParameter("--asset-media-id 与 --media-result-id 必须且只能提供一个。")
    _write(
        "reference_add",
        "POST",
        _path("shots", shot_id, "control-package", "refs"),
        client_idempotency_key,
        lane=lane,
        asset_media_id=asset_media_id,
        media_result_id=media_result_id,
        note=note,
    )


@reference_app.command("remove")
def reference_remove(
    ref_id: Annotated[str, typer.Option("--ref-id", help="参考绑定的 id，来自 reference get 的返回。")],
) -> None:
    """Remove one reference binding.  服务端按 ref 删，不按镜头删。"""

    invoke("reference_remove", "DELETE", _path("control-package-refs", ref_id))


@reference_app.command("ready")
def reference_ready(
    shot_id: Annotated[str, typer.Option("--shot-id")],
    cancel: Annotated[bool, typer.Option("--cancel", help="撤销就位标记。")] = False,
) -> None:
    """Mark the shot control package ready after the director checks it."""

    invoke(
        "reference_ready",
        "PUT",
        _path("shots", shot_id, "control-package", "ready"),
        {"ready": not cancel},
    )


@reference_app.command("missing")
def reference_missing(
    shot_id: Annotated[str, typer.Option("--shot-id")],
) -> None:
    """Report catalog lanes absent from this shot's bindings."""

    try:
        client = _business_client()
        catalog = client.request("GET", _path("vocabulary", "reference-lanes"))
        control_package = client.request("GET", _path("shots", shot_id, "control-package"))
    except (ApiConfigurationError, ApiRequestError) as error:
        fail("reference_missing", error)
    print_response(
        response("reference_missing", {"shot_id": shot_id, "missing_lanes": _missing_lanes(catalog, control_package)}),
        "json",
    )
