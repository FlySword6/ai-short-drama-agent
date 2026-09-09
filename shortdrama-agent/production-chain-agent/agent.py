"""CLI entry point for the LLM-powered production chain.

Each Skill (Script, Asset, Scene, Generation) now calls the real
Volcengine Ark API for semantic understanding.  The ReviewGate
mechanism remains unchanged — no skill may bypass human approval.
"""

from __future__ import annotations

from dotenv import load_dotenv
load_dotenv()

import argparse
import json
import os
import time
from uuid import uuid4

from production_chain.models import AssetRecord, to_dict
from production_chain.workflow import ProductionChainAgent
from sda2a import A2AOrchestrator, SubAgentCluster


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


def _require_research_runtime_opt_in() -> None:
    if (os.getenv("SHORTDRAMA_RESEARCH_RUNTIME") != "DEV" or
            os.getenv("SHORTDRAMA_RESEARCH_OPT_IN") != "1"):
        raise SystemExit("A2A research runtime is disabled; set SHORTDRAMA_RESEARCH_RUNTIME=DEV and SHORTDRAMA_RESEARCH_OPT_IN=1")


def run_production_chain(
    *,
    project_id: str = "demo-project",
    title: str = "画室夜训",
    episode_no: int = 1,
    script_text: str = DEFAULT_SCRIPT,
    inventory: list[AssetRecord] | None = None,
    reviewer: str = "director",
    agent: ProductionChainAgent | None = None,
    verbose: bool = True,
) -> dict[str, object]:
    """Run the full LLM-powered production chain and return its trace receipt."""

    def _log(step: str, msg: str = "") -> None:
        if not verbose:
            return
        ts = time.strftime("%H:%M:%S")
        line = f"[{ts}] ▸ {step}"
        if msg:
            line += f" — {msg}"
        print(line, flush=True)

    agent = agent or ProductionChainAgent.create()

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

    # 1. 剧本语义拆解（LLM）
    _log("ScriptSkill", f"输入剧本 {len(script_text)} 字")
    t0 = time.time()
    breakdown = agent.script.run(
        project_id=project_id, title=title,
        episode_no=episode_no, script_text=script_text,
    )
    _log("ScriptSkill",
         f"{time.time()-t0:.1f}s  拆出 {len(breakdown.scenes)} 场、"
         f"{len(breakdown.requirements)} 个需求")
    for req in breakdown.requirements:
        _log("  └", f"{req.kind}: {req.name}  (置信度 {req.evidence.confidence})")

    # 2. 资产语义匹配（LLM）
    _log("AssetSkill", f"匹配 {len(breakdown.requirements)} 个需求 × {len(inventory)} 个资产")
    t0 = time.time()
    matches, gaps = agent.asset.run(breakdown.requirements, inventory)
    _log("AssetSkill",
         f"{time.time()-t0:.1f}s  匹配 {len(matches)} 个、缺口 {len(gaps)} 个")
    for m in matches:
        _log("  └", f"{m.requirement_id[:16]}… → {m.asset_id}  (置信度 {m.confidence})")
    for g in gaps:
        _log("  └", f"缺口 {g.requirement_id[:16]}… → 建议 {g.recommendation}")

    # 3. 镜头卡组装（LLM 生成提示词）
    _log("SceneSkill", f"组装 {len(breakdown.scenes)} 个镜头卡")
    t0 = time.time()
    packages = agent.scene.run(breakdown, matches, gaps)
    _log("SceneSkill", f"{time.time()-t0:.1f}s  生成 {len(packages)} 个镜头卡")
    for p in packages:
        _log("  └", f"{p.shot.shot_id[:20]}…  readiness={p.readiness}")
        _log("  └", f"prompt: {p.shot.prompt_summary[:80]}…")

    # 4. 对每个镜头卡：审片 → 生成 → 二次审片 → 入库
    all_tasks: list = []
    all_results: list = []
    all_promoted: list = []

    for i, package in enumerate(packages, 1):
        _log(f"--- 镜头卡 {i}/{len(packages)} ---")

        # 第一道人审：导演确认镜头卡后，才允许创建生成任务。
        _log("ReviewGate①", f"request shot_card {package.shot.shot_id[:20]}…")
        shot_review = agent.review_gate.request(
            "shot_card", package.shot.shot_id, "director confirmation required",
        )
        agent.review_gate.approve(shot_review, reviewer=reviewer)
        _log("ReviewGate①", f"approved by {reviewer}")

        # 真实画面生成（调用 Ark 图片生成 API）
        _log("GenerationSkill", "调用 Ark 生图 API…")
        t0 = time.time()
        task, result = agent.generation.run(
            package.shot, trace_id,
            f"{breakdown.script_version}:{package.shot.revision}",
        )
        elapsed = time.time() - t0
        _log("GenerationSkill",
             f"{elapsed:.1f}s  state={task.state}  "
             f"output_url={'有' if result.output_url else '无'}")
        all_tasks.append(task)
        all_results.append(result)

        # 第二道人审：生成结果仍是候选，不能直接作为可复用资产。
        _log("ReviewGate②", f"request generation_result {result.result_id[:20]}…")
        result_review = agent.review_gate.request(
            "generation_result", result.result_id,
            "result promotion requires review",
        )
        agent.review_gate.approve(result_review, reviewer=reviewer)
        _log("ReviewGate②", f"approved by {reviewer}")

        promoted = agent.promote_result_to_asset(result, result_review)
        _log("PromoteAsset", f"asset_id={promoted.asset_id[:20]}…  kind={promoted.kind}")
        all_promoted.append(promoted)

    _log("DONE", f"tasks={len(all_tasks)}  results={len(all_results)}  assets={len(all_promoted)}")

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


def run_dry_run() -> dict[str, object]:
    """Backward-compatible alias: run the default fixture with real LLM."""

    return run_production_chain()


def run_a2a_production_chain(
    *,
    project_id: str = "demo-project",
    title: str = "画室夜训",
    episode_no: int = 1,
    script_text: str = DEFAULT_SCRIPT,
    inventory: list[AssetRecord] | None = None,
    reviewer: str = "director",
    verbose: bool = True,
    llm=None,
) -> dict[str, object]:
    """Run the production chain using A2A multi-agent architecture.

    Starts four sub-agent servers (Script, Asset, Scene, Generation)
    and coordinates them via A2A protocol (JSON-RPC 2.0 over HTTP).
    """

    cluster = SubAgentCluster(llm=llm)
    try:
        urls = cluster.start()
        orchestrator = A2AOrchestrator(urls)
        return orchestrator.run(
            project_id=project_id,
            title=title,
            episode_no=episode_no,
            script_text=script_text,
            inventory=inventory,
            reviewer=reviewer,
            verbose=verbose,
        )
    finally:
        cluster.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Run the LLM-powered production chain",
    )
    parser.add_argument("--project-id", default="demo-project", help="project ID")
    parser.add_argument("--title", default="画室夜训", help="episode title")
    parser.add_argument("--episode", type=int, default=1, help="episode number")
    parser.add_argument("--script", default=DEFAULT_SCRIPT, help="script text")
    parser.add_argument(
        "--inventory", default=None,
        help='JSON array of assets, e.g. [{"asset_id":"a1","name":"林夏","kind":"character"}]',
    )
    parser.add_argument("--reviewer", default="director", help="reviewer name")
    parser.add_argument("-q", "--quiet", action="store_true", help="suppress step-by-step flow log")
    parser.add_argument("--a2a", action="store_true", help="use A2A multi-agent architecture")
    args = parser.parse_args()

    inv: list[AssetRecord] | None = None
    if args.inventory:
        raw = json.loads(args.inventory)
        inv = [
            AssetRecord(
                asset_id=item["asset_id"],
                name=item["name"],
                kind=item["kind"],
                description=item.get("description", ""),
                aliases=item.get("aliases", []),
            )
            for item in raw
        ]

    if args.a2a:
        _require_research_runtime_opt_in()
        receipt = run_a2a_production_chain(
            project_id=args.project_id,
            title=args.title,
            episode_no=args.episode,
            script_text=args.script,
            inventory=inv,
            reviewer=args.reviewer,
            verbose=not args.quiet,
        )
    else:
        receipt = run_production_chain(
            project_id=args.project_id,
            title=args.title,
            episode_no=args.episode,
            script_text=args.script,
            inventory=inv,
            reviewer=args.reviewer,
            verbose=not args.quiet,
        )
    print(json.dumps(receipt, ensure_ascii=False, indent=2))
