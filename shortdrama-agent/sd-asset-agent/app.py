"""Harness entry point – sd-asset-agent.

Exposes AssetSkill as a FunctionTool for semantic matching of asset requirements
against inventory.
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
# FunctionTool – AssetSkill
# ---------------------------------------------------------------------------

def match_assets(requirements_json: str, inventory_json: str) -> dict:
    """Match asset requirements against inventory using semantic LLM understanding.

    Args:
        requirements_json: JSON array of requirement objects, each with fields:
            requirement_id (str), kind (character|scene|prop), name (str),
            evidence: {scene_no, excerpt, confidence}.
        inventory_json: JSON array of asset objects, each with fields:
            asset_id (str), name (str), kind (str),
            description (str, optional), aliases (list, optional).

    Returns:
        Dict with 'matches' (list of {requirement_id, asset_id, confidence,
        rationale}) and 'gaps' (list of {requirement_id, recommendation}).
    """
    from production_chain.workflow import AssetSkill
    from production_chain.models import (
        AssetRequirementCandidate, AssetRecord, Evidence, to_dict,
    )

    reqs_data = json.loads(requirements_json) if isinstance(requirements_json, str) else requirements_json
    inv_data = json.loads(inventory_json) if isinstance(inventory_json, str) else inventory_json

    requirements = []
    for r in reqs_data:
        ev = r.get("evidence") or {}
        requirements.append(AssetRequirementCandidate(
            requirement_id=r["requirement_id"],
            kind=r["kind"],
            name=r["name"],
            evidence=Evidence(
                scene_no=int(ev.get("scene_no", 1)),
                excerpt=ev.get("excerpt", ""),
                confidence=float(ev.get("confidence", 0.5)),
            ),
        ))

    inventory = [
        AssetRecord(
            asset_id=a["asset_id"],
            name=a["name"],
            kind=a["kind"],
            description=a.get("description", ""),
            aliases=a.get("aliases", []),
        )
        for a in inv_data
    ]

    skill = AssetSkill()
    matches, gaps = skill.run(requirements, inventory)
    return {
        "matches": [to_dict(m) for m in matches],
        "gaps": [to_dict(g) for g in gaps],
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
    name = config.get("harness_name", "sd_asset_agent").replace("-", "_")
    system_prompt = config.get("system_prompt", (
        "你是短剧资产匹配专家。"
        "收到需求列表和资产库存后，调用 match_assets 工具进行语义匹配，"
        "返回匹配结果和缺口列表。"
    ))
    return Agent(
        name=name,
        model_api_key=_resolve_model_api_key(),
        instruction=system_prompt,
        tools=[FunctionTool(match_assets)],
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
