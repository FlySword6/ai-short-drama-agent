"""Frozen v0.3 project, episode, scene and shot commands."""

from __future__ import annotations

from typing import Annotated

import typer

from shortdrama_cli.cli.common import invoke
from shortdrama_cli.cli.v030._helpers import _path, _require_human_confirmation
from shortdrama_cli.i18n import t

project_app = typer.Typer(help="项目与集。")


@project_app.command("list")
def project_list() -> None:
    invoke("project_list", "GET", _path("projects"))


@project_app.command("create")
def project_create(name: Annotated[str, typer.Option("--name")], description: Annotated[str | None, typer.Option("--description")] = None) -> None:
    invoke("project_create", "POST", _path("projects"), {
        "name": name,
        **({"description": description} if description is not None else {}),
    })


@project_app.command("get")
def project_get(project_id: Annotated[str, typer.Option("--project-id")]) -> None:
    invoke("project_get", "GET", _path("projects", project_id))


@project_app.command("update")
def project_update(project_id: Annotated[str, typer.Option("--project-id")], name: Annotated[str | None, typer.Option("--name")] = None, description: Annotated[str | None, typer.Option("--description")] = None) -> None:
    if name is None and description is None:
        raise typer.BadParameter("至少提供一个可更新字段。")
    invoke("project_update", "PATCH", _path("projects", project_id), {
        **({"name": name} if name is not None else {}),
        **({"description": description} if description is not None else {}),
    })


@project_app.command("episode-list")
def episode_list(project_id: Annotated[str, typer.Option("--project-id")]) -> None:
    invoke("episode_list", "GET", _path("projects", project_id, "episodes"))


@project_app.command("episode-create")
def episode_create(project_id: Annotated[str, typer.Option("--project-id")], episode_no: Annotated[int, typer.Option("--episode-no")], name: Annotated[str | None, typer.Option("--name")] = None) -> None:
    invoke("episode_create", "POST", _path("projects", project_id, "episodes"), {
        "episode_no": episode_no,
        **({"name": name} if name is not None else {}),
    })


@project_app.command("episode-get")
def episode_get(episode_id: Annotated[str, typer.Option("--episode-id")]) -> None:
    invoke("episode_get", "GET", _path("episodes", episode_id))


@project_app.command("scene-list")
def scene_list(episode_id: Annotated[str, typer.Option("--episode-id")]) -> None:
    invoke("scene_list", "GET", _path("episodes", episode_id, "scenes"))


@project_app.command("shot-list")
def shot_list(episode_id: Annotated[str, typer.Option("--episode-id")]) -> None:
    invoke("shot_list", "GET", _path("episodes", episode_id, "shots"))


@project_app.command("shot-get")
def shot_get(shot_id: Annotated[str, typer.Option("--shot-id")]) -> None:
    """读取一镜的可编辑生产字段。"""

    invoke("shot_get", "GET", _path("shots", shot_id))


@project_app.command("shot-update")
def shot_update(
    shot_id: Annotated[str, typer.Option("--shot-id")],
    framing: Annotated[str | None, typer.Option("--framing")] = None,
    camera_movement: Annotated[str | None, typer.Option("--camera-movement")] = None,
    duration: Annotated[int | None, typer.Option("--duration")] = None,
    visual_prompt: Annotated[str | None, typer.Option("--visual-prompt")] = None,
) -> None:
    """修改一镜的一个或多个可编辑字段。"""

    if all(value is None for value in (framing, camera_movement, duration, visual_prompt)):
        raise typer.BadParameter(t("shot.update.missing_fields"))
    invoke("shot_update", "PATCH", _path("shots", shot_id), {
        **({"framing": framing} if framing is not None else {}),
        **({"camera_movement": camera_movement} if camera_movement is not None else {}),
        **({"duration": duration} if duration is not None else {}),
        **({"visual_prompt": visual_prompt} if visual_prompt is not None else {}),
    })


@project_app.command("shot-delete")
def shot_delete(
    shot_id: Annotated[str, typer.Option("--shot-id")],
    i_mean_it: Annotated[bool, typer.Option("--i-mean-it")] = False,
) -> None:
    """经人工确认后不可逆地删除一个多余镜头。"""

    if not i_mean_it:
        raise typer.BadParameter(t("shot.delete.confirmation_required"))
    invoke("shot_delete", "DELETE", _path("shots", shot_id))


@project_app.command("shot-media-list")
def shot_media_list(shot_id: Annotated[str, typer.Option("--shot-id")]) -> None:
    """列出一镜已经生成的媒体产物。"""

    invoke("shot_media_list", "GET", _path("shots", shot_id, "media"))


@project_app.command("episode-production-status")
def episode_production_status(episode_id: Annotated[str, typer.Option("--episode-id")]) -> None:
    """读取整集生产卡点的状态汇总。"""

    invoke("episode_production_status", "GET", _path("episodes", episode_id, "production-status"))


@project_app.command("episode-playback")
def episode_playback(episode_id: Annotated[str, typer.Option("--episode-id")]) -> None:
    """读取整集播放信息。"""

    invoke("episode_playback", "GET", _path("episodes", episode_id, "playback"))


@project_app.command("member-directory")
def project_member_directory(query: Annotated[str, typer.Option("--query")]) -> None:
    """按名称搜索成员目录，取得派单需要的真实 user_id。"""

    invoke("project_member_directory", "GET", _path("users", "directory", query={"q": query}))


@project_app.command("member-list")
def project_member_list(project_id: Annotated[str, typer.Option("--project-id")]) -> None:
    """列项目成员与项目角色。"""

    invoke("project_member_list", "GET", _path("projects", project_id, "members"))


@project_app.command("member-add")
def project_member_add(
    project_id: Annotated[str, typer.Option("--project-id")],
    user_id: Annotated[str, typer.Option("--user-id")],
    role: Annotated[str, typer.Option("--role")],
) -> None:
    """以真实 user_id 和项目角色添加成员。"""

    invoke(
        "project_member_add",
        "POST",
        _path("projects", project_id, "members"),
        {"user_id": user_id, "role": role},
    )


@project_app.command("member-update")
def project_member_update(
    project_id: Annotated[str, typer.Option("--project-id")],
    user_id: Annotated[str, typer.Option("--user-id")],
    role: Annotated[str, typer.Option("--role")],
) -> None:
    """修改成员项目角色。"""

    invoke(
        "project_member_update",
        "PATCH",
        _path("projects", project_id, "members", user_id),
        {"role": role},
    )


@project_app.command("member-remove")
def project_member_remove(
    project_id: Annotated[str, typer.Option("--project-id")],
    user_id: Annotated[str, typer.Option("--user-id")],
    i_mean_it: Annotated[bool, typer.Option("--i-mean-it")] = False,
) -> None:
    """经人工确认后不可逆地移除项目成员。"""

    _require_human_confirmation(i_mean_it, "移除项目成员")
    invoke("project_member_remove", "DELETE", _path("projects", project_id, "members", user_id))


@project_app.command("costs")
def project_costs(
    project_id: Annotated[str, typer.Option("--project-id")],
    group_by: Annotated[str, typer.Option("--group-by")],
    page: Annotated[int | None, typer.Option("--page")] = None,
    page_size: Annotated[int | None, typer.Option("--page-size")] = None,
    from_date: Annotated[str | None, typer.Option("--from")] = None,
    to_date: Annotated[str | None, typer.Option("--to")] = None,
) -> None:
    """看项目花费汇总，按成员、模型或日期分组。"""

    invoke(
        "project_costs",
        "GET",
        _path(
            "projects",
            project_id,
            "costs",
            query={
                "group_by": group_by,
                "page": page,
                "page_size": page_size,
                "from": from_date,
                "to": to_date,
            },
        ),
    )


@project_app.command("consumption-records")
def project_consumption_records(
    project_id: Annotated[str, typer.Option("--project-id")],
    page: Annotated[int | None, typer.Option("--page")] = None,
    page_size: Annotated[int | None, typer.Option("--page-size")] = None,
    task_type: Annotated[str | None, typer.Option("--task-type")] = None,
    model: Annotated[str | None, typer.Option("--model")] = None,
    from_date: Annotated[str | None, typer.Option("--from")] = None,
    to_date: Annotated[str | None, typer.Option("--to")] = None,
) -> None:
    """看项目消费明细。"""

    invoke(
        "project_consumption_records",
        "GET",
        _path(
            "projects",
            project_id,
            "consumption",
            "records",
            query={
                "page": page,
                "page_size": page_size,
                "task_type": task_type,
                "model": model,
                "from": from_date,
                "to": to_date,
            },
        ),
    )
