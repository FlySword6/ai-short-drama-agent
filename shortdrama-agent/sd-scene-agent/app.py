"""Harness entry point – sd-scene-agent.

Exposes SceneSkill as a FunctionTool for assembling LLM-generated shot card
prompts from script breakdown and asset matching results.
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
from veadk.memory.short_term_memory import ShortTermMemory


# ---------------------------------------------------------------------------
# FunctionTool – SceneSkill
# ---------------------------------------------------------------------------

def assemble_shots(
    breakdown_json: str,
    matches_json: str,
    gaps_json: str,
) -> dict:
    """Generate shot card prompts for each scene using SceneSkill.

    Args:
        breakdown_json: ScriptBreakdown dict (output of sd-script-agent parse_script).
            Must contain 'project_id', 'script_title', 'episode_no',
            'script_version', 'parse_batch_id', 'scenes', 'requirements'.
        matches_json: JSON array of AssetMatch objects from sd-asset-agent.
            Each item: {requirement_id, asset_id, confidence, rationale}.
        gaps_json: JSON array of AssetGap objects from sd-asset-agent.
            Each item: {requirement_id, recommendation}.

    Returns:
        Dict with 'packages' array. Each package: {scene_id, readiness,
        shot: {shot_id, scene_id, prompt_summary, asset_ids}, missing_requirement_ids}.
    """
    from production_chain.workflow import SceneSkill
    from production_chain.models import (
        ScriptBreakdown, SceneDraft, AssetRequirementCandidate,
        Evidence, AssetMatch, AssetGap, to_dict,
    )

    bd = json.loads(breakdown_json) if isinstance(breakdown_json, str) else breakdown_json
    matches_data = json.loads(matches_json) if isinstance(matches_json, str) else matches_json
    gaps_data = json.loads(gaps_json) if isinstance(gaps_json, str) else gaps_json

    scenes = [
        SceneDraft(
            scene_id=s["scene_id"],
            scene_no=int(s["scene_no"]),
            title=s["title"],
            dialogue=s["dialogue"],
            revision=int(s.get("revision", 1)),
        )
        for s in bd.get("scenes", [])
    ]
    requirements = [
        AssetRequirementCandidate(
            requirement_id=r["requirement_id"],
            kind=r["kind"],
            name=r["name"],
            evidence=Evidence(
                scene_no=int(r["evidence"]["scene_no"]),
                excerpt=r["evidence"]["excerpt"],
                confidence=float(r["evidence"]["confidence"]),
            ),
        )
        for r in bd.get("requirements", [])
    ]
    breakdown = ScriptBreakdown(
        project_id=bd["project_id"],
        script_title=bd["script_title"],
        episode_no=int(bd["episode_no"]),
        script_version=bd["script_version"],
        parse_batch_id=bd["parse_batch_id"],
        scenes=scenes,
        requirements=requirements,
    )

    matches = [
        AssetMatch(
            requirement_id=m["requirement_id"],
            asset_id=m["asset_id"],
            confidence=float(m["confidence"]),
            rationale=m.get("rationale", ""),
        )
        for m in matches_data
    ]
    gaps = [
        AssetGap(
            requirement_id=g["requirement_id"],
            recommendation=g.get("recommendation", "generate"),
        )
        for g in gaps_data
    ]

    skill = SceneSkill()
    packages = skill.run(breakdown, matches, gaps)
    return {"packages": [to_dict(p) for p in packages]}


# ---------------------------------------------------------------------------
# Harness bootstrap
# ---------------------------------------------------------------------------

def _resolve_model_api_key() -> str:
    for name in ("MODEL_AGENT_API_KEY", "ARK_API_KEY", "VOLCENGINE_ARK_API_KEY"):
        token = os.getenv(name, "").strip()
        if token:
            return token
    return get_ark_token()


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
    name = config.get("harness_name", "sd_scene_agent").replace("-", "_")
    system_prompt = config.get("system_prompt", (
        "你是短剧分镜师。"
        "收到剧本拆解结果、资产匹配和缺口信息后，调用 assemble_shots 工具"
        "生成每个场景的专业镜头卡画面提示词。"
    ))
    return Agent(
        name=name,
        model_api_key=_resolve_model_api_key(),
        instruction=system_prompt,
        tools=[FunctionTool(assemble_shots)],
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
