"""Frozen v0.3 delivery manifest, history and download commands."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from shortdrama_cli.api.errors import ApiConfigurationError, ApiRequestError
from shortdrama_cli.cli.common import fail, invoke, response
from shortdrama_cli.cli.v030._helpers import _business_client, _path
from shortdrama_cli.output import print_response

delivery_app = typer.Typer(help="交付查询和下载。")


@delivery_app.command("manifest")
def delivery_manifest(
    episode_id: Annotated[str, typer.Option("--episode-id")],
    partial: Annotated[bool, typer.Option("--partial")] = False,
) -> None:
    invoke(
        "delivery_manifest",
        "GET",
        _path(
            "episodes",
            episode_id,
            "deliverables",
            query={"partial": str(partial).lower()},
        ),
    )


@delivery_app.command("history")
def delivery_history(episode_id: Annotated[str, typer.Option("--episode-id")]) -> None:
    invoke("delivery_history", "GET", _path("episodes", episode_id, "deliveries"))


@delivery_app.command("record")
def delivery_record(
    episode_id: Annotated[str, typer.Option("--episode-id")],
    purpose: Annotated[str | None, typer.Option("--purpose")] = None,
    partial: Annotated[bool, typer.Option("--partial")] = False,
) -> None:
    invoke(
        "delivery_record",
        "POST",
        _path("episodes", episode_id, "deliveries"),
        {
            **({"purpose": purpose} if purpose else {}),
            "partial": partial,
        },
    )


@delivery_app.command("download")
def delivery_download(
    media_id: Annotated[str, typer.Option("--media-id")],
    output: Annotated[Path, typer.Option("--output", dir_okay=False)],
) -> None:
    try:
        content, _headers = _business_client().download(_path("media", media_id, "download"))
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(content)
    except (ApiConfigurationError, ApiRequestError, OSError) as error:
        fail("delivery_download", error)
    print_response(response("delivery_download", {
        "media_id": media_id,
        "output": str(output),
        "byte_length": len(content),
    }), "json")


@delivery_app.command("csv")
def delivery_csv(
    episode_id: Annotated[str, typer.Option("--episode-id")],
    output: Annotated[Path, typer.Option("--output", dir_okay=False)],
    partial: Annotated[bool, typer.Option("--partial")] = False,
) -> None:
    path = _path(
        "episodes",
        episode_id,
        "deliverables.csv",
        query={"partial": str(partial).lower()},
    )
    try:
        content, _headers = _business_client().download(path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(content)
    except (ApiConfigurationError, ApiRequestError, OSError) as error:
        fail("delivery_csv", error)
    print_response(response("delivery_csv", {
        "episode_id": episode_id,
        "output": str(output),
        "byte_length": len(content),
    }), "json")
