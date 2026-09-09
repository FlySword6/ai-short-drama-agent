"""Frozen v0.3 asset search and registration commands."""

from __future__ import annotations

import json
import mimetypes
from pathlib import Path
from typing import Annotated, Any
from uuid import UUID, uuid4

import typer

from shortdrama_cli.api.errors import ApiConfigurationError, ApiRequestError
from shortdrama_cli.cli.common import (
    ClientIdempotencyKey,
    fail,
    invoke,
    response,
)
from shortdrama_cli.cli.v030._helpers import _business_client, _json_payload, _path, _require_human_confirmation
from shortdrama_cli.output import print_response

asset_app = typer.Typer(help="资产查询与登记。")


def _uuid_idempotency_key(value: str | None) -> str:
    if value is None:
        return str(uuid4())
    try:
        return str(UUID(value))
    except ValueError as error:
        raise typer.BadParameter("--client-idempotency-key 必须是 UUID。") from error


@asset_app.command("search")
def asset_search(
    query: Annotated[str | None, typer.Option("--query")] = None,
    scope: Annotated[str | None, typer.Option("--scope")] = None,
    project_id: Annotated[str | None, typer.Option("--project-id")] = None,
) -> None:
    if scope == "project" and not project_id:
        raise typer.BadParameter("--scope project 必须同时提供 --project-id。")
    if project_id and scope != "project":
        raise typer.BadParameter("--project-id 只与 --scope project 一起使用。")
    params = {
        **({"q": query} if query else {}),
        **({"scope": scope} if scope else {}),
        **({"project_id": project_id} if project_id else {}),
        "page_size": 24,
    }
    invoke("asset_search", "GET", _path("assets", query=params))


@asset_app.command("semantic")
def asset_semantic(query: Annotated[str, typer.Option("--query")]) -> None:
    invoke("asset_semantic", "POST", _path("asset-search"), {"query": query})


@asset_app.command("get")
def asset_get(asset_id: Annotated[str, typer.Option("--asset-id")]) -> None:
    invoke("asset_get", "GET", _path("assets", asset_id))


@asset_app.command("registration-schema")
def registration_schema() -> None:
    invoke("asset_registration_schema", "GET", _path("assets", "registration-schema"))


@asset_app.command("register")
def asset_register(
    file: Annotated[Path, typer.Option("--file", exists=True, dir_okay=False)],
    registration_json: Annotated[str, typer.Option(
        "--registration-json",
        help="登记表 JSON 对象；字段必须来自 registration-schema。",
    )],
    asset_kind: Annotated[str | None, typer.Option("--asset-kind")] = None,
    source_project_name: Annotated[str | None, typer.Option("--source-project-name")] = None,
    client_idempotency_key: ClientIdempotencyKey = None,
) -> None:
    key = _uuid_idempotency_key(client_idempotency_key)
    fields = {"client_idempotency_key": key}
    if asset_kind:
        fields["asset_kind_hint"] = asset_kind
    if source_project_name:
        fields["source_project_name"] = source_project_name
    fields["registration"] = json.dumps(_json_payload(registration_json), ensure_ascii=False)
    try:
        value = _business_client().upload(
            _path("asset-upload-tasks"),
            file.name,
            file.read_bytes(),
            mimetypes.guess_type(file.name)[0] or "application/octet-stream",
            fields,
        )
    except (ApiConfigurationError, ApiRequestError) as error:
        fail("asset_register", error)
    print_response(response("asset_register", value), "json")


@asset_app.command("register-status")
def asset_register_status(task_id: Annotated[str, typer.Option("--task-id")]) -> None:
    invoke("asset_register_status", "GET", _path("asset-upload-tasks", task_id))


@asset_app.command("add-to-project")
def asset_add_to_project(project_id: Annotated[str, typer.Option("--project-id")], asset_id: Annotated[str, typer.Option("--asset-id")]) -> None:
    invoke(
        "asset_add_to_project",
        "POST",
        _path("projects", project_id, "assets"),
        {"asset_entity_id": asset_id},
    )


@asset_app.command("project-list")
def asset_project_list(project_id: Annotated[str, typer.Option("--project-id")]) -> None:
    invoke("asset_project_list", "GET", _path("projects", project_id, "assets"))


@asset_app.command("remove-from-project")
def asset_remove_from_project(
    project_id: Annotated[str, typer.Option("--project-id")],
    ref_id: Annotated[str, typer.Option("--ref-id")],
    i_mean_it: Annotated[bool, typer.Option("--i-mean-it")] = False,
) -> None:
    """经人工确认后不可逆地解绑项目资产。"""

    _require_human_confirmation(i_mean_it, "解绑项目资产")
    invoke("asset_remove_from_project", "DELETE", _path("projects", project_id, "assets", ref_id))


@asset_app.command("version-list")
def asset_version_list(asset_id: Annotated[str, typer.Option("--asset-id")]) -> None:
    invoke("asset_version_list", "GET", _path("assets", asset_id, "versions"))


@asset_app.command("version-add")
def asset_version_add(
    asset_id: Annotated[str, typer.Option("--asset-id")],
    file: Annotated[Path, typer.Option("--file", exists=True, dir_okay=False)],
    title: Annotated[str | None, typer.Option("--title")] = None,
    description: Annotated[str | None, typer.Option("--description")] = None,
    variant_id: Annotated[str | None, typer.Option("--variant-id")] = None,
    is_primary: Annotated[bool, typer.Option("--is-primary")] = False,
) -> None:
    fields: dict[str, str] = {}
    if title:
        fields["title"] = title
    if description:
        fields["description"] = description
    if variant_id:
        fields["asset_variant_id"] = variant_id
    if is_primary:
        fields["is_primary"] = "true"
    # 后端 multipart 解析只放三个字段位；本地先拦，别让它变成请求级错误。
    if len(fields) > 3:
        raise typer.BadParameter("--title/--description/--variant-id/--is-primary 合计最多三项。")
    try:
        value = _business_client().upload(
            _path("assets", asset_id, "media"),
            file.name,
            file.read_bytes(),
            mimetypes.guess_type(file.name)[0] or "application/octet-stream",
            fields,
        )
    except (ApiConfigurationError, ApiRequestError) as error:
        fail("asset_version_add", error)
    print_response(response("asset_version_add", value), "json")


@asset_app.command("version-set-primary")
def asset_version_set_primary(
    asset_id: Annotated[str, typer.Option("--asset-id")],
    media_id: Annotated[str, typer.Option("--media-id")],
    i_mean_it: Annotated[bool, typer.Option("--i-mean-it")] = False,
) -> None:
    if not i_mean_it:
        raise typer.BadParameter("设置资产主媒体版本会改变生产事实；请人工确认后提供 --i-mean-it。")
    invoke(
        "asset_version_set_primary",
        "POST",
        _path("assets", asset_id, "media", media_id, "set-primary"),
    )


@asset_app.command("variant-list")
def asset_variant_list(asset_id: Annotated[str, typer.Option("--asset-id")]) -> None:
    invoke("asset_variant_list", "GET", _path("assets", asset_id, "variants"))


@asset_app.command("variant-create")
def asset_variant_create(
    asset_id: Annotated[str, typer.Option("--asset-id")],
    name: Annotated[str, typer.Option("--name")],
    variant_kind: Annotated[str, typer.Option("--kind", help="变体类别，取服务端值；缺省 look。")] = "look",
    description: Annotated[str | None, typer.Option("--description")] = None,
    usage_context: Annotated[str | None, typer.Option("--usage-context")] = None,
    visual_prompt: Annotated[str | None, typer.Option("--visual-prompt")] = None,
    episode_no: Annotated[list[int], typer.Option("--episode-no", help="适用集数；可重复。")] = [],
    sort_order: Annotated[int, typer.Option("--sort-order")] = 0,
    is_primary: Annotated[bool, typer.Option("--is-primary")] = False,
) -> None:
    body: dict[str, Any] = {
        "name": name,
        "variant_kind": variant_kind,
        "is_primary": is_primary,
        "sort_order": sort_order,
    }
    if description:
        body["description"] = description
    if usage_context:
        body["usage_context"] = usage_context
    if visual_prompt:
        body["visual_prompt"] = visual_prompt
    if episode_no:
        body["episode_nos"] = episode_no
    invoke("asset_variant_create", "POST", _path("assets", asset_id, "variants"), body)
