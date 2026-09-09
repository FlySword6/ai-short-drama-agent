"""Frozen v0.3 scene prep-list commands."""

from __future__ import annotations

from typing import Annotated, Any

import typer

from shortdrama_cli.cli.common import ClientIdempotencyKey, invoke
from shortdrama_cli.cli.v030._helpers import _path, _write

prep_app = typer.Typer(help="场级备戏清单。")


@prep_app.command("list")
def prep_list(scene_id: Annotated[str, typer.Option("--scene-id")]) -> None:
    invoke("prep_list", "GET", _path("scenes", scene_id, "prep-list"))


@prep_app.command("pull")
def prep_pull(
    scene_id: Annotated[str, typer.Option("--scene-id")],
    lane: Annotated[str, typer.Option("--lane")],
    asset_id: Annotated[str, typer.Option("--asset-id")],
    asset_variant_id: Annotated[str | None, typer.Option("--asset-variant-id")] = None,
    asset_media_id: Annotated[str | None, typer.Option("--asset-media-id")] = None,
    client_idempotency_key: ClientIdempotencyKey = None,
) -> None:
    _write(
        "prep_pull",
        "POST",
        _path("scenes", scene_id, "prep-list", "items"),
        client_idempotency_key,
        lane=lane,
        asset_entity_id=asset_id,
        asset_variant_id=asset_variant_id,
        asset_media_id=asset_media_id,
    )


@prep_app.command("remove")
def prep_remove(scene_id: Annotated[str, typer.Option("--scene-id")], item_id: Annotated[str, typer.Option("--item-id")]) -> None:
    invoke(
        "prep_remove",
        "DELETE",
        _path("scenes", scene_id, "prep-list", "items", item_id),
    )


@prep_app.command("send")
def prep_send(scene_id: Annotated[str, typer.Option("--scene-id")], item: Annotated[list[str], typer.Option("--item")], shot: Annotated[list[str], typer.Option("--shot")] = [], all_shots: Annotated[bool, typer.Option("--all-shots")] = False, i_mean_it: Annotated[bool, typer.Option("--i-mean-it")] = False, client_idempotency_key: ClientIdempotencyKey = None) -> None:
    if shot and all_shots:
        raise typer.BadParameter("--shot 与 --all-shots 互斥。")
    if all_shots and not i_mean_it:
        raise typer.BadParameter("--all-shots 必须同时提供 --i-mean-it。")
    body: dict[str, Any] = {"item_ids": item}
    if shot:
        body["shot_ids"] = shot
    if all_shots:
        body["all_shots"] = True
        body["i_mean_it"] = True
    _write(
        "prep_send",
        "POST",
        _path("scenes", scene_id, "prep-list", "commit"),
        client_idempotency_key,
        **body,
    )
