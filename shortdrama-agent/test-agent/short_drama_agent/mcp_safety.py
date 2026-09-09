import copy
import base64
import mimetypes
import os
import re
from pathlib import Path
from typing import Any

from google.adk.tools.base_tool import BaseTool
from google.adk.tools.base_toolset import BaseToolset
from google.adk.tools.tool_context import ToolContext
from google.genai import types
from veadk.utils.logger import get_logger

from short_drama_agent.config import IMAGE_EXT_TO_MIME

logger = get_logger(__name__)

IMAGE_EXT_TO_MIME_REVERSE = {
    mime_type: ext for ext, mime_type in IMAGE_EXT_TO_MIME.items()
}
IMAGE_EXT_TO_MIME_REVERSE["image/jpeg"] = ".jpg"

ARTIFACT_NAME_RE = re.compile(r"^artifact_[A-Za-z0-9_.-]+$")
FILENAME_ARG_KEYS = {
    "file",
    "file_name",
    "filename",
    "name",
    "upload_file_name",
    "asset_file_name",
    "asset_name",
    "object_name",
}
INGEST_TOOL_SUFFIXES = (
    "ingest_to_agentkit_kb",
    "ingest_to_viking_kb",
)
INGEST_TARGET_ID_KEYS = (
    "kb_id",
    "resourceID",
    "resource_id",
)


def _is_generated_artifact_name(value: str) -> bool:
    return bool(ARTIFACT_NAME_RE.match(Path(value).name)) and not Path(value).suffix


def _guess_extension_from_content_type(content_type: str | None) -> str:
    if not content_type:
        return ""

    normalized = content_type.split(";", 1)[0].strip().lower()
    if normalized == "application/octet-stream":
        return ""

    guessed = IMAGE_EXT_TO_MIME_REVERSE.get(normalized) or mimetypes.guess_extension(
        normalized, strict=False
    )
    if guessed == ".jpe":
        return ".jpg"
    return guessed or ""


def _guess_extension_from_bytes(data: bytes | str | None) -> str:
    if data is None:
        return ""
    if isinstance(data, str):
        try:
            data = base64.b64decode(data, validate=True)
        except Exception:
            return ""

    signatures: tuple[tuple[bytes, str], ...] = (
        (b"\xff\xd8\xff", ".jpg"),
        (b"\x89PNG\r\n\x1a\n", ".png"),
        (b"GIF87a", ".gif"),
        (b"GIF89a", ".gif"),
        (b"RIFF", ".webp"),
        (b"%PDF-", ".pdf"),
    )
    for signature, extension in signatures:
        if data.startswith(signature):
            if extension == ".webp" and data[8:12] != b"WEBP":
                continue
            return extension

    try:
        data[:4096].decode("utf-8")
    except UnicodeDecodeError:
        return ""
    return ".txt"


def _part_display_name(part: types.Part | None) -> str:
    if part is None:
        return ""

    inline_data = getattr(part, "inline_data", None)
    if inline_data and getattr(inline_data, "display_name", None):
        return str(inline_data.display_name)

    file_data = getattr(part, "file_data", None) or getattr(part, "fileData", None)
    if file_data and getattr(file_data, "file_uri", None):
        return Path(str(file_data.file_uri)).name

    return ""


def _part_mime_type(part: types.Part | None) -> str:
    if part is None:
        return ""

    inline_data = getattr(part, "inline_data", None)
    if inline_data and getattr(inline_data, "mime_type", None):
        return str(inline_data.mime_type)

    file_data = getattr(part, "file_data", None) or getattr(part, "fileData", None)
    if file_data and getattr(file_data, "mime_type", None):
        return str(file_data.mime_type)

    return ""


def _part_bytes(part: types.Part | None) -> bytes | str | None:
    if part is None:
        return None

    inline_data = getattr(part, "inline_data", None)
    if inline_data and getattr(inline_data, "data", None) is not None:
        return inline_data.data

    text = getattr(part, "text", None)
    if text is not None:
        return text.encode("utf-8")

    return None


async def _resolve_upload_safe_artifact_name(
    artifact_name: str, tool_context: ToolContext
) -> str:
    if not _is_generated_artifact_name(artifact_name):
        return artifact_name

    try:
        part = await tool_context.load_artifact(artifact_name)
    except Exception as exc:
        logger.warning(
            f"Unable to load ADK artifact while repairing MCP upload filename: "
            f"{artifact_name}; error={exc}"
        )
        part = None

    display_name = _part_display_name(part)
    if display_name and Path(display_name).suffix:
        repaired_name = Path(display_name).name
        logger.info(
            f"Repaired MCP upload artifact filename from {artifact_name} to "
            f"{repaired_name} using artifact display_name."
        )
        return repaired_name

    extension = _guess_extension_from_content_type(
        _part_mime_type(part)
    ) or _guess_extension_from_bytes(_part_bytes(part))
    if extension:
        repaired_name = f"{Path(artifact_name).name}{extension}"
        logger.info(
            f"Repaired MCP upload artifact filename from {artifact_name} to "
            f"{repaired_name}."
        )
        return repaired_name

    logger.warning(
        f"Unable to infer suffix for generated ADK artifact filename: {artifact_name}"
    )
    return artifact_name


def _is_filename_arg_key(key: str | None) -> bool:
    if not key:
        return False
    normalized = key.replace("-", "_").lower()
    return normalized in FILENAME_ARG_KEYS or normalized.endswith("_file_name")


async def _rewrite_artifact_filenames(
    value: Any,
    tool_context: ToolContext,
    *,
    key: str | None = None,
    force_strings: bool = False,
) -> Any:
    if isinstance(value, dict):
        rewritten: dict[str, Any] = {}
        for child_key, child_value in value.items():
            rewritten[child_key] = await _rewrite_artifact_filenames(
                child_value,
                tool_context,
                key=str(child_key),
                force_strings=force_strings,
            )
        return rewritten

    if isinstance(value, list):
        return [
            await _rewrite_artifact_filenames(
                item,
                tool_context,
                key=key,
                force_strings=force_strings,
            )
            for item in value
        ]

    if isinstance(value, str) and _is_generated_artifact_name(value):
        if force_strings or _is_filename_arg_key(key):
            return await _resolve_upload_safe_artifact_name(value, tool_context)

    return value


async def rewrite_mcp_tool_args(
    tool_name: str,
    args: dict[str, Any],
    tool_context: ToolContext,
) -> dict[str, Any]:
    force_strings = tool_name.endswith("create_tos_upload_credential")
    safe_args = await _rewrite_artifact_filenames(
        copy.deepcopy(args),
        tool_context,
        force_strings=force_strings,
    )
    if any(tool_name.endswith(suffix) for suffix in INGEST_TOOL_SUFFIXES):
        _ensure_ingest_target_args(tool_name, safe_args)
    return safe_args


def _first_env_value(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def _ensure_ingest_target_args(tool_name: str, args: dict[str, Any]) -> None:
    project = _first_env_value("DATABASE_VIKING_PROJECT") or "shortdrama"
    collection_name = _first_env_value("DATABASE_VIKING_COLLECTION") or "role"
    kb_id = _first_env_value(
        "AGENTKIT_KB_ID",
        "AGENTKIT_KNOWLEDGEBASE_ID",
        "KNOWLEDGEBASE_ID",
        "VIKING_KB_ID",
        "VIKING_RESOURCE_ID",
    )

    args.setdefault("project", project)
    args.setdefault("collection_name", collection_name)
    if kb_id:
        args.setdefault("kb_id", kb_id)
        args.setdefault("resourceID", kb_id)
        args.setdefault("resource_id", kb_id)

    logger.info(
        f"Ensured MCP ingest target args for {tool_name}: "
        f"project={args.get('project')}, collection_name={args.get('collection_name')}, "
        f"has_kb_id={bool(kb_id)}."
    )


def is_ingest_tool_name(tool_name: str) -> bool:
    return any(tool_name.endswith(suffix) for suffix in INGEST_TOOL_SUFFIXES)


def has_ingest_target_id(args: dict[str, Any]) -> bool:
    return any(str(args.get(key) or "").strip() for key in INGEST_TARGET_ID_KEYS)


def missing_ingest_target_response(tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    project = args.get("project") or "shortdrama"
    collection_name = args.get("collection_name") or "role"
    message = (
        "当前 MCP 入库服务缺少真实知识库资源 ID，已阻止继续请求 Viking。"
        "请在本地/部署环境配置 AGENTKIT_KB_ID 或 VIKING_RESOURCE_ID，"
        "或让用户明确提供要导入的知识库 ID。"
        f"当前 project={project}, collection_name={collection_name}。"
    )
    logger.warning(
        f"Blocked MCP ingest tool {tool_name} because no kb_id/resourceID was "
        f"available; project={project}, collection_name={collection_name}."
    )
    return {
        "statusCode": 400,
        "success": False,
        "status": "failed",
        "error_code": "MISSING_KB_RESOURCE_ID",
        "message": message,
        "required_env": [
            "AGENTKIT_KB_ID",
            "VIKING_RESOURCE_ID",
        ],
        "request_args": {
            "project": project,
            "collection_name": collection_name,
            "file_name": args.get("file_name"),
            "tos_path": args.get("tos_path"),
            "file_url": args.get("file_url"),
            "file_ref": args.get("file_ref"),
        },
    }


class AssetIngestSafeMcpTool(BaseTool):
    """Wrap an MCP tool and repair generated artifact filenames before calling it."""

    def __init__(self, wrapped_tool: BaseTool):
        super().__init__(
            name=wrapped_tool.name,
            description=wrapped_tool.description,
            is_long_running=getattr(wrapped_tool, "is_long_running", False),
            custom_metadata=getattr(wrapped_tool, "custom_metadata", None),
        )
        self._wrapped_tool = wrapped_tool

    def _get_declaration(self):
        return self._wrapped_tool._get_declaration()

    async def process_llm_request(self, *, tool_context, llm_request) -> None:
        await self._wrapped_tool.process_llm_request(
            tool_context=tool_context,
            llm_request=llm_request,
        )

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        safe_args = await rewrite_mcp_tool_args(self.name, args, tool_context)
        if is_ingest_tool_name(self.name) and not has_ingest_target_id(safe_args):
            return missing_ingest_target_response(self.name, safe_args)
        return await self._wrapped_tool.run_async(
            args=safe_args,
            tool_context=tool_context,
        )


class AssetIngestSafeMcpToolset(BaseToolset):
    """Wrap MCP tools so artifact temp names never reach upload credential calls."""

    def __init__(self, wrapped_toolset: BaseToolset):
        super().__init__(
            tool_filter=getattr(wrapped_toolset, "tool_filter", None),
            tool_name_prefix=getattr(wrapped_toolset, "tool_name_prefix", None),
        )
        self._wrapped_toolset = wrapped_toolset
        self.name = getattr(wrapped_toolset, "name", None) or "mcp_router"

    async def get_tools(self, readonly_context=None) -> list[BaseTool]:
        tools = await self._wrapped_toolset.get_tools(readonly_context)
        return [AssetIngestSafeMcpTool(tool) for tool in tools]

    async def close(self) -> None:
        await self._wrapped_toolset.close()

    async def process_llm_request(self, *, tool_context, llm_request) -> None:
        await self._wrapped_toolset.process_llm_request(
            tool_context=tool_context,
            llm_request=llm_request,
        )

    def get_auth_config(self):
        return self._wrapped_toolset.get_auth_config()


def make_asset_ingest_safe_mcp_toolset(toolset: BaseToolset) -> BaseToolset:
    return AssetIngestSafeMcpToolset(toolset)
