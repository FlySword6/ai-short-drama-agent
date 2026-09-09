"""A2A orchestrator — coordinates sub-agents via A2A protocol.

Replaces the direct function-call pipeline with A2A HTTP calls.
The orchestrator owns:
- **ReviewGate**: authorization boundary (no sub-agent may bypass)
- **Idempotency**: tracks generation tasks by key
- **Promotion**: converts approved generation results to assets

Sub-agents are stateless and disposable — they can be restarted
or scaled independently without affecting pipeline state.
"""

from __future__ import annotations

import time
from uuid import uuid4

from production_chain.models import (
    AssetRecord, GenerationResult, GenerationTask, ReviewItem,
    ScenePackage, ShotCardDraft, to_dict,
)
from production_chain.workflow import ReviewGate, stable_id

from .client import A2AClient
from .sub_agents import _dict_to_asset_gap, _dict_to_asset_match, _dict_to_breakdown


# ---------------------------------------------------------------------------
# Dict → dataclass helpers for orchestrator-only types
# ---------------------------------------------------------------------------

def _dict_to_shot_card(d: dict) -> ShotCardDraft:
    return ShotCardDraft(
        shot_id=d["shot_id"],
        scene_id=d["scene_id"],
        revision=d.get("revision", 1),
        prompt_summary=d.get("prompt_summary", ""),
        asset_ids=d.get("asset_ids", []),
    )


def _dict_to_scene_package(d: dict) -> ScenePackage:
    return ScenePackage(
        scene_id=d["scene_id"],
        readiness=d.get("readiness", "blocked"),
        shot=_dict_to_shot_card(d["shot"]),
        missing_requirement_ids=d.get("missing_requirement_ids", []),
    )


# ---------------------------------------------------------------------------
# A2AOrchestrator
# ---------------------------------------------------------------------------

DEFAULT_SCRIPT = (
    "角色：林夏；场景：旧画室；道具：折角准考证；"
    "林夏低声说：我再画一张。"
)

DEFAULT_INVENTORY = [
    {
        "asset_id": "asset_linxia",
        "name": "林夏",
        "kind": "character",
        "description": "女主角，年轻画家",
        "aliases": ["林夏", "小夏"],
    },
    {
        "asset_id": "asset_studio",
        "name": "旧画室",
        "kind": "scene",
        "description": "老旧画室，光线昏暗",
        "aliases": ["画室"],
    },
    {
        "asset_id": "asset_ticket",
        "name": "折角准考证",
        "kind": "prop",
        "description": "折角的准考证",
        "aliases": ["准考证"],
    },
]


class A2AOrchestrator:
    """Coordinates the production chain by calling A2A sub-agents.

    Args:
        agent_urls: Maps agent names to base URLs.
            Required keys: "script", "asset", "scene", "generation".
        client: Optional ``A2AClient`` instance (created if omitted).
    """

    def __init__(
        self,
        agent_urls: dict[str, str],
        client: A2AClient | None = None,
    ) -> None:
        self._urls = agent_urls
        self._client = client or A2AClient()
        self._review_gate = ReviewGate()
        self._gen_tasks: dict[str, GenerationTask] = {}
        self._gen_results: dict[str, GenerationResult] = {}

    @property
    def review_gate(self) -> ReviewGate:
        return self._review_gate

    # ------------------------------------------------------------------
    # Pipeline
    # ------------------------------------------------------------------

    def run(
        self,
        *,
        project_id: str = "demo-project",
        title: str = "画室夜训",
        episode_no: int = 1,
        script_text: str = DEFAULT_SCRIPT,
        inventory: list[AssetRecord] | None = None,
        reviewer: str = "director",
        verbose: bool = True,
    ) -> dict[str, object]:
        """Run the full production chain via A2A sub-agents.

        Returns a trace receipt with the same structure as the
        direct-call pipeline in ``agent.py``.
        """

        def _log(step: str, msg: str = "") -> None:
            if not verbose:
                return
            ts = time.strftime("%H:%M:%S")
            line = f"[{ts}] ▸ {step}"
            if msg:
                line += f" — {msg}"
            print(line, flush=True)

        if inventory is None:
            inventory = [
                AssetRecord(
                    asset_id=item["asset_id"],
                    name=item["name"],
                    kind=item["kind"],
                    description=item.get("description", ""),
                    aliases=item.get("aliases", []),
                )
                for item in DEFAULT_INVENTORY
            ]

        trace_id = f"trace_{uuid4().hex}"
        _log("START", f"trace_id={trace_id}  project={project_id}  episode={episode_no}")
        _log("A2A", f"sub-agents: {', '.join(f'{k}={v}' for k, v in self._urls.items())}")

        # ------------------------------------------------------------------
        # 1. Script Agent (A2A)
        # ------------------------------------------------------------------
        _log("→ ScriptAgent", f"POST {self._urls['script']}")
        t0 = time.time()
        breakdown_data = self._client.send_task(
            self._urls["script"],
            {
                "project_id": project_id,
                "title": title,
                "episode_no": episode_no,
                "script_text": script_text,
            },
        )
        breakdown = _dict_to_breakdown(breakdown_data)
        _log("← ScriptAgent",
             f"{time.time()-t0:.1f}s  拆出 {len(breakdown.scenes)} 场、"
             f"{len(breakdown.requirements)} 个需求")
        for req in breakdown.requirements:
            _log("  └", f"{req.kind}: {req.name}  (置信度 {req.evidence.confidence})")

        # ------------------------------------------------------------------
        # 2. Asset Agent (A2A)
        # ------------------------------------------------------------------
        _log("→ AssetAgent", f"POST {self._urls['asset']}")
        t0 = time.time()
        asset_data = self._client.send_task(
            self._urls["asset"],
            {
                "requirements": [to_dict(r) for r in breakdown.requirements],
                "inventory": [to_dict(a) for a in inventory],
            },
        )
        matches = [_dict_to_asset_match(m) for m in asset_data.get("matches", [])]
        gaps = [_dict_to_asset_gap(g) for g in asset_data.get("gaps", [])]
        _log("← AssetAgent",
             f"{time.time()-t0:.1f}s  匹配 {len(matches)} 个、缺口 {len(gaps)} 个")
        for m in matches:
            _log("  └", f"{m.requirement_id[:16]}… → {m.asset_id}  (置信度 {m.confidence})")
        for g in gaps:
            _log("  └", f"缺口 {g.requirement_id[:16]}… → 建议 {g.recommendation}")

        # ------------------------------------------------------------------
        # 3. Scene Agent (A2A)
        # ------------------------------------------------------------------
        _log("→ SceneAgent", f"POST {self._urls['scene']}")
        t0 = time.time()
        scene_data = self._client.send_task(
            self._urls["scene"],
            {
                "breakdown": to_dict(breakdown),
                "matches": [to_dict(m) for m in matches],
                "gaps": [to_dict(g) for g in gaps],
            },
        )
        packages = [
            _dict_to_scene_package(p)
            for p in scene_data.get("packages", [])
        ]
        _log("← SceneAgent", f"{time.time()-t0:.1f}s  生成 {len(packages)} 个镜头卡")
        for p in packages:
            _log("  └", f"{p.shot.shot_id[:20]}…  readiness={p.readiness}")
            _log("  └", f"prompt: {p.shot.prompt_summary[:80]}…")

        # ------------------------------------------------------------------
        # 4. Review → Generation → Review → Promotion (orchestrator-owned)
        # ------------------------------------------------------------------
        all_tasks: list[GenerationTask] = []
        all_results: list[GenerationResult] = []
        all_promoted: list[AssetRecord] = []

        for i, package in enumerate(packages, 1):
            _log(f"--- 镜头卡 {i}/{len(packages)} ---")

            # 第一道人审：导演确认镜头卡
            _log("ReviewGate①", f"request shot_card {package.shot.shot_id[:20]}…")
            shot_review = self._review_gate.request(
                "shot_card", package.shot.shot_id, "director confirmation required",
            )
            self._review_gate.approve(shot_review, reviewer=reviewer)
            _log("ReviewGate①", f"approved by {reviewer}")

            # 调用 Generation Agent (A2A)
            # A revision is only unique within a shot. Include the shot ID so
            # different scenes at revision 1 cannot share a generated image.
            idempotency_key = (
                f"{breakdown.script_version}:{package.shot.shot_id}:"
                f"{package.shot.revision}"
            )
            task, result = self._call_generation_agent(
                package.shot, trace_id, idempotency_key, _log,
            )
            all_tasks.append(task)
            all_results.append(result)

            # A failed or empty generation is only a failed task record. It
            # must never enter the review-and-promotion path as an asset.
            if task.state != "succeeded" or not result.output_url:
                _log("GenerationAgent", "generation failed; skip review and promotion")
                continue

            # 第二道人审：生成结果候选 → 正式资产
            _log("ReviewGate②", f"request generation_result {result.result_id[:20]}…")
            result_review = self._review_gate.request(
                "generation_result", result.result_id,
                "result promotion requires review",
            )
            self._review_gate.approve(result_review, reviewer=reviewer)
            _log("ReviewGate②", f"approved by {reviewer}")

            promoted = self._promote_result_to_asset(result, result_review)
            _log("PromoteAsset", f"asset_id={promoted.asset_id[:20]}…  kind={promoted.kind}")
            all_promoted.append(promoted)

        _log("DONE",
             f"tasks={len(all_tasks)}  results={len(all_results)}  "
             f"assets={len(all_promoted)}")

        return to_dict({
            "trace_id": trace_id,
            "breakdown": breakdown,
            "matches": matches,
            "gaps": gaps,
            "scene_packages": packages,
            "generation_tasks": all_tasks,
            "generation_results": all_results,
            "promoted_assets": all_promoted,
        })

    # ------------------------------------------------------------------
    # Generation via A2A (with idempotency in orchestrator)
    # ------------------------------------------------------------------

    def _call_generation_agent(
        self,
        shot: ShotCardDraft,
        trace_id: str,
        idempotency_key: str,
        _log,
    ) -> tuple[GenerationTask, GenerationResult]:
        """Send generation task to the GenerationAgent via A2A.

        Idempotency is tracked locally — duplicate calls with the
        same key return the cached result without hitting the agent.
        """

        # 幂等检查：同一 key 的重复请求直接返回缓存结果。
        cached_task = self._gen_tasks.get(idempotency_key)
        if cached_task is not None:
            cached_result = self._gen_results.get(
                idempotency_key,
                GenerationResult(
                    stable_id("result", cached_task.task_id),
                    cached_task.task_id, shot.shot_id, "candidate", 0, "",
                ),
            )
            return cached_task, cached_result

        # 调用 Generation Agent (A2A)
        _log("→ GenerationAgent", f"POST {self._urls['generation']}")
        t0 = time.time()
        gen_data = self._client.send_task(
            self._urls["generation"],
            {"prompt": shot.prompt_summary, "size": "1024x1024"},
        )
        elapsed = time.time() - t0
        state = gen_data.get("state", "failed")
        output_url = gen_data.get("output_url", "")
        _log("← GenerationAgent",
             f"{elapsed:.1f}s  state={state}  "
             f"output_url={'有' if output_url else '无'}")

        task = GenerationTask(
            stable_id("gen", shot.shot_id, idempotency_key),
            shot.shot_id, trace_id, idempotency_key, state,
        )
        result = GenerationResult(
            stable_id("result", task.task_id),
            task.task_id, shot.shot_id, "candidate",
            cost_cents=20 if state == "succeeded" else 0,
            output_url=output_url,
        )
        self._gen_tasks[idempotency_key] = task
        self._gen_results[idempotency_key] = result
        return task, result

    # ------------------------------------------------------------------
    # Promotion (orchestrator-owned, same logic as ProductionChainAgent)
    # ------------------------------------------------------------------

    def _promote_result_to_asset(
        self, result: GenerationResult, review: ReviewItem,
    ) -> AssetRecord:
        """Promote an approved generation result to a formal asset."""

        if review.target_id != result.result_id:
            raise ValueError("review item does not belong to this generation result")
        self._review_gate.require_approved(result.result_id)
        return AssetRecord(
            stable_id("asset", result.result_id),
            f"generated-{result.shot_id}", "video",
        )
