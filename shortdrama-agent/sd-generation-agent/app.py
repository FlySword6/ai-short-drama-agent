"""Harness entry point – sd-generation-agent.

Exposes a generate_scene_image FunctionTool backed by the Volcengine Ark
image generation API.
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
# FunctionTool – GenerationSkill
# ---------------------------------------------------------------------------

def generate_scene_image(prompt: str, size: str = "1024x1024") -> dict:
    """Generate a scene image from a shot card prompt.

    Calls the Volcengine Ark image generation API
    (doubao-seedream-3-0-t2i-250415 by default).

    Args:
        prompt: Shot card prompt summary describing the scene to generate.
        size: Image size string, e.g. '1024x1024' (default).

    Returns:
        Dict with:
          - state: 'succeeded' or 'failed'
          - output_url: image URL (empty on failure)
          - description: brief description or error message
    """
    from production_chain.llm import LLMClient

    llm = LLMClient()
    try:
        url = llm.generate_image(prompt=prompt, size=size)
        return {
            "state": "succeeded",
            "output_url": url,
            "description": f"已生成画面：{prompt[:80]}",
        }
    except Exception as exc:
        return {
            "state": "failed",
            "output_url": "",
            "description": f"生成失败：{exc}",
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
    name = config.get("harness_name", "sd_generation_agent").replace("-", "_")
    system_prompt = config.get("system_prompt", (
        "你是短剧画面生成 Agent。"
        "收到镜头卡提示词后，调用 generate_scene_image 工具生成画面，"
        "返回生成结果（output_url 和 state）。"
    ))
    return Agent(
        name=name,
        model_api_key=_resolve_model_api_key(),
        instruction=system_prompt,
        tools=[FunctionTool(generate_scene_image)],
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
