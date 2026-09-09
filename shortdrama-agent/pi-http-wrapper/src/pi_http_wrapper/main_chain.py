"""Main API tools backed by the commit-pinned shortdrama CLI HTTP client."""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from datetime import datetime, timezone
UTC = timezone.utc
from typing import Any, Protocol
from urllib.parse import urlencode
from uuid import UUID, uuid4

from shortdrama_cli.api.errors import ApiConfigurationError, ApiRequestError
from shortdrama_cli.server_api.client import BusinessServerClient

from .contract import ToolCall, ToolDefinition, ToolResult
from .main_chain_domain import (
    NameResolution,
    require_record_id,
    resolve_unique_name,
    resolve_unique_number,
)
from .trusted_endpoint import resolve_trusted_environment


CLI_CLIENT_COMMIT = "fe3019b1c5e1431b4b9fb6fe327e569ad2aba6fb"


class MainApiClient(Protocol):
    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...

    def upload(
        self,
        path: str,
        filename: str,
        content: bytes,
        content_type: str,
        fields: dict[str, str],
    ) -> dict[str, Any]: ...


class MainChainInputError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]
    handler: str
    cost_status: str = "none"
    reversible: str = "not_applicable"


def _object(
    properties: dict[str, Any],
    *,
    required: tuple[str, ...] = (),
    any_of: tuple[tuple[str, ...], ...] = (),
) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = list(required)
    if any_of:
        schema["anyOf"] = [{"required": list(fields)} for fields in any_of]
    return schema


def _episode_locator_combinations() -> tuple[tuple[str, ...], ...]:
    return (
        ("episode_id",),
        ("project_id", "episode_name"),
        ("project_id", "episode_no"),
        ("project_name", "episode_name"),
        ("project_name", "episode_no"),
    )


EMPTY_OBJECT = {"type": "object", "properties": {}, "additionalProperties": False}
PROJECT_LOCATOR = {
    "project_id": {"type": "string", "format": "uuid"},
    "project_name": {"type": "string", "minLength": 1},
}
EPISODE_LOCATOR = {
    "episode_id": {"type": "string", "format": "uuid"},
    "episode_name": {"type": "string", "minLength": 1},
    "episode_no": {"type": "integer", "minimum": 1},
    **PROJECT_LOCATOR,
}


TOOL_SPECS = (
    ToolSpec(
        "shortdrama_capabilities",
        "读取当前 Agent 凭据的角色、项目权限与能力；其他工具调用前必须先调用一次。",
        EMPTY_OBJECT,
        "_capabilities",
    ),
    ToolSpec(
        "shortdrama_project_list",
        "列出当前用户可以访问的项目。",
        EMPTY_OBJECT,
        "_project_list",
    ),
    ToolSpec(
        "shortdrama_project_get",
        "按明确 ID 或唯一精确名称读取一个项目；同名时拒绝猜测。",
        _object(PROJECT_LOCATOR, any_of=(("project_id",), ("project_name",))),
        "_project_get",
    ),
    ToolSpec(
        "shortdrama_episode_list",
        "列出一个项目的集。",
        _object(PROJECT_LOCATOR, any_of=(("project_id",), ("project_name",))),
        "_episode_list",
    ),
    ToolSpec(
        "shortdrama_episode_get",
        "按明确 ID，或在一个项目内按唯一集名/集号读取一集。",
        _object(
            EPISODE_LOCATOR,
            any_of=(("episode_id",), ("project_id", "episode_name"), ("project_id", "episode_no"),
                    ("project_name", "episode_name"), ("project_name", "episode_no")),
        ),
        "_episode_get",
    ),
    ToolSpec(
        "shortdrama_scene_list",
        "列出一集的场。",
        _object(EPISODE_LOCATOR, any_of=_episode_locator_combinations()),
        "_scene_list",
    ),
    ToolSpec(
        "shortdrama_scene_get",
        "在一集内按明确 ID、唯一场名或场号解析一场；同名时拒绝猜测。",
        _object(
            {
                **EPISODE_LOCATOR,
                "scene_id": {"type": "string", "format": "uuid"},
                "scene_name": {"type": "string", "minLength": 1},
                "scene_no": {"type": "string", "minLength": 1},
            },
            any_of=(
                ("episode_id", "scene_id"),
                ("episode_id", "scene_name"),
                ("episode_id", "scene_no"),
                ("project_id", "episode_name", "scene_name"),
                ("project_name", "episode_name", "scene_name"),
            ),
        ),
        "_scene_get",
    ),
    ToolSpec(
        "shortdrama_shot_list",
        "列出一集的镜头。",
        _object(EPISODE_LOCATOR, any_of=_episode_locator_combinations()),
        "_shot_list",
    ),
    ToolSpec(
        "shortdrama_shot_get",
        "按明确 ID，或在一集内按唯一镜号/标题读取一个镜头。",
        _object(
            {
                **EPISODE_LOCATOR,
                "shot_id": {"type": "string", "format": "uuid"},
                "shot_no": {"type": "string", "minLength": 1},
                "shot_title": {"type": "string", "minLength": 1},
            },
            any_of=(
                ("shot_id",),
                ("episode_id", "shot_no"),
                ("episode_id", "shot_title"),
                ("project_id", "episode_name", "shot_no"),
                ("project_name", "episode_name", "shot_no"),
            ),
        ),
        "_shot_get",
    ),
    ToolSpec(
        "shortdrama_script_versions",
        "列出一集的剧本版本及正文。",
        _object(EPISODE_LOCATOR, any_of=_episode_locator_combinations()),
        "_script_versions",
    ),
    ToolSpec(
        "shortdrama_script_paste",
        "粘贴剧本文本并创建候选剧本版本，不执行人工确认。",
        _object(
            {
                **EPISODE_LOCATOR,
                "script_text": {"type": "string", "minLength": 1, "maxLength": 60000},
                "title": {"type": "string", "minLength": 1},
                "client_idempotency_key": {"type": "string", "format": "uuid"},
            },
            required=("script_text",),
            any_of=_episode_locator_combinations(),
        ),
        "_script_paste",
        reversible="unknown",
    ),
    ToolSpec(
        "shortdrama_script_breakdown",
        "开始一次剧本拆解，只写候选层，不执行确认转正。",
        _object(
            {
                **EPISODE_LOCATOR,
                "script_version_id": {"type": "string", "format": "uuid"},
                "target_duration_sec": {"type": "integer", "minimum": 1},
                "client_idempotency_key": {"type": "string", "format": "uuid"},
            },
            required=("script_version_id",),
            any_of=_episode_locator_combinations(),
        ),
        "_script_breakdown",
        cost_status="unknown",
        reversible="human_discard_required",
    ),
    ToolSpec(
        "shortdrama_script_breakdown_status",
        "读取一次剧本拆解的候选、阶段、错误和用量。",
        _object({"run_id": {"type": "string", "format": "uuid"}}, required=("run_id",)),
        "_script_breakdown_status",
    ),
    ToolSpec(
        "shortdrama_script_breakdown_resume",
        "继续一次失败或中断的候选拆解，不执行确认转正。",
        _object({"run_id": {"type": "string", "format": "uuid"}}, required=("run_id",)),
        "_script_breakdown_resume",
        cost_status="unknown",
        reversible="human_discard_required",
    ),
    ToolSpec(
        "shortdrama_asset_search",
        "按自然语言查询资产；返回候选 ID，不自动选择同名资产。",
        _object({
            "query": {"type": "string", "minLength": 1},
            "scope": {"type": "string", "enum": ["personal", "common", "project"]},
            "project_id": {"type": "string", "format": "uuid"},
            "page": {"type": "integer", "minimum": 1},
        }, required=("query",)),
        "_asset_search",
    ),
    ToolSpec(
        "shortdrama_asset_get",
        "按明确资产 ID 读取资产详情。",
        _object({"asset_id": {"type": "string", "format": "uuid"}}, required=("asset_id",)),
        "_asset_get",
    ),
    ToolSpec(
        "shortdrama_asset_registration_schema",
        "读取资产登记表字段和字典版本，登记前必须先调用。",
        _object({
            "asset_kind": {"type": "string", "minLength": 1},
            "factor_type": {"type": "string", "minLength": 1},
        }),
        "_asset_registration_schema",
    ),
    ToolSpec(
        "shortdrama_asset_register_candidate",
        "上传一张 base64 图片和用户提供的登记表，创建个人域候选登记任务。",
        _object({
            "file_name": {"type": "string", "minLength": 1},
            "content_type": {"type": "string", "pattern": "^image/"},
            "image_base64": {"type": "string", "minLength": 1},
            "registration": {"type": "object"},
            "asset_kind_hint": {"type": "string", "minLength": 1},
            "source_project_name": {"type": "string", "minLength": 1},
            "client_idempotency_key": {"type": "string", "format": "uuid"},
        }, required=("file_name", "content_type", "image_base64", "registration")),
        "_asset_register",
        cost_status="unknown",
        reversible="unknown",
    ),
    ToolSpec(
        "shortdrama_asset_registration_status",
        "读取一个资产登记任务状态。",
        _object({"task_id": {"type": "string", "format": "uuid"}}, required=("task_id",)),
        "_asset_registration_status",
    ),
    ToolSpec(
        "shortdrama_project_asset_add",
        "把明确资产 ID 拉入项目备料引用；不创建控制包、不做审核或主版本选择。",
        _object({
            "project_id": {"type": "string", "format": "uuid"},
            "asset_id": {"type": "string", "format": "uuid"},
            "asset_variant_id": {"type": "string", "format": "uuid"},
            "asset_media_id": {"type": "string", "format": "uuid"},
        }, required=("project_id", "asset_id")),
        "_asset_add_to_project",
        reversible="remove_project_asset_reference",
    ),
    ToolSpec(
        "shortdrama_project_asset_list",
        "列出一个项目已经采用的资产引用。",
        _object({"project_id": {"type": "string", "format": "uuid"}}, required=("project_id",)),
        "_project_asset_list",
    ),
)


class MainChainAdapter:
    """Dispatch approved free-path tools through the CLI-owned API client."""

    def __init__(self, client: MainApiClient) -> None:
        self.client = client
        self._specs = {spec.name: spec for spec in TOOL_SPECS}
        self._capabilities_checked = False

    @classmethod
    def for_environment(cls, environment: str, agent_token: str) -> "MainChainAdapter":
        """Build the adapter for a trusted environment name; URLs are rejected."""
        entry = resolve_trusted_environment(environment)
        return cls(BusinessServerClient(entry.api_base, token=agent_token))

    def definitions(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(
                name=spec.name,
                description=spec.description,
                input_schema=spec.input_schema,
            )
            for spec in TOOL_SPECS
        ]

    def handles(self, name: str) -> bool:
        return name in self._specs

    def execute(self, call: ToolCall) -> ToolResult:
        spec = self._specs.get(call.name)
        if spec is None:
            return ToolResult(
                tool_call_id=call.id,
                content=self._failure(
                    call.name,
                    "unknown_tool",
                    "这个工具不在已批准的短剧工具清单中。",
                    cost_status="unknown",
                    reversible="unknown",
                ),
                is_error=True,
            )
        if call.name != "shortdrama_capabilities" and not self._capabilities_checked:
            return ToolResult(
                tool_call_id=call.id,
                content=self._failure(
                    call.name,
                    "capabilities_required",
                    "请先调用 shortdrama_capabilities 检查当前凭据和项目权限。",
                    cost_status=spec.cost_status,
                    reversible=spec.reversible,
                ),
                is_error=True,
            )
        try:
            arguments = _arguments(call.arguments)
            data = getattr(self, spec.handler)(arguments)
            return ToolResult(
                tool_call_id=call.id,
                content={
                    "data": data,
                    "receipt": self._receipt(
                        call.name,
                        "succeeded",
                        spec.cost_status,
                        spec.reversible,
                    ),
                },
            )
        except MainChainInputError as error:
            return ToolResult(
                tool_call_id=call.id,
                content=self._failure(
                    call.name,
                    error.code,
                    str(error),
                    details=error.details,
                    cost_status=spec.cost_status,
                    reversible=spec.reversible,
                ),
                is_error=True,
            )
        except (ApiConfigurationError, ApiRequestError) as error:
            return ToolResult(
                tool_call_id=call.id,
                content=self._failure(
                    call.name,
                    "main_api_request_failed",
                    "短剧平台没有完成这次请求，请检查登录状态、权限和填写内容后重试。",
                    details={"diagnostic": _safe_diagnostic(error)},
                    cost_status=spec.cost_status,
                    reversible=spec.reversible,
                ),
                is_error=True,
            )

    def _capabilities(self, _input: dict[str, Any]) -> dict[str, Any]:
        data = self.client.request("GET", "/me/capabilities")
        self._capabilities_checked = True
        return data

    def _project_list(self, _input: dict[str, Any]) -> dict[str, Any]:
        return self.client.request("GET", "/projects")

    def _project_get(self, input: dict[str, Any]) -> dict[str, Any]:
        project_id = self._project_id(input)
        return self.client.request("GET", f"/projects/{project_id}")

    def _episode_list(self, input: dict[str, Any]) -> dict[str, Any]:
        project_id = self._project_id(input)
        return self.client.request("GET", f"/projects/{project_id}/episodes")

    def _episode_get(self, input: dict[str, Any]) -> dict[str, Any]:
        episode_id = self._episode_id(input)
        return self.client.request("GET", f"/episodes/{episode_id}")

    def _scene_list(self, input: dict[str, Any]) -> dict[str, Any]:
        episode_id = self._episode_id(input)
        return self.client.request("GET", f"/episodes/{episode_id}/scenes")

    def _scene_get(self, input: dict[str, Any]) -> dict[str, Any]:
        episode_id = self._episode_id(input)
        items = _items(self.client.request("GET", f"/episodes/{episode_id}/scenes"), "场")
        if input.get("scene_id"):
            resolution = resolve_unique_name(
                items,
                query=_uuid_text(input, "scene_id"),
                fields=("id",),
                entity_label="场",
            )
        else:
            query = _one_text(input, ("scene_name", "scene_no"), "场名或场号")
            resolution = resolve_unique_name(
                items,
                query=query,
                fields=("name", "scene_no", "scene_code"),
                entity_label="场",
            )
        return _resolved(resolution)

    def _shot_list(self, input: dict[str, Any]) -> dict[str, Any]:
        episode_id = self._episode_id(input)
        return self.client.request("GET", f"/episodes/{episode_id}/shots")

    def _shot_get(self, input: dict[str, Any]) -> dict[str, Any]:
        if input.get("shot_id"):
            return self.client.request("GET", f"/shots/{_uuid_text(input, 'shot_id')}")
        episode_id = self._episode_id(input)
        items = _items(self.client.request("GET", f"/episodes/{episode_id}/shots"), "镜头")
        query = _one_text(input, ("shot_no", "shot_title"), "镜号或镜头标题")
        resolution = resolve_unique_name(
            items,
            query=query,
            fields=("shot_no", "shot_code", "title"),
            entity_label="镜头",
        )
        shot_id = _record_id(_resolved(resolution), entity_label="镜头")
        return self.client.request("GET", f"/shots/{shot_id}")

    def _script_versions(self, input: dict[str, Any]) -> dict[str, Any]:
        return self.client.request(
            "GET",
            f"/episodes/{self._episode_id(input)}/script-versions",
        )

    def _script_paste(self, input: dict[str, Any]) -> dict[str, Any]:
        body = {
            "script_text": _text(input, "script_text"),
            "client_idempotency_key": _idempotency_key(input),
        }
        if input.get("title") is not None:
            body["title"] = _text(input, "title")
        return self.client.request(
            "POST",
            f"/episodes/{self._episode_id(input)}/script-versions",
            body,
        )

    def _script_breakdown(self, input: dict[str, Any]) -> dict[str, Any]:
        body: dict[str, Any] = {
            "script_version_id": _uuid_text(input, "script_version_id"),
            "client_idempotency_key": _idempotency_key(input),
        }
        if input.get("target_duration_sec") is not None:
            body["target_duration_sec"] = _positive_int(input, "target_duration_sec")
        return self.client.request(
            "POST",
            f"/episodes/{self._episode_id(input)}/script-breakdowns",
            body,
        )

    def _script_breakdown_status(self, input: dict[str, Any]) -> dict[str, Any]:
        return self.client.request(
            "GET",
            f"/script-breakdowns/{_uuid_text(input, 'run_id')}",
        )

    def _script_breakdown_resume(self, input: dict[str, Any]) -> dict[str, Any]:
        return self.client.request(
            "POST",
            f"/script-breakdowns/{_uuid_text(input, 'run_id')}/resume",
        )

    def _asset_search(self, input: dict[str, Any]) -> dict[str, Any]:
        query = _text(input, "query")
        scope = input.get("scope")
        project_id = input.get("project_id")
        if scope == "project" and project_id is None:
            raise MainChainInputError(
                "project_id_required",
                "查询项目资产时必须提供 project_id。",
            )
        if project_id is not None and scope != "project":
            raise MainChainInputError(
                "project_scope_required",
                "project_id 只用于 scope=project 的资产查询。",
            )
        params: dict[str, Any] = {
            "q": query,
            "page": _positive_int(input, "page") if input.get("page") is not None else 1,
            "page_size": 24,
        }
        if isinstance(scope, str):
            params["scope"] = scope
        if project_id is not None:
            params["project_id"] = _uuid_text(input, "project_id")
        return self.client.request("GET", f"/assets?{urlencode(params)}")

    def _asset_get(self, input: dict[str, Any]) -> dict[str, Any]:
        return self.client.request("GET", f"/assets/{_uuid_text(input, 'asset_id')}")

    def _asset_registration_schema(self, input: dict[str, Any]) -> dict[str, Any]:
        params = {
            key: _text(input, key)
            for key in ("asset_kind", "factor_type")
            if input.get(key) is not None
        }
        suffix = f"?{urlencode(params)}" if params else ""
        return self.client.request("GET", f"/assets/registration-schema{suffix}")

    def _asset_register(self, input: dict[str, Any]) -> dict[str, Any]:
        file_name = _plain_file_name(_text(input, "file_name"))
        content_type = _text(input, "content_type")
        if not content_type.startswith("image/"):
            raise MainChainInputError("image_required", "资产登记只接受图片文件。")
        try:
            content = base64.b64decode(_text(input, "image_base64"), validate=True)
        except (binascii.Error, ValueError) as error:
            raise MainChainInputError("invalid_image_base64", "图片内容不是有效的 base64。") from error
        if not content:
            raise MainChainInputError("empty_image", "图片内容不能为空。")
        if len(content) > 20 * 1024 * 1024:
            raise MainChainInputError("image_too_large", "图片不能超过 20 MB。")
        registration = input.get("registration")
        if not isinstance(registration, dict):
            raise MainChainInputError("registration_required", "必须提供登记表 JSON 对象。")
        fields = {
            "client_idempotency_key": _idempotency_key(input),
            "registration": json.dumps(registration, ensure_ascii=False, separators=(",", ":")),
        }
        for key in ("asset_kind_hint", "source_project_name"):
            if input.get(key) is not None:
                fields[key] = _text(input, key)
        return self.client.upload(
            "/asset-upload-tasks",
            file_name,
            content,
            content_type,
            fields,
        )

    def _asset_registration_status(self, input: dict[str, Any]) -> dict[str, Any]:
        return self.client.request(
            "GET",
            f"/asset-upload-tasks/{_uuid_text(input, 'task_id')}",
        )

    def _asset_add_to_project(self, input: dict[str, Any]) -> dict[str, Any]:
        body = {"asset_entity_id": _uuid_text(input, "asset_id")}
        for key in ("asset_variant_id", "asset_media_id"):
            if input.get(key) is not None:
                body[key] = _uuid_text(input, key)
        return self.client.request(
            "POST",
            f"/projects/{_uuid_text(input, 'project_id')}/assets",
            body,
        )

    def _project_asset_list(self, input: dict[str, Any]) -> dict[str, Any]:
        return self.client.request(
            "GET",
            f"/projects/{_uuid_text(input, 'project_id')}/assets",
        )

    def _project_id(self, input: dict[str, Any]) -> str:
        if input.get("project_id") is not None:
            return _uuid_text(input, "project_id")
        name = _text(input, "project_name")
        items = _items(self.client.request("GET", "/projects"), "项目")
        return _record_id(
            _resolved(resolve_unique_name(
                items,
                query=name,
                fields=("name",),
                entity_label="项目",
            )),
            entity_label="项目",
        )

    def _episode_id(self, input: dict[str, Any]) -> str:
        if input.get("episode_id") is not None:
            return _uuid_text(input, "episode_id")
        project_id = self._project_id(input)
        items = _items(
            self.client.request("GET", f"/projects/{project_id}/episodes"),
            "集",
        )
        if input.get("episode_no") is not None:
            resolution = resolve_unique_number(
                items,
                query=_positive_int(input, "episode_no"),
                fields=("episode_no", "episode_number"),
                entity_label="集",
            )
        else:
            resolution = resolve_unique_name(
                items,
                query=_text(input, "episode_name"),
                fields=("name",),
                entity_label="集",
            )
        return _record_id(_resolved(resolution), entity_label="集")

    def _receipt(
        self,
        tool: str,
        status: str,
        cost_status: str,
        reversible: str,
    ) -> dict[str, Any]:
        return {
            "request_id": "unknown",
            "tool": tool,
            "status": status,
            "permissions_checked": self._capabilities_checked,
            "cost_status": cost_status,
            "reversible": reversible,
            "timestamp": datetime.now(UTC).isoformat(),
        }

    def _failure(
        self,
        tool: str,
        code: str,
        message: str,
        *,
        cost_status: str,
        reversible: str,
        details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "error": {
                "code": code,
                "message": message,
                **({"details": details} if details else {}),
            },
            "receipt": self._receipt(tool, "failed", cost_status, reversible),
        }


def _arguments(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise MainChainInputError("invalid_arguments", "工具参数必须是 JSON 对象。")
    return value


def _items(data: dict[str, Any], entity_label: str) -> list[dict[str, Any]]:
    value = data.get("items")
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise MainChainInputError(
            "invalid_main_response",
            f"{entity_label}列表响应缺少 items，不能继续推断。",
        )
    return value


def _resolved(resolution: NameResolution) -> dict[str, Any]:
    if resolution.item is not None:
        return resolution.item
    raise MainChainInputError(
        resolution.code or "name_resolution_failed",
        resolution.message or "名称解析失败。",
        details={"candidates": list(resolution.candidates)} if resolution.candidates else None,
    )


def _record_id(item: dict[str, Any], *, entity_label: str) -> str:
    try:
        return require_record_id(item, entity_label=entity_label)
    except ValueError as error:
        raise MainChainInputError(
            "invalid_main_response",
            f"{entity_label}响应缺少 id，不能继续推断。",
        ) from error


def _text(input: dict[str, Any], key: str) -> str:
    value = input.get(key)
    if not isinstance(value, str) or not value.strip():
        raise MainChainInputError("field_required", f"{key} 不能为空。")
    return value.strip()


def _one_text(input: dict[str, Any], keys: tuple[str, ...], label: str) -> str:
    present = [key for key in keys if input.get(key) is not None]
    if len(present) != 1:
        raise MainChainInputError("locator_required", f"请只提供一个{label}。")
    return _text(input, present[0])


def _uuid_text(input: dict[str, Any], key: str) -> str:
    value = _text(input, key)
    try:
        return str(UUID(value))
    except ValueError as error:
        raise MainChainInputError("invalid_id", f"{key} 必须是 UUID。") from error


def _positive_int(input: dict[str, Any], key: str) -> int:
    value = input.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise MainChainInputError("invalid_number", f"{key} 必须是正整数。")
    return value


def _idempotency_key(input: dict[str, Any]) -> str:
    if input.get("client_idempotency_key") is None:
        return str(uuid4())
    return _uuid_text(input, "client_idempotency_key")


def _plain_file_name(value: str) -> str:
    if "/" in value or "\\" in value or value in {".", ".."}:
        raise MainChainInputError("invalid_file_name", "file_name 只能是文件名，不能包含路径。")
    return value


def _safe_diagnostic(error: Exception) -> str:
    # Upstream errors can include response bodies. Agent-visible receipts keep
    # only the exception class so credentials and user content cannot leak.
    return error.__class__.__name__


def build_main_chain_adapter(
    environment: str | None,
    agent_token: str | None,
) -> MainChainAdapter | None:
    if environment is None and agent_token is None:
        return None
    if not environment or not agent_token:
        raise ApiConfigurationError(
            "SHORTDRAMA_ENV 与 SHORTDRAMA_AGENT_TOKEN 必须同时配置。",
        )
    return MainChainAdapter.for_environment(environment, agent_token)


def tool_schema_document() -> dict[str, Any]:
    """Export the Pi package schema from the executable server-owned registry."""
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "version": "0.3.0",
        "cli_client_commit": CLI_CLIENT_COMMIT,
        "tools": [
            {
                "name": spec.name,
                "description": spec.description,
                "input": spec.input_schema,
                "cost_status": spec.cost_status,
                "reversible": spec.reversible,
            }
            for spec in TOOL_SPECS
        ],
    }
