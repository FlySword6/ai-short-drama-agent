"""Frozen v0.3 script text and breakdown commands."""

from __future__ import annotations

from typing import Annotated

import typer

from shortdrama_cli.cli.common import ClientIdempotencyKey, invoke
from shortdrama_cli.cli.v030._helpers import _path, _write

script_app = typer.Typer(help="剧本文本与拆解。")


@script_app.command("paste")
def script_paste(episode_id: Annotated[str, typer.Option("--episode-id")], text: Annotated[str, typer.Option("--text")], title: Annotated[str | None, typer.Option("--title")] = None, client_idempotency_key: ClientIdempotencyKey = None) -> None:
    _write(
        "script_paste",
        "POST",
        _path("episodes", episode_id, "script-versions"),
        client_idempotency_key,
        script_text=text,
        title=title,
    )


@script_app.command("versions")
def script_versions(episode_id: Annotated[str, typer.Option("--episode-id")]) -> None:
    invoke("script_versions", "GET", _path("episodes", episode_id, "script-versions"))


@script_app.command("breakdown")
def script_breakdown(episode_id: Annotated[str, typer.Option("--episode-id")], script_version_id: Annotated[str, typer.Option("--script-version-id")], target_duration_sec: Annotated[int | None, typer.Option("--target-duration-sec")] = None, client_idempotency_key: ClientIdempotencyKey = None) -> None:
    _write(
        "script_breakdown",
        "POST",
        _path("episodes", episode_id, "script-breakdowns"),
        client_idempotency_key,
        script_version_id=script_version_id,
        target_duration_sec=target_duration_sec,
    )


@script_app.command("status")
def script_status(run_id: Annotated[str, typer.Option("--run-id")]) -> None:
    invoke("script_status", "GET", _path("script-breakdowns", run_id))


@script_app.command("resume")
def script_resume(run_id: Annotated[str, typer.Option("--run-id")]) -> None:
    invoke("script_resume", "POST", _path("script-breakdowns", run_id, "resume"))


@script_app.command("confirm")
def script_confirm(run_id: Annotated[str, typer.Option("--run-id")]) -> None:
    invoke("script_confirm", "POST", _path("script-breakdowns", run_id, "confirm"))
