"""Sub-agent server implementations — each Skill wrapped as an A2A agent.

Each sub-agent:
1. Publishes an AgentCard describing its capabilities
2. Wraps the corresponding Skill's logic in a task handler
3. Runs an ``A2AAgentServer`` to accept HTTP JSON-RPC requests

The orchestrator discovers these agents via AgentCards and sends tasks
through ``A2AClient``.  Sub-agents are **stateless** — all stateful
concerns (ReviewGate, idempotency, promotion) live in the orchestrator.
"""

from __future__ import annotations

from typing import Any

from production_chain.llm import LLMClient, default_llm
from production_chain.models import (
    AssetGap, AssetMatch, AssetRecord, AssetRequirementCandidate,
    Evidence, SceneDraft, ScriptBreakdown, to_dict,
)
from production_chain.workflow import AssetSkill, SceneSkill, ScriptSkill

from .hub import HubManager
from .protocol import AgentCard
from .protocol import AgentSkill as CardSkill
from .server import A2AAgentServer


# ---------------------------------------------------------------------------
# Dataclass reconstruction helpers (dict → dataclass)
# ---------------------------------------------------------------------------

def _dict_to_evidence(d: dict) -> Evidence:
    return Evidence(
        scene_no=d["scene_no"],
        excerpt=d.get("excerpt", ""),
        confidence=d.get("confidence", 0.5),
    )


def _dict_to_requirement(d: dict) -> AssetRequirementCandidate:
    return AssetRequirementCandidate(
        requirement_id=d["requirement_id"],
        kind=d["kind"],
        name=d["name"],
        evidence=_dict_to_evidence(d.get("evidence", {})),
    )


def _dict_to_asset_record(d: dict) -> AssetRecord:
    return AssetRecord(
        asset_id=d["asset_id"],
        name=d["name"],
        kind=d["kind"],
        description=d.get("description", ""),
        aliases=d.get("aliases", []),
    )


def _dict_to_scene_draft(d: dict) -> SceneDraft:
    return SceneDraft(
        scene_id=d["scene_id"],
        scene_no=d["scene_no"],
        title=d.get("title", ""),
        dialogue=d.get("dialogue", ""),
        revision=d.get("revision", 1),
    )


def _dict_to_breakdown(d: dict) -> ScriptBreakdown:
    return ScriptBreakdown(
        project_id=d["project_id"],
        script_title=d.get("script_title", ""),
        episode_no=d["episode_no"],
        script_version=d.get("script_version", ""),
        parse_batch_id=d.get("parse_batch_id", ""),
        scenes=[_dict_to_scene_draft(s) for s in d.get("scenes", [])],
        requirements=[_dict_to_requirement(r) for r in d.get("requirements", [])],
    )


def _dict_to_asset_match(d: dict) -> AssetMatch:
    return AssetMatch(
        requirement_id=d["requirement_id"],
        asset_id=d["asset_id"],
        confidence=d.get("confidence", 0.5),
        rationale=d.get("rationale", ""),
    )


def _dict_to_asset_gap(d: dict) -> AssetGap:
    return AssetGap(
        requirement_id=d["requirement_id"],
        recommendation=d.get("recommendation", "generate"),
    )


# ---------------------------------------------------------------------------
# ScriptAgent — 剧本语义拆解
# ---------------------------------------------------------------------------

_SCRIPT_CARD = AgentCard(
    name="script-agent",
    description="剧本语义拆解 Agent：从剧本文本中提取场景草稿和资产需求",
    url="",
    version="0.1.0",
    capabilities={"streaming": False},
    skills=[
        CardSkill(
            name="script_breakdown",
            description="从剧本文本中提取场景和资产需求",
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "title": {"type": "string"},
                    "episode_no": {"type": "integer"},
                    "script_text": {"type": "string"},
                },
            },
        ),
    ],
)


class ScriptAgentServer:
    """A2A agent wrapping :class:`ScriptSkill`."""

    def __init__(self, llm: LLMClient | None = None) -> None:
        self._skill = ScriptSkill(llm=llm)
        self._server: A2AAgentServer | None = None

    def _handle_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        breakdown = self._skill.run(
            project_id=payload["project_id"],
            title=payload["title"],
            episode_no=payload["episode_no"],
            script_text=payload["script_text"],
        )
        return to_dict(breakdown)

    def start(self, host: str = "127.0.0.1", port: int = 0) -> str:
        self._server = A2AAgentServer(_SCRIPT_CARD, self._handle_task, host, port)
        return self._server.start()

    def stop(self) -> None:
        if self._server:
            self._server.stop()
            self._server = None

    @property
    def url(self) -> str:
        return self._server.url if self._server else ""


# ---------------------------------------------------------------------------
# AssetAgent — 资产语义匹配
# ---------------------------------------------------------------------------

_ASSET_CARD = AgentCard(
    name="asset-agent",
    description="资产语义匹配 Agent：将需求列表与资产库存进行语义匹配",
    url="",
    version="0.1.0",
    capabilities={"streaming": False},
    skills=[
        CardSkill(
            name="asset_match",
            description="将需求列表与资产库存进行语义匹配，返回匹配和缺口",
            input_schema={
                "type": "object",
                "properties": {
                    "requirements": {"type": "array"},
                    "inventory": {"type": "array"},
                },
            },
        ),
    ],
)


class AssetAgentServer:
    """A2A agent wrapping :class:`AssetSkill`."""

    def __init__(self, llm: LLMClient | None = None) -> None:
        self._skill = AssetSkill(llm=llm)
        self._server: A2AAgentServer | None = None

    def _handle_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        requirements = [
            _dict_to_requirement(r) for r in payload.get("requirements", [])
        ]
        inventory = [
            _dict_to_asset_record(a) for a in payload.get("inventory", [])
        ]
        matches, gaps = self._skill.run(requirements, inventory)
        return {
            "matches": [to_dict(m) for m in matches],
            "gaps": [to_dict(g) for g in gaps],
        }

    def start(self, host: str = "127.0.0.1", port: int = 0) -> str:
        self._server = A2AAgentServer(_ASSET_CARD, self._handle_task, host, port)
        return self._server.start()

    def stop(self) -> None:
        if self._server:
            self._server.stop()
            self._server = None

    @property
    def url(self) -> str:
        return self._server.url if self._server else ""


# ---------------------------------------------------------------------------
# SceneAgent — 镜头卡组装
# ---------------------------------------------------------------------------

_SCENE_CARD = AgentCard(
    name="scene-agent",
    description="镜头卡组装 Agent：为每个场景生成专业画面提示词",
    url="",
    version="0.1.0",
    capabilities={"streaming": False},
    skills=[
        CardSkill(
            name="scene_assemble",
            description="根据场景草稿和资产匹配生成镜头卡提示词",
            input_schema={
                "type": "object",
                "properties": {
                    "breakdown": {"type": "object"},
                    "matches": {"type": "array"},
                    "gaps": {"type": "array"},
                },
            },
        ),
    ],
)


class SceneAgentServer:
    """A2A agent wrapping :class:`SceneSkill`."""

    def __init__(self, llm: LLMClient | None = None) -> None:
        self._skill = SceneSkill(llm=llm)
        self._server: A2AAgentServer | None = None

    def _handle_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        breakdown = _dict_to_breakdown(payload["breakdown"])
        matches = [_dict_to_asset_match(m) for m in payload.get("matches", [])]
        gaps = [_dict_to_asset_gap(g) for g in payload.get("gaps", [])]
        packages = self._skill.run(breakdown, matches, gaps)
        return {"packages": [to_dict(p) for p in packages]}

    def start(self, host: str = "127.0.0.1", port: int = 0) -> str:
        self._server = A2AAgentServer(_SCENE_CARD, self._handle_task, host, port)
        return self._server.start()

    def stop(self) -> None:
        if self._server:
            self._server.stop()
            self._server = None

    @property
    def url(self) -> str:
        return self._server.url if self._server else ""


# ---------------------------------------------------------------------------
# GenerationAgent — 画面生成（无状态，不含 ReviewGate）
# ---------------------------------------------------------------------------

_GEN_CARD = AgentCard(
    name="generation-agent",
    description="画面生成 Agent：调用 Ark 图片生成 API（无状态，不含审片逻辑）",
    url="",
    version="0.1.0",
    capabilities={"streaming": False},
    skills=[
        CardSkill(
            name="generate_image",
            description="根据提示词生成画面",
            input_schema={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string"},
                    "size": {"type": "string"},
                },
            },
        ),
    ],
)


class GenerationAgentServer:
    """A2A agent wrapping the image generation API.

    Unlike the monolithic :class:`GenerationSkill`, this agent is
    **stateless** — it does not enforce ReviewGate or track idempotency.
    Those concerns are the orchestrator's responsibility.
    """

    def __init__(self, llm: LLMClient | None = None) -> None:
        self._llm = llm or default_llm()
        self._server: A2AAgentServer | None = None

    def _handle_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        prompt = payload["prompt"]
        size = payload.get("size", "1024x1024")
        try:
            output_url = self._llm.generate_image(prompt=prompt, size=size)
            return {"output_url": output_url, "state": "succeeded"}
        except Exception as exc:
            return {"output_url": "", "state": "failed", "error": str(exc)}

    def start(self, host: str = "127.0.0.1", port: int = 0) -> str:
        self._server = A2AAgentServer(_GEN_CARD, self._handle_task, host, port)
        return self._server.start()

    def stop(self) -> None:
        if self._server:
            self._server.stop()
            self._server = None

    @property
    def url(self) -> str:
        return self._server.url if self._server else ""


# ---------------------------------------------------------------------------
# SubAgentCluster — convenience to start/stop all sub-agents together
# ---------------------------------------------------------------------------

class SubAgentCluster:
    """Manage all four sub-agent servers as a group.

    Starts each agent on a random port (port=0) and provides a
    ``urls`` dict mapping agent names to their base URLs.

    Usage::

        cluster = SubAgentCluster(llm=mock_llm)
        cluster.start()
        urls = cluster.urls  # {"script": "http://...", "asset": ..., ...}
        # ... orchestrator runs pipeline using urls ...
        cluster.stop()
    """

    def __init__(
        self,
        llm: LLMClient | None = None,
        hub: HubManager | None = None,
    ) -> None:
        self._llm = llm
        self._hub = hub
        self._agents = {
            "script": ScriptAgentServer(llm=llm),
            "asset": AssetAgentServer(llm=llm),
            "scene": SceneAgentServer(llm=llm),
            "generation": GenerationAgentServer(llm=llm),
        }

    def start(self, host: str = "127.0.0.1") -> dict[str, str]:
        """Start all sub-agents and optionally register to Hub.

        Returns a dict of ``{name: url}``.
        """

        urls: dict[str, str] = {}
        for name, agent in self._agents.items():
            url = agent.start(host=host)
            urls[name] = url

            # 注册到 A2A Hub（如果配置了）
            if self._hub is not None and self._hub.is_running:
                card = agent._server.card  # type: ignore[union-attr]
                self._hub.register_agent(
                    agent_id=card.name,
                    agent_card=card.to_dict(),
                )
        return urls

    def stop(self) -> None:
        """Stop all sub-agents."""

        for agent in self._agents.values():
            agent.stop()

    @property
    def urls(self) -> dict[str, str]:
        """Current base URLs of all running sub-agents."""

        return {
            name: agent.url
            for name, agent in self._agents.items()
        }

    @property
    def cards(self) -> dict[str, AgentCard]:
        """AgentCards of all sub-agents (after start)."""

        return {
            name: agent._server.card  # type: ignore[union-attr]
            for name, agent in self._agents.items()
            if agent._server is not None
        }
