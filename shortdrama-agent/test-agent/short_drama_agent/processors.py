import base64
import mimetypes
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from google.genai import types
from veadk import Runner
from veadk.knowledgebase.knowledgebase import KnowledgeBase
from veadk.processors import BaseRunProcessor
from veadk.utils.logger import get_logger

from short_drama_agent.execute_skills import get_execute_skills_status
from short_drama_agent.knowledge_assets import (
    build_asset_friendly_entry,
    build_reference_text,
    entry_relevance_score,
    extract_image_urls,
    extract_search_query,
    filter_asset_reference_entries,
    guess_image_mime_type,
    markdownify_image_urls,
    search_knowledge_entries,
)

logger = get_logger(__name__)

MEMORY_QUERY_KEYWORDS = (
    "我是谁",
    "我叫什么",
    "我的名字",
    "我叫啥",
    "我是啥",
    "我喜欢",
    "我爱好",
    "我的爱好",
    "我偏好",
    "我的偏好",
    "我之前",
    "我刚才",
    "我告诉过",
    "我跟你说",
    "我说过",
    "我提过",
    "你还记得",
    "你记得我",
    "记住我",
    "我买过",
    "我看过",
    "我听过",
    "我的信息",
    "我的资料",
    "我的历史",
    "上次",
    "上一次",
    "之前聊",
    "之前说",
    "之前提",
    "who am i",
    "my name",
    "my hobby",
    "my preference",
    "do you remember",
    "i told you",
    "i said",
    "i mentioned",
    "last time",
    "previously",
)

SKILL_INVENTORY_KEYWORDS = (
    "skill 有哪些",
    "skill有哪些",
    "skills 有哪些",
    "skills有哪些",
    "有哪些 skill",
    "有哪些 skills",
    "当前可用的skill",
    "当前可用 skill",
    "可用的skill",
    "可用 skill",
    "skill 列表",
    "skills 列表",
    "列出 skill",
    "列出 skills",
    "技能有哪些",
    "有哪些技能",
    "可用技能",
    "技能列表",
    "list skills",
    "available skills",
)

EXTERNAL_ACTION_KEYWORDS = (
    "调用 skill",
    "调用 skills",
    "调用工具",
    "外部工具",
    "mcp",
    "router",
    "发邮件",
    "发送邮件",
    "查日历",
    "查询日历",
    "创建日程",
    "创建任务",
    "创建工单",
    "同步数据",
    "调用接口",
    "执行工具",
    "use skill",
    "use tool",
    "call tool",
    "call skill",
    "send email",
    "check calendar",
    "create ticket",
)

ASSET_GENERATION_QUERY_KEYWORDS = (
    "资产完成图片生成",
    "资产图片生成",
    "图片生成",
    "生成图片",
    "完成生成",
    "补生成",
    "重新生成",
    "生成状态",
)

ASSET_GENERATION_TARGET_KEYWORDS = (
    "资产",
    "图片",
    "图像",
    "剧照",
    "场景图",
    "角色图",
    "道具图",
    "分镜图",
)

SCRIPT_BREAKDOWN_KEYWORDS = (
    "剧本拆解",
    "分镜拆解",
    "资产拆解",
    "角色拆解",
    "场景拆解",
    "道具拆解",
    "生成分镜",
    "提取制作要素",
    "storyboard",
    "video_prompt",
    "scene_continuity_key",
    "scene_anchor",
    "script breakdown",
)

BUSINESS_STORYBOARD_INGEST_KEYWORDS = (
    "业务分镜入库",
    "分镜入库",
    "完成业务入库",
    "入库项目",
    "已入库项目",
    "storyboard_ingestion",
    "ingeststoryboarddecomposition",
    "lookupprojectshotid",
    "createprojectshot",
    "project_shot_id",
    "project_id",
    "projectid",
    "project_prompts",
)

EXISTING_WORK_LISTING_KEYWORDS = (
    "有哪些",
    "有什么",
    "给我",
    "列出",
    "整理",
    "清单",
    "汇总",
)

EXISTING_WORK_ASSET_KEYWORDS = (
    "角色",
    "场景",
    "道具",
    "分镜",
    "剧情",
    "剧本内",
)

ASSET_INGEST_KEYWORDS = (
    "入知识库",
    "入库",
    "导入知识库",
    "写入知识库",
    "知识库导入",
    "知识库入库",
    "添加到知识库",
    "上传到知识库",
    "ingest",
    "knowledgebase ingest",
)

ASSET_TARGET_KEYWORDS = (
    "附件",
    "图片",
    "图像",
    "照片",
    "剧照",
    "定妆照",
    "角色图",
    "场景图",
    "道具图",
    "分镜图",
    "资产",
    "文件",
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    "attachment",
    "image",
    "photo",
    "asset",
    "file",
)

MIME_TYPE_EXTENSION_OVERRIDES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "application/pdf": ".pdf",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
    "text/plain": ".txt",
}


def is_memory_oriented_query(query: str) -> bool:
    """Return true when a query should be routed to long-term memory."""
    if not query:
        return False
    query_lower = query.lower()
    return any(kw in query_lower for kw in MEMORY_QUERY_KEYWORDS)


def is_skill_inventory_query(query: str) -> bool:
    if not query:
        return False
    normalized = re.sub(r"\s+", " ", query.lower()).strip()
    return any(keyword in normalized for keyword in SKILL_INVENTORY_KEYWORDS)


def is_external_action_query(query: str) -> bool:
    if not query:
        return False
    normalized = re.sub(r"\s+", " ", query.lower()).strip()
    if is_asset_ingest_query(normalized):
        return False
    return any(keyword in normalized for keyword in EXTERNAL_ACTION_KEYWORDS)


def is_asset_ingest_query(query: str) -> bool:
    if not query:
        return False
    normalized = re.sub(r"\s+", " ", query.lower()).strip()
    has_ingest_intent = any(keyword in normalized for keyword in ASSET_INGEST_KEYWORDS)
    has_asset_target = any(keyword in normalized for keyword in ASSET_TARGET_KEYWORDS)
    return has_ingest_intent and has_asset_target


def is_asset_generation_completion_query(query: str) -> bool:
    if not query:
        return False
    normalized = re.sub(r"\s+", " ", query.lower()).strip()
    has_generation_intent = any(
        keyword in normalized for keyword in ASSET_GENERATION_QUERY_KEYWORDS
    )
    has_asset_target = any(
        keyword in normalized for keyword in ASSET_GENERATION_TARGET_KEYWORDS
    )
    return has_generation_intent and has_asset_target


def is_script_breakdown_query(query: str) -> bool:
    if not query:
        return False
    normalized = re.sub(r"\s+", " ", query.lower()).strip()
    return any(keyword in normalized for keyword in SCRIPT_BREAKDOWN_KEYWORDS)


def is_business_storyboard_ingestion_query(query: str) -> bool:
    if not query:
        return False
    normalized = re.sub(r"\s+", " ", query.lower()).strip()
    return any(keyword in normalized for keyword in BUSINESS_STORYBOARD_INGEST_KEYWORDS)


def is_existing_work_asset_listing_query(query: str) -> bool:
    """Identify existing-work inventory requests that should use the knowledgebase."""
    if not query:
        return False
    normalized = re.sub(r"\s+", " ", query.lower()).strip()
    has_listing_intent = any(
        keyword in normalized for keyword in EXISTING_WORK_LISTING_KEYWORDS
    )
    has_asset_scope = any(
        keyword in normalized for keyword in EXISTING_WORK_ASSET_KEYWORDS
    )
    explicit_new_breakdown = any(
        keyword in normalized
        for keyword in (
            "剧本拆解",
            "分镜拆解",
            "资产拆解",
            "输出 json",
            "输出json",
            "入库",
            "创建生图任务",
        )
    )
    return has_listing_intent and has_asset_scope and not explicit_new_breakdown


def supports_image_input() -> bool:
    """Return true only when the configured runtime model accepts image parts."""
    return os.getenv("AGENT_ENABLE_IMAGE_INPUT", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _guess_extension_from_mime_type(mime_type: str | None) -> str:
    if not mime_type:
        return ""

    normalized = mime_type.split(";", 1)[0].strip().lower()
    if not normalized:
        return ""
    if normalized == "application/octet-stream":
        return ""

    guessed = MIME_TYPE_EXTENSION_OVERRIDES.get(
        normalized
    ) or mimetypes.guess_extension(normalized, strict=False)
    if guessed == ".jpe":
        return ".jpg"
    return guessed or ""


def _normalize_attachment_name(value: str) -> str:
    if not value:
        return ""

    parsed = urlparse(value)
    candidate = parsed.path or value
    return Path(unquote(candidate)).name.strip()


def _guess_extension_from_inline_data(data: bytes | str | None) -> str:
    """Infer common upload extensions when the browser reports octet-stream."""
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


def _ensure_attachment_extension(
    file_name: str, mime_type: str | None, data: bytes | str | None = None
) -> str:
    normalized = _normalize_attachment_name(file_name)
    if not normalized:
        normalized = "attachment"
    if Path(normalized).suffix:
        return normalized

    extension = _guess_extension_from_mime_type(
        mime_type
    ) or _guess_extension_from_inline_data(data)
    if extension:
        return f"{normalized}{extension}"
    return normalized


def _extract_attachment_hints(message_parts: list[types.Part]) -> list[dict[str, str]]:
    hints: list[dict[str, str]] = []

    for index, part in enumerate(message_parts, start=1):
        inline_data = getattr(part, "inline_data", None)
        if inline_data is not None:
            source_name = str(getattr(inline_data, "display_name", "") or "")
            mime_type = str(getattr(inline_data, "mime_type", "") or "")
            normalized_name = _ensure_attachment_extension(
                source_name, mime_type, getattr(inline_data, "data", None)
            )
            hints.append(
                {
                    "source_name": source_name,
                    "normalized_name": normalized_name,
                    "mime_type": mime_type,
                    "origin": f"message_part_{index}",
                }
            )
            continue

        file_data = getattr(part, "file_data", None) or getattr(part, "fileData", None)
        if file_data is None:
            continue

        source_name = str(getattr(file_data, "file_uri", "") or "")
        mime_type = str(getattr(file_data, "mime_type", "") or "")
        normalized_name = _ensure_attachment_extension(source_name, mime_type)
        hints.append(
            {
                "source_name": _normalize_attachment_name(source_name),
                "normalized_name": normalized_name,
                "mime_type": mime_type,
                "origin": f"message_part_{index}",
            }
        )

    deduped_hints: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for hint in hints:
        key = (
            hint.get("source_name", ""),
            hint.get("normalized_name", ""),
            hint.get("mime_type", ""),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped_hints.append(hint)
    return deduped_hints


def _format_attachment_hint_text(message_parts: list[types.Part]) -> str:
    attachment_hints = _extract_attachment_hints(message_parts)
    if not attachment_hints:
        return ""

    lines = [
        "当前消息检测到以下附件；如果 ADK 暂存名是无后缀的 `artifact_*`，不要原样传给上传/入库工具："
    ]
    for index, hint in enumerate(attachment_hints, start=1):
        normalized_name = hint.get("normalized_name", "") or "attachment"
        source_name = hint.get("source_name", "")
        mime_type = hint.get("mime_type", "")
        line = f"- 附件{index}：建议上传文件名 `{normalized_name}`"
        if (
            source_name
            and source_name != normalized_name
            and not _is_generated_artifact_name(source_name)
        ):
            line += f"；原始标识 `{source_name}`"
        if mime_type:
            line += f"；mime_type={mime_type}"
        line += f"；调用上传/入库 skill 时请传 upload_file_name=`{normalized_name}`"
        lines.append(line)
    return "\n" + "\n".join(lines)


def _is_generated_artifact_name(value: str) -> bool:
    name = _normalize_attachment_name(value)
    return name.startswith("artifact_") and not Path(name).suffix


def _normalize_attachment_parts(message_parts: list[types.Part]) -> None:
    """Expose upload-safe filenames to the model before it chooses tool args."""
    for part in message_parts:
        inline_data = getattr(part, "inline_data", None)
        if inline_data is not None:
            display_name = str(getattr(inline_data, "display_name", "") or "")
            mime_type = str(getattr(inline_data, "mime_type", "") or "")
            normalized_name = _ensure_attachment_extension(
                display_name, mime_type, getattr(inline_data, "data", None)
            )
            if normalized_name != display_name:
                inline_data.display_name = normalized_name
            continue

        file_data = getattr(part, "file_data", None) or getattr(part, "fileData", None)
        if file_data is None:
            continue

        file_uri = str(getattr(file_data, "file_uri", "") or "")
        mime_type = str(getattr(file_data, "mime_type", "") or "")
        normalized_name = _ensure_attachment_extension(file_uri, mime_type)
        if normalized_name != _normalize_attachment_name(file_uri):
            file_data.file_uri = normalized_name


def _insert_before_first_attachment(
    message_parts: list[types.Part], part: types.Part
) -> None:
    """Place routing guidance before binary/file parts so tools see it first."""
    for index, message_part in enumerate(message_parts):
        if getattr(message_part, "inline_data", None) is not None:
            message_parts.insert(index, part)
            return
        if getattr(message_part, "file_data", None) is not None:
            message_parts.insert(index, part)
            return
        if getattr(message_part, "fileData", None) is not None:
            message_parts.insert(index, part)
            return
    message_parts.append(part)


def _build_skill_runtime_summary() -> tuple[str, list[str]]:
    skill_status = get_execute_skills_status()
    skill_tools = [
        tool.get("name", "").strip()
        for tool in skill_status.get("tools", [])
        if tool.get("name", "").strip()
    ]
    skill_tools_text = "、".join(skill_tools[:12]) if skill_tools else ""

    if skill_status.get("loaded"):
        source = skill_status.get("tool_id") or "已配置 Skills Sandbox Tool"
        if skill_tools_text:
            return (
                f"已挂载官方 execute_skills 工具，Tool ID：{source}；当前工具包括：{skill_tools_text}。",
                skill_tools,
            )
        return (
            f"已挂载官方 execute_skills 工具，Tool ID：{source}。",
            skill_tools,
        )

    if skill_status.get("configured"):
        error = skill_status.get("error") or "未知原因"
        return (
            f"已配置 AGENTKIT_TOOL_ID，但 execute_skills 加载失败：{error}。",
            skill_tools,
        )

    return "当前未配置 AGENTKIT_TOOL_ID，官方 execute_skills 未挂载。", skill_tools


def build_skill_inventory_context() -> str:
    router_url = os.getenv("TOOL_MCP_ROUTER_URL", "").strip()
    skill_summary, skill_tools = _build_skill_runtime_summary()
    router_summary = (
        f"官方 MCP Router 已挂载，地址为：{router_url}。"
        if router_url
        else "当前未配置官方 MCP Router。"
    )
    direct_guidance = (
        "请说明已挂载官方 `execute_skills` 工具，可按用户需求调用 Skills Sandbox 中的 skill。"
        if skill_tools
        else "当前没有可用的 `execute_skills`；如果用户需要外部能力，只能说明是否可通过 `mcp_router` 兜底。"
    )
    return (
        "\n[系统提示] 用户正在询问当前可用的 skills。"
        f"{skill_summary}{router_summary}"
        f"{direct_guidance}"
        "回答时不要查询知识库或长期记忆，直接基于当前工具挂载状态说明。"
    )


def build_script_breakdown_context(query: str = "") -> str:
    router_url = os.getenv("TOOL_MCP_ROUTER_URL", "").strip()
    if is_business_storyboard_ingestion_query(query):
        if router_url:
            return (
                "\n[系统提示] 当前请求是剧本拆解并完成短剧业务分镜入库。"
                "不要调用 `execute_skills`；Skills Sandbox 可能无法访问短剧业务 MCP。"
                "不要只调用 `script_breakdown` 后结束。"
                "请直接使用当前 agent 已挂载的 MCP Router/短剧业务工具完成全链路："
                "`Shortdrama Generation API_listProjects`、`Shortdrama Generation API_createProject`、"
                "`Shortdrama Generation API_lookupProjectShotId`、`Shortdrama Generation API_createProjectShot`、"
                "`Shortdrama Generation API_ingestStoryboardDecomposition`。"
                "如果工具在运行时以命名空间暴露，请使用实际可见的完整工具名。"
                "最终只能在 ingestStoryboardDecomposition 返回 ok=true 且包含 project_prompts "
                "或 project_shot_generations 时声明入库成功；否则返回严格 JSON 错误，"
                "不要用 TOS 上传、知识库上传或生成 request 替代业务入库。"
            )
        return (
            "\n[系统提示] 当前请求是剧本拆解并完成短剧业务分镜入库，"
            "但当前未配置官方 `mcp_router`，无法调用短剧业务 MCP。"
            "请返回严格 JSON 错误，不要调用 `execute_skills` 或声称已入库。"
        )

    skill_summary, skill_tools = _build_skill_runtime_summary()
    if skill_tools:
        return (
            "\n[系统提示] 当前请求是剧本/分镜/资产拆解任务。"
            f"{skill_summary}"
            "请不要先查询知识库。请优先直接调用 `execute_skills`，"
            "并明确指定使用 skill `script-asset-breakdown`，模式为 `script_breakdown`。"
            "要求 skill 只返回严格 JSON，不要解释文字。"
            "只有在 `execute_skills` 明确失败或不可用时，才回退调用 `script_breakdown` 工具。"
        )

    return (
        "\n[系统提示] 当前请求是剧本/分镜/资产拆解任务。"
        f"{_build_skill_runtime_summary()[0]}"
        "当前没有可用的 `execute_skills`，请不要查知识库，直接调用本地 `script_breakdown` 工具完成拆解。"
    )


def build_existing_work_asset_listing_context() -> str:
    return (
        "\n[系统提示] 当前请求是在查询和整理已有作品/剧本资料中的角色、场景、道具、剧情或分镜。"
        "请优先使用本轮预注入的知识库资料；若资料不足，再调用 `load_knowledgebase` 查询。"
        "不要调用 `execute_skills` 或 `script_breakdown`，不要反问用户提供完整剧本，也不要编造知识库没有的角色、道具或分镜。"
    )


def build_asset_generation_completion_context() -> str:
    router_url = os.getenv("TOOL_MCP_ROUTER_URL", "").strip()
    if router_url:
        return (
            "\n[系统提示] 当前请求是剧本关联资产的图片生成状态检查与补生成任务。"
            "不要先查询知识库，也不要只根据向量召回回答。"
            "不要调用 `execute_skills` 或 `script_breakdown`，不要反问用户提供完整剧本。"
            "请直接调用 `mcp_router`，先查询用户所指剧本/开篇/场景关联的资产清单；"
            "再逐项检查每个关联资产的图片生成状态。"
            "对已经完成生成的资产，只汇总其完成状态和结果；"
            "对尚未完成生成、生成失败或缺少图片结果的资产，继续通过 MCP 工具直接发起图片生成。"
            "短剧图片生成 MCP 工具通常带有 `Shortdrama Generation API_` 前缀，"
            "优先使用 `Shortdrama Generation API_listProjectPrompts`、"
            "`Shortdrama Generation API_createShotImage`、`Shortdrama Generation API_listShotImages`、"
            "`Shortdrama Generation API_refreshShotImage`。"
            "生成请求必须带上原始用户提示中的剧本名称、场景/开篇描述、资产 ID 或资产名称，"
            "并基于每一步真实 MCP 结果继续，不要编造资产清单、生成状态或图片 URL。"
        )

    return (
        "\n[系统提示] 当前请求是剧本关联资产的图片生成状态检查与补生成任务，"
        "但当前未配置官方 `mcp_router`，无法查询关联资产或触发图片生成。"
        "请直接说明缺少可用 MCP 工具，不要改查知识库或编造生成结果。"
    )


def build_external_action_context() -> str:
    router_url = os.getenv("TOOL_MCP_ROUTER_URL", "").strip()
    skill_summary, skill_tools = _build_skill_runtime_summary()
    if skill_tools:
        return (
            "\n[系统提示] 当前请求更适合调用外部 MCP skill。"
            f"{skill_summary}"
            "优先调用 `execute_skills`，让 Skills Sandbox 根据用户需求执行对应 skill；"
            "若 execute_skills 无法满足，再使用 `mcp_router` 作为兜底。"
            "如果任务需要多步执行，请基于每一步真实工具结果继续，不要编造中间结果。"
        )

    if router_url:
        return (
            "\n[系统提示] 当前请求更适合调用外部 MCP skill。"
            "当前没有可用的 `execute_skills`，但官方 `mcp_router` 已挂载。"
            "请直接尝试使用 `mcp_router` 路由到合适的 MCP 工具；"
            "如果任务需要多步执行，请按步骤逐次调用，并基于真实工具结果继续。"
        )

    return (
        "\n[系统提示] 用户正在请求外部工具能力，但当前既没有 execute_skills，也没有可用的 MCP Router。"
        "请直接说明当前运行时没有可调用的外部 MCP skill，不要改查知识库或长期记忆来冒充执行结果。"
    )


def build_asset_ingest_context(message_parts: list[types.Part] | None = None) -> str:
    router_url = os.getenv("TOOL_MCP_ROUTER_URL", "").strip()
    skill_summary, skill_tools = _build_skill_runtime_summary()
    attachment_hint_text = _format_attachment_hint_text(message_parts or [])
    if skill_tools:
        return (
            "\n[系统提示] 当前请求是资产/附件/图片入知识库任务。"
            f"{skill_summary}"
            "请优先调用 `execute_skills`，让 Skills Sandbox 中的知识入库 skill 编排完成处理。"
            "请在 skill 请求中明确带上用户提供的文件名或附件名，以及作品、角色、标签、资产类型等 metadata。"
            "如果发现附件内部名是无后缀的 `artifact_*`，请改用下方建议上传文件名；必要时按 mime_type 自动补全扩展名后再调用上传凭证相关工具。"
            f"{attachment_hint_text}"
            "\n如果任务需要多步执行，请按步骤逐次调用，并基于真实工具结果继续。"
        )

    if router_url:
        return (
            "\n[系统提示] 当前请求是资产/附件/图片入知识库任务。"
            f"{skill_summary}"
            "当前没有可用的 `execute_skills`，但官方 `mcp_router` 已挂载。"
            "请尝试使用 `mcp_router` 路由到可执行知识入库的外部 MCP 工具。"
            "请在路由请求中明确带上用户提供的文件名或附件名，以及作品、角色、标签、资产类型等 metadata。"
            "如果发现附件内部名是无后缀的 `artifact_*`，请改用下方建议上传文件名；必要时按 mime_type 自动补全扩展名后再调用上传凭证相关工具。"
            f"{attachment_hint_text}"
            "\n如果任务需要多步执行，请按步骤逐次调用，并基于真实工具结果继续。"
        )

    return (
        "\n[系统提示] 当前请求是资产/附件/图片入知识库任务。"
        f"{skill_summary}"
        "但当前既没有可用的 `execute_skills`，也未配置 `mcp_router`，因此本轮运行时无法执行知识入库。"
        "请直接说明当前缺少可用的知识入库工具或路由，不要编造入库结果。"
        f"{attachment_hint_text}"
    )


class AssetAwareRunProcessor(BaseRunProcessor):
    """Inject matched image assets into the user message before model inference."""

    def __init__(self, knowledgebase: KnowledgeBase):
        self.knowledgebase = knowledgebase

    def process_run(self, runner: Runner, message: types.Content, **kwargs: Any):
        def decorator(event_generator_func):
            async def wrapper():
                message_parts: list[types.Part] = list(message.parts or [])
                message.parts = message_parts
                query_text = " ".join(
                    text_value.strip()
                    for part in message_parts
                    for text_value in [getattr(part, "text", None)]
                    if isinstance(text_value, str) and text_value.strip()
                )

                tracked_image_urls: list[str] = []

                if query_text and is_skill_inventory_query(query_text):
                    logger.info(
                        f"Skill inventory query detected, inject skill status: {query_text}"
                    )
                    message_parts.append(
                        types.Part(text=build_skill_inventory_context())
                    )
                elif query_text and is_asset_ingest_query(query_text):
                    logger.info(
                        f"Asset ingest query detected, inject skill ingest routing hint: {query_text}"
                    )
                    _normalize_attachment_parts(message_parts)
                    _insert_before_first_attachment(
                        message_parts,
                        types.Part(text=build_asset_ingest_context(message_parts)),
                    )
                elif query_text and is_asset_generation_completion_query(query_text):
                    logger.info(
                        "Asset generation completion query detected, inject MCP "
                        f"routing hint: {query_text}"
                    )
                    message_parts.append(
                        types.Part(text=build_asset_generation_completion_context())
                    )
                elif (
                    query_text
                    and is_script_breakdown_query(query_text)
                    and not is_existing_work_asset_listing_query(query_text)
                ):
                    route_name = (
                        "mcp_router"
                        if is_business_storyboard_ingestion_query(query_text)
                        else "script_breakdown"
                    )
                    logger.info(
                        f"Script breakdown query detected, inject {route_name} hint: {query_text}"
                    )
                    message_parts.append(
                        types.Part(text=build_script_breakdown_context(query_text))
                    )
                elif query_text and is_external_action_query(query_text):
                    logger.info(
                        f"External action query detected, inject tool routing hint: {query_text}"
                    )
                    message_parts.append(
                        types.Part(text=build_external_action_context())
                    )
                elif query_text and is_memory_oriented_query(query_text):
                    logger.info(
                        f"Memory-oriented query detected, skip knowledgebase "
                        f"preload to let model use load_memory: {query_text}"
                    )
                    message_parts.append(
                        types.Part(
                            text=(
                                "\n[系统提示] 该问题涉及用户的个人身份/偏好/历史信息，"
                                "知识库中不包含此类信息。请调用 load_memory 工具，"
                                "用用户的问题作为 query 检索长期记忆后再回答。"
                            )
                        )
                    )
                elif query_text:
                    logger.info(
                        f"Preloading asset references from knowledgebase for query: {query_text}"
                    )
                    if is_existing_work_asset_listing_query(query_text):
                        message_parts.append(
                            types.Part(text=build_existing_work_asset_listing_context())
                        )
                    search_query = extract_search_query(query_text)
                    entries = search_knowledge_entries(search_query, limit=20)
                    filtered_entries = filter_asset_reference_entries(
                        entries, query_text
                    )
                    ranked_entries = sorted(
                        filtered_entries,
                        key=lambda entry: (
                            entry_relevance_score(entry, query_text),
                            1 if extract_image_urls(entry.metadata) else 0,
                            1 if (entry.content or "").strip() else 0,
                        ),
                        reverse=True,
                    )
                    normalized_entries = [
                        build_asset_friendly_entry(entry)
                        for entry in ranked_entries[:6]
                    ]
                    image_urls: list[str] = []
                    for entry in normalized_entries:
                        image_urls.extend(extract_image_urls(entry.metadata))

                    deduped_image_urls: list[str] = []
                    for image_url in image_urls:
                        if image_url not in deduped_image_urls:
                            deduped_image_urls.append(image_url)

                    reference_text = build_reference_text(normalized_entries)
                    if reference_text:
                        message_parts.append(types.Part(text=reference_text))

                    if supports_image_input():
                        for image_url in deduped_image_urls[:4]:
                            message_parts.append(
                                types.Part(
                                    fileData=types.FileData(
                                        file_uri=image_url,
                                        mime_type=guess_image_mime_type(image_url),
                                    )
                                )
                            )
                    elif deduped_image_urls:
                        logger.info(
                            "Image input disabled for current model; passing image "
                            "URLs as text only."
                        )

                    tracked_image_urls = deduped_image_urls

                async for event in event_generator_func():
                    if tracked_image_urls and event is not None:
                        try:
                            content = getattr(event, "content", None)
                            if content and getattr(content, "parts", None):
                                for part in content.parts:
                                    if getattr(part, "function_call", None) or getattr(
                                        part, "function_response", None
                                    ):
                                        continue
                                    if getattr(part, "thought", None):
                                        continue
                                    text = getattr(part, "text", None)
                                    if text:
                                        part.text = markdownify_image_urls(
                                            text, tracked_image_urls
                                        )
                        except Exception as e:
                            logger.warning(f"markdownify image urls failed: {e}")
                    yield event

            return wrapper

        return decorator
