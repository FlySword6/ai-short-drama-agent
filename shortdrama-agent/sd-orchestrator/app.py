"""Harness entry point – sd-orchestrator.

Exposes run_production_pipeline as a FunctionTool that coordinates the full
short-drama production chain: Script → Asset → Scene → Generation.
"""

from __future__ import annotations

from dotenv import load_dotenv
load_dotenv()

import json
import os
from pathlib import Path

from agentkit.apps import AgentkitAgentServerApp
from google.adk.tools import FunctionTool
from veadk import Agent
from veadk.auth.veauth.ark_veauth import get_ark_token
from veadk.memory.long_term_memory import LongTermMemory
from veadk.memory.short_term_memory import ShortTermMemory


_asset_card_service = None
_task_state_machine = None


def _get_asset_card_service():
    """Create the card service only when a user asks for an asset draft."""

    global _asset_card_service
    if _asset_card_service is None:
        from production_chain.asset_cards import AssetCardService

        _asset_card_service = AssetCardService()
    return _asset_card_service


def _get_task_state_machine():
    """Keep task state available across consecutive turns in this process."""

    global _task_state_machine
    if _task_state_machine is None:
        from production_chain.task_state import TaskStateMachine

        _task_state_machine = TaskStateMachine.from_environment()
    return _task_state_machine


# ---------------------------------------------------------------------------
# FunctionTools – conversational asset creation
# ---------------------------------------------------------------------------

def create_asset_card(asset_request: str) -> dict:
    """Draft a character, scene, or prop asset card without generating media.

    Use this first when a user asks to create an asset in natural language.
    The returned card includes kind, name, gender, age, visual attributes, and
    an image-generation prompt. Present it to the user and wait for explicit
    confirmation before calling ``confirm_asset_card``.
    """

    card = _get_asset_card_service().draft(asset_request)
    task = _get_task_state_machine().create_asset_task(card.card_id)
    return {"task": task.to_dict(), "asset_card": card.to_dict()}


def confirm_asset_card(asset_card_id: str) -> dict:
    """Generate exactly one image for a card the user has explicitly confirmed.

    Args:
        asset_card_id: The ID returned by ``create_asset_card``.

    Returns:
        The generated asset card and a reusable asset record with ``source_url``.
    """

    tasks = _get_task_state_machine()
    tasks.begin_asset_generation(asset_card_id)
    try:
        card, asset = _get_asset_card_service().confirm(asset_card_id)
    except Exception as exc:
        task = tasks.fail_asset_generation(asset_card_id, str(exc))
        return {"task": task.to_dict(), "error": "asset generation failed"}

    task = tasks.complete_asset_generation(asset_card_id)
    return {
        "task": task.to_dict(),
        "asset_card": card.to_dict(),
        "asset": asset.__dict__,
    }


def get_task_status(task_id: str) -> dict:
    """Return the current plan and state for a multi-turn task."""

    return _get_task_state_machine().get_task(task_id).to_dict()


# ---------------------------------------------------------------------------
# FunctionTool – full production pipeline
# ---------------------------------------------------------------------------

def run_production_pipeline(
    project_id: str,
    title: str,
    episode_no: int,
    script_text: str,
    inventory_json: str = "[]",
    auto_approve_generated_assets: bool = True,
) -> dict:
    """Run the complete short-drama production pipeline end-to-end.

    Executes the full chain in sequence:
    1. ScriptSkill  – parse script into scenes + asset requirements
    2. AssetSkill   – match requirements against inventory (find matches / gaps)
    3. AssetGenerationSkill – create candidate character, scene, and prop assets
       for gaps marked ``generate``
    4. SceneSkill   – assemble shot cards using matched and approved new assets
    5. GenerationSkill – generate scene images (returns URL or failure)

    Args:
        project_id: Unique project identifier.
        title: Episode title.
        episode_no: Episode number.
        script_text: Full script text to process.
        inventory_json: JSON array of existing assets. Each item must have
            asset_id, name, kind; optionally description, aliases.
            Pass '[]' or omit to treat all requirements as gaps.
        auto_approve_generated_assets: Demo-mode review decision for generated
            assets. Set false to return candidates without making them usable.

    Returns:
        Full production trace dict with keys:
          breakdown, matches, unresolved_gaps, asset_generations, packages,
          generation_results.
    """
    from production_chain.workflow import (
        ProductionChainAgent, stable_id,
    )
    from production_chain.models import AssetMatch, AssetRecord, to_dict

    # Deserialise inventory
    inv_data = json.loads(inventory_json) if inventory_json else []
    inventory = [
        AssetRecord(
            asset_id=a["asset_id"],
            name=a["name"],
            kind=a["kind"],
            description=a.get("description", ""),
            aliases=a.get("aliases", []),
            source_url=a.get("source_url", ""),
        )
        for a in inv_data
    ]

    coordinator = ProductionChainAgent.create()

    # 1. Script parsing
    breakdown = coordinator.script.run(
        project_id=project_id,
        title=title,
        episode_no=episode_no,
        script_text=script_text,
    )

    # 2. Asset matching
    matches, gaps = coordinator.asset.run(breakdown.requirements, inventory)

    # 3. Generate reusable assets for every explicit generation gap. The
    # candidate only enters the scene workflow after its own review decision.
    requirement_by_id = {item.requirement_id: item for item in breakdown.requirements}
    generated_assets = []
    asset_generations = []
    unresolved_gaps = []
    trace_id = stable_id("trace", project_id, episode_no)
    for gap in gaps:
        requirement = requirement_by_id.get(gap.requirement_id)
        if gap.recommendation != "generate" or requirement is None:
            unresolved_gaps.append(gap)
            continue

        idempotency_key = stable_id("asset_idem", requirement.requirement_id, trace_id)
        task, result = coordinator.asset_generation.run(
            requirement, trace_id, idempotency_key,
        )
        receipt = {"task": to_dict(task), "result": to_dict(result)}
        if task.state == "succeeded" and result.output_url and auto_approve_generated_assets:
            review = coordinator.review_gate.request(
                "asset_generation_result", result.result_id,
                "auto-approved generated asset for demo",
            )
            coordinator.review_gate.approve(review, reviewer="director")
            generated_asset = coordinator.promote_generated_asset(result, review)
            generated_assets.append(generated_asset)
            matches.append(AssetMatch(
                requirement.requirement_id, generated_asset.asset_id, 1.0,
                "generated from the unmatched script requirement",
            ))
            receipt["promoted_asset"] = to_dict(generated_asset)
        else:
            unresolved_gaps.append(gap)
        asset_generations.append(receipt)

    # 4. Shot card assembly uses both inventory matches and approved generated assets.
    packages = coordinator.scene.run(breakdown, matches, unresolved_gaps)

    # 4. Auto-approve all shot cards for demo mode
    for pkg in packages:
        review_item = coordinator.review_gate.request(
            "shot_card", pkg.shot.shot_id, "auto-approved for demo"
        )
        coordinator.review_gate.approve(review_item, reviewer="director")

    # 5. Image generation
    generation_results = []
    for pkg in packages:
        idem_key = stable_id("idem", pkg.shot.shot_id, trace_id)
        task, result = coordinator.generation.run(pkg.shot, trace_id, idem_key)
        generation_results.append({
            "scene_id": pkg.scene_id,
            "task": to_dict(task),
            "result": to_dict(result),
        })

    return {
        "breakdown": to_dict(breakdown),
        "matches": [to_dict(m) for m in matches],
        # Retain the original response key for existing callers; it now means
        # only the gaps that were not promoted into usable generated assets.
        "gaps": [to_dict(g) for g in unresolved_gaps],
        "unresolved_gaps": [to_dict(g) for g in unresolved_gaps],
        "generated_assets": [to_dict(asset) for asset in generated_assets],
        "asset_generations": asset_generations,
        "packages": [to_dict(p) for p in packages],
        "generation_results": generation_results,
    }


# ---------------------------------------------------------------------------
# Harness bootstrap
# ---------------------------------------------------------------------------

def _resolve_model_api_key() -> str:
    for name in ("MODEL_AGENT_API_KEY", "ARK_API_KEY", "VOLCENGINE_ARK_API_KEY"):
        token = os.getenv(name, "").strip()
        if token:
            return token
    return get_ark_token()


def _create_long_term_memory() -> LongTermMemory | None:
    """Use the AgentKit-attached Viking collection when deployed in cloud."""

    collection = os.getenv("DATABASE_VIKINGMEM_COLLECTION", "").strip()
    if not collection:
        return None
    return LongTermMemory(
        backend="viking",
        index=collection,
        app_name="sd_orchestrator",
    )


def _load_config() -> dict:
    search_dirs = (Path.cwd(), Path(__file__).parent)
    for d in search_dirs:
        for f in sorted(d.glob("*.harness.json")):
            with open(f, encoding="utf-8") as fp:
                return json.load(fp)
    for d in search_dirs:
        p = d / "harness.json"
        if p.exists():
            with open(p, encoding="utf-8") as fp:
                return json.load(fp)
    return {}


def create_root_agent() -> Agent:
    config = _load_config()
    name = config.get("harness_name", "sd_orchestrator").replace("-", "_")
    system_prompt = config.get("system_prompt", (
        "你是短剧生产链路编排 Agent。"
        "收到剧本和资产库存后，调用 run_production_pipeline 工具完成全链路生产，"
        "包含剧本拆解、资产匹配、镜头卡组装和画面生成，并将结果汇总返回给用户。"
        "如果用户没有提供资产库存，传入空数组 '[]'。"
    ))
    system_prompt += (
        "\n\n当用户用自然语言要求生成角色、场景或道具资产时，先调用 "
        "create_asset_card 并展示返回的资产卡（名称、性别、年龄、视觉特征和提示词）。"
        "不得在同一轮直接调用 confirm_asset_card；只有用户在后续消息中明确确认该卡片后，"
        "才可以调用 confirm_asset_card 生成图片。用户要求修改时，基于修改后的描述重新创建资产卡。"
        "创建资产卡后需要说明任务当前为 awaiting_confirmation；需要回顾进度时调用 get_task_status。"
    )
    long_term_memory = _create_long_term_memory()
    return Agent(
        name=name,
        model_api_key=_resolve_model_api_key(),
        instruction=system_prompt,
        long_term_memory=long_term_memory,
        auto_save_session=long_term_memory is not None,
        tools=[
            FunctionTool(create_asset_card),
            FunctionTool(confirm_asset_card),
            FunctionTool(get_task_status),
            FunctionTool(run_production_pipeline),
        ],
    )


root_agent = create_root_agent()
agent_server_app = AgentkitAgentServerApp(
    agent=root_agent,
    short_term_memory=ShortTermMemory(backend="local"),
)

if __name__ == "__main__":
    if os.getenv("SHORTDRAMA_RESEARCH_RUNTIME") != "DEV" or os.getenv("SHORTDRAMA_RESEARCH_OPT_IN") != "1":
        raise SystemExit("AgentKit research runtime is disabled; set SHORTDRAMA_RESEARCH_RUNTIME=DEV and SHORTDRAMA_RESEARCH_OPT_IN=1")
    agent_server_app.run(host="0.0.0.0", port=8000)
