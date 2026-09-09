"""Volcengine AgentKit entry point for the LLM-powered production chain.

The cloud model can invoke the production chain tool with real parameters.
Review approvals remain protected domain boundaries — the model cannot
approve reviews or write a real asset library on its own.
"""

from __future__ import annotations

from dotenv import load_dotenv
load_dotenv()

import json
import os

from agentkit.apps import AgentkitAgentServerApp
from google.adk.tools import FunctionTool
from veadk import Agent
from veadk.auth.veauth.ark_veauth import get_ark_token
from veadk.memory.short_term_memory import ShortTermMemory

from agent import run_a2a_production_chain, run_production_chain
from production_chain.models import AssetRecord
from sda2a.hub import HubManager
from sda2a.orchestrator import A2AOrchestrator


APP_NAME = "shortdrama_production_chain_agent"


def resolve_model_api_key() -> str:
    """Use a configured Ark token or obtain one from AgentKit runtime credentials."""

    for name in ("MODEL_AGENT_API_KEY", "ARK_API_KEY", "VOLCENGINE_ARK_API_KEY"):
        token = os.getenv(name, "").strip()
        if token:
            return token
    # 云端运行时可通过绑定的 AK/SK 换取 Ark token，本地则应优先显式传入环境变量。
    return get_ark_token()


def run_fixture_production_chain() -> dict[str, object]:
    """Run the built-in fixture through the full LLM-powered chain.

    This intentionally has no arguments: callers cannot use it to create
    a production task with arbitrary parameters, approve a review, or
    persist a real asset.
    """

    # 工具不接收生产参数，防止演示入口被误用为真实生成或资产写入接口。
    return run_production_chain()


def run_production_chain_tool(
    project_id: str,
    title: str,
    episode_no: int,
    script_text: str,
    inventory_json: str = "",
    reviewer: str = "director",
) -> dict[str, object]:
    """Run the full production chain with real LLM-powered skills.

    Executes Script→Asset→Scene→Review→Generation→Review→Asset promotion.
    Each step calls the Volcengine Ark API for real semantic understanding
    and image generation.

    Args:
        project_id: Project identifier.
        title: Episode title.
        episode_no: Episode number.
        script_text: Full script text to parse.
        inventory_json: JSON array of existing assets (optional). Each item
            should have asset_id, name, kind, and optionally description/aliases.
        reviewer: Reviewer name for auto-approval in demo mode (default: "director").

    Returns:
        Full trace receipt with breakdown, matches, gaps, scene packages,
        generation tasks, generation results, and promoted assets.
    """
    inventory: list[AssetRecord] | None = None
    if inventory_json:
        raw = json.loads(inventory_json)
        inventory = [
            AssetRecord(
                asset_id=item["asset_id"],
                name=item["name"],
                kind=item["kind"],
                description=item.get("description", ""),
                aliases=item.get("aliases", []),
            )
            for item in raw
        ]

    return run_production_chain(
        project_id=project_id,
        title=title,
        episode_no=episode_no,
        script_text=script_text,
        inventory=inventory,
        reviewer=reviewer,
    )


def run_a2a_hub_production_chain_tool(
    hub_host: str = "127.0.0.1",
    hub_port: int = 9000,
    project_id: str = "demo-project",
    title: str = "画室夜训",
    episode_no: int = 1,
    script_text: str = "",
    reviewer: str = "director",
) -> dict[str, object]:
    """Run the production chain via A2A Hub discovery.

    Discovers sub-agents (Script, Asset, Scene, Generation) from the
    A2A Hub and coordinates them via JSON-RPC 2.0 over HTTP.

    Args:
        hub_host: A2A Hub server host.
        hub_port: A2A Hub server port.
        project_id: Project identifier.
        title: Episode title.
        episode_no: Episode number.
        script_text: Full script text to parse.
        reviewer: Reviewer name for auto-approval.

    Returns:
        Full trace receipt with breakdown, matches, gaps, scene packages,
        generation tasks, generation results, and promoted assets.
    """

    hub = HubManager(host=hub_host, port=hub_port)
    agent_urls = hub.discover_agent_urls()

    if not agent_urls:
        return {"error": "no agents found in Hub", "hub_url": hub.url}

    orchestrator = A2AOrchestrator(agent_urls)
    kwargs = dict(
        project_id=project_id,
        title=title,
        episode_no=episode_no,
        reviewer=reviewer,
        verbose=False,
    )
    if script_text:
        kwargs["script_text"] = script_text

    return orchestrator.run(**kwargs)


def create_root_agent() -> Agent:
    """Create the AgentKit-visible agent with real production chain tools."""

    return Agent(
        name=APP_NAME,
        model_api_key=resolve_model_api_key(),
        instruction=(
            "你是短剧生产链路编排 Agent。你可以调用以下工具执行真实的剧本拆解、"
            "资产匹配、镜头卡组装和画面生成：\n"
            "1. run_production_chain_tool：直接调用模式，接收剧本文本和资产库存，"
            "执行完整的 Script→Asset→Scene→Review→Generation→Review→Asset 链路。\n"
            "2. run_a2a_hub_production_chain_tool：A2A 多 Agent 模式，通过 Hub 发现"
            "子 Agent 并以 JSON-RPC 2.0 协议编排。需要提供 Hub 地址。\n"
            "3. run_fixture_production_chain：使用内置示例剧本快速验证链路，无需参数。\n\n"
            "生成结果仍是候选版本，二次人审通过后才被沉淀为资产。"
            "收到用户提供的剧本文本时，优先使用 run_production_chain_tool 执行真实拆解和生成。"
            "如果用户要求使用 A2A 多 Agent 架构或指定了 Hub 地址，"
            "使用 run_a2a_hub_production_chain_tool。"
            "不要声称执行了未经验证的资产入库或人审。"
        ),
        tools=[
            FunctionTool(run_fixture_production_chain),
            FunctionTool(run_production_chain_tool),
            FunctionTool(run_a2a_hub_production_chain_tool),
        ],
    )


# AgentKit 通过 entry_point 导入这个模块级对象；不要将其改成仅在 main 中创建。
root_agent = create_root_agent()
agent_server_app = AgentkitAgentServerApp(
    agent=root_agent,
    short_term_memory=ShortTermMemory(backend="local"),
)


if __name__ == "__main__":
    agent_server_app.run(host="0.0.0.0", port=8000)
