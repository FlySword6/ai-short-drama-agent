"""Frozen v0.3 generation estimate, confirm and submit commands."""

from __future__ import annotations

from typing import Annotated, Any, Literal

import typer

from shortdrama_cli.cli.common import ClientIdempotencyKey, invoke
from shortdrama_cli.cli.v030._helpers import _json_payload, _path, _write

generation_app = typer.Typer(help="估价、确认和提交必须分三步。")


@generation_app.command("models")
def generation_models() -> None:
    invoke("generation_models", "GET", _path("generation-models"))


@generation_app.command("capability-tiers")
def generation_tiers(
    media_type: Annotated[Literal["image", "video", "audio"], typer.Option("--media-type")],
) -> None:
    invoke(
        "generation_capability_tiers",
        "GET",
        _path("generation", "capability-tiers", query={"media_type": media_type}),
    )


def _paid(action: str, path: str, key: str | None, **body: Any) -> None:
    _write(action, "POST", path, key, **body)


@generation_app.command("estimate")
def generation_estimate(payload: Annotated[str, typer.Option("--payload", help="JSON 由 agent 传入，不在 CLI 重解释。")], client_idempotency_key: ClientIdempotencyKey = None) -> None:
    body = _json_payload(payload)
    full_input_keys = {
        "project_id",
        "episode_id",
        "scene_id",
        "shot_id",
        "target_asset_entity_id",
        "prompt",
        "supplement_prompt",
        "audio_prompt_dimensions",
        "reference_media_ids",
        "first_frame_media_id",
        "last_frame_media_id",
        "references",
        "client_idempotency_key",
    }
    if full_input_keys.intersection(body):
        _paid(
            "generation_estimate",
            _path("generations", "estimate"),
            client_idempotency_key,
            **body,
        )
        return
    if client_idempotency_key:
        raise typer.BadParameter("简单估价不接受 --client-idempotency-key；正式生成估价请传完整生成参数。")
    invoke("generation_estimate", "POST", _path("generations", "estimate"), body)


@generation_app.command("confirm")
def generation_confirm(quote_id: Annotated[str, typer.Option("--quote-id")]) -> None:
    invoke("generation_confirm", "POST", _path("generation-quotes", quote_id, "confirm"))


@generation_app.command("submit")
def generation_submit(payload: Annotated[str, typer.Option("--payload")], client_idempotency_key: ClientIdempotencyKey = None) -> None:
    _paid(
        "generation_submit",
        _path("generations"),
        client_idempotency_key,
        **_json_payload(payload),
    )


@generation_app.command("batch-estimate")
def generation_batch_estimate(payload: Annotated[str, typer.Option("--payload")]) -> None:
    invoke(
        "generation_batch_estimate",
        "POST",
        _path("generations", "batch-estimate"),
        _json_payload(payload),
    )


@generation_app.command("batch-confirm")
def generation_batch_confirm(payload: Annotated[str, typer.Option("--payload")], client_idempotency_key: ClientIdempotencyKey = None) -> None:
    _paid(
        "generation_batch_confirm",
        _path("generations", "batch-confirm"),
        client_idempotency_key,
        **_json_payload(payload),
    )


@generation_app.command("batch-submit")
def generation_batch_submit(authorization_id: Annotated[str, typer.Option("--authorization-id")]) -> None:
    invoke(
        "generation_batch_submit",
        "POST",
        _path("generation-batches", authorization_id, "submit"),
    )


# 项目生成默认策略是另一个后端模块（`origin/dev:src/modules/generation/defaults/routes.ts`），
# 不碰参考测试本身，所以命令挂在 generation 组，不在 reference-test 组。


@generation_app.command("default-get")
def generation_default_get(
    project_id: Annotated[str, typer.Option("--project-id")],
) -> None:
    invoke(
        "generation_default_get",
        "GET",
        _path("projects", project_id, "generation-defaults"),
    )


@generation_app.command("default-update")
def generation_default_update(
    project_id: Annotated[str, typer.Option("--project-id")],
    media_kind: Annotated[Literal["image", "video"], typer.Option("--media-kind", help="默认策略按媒体类型分开存。")],
    mode: Annotated[Literal["direct_reference", "material_to_prompt"], typer.Option("--mode")],
    model_key: Annotated[str, typer.Option("--model-key")],
    expected_version: Annotated[
        int,
        typer.Option(
            "--expected-version",
            help="默认策略记录的乐观锁版本；来自 generation default-get 返回的 version（首次设置传 0）。",
        ),
    ],
    parameters: Annotated[
        str | None,
        typer.Option("--parameters", help="JSON 对象；缺省为空对象。"),
    ] = None,
    source_generation_request_id: Annotated[
        str | None,
        typer.Option("--source-generation-request-id"),
    ] = None,
) -> None:
    """服务端是 PUT，且按 media_kind 分开（`defaults/routes.ts:57`, `putSchema`）。"""

    body: dict[str, Any] = {
        "mode": mode,
        "model_key": model_key,
        "parameters": _json_payload(parameters, "--parameters") if parameters else {},
        "expected_version": expected_version,
    }
    if source_generation_request_id is not None:
        body["source_generation_request_id"] = source_generation_request_id
    invoke(
        "generation_default_update",
        "PUT",
        _path("projects", project_id, "generation-defaults", media_kind),
        body,
    )


@generation_app.command("project-list")
def generation_project_list(project_id: Annotated[str, typer.Option("--project-id")]) -> None:
    """列本项目全部生成记录。"""

    invoke("generation_project_list", "GET", _path("projects", project_id, "generations"))


@generation_app.command("failed-list")
def generation_failed_list(
    page: Annotated[int | None, typer.Option("--page")] = None,
    page_size: Annotated[int | None, typer.Option("--page-size")] = None,
) -> None:
    """列当前用户失败的生成任务。"""

    invoke("generation_failed_list", "GET", _path("generations", "failed", query={"page": page, "page_size": page_size}))
