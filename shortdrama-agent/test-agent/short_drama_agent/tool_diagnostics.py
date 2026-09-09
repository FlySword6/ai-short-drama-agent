import asyncio
import os
from typing import Any

from google.adk.tools.base_toolset import BaseToolset
from veadk.utils.logger import get_logger

from short_drama_agent.execute_skills import get_execute_skills_status

logger = get_logger(__name__)


def _tool_summary(tool: Any) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "name": getattr(tool, "name", "") or "",
        "description": getattr(tool, "description", "") or "",
        "type": type(tool).__name__,
        "module": type(tool).__module__,
    }
    raw_mcp_tool = getattr(tool, "raw_mcp_tool", None)
    if raw_mcp_tool is not None:
        summary["mcp_input_schema"] = getattr(raw_mcp_tool, "inputSchema", None)
    return summary


def summarize_agent_tools(agent_tools: list[Any]) -> list[dict[str, Any]]:
    """Summarize regular ADK tools without opening external connections."""
    summaries: list[dict[str, Any]] = []
    for tool in agent_tools:
        if isinstance(tool, BaseToolset):
            summaries.append(
                {
                    "name": getattr(tool, "name", "") or "",
                    "description": getattr(tool, "description", "") or "",
                    "type": type(tool).__name__,
                    "module": type(tool).__module__,
                    "connection_url": getattr(
                        getattr(tool, "_connection_params", None), "url", ""
                    )
                    or "",
                    "kind": "toolset",
                }
            )
        else:
            item = _tool_summary(tool)
            item["kind"] = "tool"
            summaries.append(item)
    return summaries


async def inspect_mcp_toolsets(agent_tools: list[Any]) -> list[dict[str, Any]]:
    """Open MCP toolsets and list exposed tools. Errors are reported as data."""
    timeout = float(os.getenv("TOOL_DIAGNOSTICS_TIMEOUT", "8"))
    diagnostics: list[dict[str, Any]] = []

    for tool in agent_tools:
        if not isinstance(tool, BaseToolset):
            continue

        connection_params = getattr(tool, "_connection_params", None)
        item: dict[str, Any] = {
            "toolset_type": type(tool).__name__,
            "module": type(tool).__module__,
            "connection_url": getattr(connection_params, "url", "") or "",
            "status": "unknown",
            "tools": [],
        }
        try:
            tools = await asyncio.wait_for(tool.get_tools(None), timeout=timeout)
            item["status"] = "ok"
            item["tools"] = [_tool_summary(mcp_tool) for mcp_tool in tools]
            item["tool_count"] = len(tools)
        except Exception as exc:
            item["status"] = "error"
            item["error_type"] = type(exc).__name__
            item["error"] = str(exc)
        diagnostics.append(item)

    return diagnostics


async def collect_tool_diagnostics(agent_tools: list[Any]) -> dict[str, Any]:
    """Collect local tool, dedicated skill toolset, and MCP Router diagnostics."""
    return {
        "skill_status": get_execute_skills_status(),
        "local_tools": summarize_agent_tools(agent_tools),
        "mcp_toolsets": await inspect_mcp_toolsets(agent_tools),
    }


async def log_startup_tool_diagnostics(agent_tools: list[Any]) -> None:
    diagnostics = await collect_tool_diagnostics(agent_tools)
    logger.info(f"Startup skill diagnostics: {diagnostics['skill_status']}")
    logger.info(f"Startup local tool diagnostics: {diagnostics['local_tools']}")
    logger.info(f"Startup MCP tool diagnostics: {diagnostics['mcp_toolsets']}")
