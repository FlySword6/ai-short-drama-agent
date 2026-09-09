"""Reference-test workbench commands for the card-drawing workflow.

线路契约 2026-08-12 对着后端源码核过：
`origin/dev:src/modules/referenceTests/routes.ts` 的**每一条**路由都嵌在
`/api/v1/projects/:project_id/` 下面；默认策略在
`origin/dev:src/modules/generation/defaults/routes.ts`。

这些 body schema 全部 `.strict()`，多一个未知键就是 400——所以这里一律用
`invoke` 显式拼 body，**不能用 `_write`**：它会往 body 里注入
`client_idempotency_key`，那是个未知键。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

import typer

from shortdrama_cli.cli.common import invoke
from shortdrama_cli.cli.v030._helpers import _json_payload, _path

reference_test_app = typer.Typer(
    help="参考测试工作台：建立测试、挂上生成结果、挑一个设为项目默认策略。"
)

MediaKind = Literal["image", "video"]
TestMode = Literal["direct_reference", "material_to_prompt"]


def _reference_test_body(
    name: str,
    media_kind: str,
    mode: str,
    model_key: str,
    payload: str | None,
) -> dict[str, Any]:
    """Assemble `referenceTestBody`（`routes.ts:24-34`）。strict——不许多键。"""

    body: dict[str, Any] = {
        "name": name,
        "media_kind": media_kind,
        "mode": mode,
        "model_key": model_key,
    }
    if payload is not None:
        extra = _json_payload(payload)
        unknown = set(extra) - {"prompt", "parameters", "reference_media_ids"}
        if unknown:
            raise typer.BadParameter(
                "--payload 只接受 prompt、parameters、reference_media_ids；"
                f"服务端会拒绝未知字段：{'、'.join(sorted(unknown))}。"
            )
        body.update(extra)
    return body


@reference_test_app.command("create")
def reference_test_create(
    project_id: Annotated[str, typer.Option("--project-id")],
    name: Annotated[str, typer.Option("--name", help="测试名称，服务端必填。")],
    media_kind: Annotated[MediaKind, typer.Option("--media-kind")],
    mode: Annotated[TestMode, typer.Option("--mode")],
    model_key: Annotated[str, typer.Option("--model-key", help="模型键；不是 model_id。")],
    payload: Annotated[
        str | None,
        typer.Option("--payload", help="可选 JSON，只收 prompt、parameters、reference_media_ids。"),
    ] = None,
) -> None:
    invoke(
        "reference_test_create",
        "POST",
        _path("projects", project_id, "reference-tests"),
        _reference_test_body(name, media_kind, mode, model_key, payload),
    )


@reference_test_app.command("list")
def reference_test_list(
    project_id: Annotated[str, typer.Option("--project-id")],
) -> None:
    invoke("reference_test_list", "GET", _path("projects", project_id, "reference-tests"))


@reference_test_app.command("get")
def reference_test_get(
    project_id: Annotated[str, typer.Option("--project-id")],
    reference_test_id: Annotated[str, typer.Option("--reference-test-id")],
) -> None:
    invoke(
        "reference_test_get",
        "GET",
        _path("projects", project_id, "reference-tests", reference_test_id),
    )


@reference_test_app.command("update")
def reference_test_update(
    project_id: Annotated[str, typer.Option("--project-id")],
    reference_test_id: Annotated[str, typer.Option("--reference-test-id")],
    name: Annotated[str, typer.Option("--name")],
    media_kind: Annotated[MediaKind, typer.Option("--media-kind")],
    mode: Annotated[TestMode, typer.Option("--mode")],
    model_key: Annotated[str, typer.Option("--model-key")],
    expected_version: Annotated[
        int,
        typer.Option(
            "--expected-version",
            help="参考测试记录的乐观锁版本；来自 reference-test get 返回的 version。",
        ),
    ],
    payload: Annotated[str | None, typer.Option("--payload")] = None,
) -> None:
    """服务端是整体替换（PUT）而不是局部更新，所以四个字段都必须给。"""

    body = _reference_test_body(name, media_kind, mode, model_key, payload)
    body["expected_version"] = expected_version
    invoke(
        "reference_test_update",
        "PUT",
        _path("projects", project_id, "reference-tests", reference_test_id),
        body,
    )


@reference_test_app.command("delete")
def reference_test_delete(
    project_id: Annotated[str, typer.Option("--project-id")],
    reference_test_id: Annotated[str, typer.Option("--reference-test-id")],
    expected_version: Annotated[
        int,
        typer.Option(
            "--expected-version",
            help="参考测试记录的乐观锁版本；来自 reference-test get 返回的 version。",
        ),
    ],
) -> None:
    invoke(
        "reference_test_delete",
        "DELETE",
        _path("projects", project_id, "reference-tests", reference_test_id),
        {"expected_version": expected_version},
    )


@reference_test_app.command("result-attach")
def reference_test_result_attach(
    project_id: Annotated[str, typer.Option("--project-id")],
    reference_test_id: Annotated[str, typer.Option("--reference-test-id")],
    generation_request_id: Annotated[str, typer.Option("--generation-request-id")],
    media_result_id: Annotated[str, typer.Option("--media-result-id")],
) -> None:
    """把一次已完成的生成挂到这个测试下面。

    服务端没有「跑测试」这条路：生成走正常的 estimate / confirm / submit
    三步，拿到产物之后用这条命令挂上来（`routes.ts:109`, `attachResultBody`）。
    """

    invoke(
        "reference_test_result_attach",
        "POST",
        _path("projects", project_id, "reference-tests", reference_test_id, "results"),
        {
            "generation_request_id": generation_request_id,
            "media_result_id": media_result_id,
        },
    )


@reference_test_app.command("result-list")
def reference_test_result_list(
    project_id: Annotated[str, typer.Option("--project-id")],
    reference_test_id: Annotated[str, typer.Option("--reference-test-id")],
    page: Annotated[
        int | None,
        typer.Option("--page", help="结果分页页码；不传用服务端默认。"),
    ] = None,
    page_size: Annotated[
        int | None,
        typer.Option("--page-size", help="每页结果数；不传用服务端默认。"),
    ] = None,
) -> None:
    """单个测试的结果列表；服务端分页（`resultPagination`，routes.ts:21-24）。"""

    invoke(
        "reference_test_result_list",
        "GET",
        _path(
            "projects",
            project_id,
            "reference-tests",
            reference_test_id,
            "results",
            query={"page": page, "page_size": page_size},
        ),
    )


@reference_test_app.command("result-stream")
def reference_test_result_stream(
    project_id: Annotated[str, typer.Option("--project-id")],
    page: Annotated[
        int | None,
        typer.Option("--page", help="结果分页页码；不传用服务端默认。"),
    ] = None,
    page_size: Annotated[
        int | None,
        typer.Option("--page-size", help="每页结果数；不传用服务端默认。"),
    ] = None,
    media_kind: Annotated[
        MediaKind | None,
        typer.Option("--media-kind", help="按媒体类型过滤；不传返回全部类型。"),
    ] = None,
) -> None:
    """项目级的结果流水，跨所有测试（`pagination`，routes.ts:15-20）。"""

    invoke(
        "reference_test_result_stream",
        "GET",
        _path(
            "projects",
            project_id,
            "reference-test-results",
            query={"page": page, "page_size": page_size, "media_kind": media_kind},
        ),
    )


@reference_test_app.command("set-default")
def reference_test_set_default(
    project_id: Annotated[str, typer.Option("--project-id")],
    reference_test_id: Annotated[str, typer.Option("--reference-test-id")],
    result_id: Annotated[str, typer.Option("--result-id")],
    expected_version: Annotated[
        int,
        typer.Option(
            "--expected-version",
            help="默认策略记录的乐观锁版本——不是参考测试的版本；"
            "来自 generation default-get 返回的 version（首次设置传 0）。",
        ),
    ],
) -> None:
    """把某个测试结果定为项目默认策略（`routes.ts:124`, `setDefaultBody`）。"""

    invoke(
        "reference_test_set_default",
        "POST",
        _path(
            "projects",
            project_id,
            "reference-tests",
            reference_test_id,
            "results",
            result_id,
            "set-default",
        ),
        {"expected_version": expected_version},
    )

# `/generation-defaults` 不属参考测试：它是另一个后端模块
# （`generation/defaults/routes.ts`），命令挂在 generation 组
# （`generation default-get` / `generation default-update`）。
