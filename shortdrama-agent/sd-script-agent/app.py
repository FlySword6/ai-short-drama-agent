"""Harness entry point – sd-script-agent.

Exposes ScriptSkill as a FunctionTool so the LLM agent can call it with
structured parameters and return a verified ScriptBreakdown result.
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
# FunctionTool – ScriptSkill
# ---------------------------------------------------------------------------

def parse_script(
    project_id: str,
    title: str,
    episode_no: int,
    script_text: str,
) -> dict:
    """Parse a short-drama script and extract scenes and asset requirements.

    Calls the real ScriptSkill (Volcengine Ark LLM) to extract:
    - scenes: list of scene drafts with scene_id, scene_no, title, dialogue
    - requirements: list of asset requirements with kind (character/scene/prop),
      name, and evidence (excerpt, confidence)

    Args:
        project_id: Unique project identifier for idempotency tracking.
        title: Episode title.
        episode_no: Episode number (integer).
        script_text: Full script text to parse.

    Returns:
        ScriptBreakdown dict with 'scenes' and 'requirements' arrays.
    """
    from production_chain.workflow import ScriptSkill
    from production_chain.models import to_dict

    skill = ScriptSkill()
    result = skill.run(
        project_id=project_id,
        title=title,
        episode_no=episode_no,
        script_text=script_text,
    )
    return to_dict(result)


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
    """Load harness spec (*.harness.json preferred, harness.json as fallback)."""
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
    name = config.get("harness_name", "sd_script_agent").replace("-", "_")
    system_prompt = config.get("system_prompt", (
        "你是短剧制作前期的剧本拆解专家。"
        "收到剧本后，调用 parse_script 工具完成结构化拆解，"
        "返回场景草稿和资产需求列表。"
    ))
    return Agent(
        name=name,
        model_api_key=_resolve_model_api_key(),
        instruction=system_prompt,
        tools=[FunctionTool(parse_script)],
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
