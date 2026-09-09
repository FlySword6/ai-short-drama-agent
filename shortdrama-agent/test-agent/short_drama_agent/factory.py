import os
import time

from veadk import Agent
from veadk.auth.veauth.ark_veauth import get_ark_token
from veadk.knowledgebase.knowledgebase import KnowledgeBase
from veadk.memory.long_term_memory import LongTermMemory
from veadk.tools.builtin_tools.mcp_router import mcp_router
from veadk.utils.logger import get_logger

from short_drama_agent.execute_skills import (
    get_execute_skills_status,
    load_execute_skills_tool,
)
from short_drama_agent.config import AGENT_INSTRUCTION, APP_NAME
from short_drama_agent.knowledge_assets import (
    ASSET_INGEST_ROUTING_INSTRUCTION,
    AssetMetadataFirstLoadKnowledgebaseTool,
    create_knowledge_base,
)
from short_drama_agent.mcp_safety import make_asset_ingest_safe_mcp_toolset
from short_drama_agent.memory import (
    create_long_term_memory,
    make_after_agent_execution,
)
from short_drama_agent.processors import AssetAwareRunProcessor
from short_drama_agent.script_breakdown import (
    SCRIPT_BREAKDOWN_ROUTING_INSTRUCTION,
    create_script_breakdown_tool,
)

logger = get_logger(__name__)


def resolve_model_api_key() -> str:
    """Resolve Ark model API key through Volcengine credentials with retries."""
    for env_name in (
        "MODEL_AGENT_API_KEY",
        "ARK_API_KEY",
        "VOLCENGINE_ARK_API_KEY",
        "ARK_API_TOKEN",
    ):
        value = os.getenv(env_name, "").strip()
        if value:
            return value

    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            if attempt > 1:
                time.sleep(0.5 * attempt)
            logger.info(
                f"Fetching Ark API key via Volcengine AK/SK, attempt {attempt}."
            )
            return get_ark_token()
        except Exception as exc:
            last_error = exc
            logger.warning(f"Failed to fetch Ark API key on attempt {attempt}: {exc}")

    raise RuntimeError(
        "Failed to fetch Ark API key through Volcengine AK/SK after retries. "
        "Please check VOLCENGINE_ACCESS_KEY/VOLCENGINE_SECRET_KEY, network access "
        "to open.volcengineapi.com, and local TLS/proxy settings."
    ) from last_error


def create_root_agent(
    knowledgebase: KnowledgeBase | None = None,
    long_term_memory: LongTermMemory | None = None,
) -> tuple[Agent, KnowledgeBase, LongTermMemory]:
    kb = knowledgebase or create_knowledge_base()
    memory = long_term_memory or create_long_term_memory()

    root_agent = Agent(
        name=APP_NAME,
        knowledgebase=kb,
        instruction=(
            AGENT_INSTRUCTION
            + ASSET_INGEST_ROUTING_INSTRUCTION
            + SCRIPT_BREAKDOWN_ROUTING_INSTRUCTION
        ),
        long_term_memory=memory,
        after_agent_callback=make_after_agent_execution(memory),
        run_processor=AssetAwareRunProcessor(knowledgebase=kb),
        model_api_key=resolve_model_api_key(),
        model_extra_config={
            "extra_body": {
                "thinking": {"type": "enabled"},
            },
        },
    )

    root_agent.tools = [
        AssetMetadataFirstLoadKnowledgebaseTool(knowledgebase=kb)
        if getattr(tool, "name", "") == "load_knowledgebase"
        else tool
        for tool in root_agent.tools
    ]

    execute_skills_tools = load_execute_skills_tool()
    if execute_skills_tools:
        root_agent.tools.extend(execute_skills_tools)
        logger.info("Mounted official execute_skills tool before script_breakdown.")
    else:
        skill_status = get_execute_skills_status()
        logger.info(f"execute_skills is not mounted. Skill status={skill_status}")

    root_agent.tools.append(create_script_breakdown_tool())
    logger.info("Mounted script_breakdown sub-agent tool as fallback.")

    root_agent.tools.append(make_asset_ingest_safe_mcp_toolset(mcp_router))

    tool_diagnostics: list[dict[str, str]] = []
    for tool in root_agent.tools:
        tool_diagnostics.append(
            {
                "name": getattr(tool, "name", ""),
                "type": type(tool).__name__,
                "module": type(tool).__module__,
            }
        )

    logger.info(f"Agent tool diagnostics: {tool_diagnostics}")
    logger.info("Knowledge ingest requests prefer execute_skills when configured.")
    logger.info("MCP router remains mounted as an external tool fallback.")
    logger.info("MCP router mounted via TOOL_MCP_ROUTER_URL.")

    return root_agent, kb, memory
