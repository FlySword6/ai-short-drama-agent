import os
import re
from typing import Any

from google.adk.tools import ToolContext
from veadk.utils.logger import get_logger

logger = get_logger(__name__)

MAX_SKILLS_SANDBOX_TIMEOUT_SECONDS = 300
ARTIFACT_REF_RE = re.compile(r"artifact_[A-Za-z0-9_.-]+")
ASSET_INGEST_PROMPT_KEYWORDS = (
    "入库",
    "导入知识库",
    "上传到知识库",
    "同步到知识库",
    "知识库入库",
    "知识库导入",
    "火山知识库",
    "AgentKit 知识库",
    "agentkit 知识库",
    "ingest",
    "knowledgebase",
)
LAST_EXECUTE_SKILLS_STATUS: dict[str, Any] = {
    "configured": False,
    "loaded": False,
    "tool_id": "",
    "skill_space_id": "",
    "timeout": MAX_SKILLS_SANDBOX_TIMEOUT_SECONDS,
    "tools": [],
    "error": "",
}


def _set_execute_skills_status(**updates: Any) -> None:
    LAST_EXECUTE_SKILLS_STATUS.update(updates)


def get_execute_skills_status() -> dict[str, Any]:
    return LAST_EXECUTE_SKILLS_STATUS.copy()


def _get_skills_sandbox_timeout() -> int:
    raw_timeout = os.getenv(
        "AGENTKIT_SKILLS_TIMEOUT", str(MAX_SKILLS_SANDBOX_TIMEOUT_SECONDS)
    )
    try:
        timeout = int(raw_timeout)
    except ValueError:
        logger.warning(
            f"Invalid AGENTKIT_SKILLS_TIMEOUT={raw_timeout!r}; "
            f"use {MAX_SKILLS_SANDBOX_TIMEOUT_SECONDS}."
        )
        return MAX_SKILLS_SANDBOX_TIMEOUT_SECONDS

    if timeout < 1:
        logger.warning(
            f"AGENTKIT_SKILLS_TIMEOUT={timeout} is too small; use 1 second."
        )
        return 1

    if timeout > MAX_SKILLS_SANDBOX_TIMEOUT_SECONDS:
        logger.warning(
            f"AGENTKIT_SKILLS_TIMEOUT={timeout} exceeds sandbox limit; "
            f"clamped to {MAX_SKILLS_SANDBOX_TIMEOUT_SECONDS}."
        )
        return MAX_SKILLS_SANDBOX_TIMEOUT_SECONDS

    return timeout


def _extract_artifact_refs(workflow_prompt: str) -> list[str]:
    refs: list[str] = []
    for match in ARTIFACT_REF_RE.finditer(workflow_prompt or ""):
        ref = match.group(0).strip("`'\"，,。.;；:：")
        if ref and ref not in refs:
            refs.append(ref)
    return refs


def _is_asset_ingest_workflow_prompt(workflow_prompt: str) -> bool:
    normalized = (workflow_prompt or "").lower()
    return any(keyword.lower() in normalized for keyword in ASSET_INGEST_PROMPT_KEYWORDS)


async def _prepare_artifact_refs_for_skills(
    workflow_prompt: str, tool_context: ToolContext | None
) -> str:
    artifact_refs = _extract_artifact_refs(workflow_prompt)
    if not artifact_refs or not _is_asset_ingest_workflow_prompt(workflow_prompt):
        return workflow_prompt

    if tool_context is None or not hasattr(tool_context, "load_artifact"):
        return (
            "无法执行 Skills 入库：当前请求引用了 ADK artifact，"
            "但运行时没有提供可读取 artifact 的 tool_context。"
        )

    from short_drama_agent.knowledge_assets import (
        _list_artifact_names,
        _load_asset_from_artifacts,
        upload_asset_bytes_to_tos,
    )

    available_artifacts = await _list_artifact_names(tool_context)
    uploaded_assets: list[dict[str, str]] = []
    missing_refs: list[str] = []
    for artifact_ref in artifact_refs:
        artifact_asset = await _load_asset_from_artifacts(
            artifact_ref, tool_context, available_artifacts
        )
        if artifact_asset is None:
            missing_refs.append(artifact_ref)
            continue

        upload_result = upload_asset_bytes_to_tos(
            file_name=artifact_asset["file_name"],
            content=artifact_asset["content"],
            content_type=artifact_asset["content_type"],
        )
        uploaded_assets.append(
            {
                "artifact_ref": artifact_ref,
                "artifact_name": artifact_asset["artifact_name"],
                "file_name": artifact_asset["file_name"],
                "content_type": artifact_asset["content_type"] or "",
                "tos_path": upload_result["tos_path"],
                "tos_url": upload_result["tos_url"],
                "public_url": upload_result["public_url"],
            }
        )

    if missing_refs:
        return (
            "无法执行 Skills 入库：当前请求引用的 ADK artifact 未在本轮会话中找到。"
            f" missing_refs={missing_refs}; available_artifacts={available_artifacts}。"
            "请重新上传附件，或提供可访问的 tos_path/file_url。"
        )

    if not uploaded_assets:
        return workflow_prompt

    asset_lines = [
        "\n\n[系统补充] 主 Agent 已将当前会话中的 ADK artifact 上传到 TOS，"
        "请在知识库入库 skill 中直接使用以下 tos_path/file_name，不要再在 sandbox 本地查找 artifact 文件："
    ]
    for index, asset in enumerate(uploaded_assets, start=1):
        asset_lines.append(
            "\n".join(
                [
                    f"- 文件{index}:",
                    f"  artifact_ref: {asset['artifact_ref']}",
                    f"  artifact_name: {asset['artifact_name']}",
                    f"  file_name: {asset['file_name']}",
                    f"  content_type: {asset['content_type']}",
                    f"  tos_path: {asset['tos_path']}",
                    f"  tos_url: {asset['tos_url']}",
                    f"  file_url: {asset['public_url']}",
                    "  project: shortdrama",
                    "  collection_name: role",
                ]
            )
        )
    return workflow_prompt + "\n" + "\n".join(asset_lines)


async def execute_skills(workflow_prompt: str, tool_context: ToolContext = None) -> str:
    """Execute skills in a remote sandbox and return the output.

    Args:
        workflow_prompt (str): instruction of workflow.

    Returns:
        str: The output of the skill execution.
    """
    from veadk.tools.builtin_tools._agentkit import (
        get_agentkit_account_id,
        resolve_agentkit_tool_id,
    )
    from veadk.tools.builtin_tools.run_sandbox_agent import run_sandbox_agent

    timeout = _get_skills_sandbox_timeout()
    tool_id = resolve_agentkit_tool_id("AGENTKIT_TOOL_ID_SKILLS")
    account_id = get_agentkit_account_id(tool_context.state if tool_context else None)

    extra_env_vars = {}
    if account_id:
        extra_env_vars["TOS_SKILLS_DIR"] = (
            f"tos://agentkit-platform-{account_id}/skills/"
        )

    prepared_workflow_prompt = await _prepare_artifact_refs_for_skills(
        workflow_prompt, tool_context
    )
    if prepared_workflow_prompt.startswith("无法执行 Skills 入库："):
        return prepared_workflow_prompt

    return run_sandbox_agent(
        workflow_prompt=prepared_workflow_prompt,
        tool_id=tool_id,
        tool_context=tool_context,
        timeout=timeout,
        extra_env_vars=extra_env_vars,
    )


def load_execute_skills_tool() -> list[Any]:
    tool_id = os.getenv("AGENTKIT_TOOL_ID", "").strip()
    skill_space_id = os.getenv("SKILL_SPACE_ID", "").strip()
    timeout = _get_skills_sandbox_timeout()
    _set_execute_skills_status(
        configured=bool(tool_id),
        loaded=False,
        tool_id=tool_id,
        skill_space_id=skill_space_id,
        timeout=timeout,
        tools=[],
        error="",
    )

    if not tool_id:
        logger.info("AGENTKIT_TOOL_ID is not configured. Skip execute_skills.")
        return []

    try:
        from veadk.tools.builtin_tools.run_sandbox_agent import run_sandbox_agent

        _ = run_sandbox_agent
    except Exception as exc:
        error = (
            "veadk.tools.builtin_tools.run_sandbox_agent is unavailable. "
            "Upgrade veadk-python to a version that includes the official "
            "sandbox runner."
        )
        _set_execute_skills_status(error=f"{error} Import error: {exc}")
        logger.warning(f"Failed to load execute_skills, ignored: {exc}")
        return []

    _set_execute_skills_status(
        loaded=True,
        tools=[
            {
                "name": getattr(
                    execute_skills, "name", getattr(execute_skills, "__name__", "")
                )
            }
        ],
    )
    logger.info(
        f"Mounted execute_skills tool with timeout={timeout}s "
        f"(sandbox limit={MAX_SKILLS_SANDBOX_TIMEOUT_SECONDS}s)."
    )
    return [execute_skills]
