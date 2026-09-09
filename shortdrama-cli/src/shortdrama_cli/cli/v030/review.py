"""Frozen v0.3 media review and shot primary-version commands."""

from __future__ import annotations

from typing import Annotated, Literal

import typer

from shortdrama_cli.cli.common import invoke
from shortdrama_cli.cli.v030._helpers import _path, _require_human_confirmation

review_app = typer.Typer(help="媒体审核与镜头主版本。")


@review_app.command("decide")
def review_decide(
    project_id: Annotated[str, typer.Option("--project-id")],
    media_result_id: Annotated[str, typer.Option("--media-result-id")],
    action: Annotated[Literal["approve", "reject"], typer.Option("--action")],
    rejection_reason: Annotated[str | None, typer.Option("--rejection-reason")] = None,
    i_mean_it: Annotated[bool, typer.Option("--i-mean-it")] = False,
) -> None:
    _require_human_confirmation(i_mean_it, "媒体审核")
    if action == "reject" and not rejection_reason:
        raise typer.BadParameter("拒绝媒体必须提供 --rejection-reason，说明需要修改的业务原因。")
    if action == "approve" and rejection_reason:
        raise typer.BadParameter("通过媒体时不能提供 --rejection-reason。")
    decision = {
        "media_result_id": media_result_id,
        "action": action,
        **({"rejection_reason": rejection_reason} if rejection_reason else {}),
    }
    invoke(
        "review_decide",
        "POST",
        _path("projects", project_id, "media-reviews", "decisions"),
        {"decisions": [decision]},
    )


@review_app.command("set-primary")
def review_set_primary(
    shot_id: Annotated[str, typer.Option("--shot-id")],
    media_id: Annotated[str, typer.Option("--media-id")],
    i_mean_it: Annotated[bool, typer.Option("--i-mean-it")] = False,
) -> None:
    _require_human_confirmation(i_mean_it, "设置镜头主版本")
    invoke(
        "review_set_primary",
        "POST",
        _path("shots", shot_id, "media", media_id, "set-primary"),
    )
