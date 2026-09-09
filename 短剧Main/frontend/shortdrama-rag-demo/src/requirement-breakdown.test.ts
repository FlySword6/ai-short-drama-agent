/* ============================================================
   requirement-breakdown.test.ts — K2 需求拆解彩排包回归

   两层断言：
   1. 纯逻辑（node:test 直测，零 DOM）：彩排状态机迁移、match 四态 meta、
      匿名汇总、候选两层谓词、决策中立纯函数 resolveSelectedCandidate
      （含「已选候选不在前 5」占位行为）、逐项决定幂等、finalize 原子提交
      与 422 未决定项定位、放弃/恢复、§10 错误码逐字映射、demo fixture 分支覆盖。
   2. 源码断言（沿用 s17 风格）：路由/入口接线、页面不接真后端、
      S83 地盘与旧剧本页未被改动、用户可见文案用词纪律。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";

import { demoBreakdownRequirements, demoBreakdownRetrievalRequirements } from "./demo";
import { BUILTIN_LANE_VOCABULARY } from "./lane-vocabulary";
import {
  BREAKDOWN_EMBEDDED_CANDIDATE_COUNT,
  BREAKDOWN_RUN_STATUS_META,
  BREAKDOWN_STAGE_STATUS_META,
  BREAKDOWN_VIEWER_NOTE,
  MATCH_STATUS_META,
  SELECTED_CANDIDATE_PLACEHOLDER,
  acceptActionLabel,
  advanceRehearsalRun,
  anonymousHiddenSummary,
  breakdownErrorCopy,
  breakdownStageStates,
  canAcceptCandidate,
  candidateAcceptBlocker,
  confirmedResultCopy,
  createRehearsalRun,
  decideRehearsal,
  decisionDraftLabel,
  discardRehearsalRun,
  finalizeConfirmCopy,
  finalizeRehearsalRun,
  filterRequirements,
  getRehearsalRun,
  groupRequirementsByLane,
  resolveSelectedCandidate,
  resumeRehearsalRun,
  summarizeRequirements,
  tickRehearsalRun,
  undecidedRequirementIds,
  resetRehearsalRunsForTest,
  type BreakdownCandidate,
  type BreakdownRequirement,
  type RehearsalRunState,
} from "./requirement-breakdown";

/* ---------- 本地工厂（自包含，不依赖 demo fixture） ---------- */

let candidateSequence = 0;
function candidate(input: Partial<BreakdownCandidate> & { candidateId: string }): BreakdownCandidate {
  return {
    displayName: input.candidateId,
    assetEntityId: `entity-${input.candidateId}`,
    assetMediaId: `media-${input.candidateId}`,
    mediaKind: "image",
    matchScore: 0.8,
    matchedAttributes: [],
    unmetAttributes: [],
    thumbnailUrl: null,
    canPreview: true,
    canSelect: true,
    canAddToControlPackage: true,
    selectionBlockers: [],
    controlPackageBlockers: [],
    ...input,
  };
}

function requirement(input: Partial<BreakdownRequirement> & { id: string }): BreakdownRequirement {
  candidateSequence += 1;
  return {
    ordinal: candidateSequence,
    laneKey: "character",
    requiredAssetKindKey: "character",
    displayName: input.id,
    needDescription: "需要",
    match: { status: "matched", candidates: [], missingReasons: [] },
    decision: { status: "unreviewed", selectedCandidateId: null },
    generationBrief: null,
    ...input,
  };
}

const T0 = "2026-07-28T12:00:00.000Z";

function makeDraftRun(requirements: BreakdownRequirement[], runId = "run-1"): RehearsalRunState {
  const created = createRehearsalRun({
    idempotencyKey: `key-${runId}`,
    projectId: "project-1",
    scope: { kind: "shot", shotId: "shot-1" },
    scopeLabel: "第 1 集素材 · #1",
    sourceText: "雨夜巷口，女主奔跑回头。",
    requirements,
    returnDestination: { label: "回生产页", path: "/projects/project-1/storyboards" },
    now: T0,
    runId,
  });
  let state = created;
  for (let step = 0; step < 4; step += 1) state = tickRehearsalRun(runId, T0) as RehearsalRunState;
  return state;
}

beforeEach(() => {
  resetRehearsalRunsForTest();
  candidateSequence = 0;
});

/* ---------- 彩排状态机迁移（契约 §6：queued → running 逐阶段 → draft） ---------- */

describe("彩排状态机迁移", () => {
  it("queued → running（三段逐阶段）→ draft，阶段态随之推导", () => {
    const created = createRehearsalRun({
      idempotencyKey: "k1",
      projectId: "project-1",
      scope: { kind: "shot", shotId: "shot-1" },
      scopeLabel: "第 1 集素材 · #1",
      sourceText: "文本",
      requirements: [requirement({ id: "req-1" })],
      returnDestination: { label: "回生产页", path: "/x" },
      now: T0,
      runId: "run-a",
    });
    assert.equal(created.run.status, "queued");
    assert.equal(created.run.currentStage, "extract_requirements");
    assert.deepEqual(
      breakdownStageStates(created.run).map((stage) => stage.status),
      ["pending", "pending", "pending"],
    );

    let state = tickRehearsalRun("run-a", T0) as RehearsalRunState;
    assert.equal(state.run.status, "running");
    assert.deepEqual(
      breakdownStageStates(state.run).map((stage) => stage.status),
      ["running", "pending", "pending"],
    );

    state = tickRehearsalRun("run-a", T0) as RehearsalRunState;
    assert.deepEqual(
      breakdownStageStates(state.run).map((stage) => stage.status),
      ["succeeded", "running", "pending"],
    );

    state = tickRehearsalRun("run-a", T0) as RehearsalRunState;
    assert.deepEqual(
      breakdownStageStates(state.run).map((stage) => stage.status),
      ["succeeded", "succeeded", "running"],
    );

    state = tickRehearsalRun("run-a", T0) as RehearsalRunState;
    assert.equal(state.run.status, "draft");
    assert.equal(state.run.currentStage, null);
    assert.deepEqual(
      breakdownStageStates(state.run).map((stage) => stage.status),
      ["succeeded", "succeeded", "succeeded"],
    );

    /* draft 之后再步进是空操作（同一对象）。 */
    const again = tickRehearsalRun("run-a", T0) as RehearsalRunState;
    assert.equal(again.run.status, "draft");
  });

  it("confirmed/discarded 状态步进原样返回", () => {
    const state = makeDraftRun([], "run-stable");
    const finalized = finalizeRehearsalRun("run-stable", T0);
    assert.ok(finalized.ok);
    assert.equal(advanceRehearsalRun(finalized.state, T0), finalized.state);
    const discarded = discardRehearsalRun("run-stable", T0);
    assert.equal(discarded?.run.status, "confirmed", "confirmed 不能再放弃");
    void state;
  });

  it("同一幂等键重复创建返回既有运行（连点不重复建）", () => {
    const first = createRehearsalRun({
      idempotencyKey: "same-key",
      projectId: "project-1",
      scope: { kind: "shot", shotId: "shot-1" },
      scopeLabel: "x",
      sourceText: "文本",
      requirements: [],
      returnDestination: { label: "回生产页", path: "/x" },
      now: T0,
      runId: "run-idem-1",
    });
    const second = createRehearsalRun({
      idempotencyKey: "same-key",
      projectId: "project-1",
      scope: { kind: "shot", shotId: "shot-1" },
      scopeLabel: "x",
      sourceText: "文本",
      requirements: [],
      returnDestination: { label: "回生产页", path: "/x" },
      now: T0,
      runId: "run-idem-2",
    });
    assert.equal(second.run.id, first.run.id);
  });

  it("failed 形态的阶段态：当前段标失败，之前段完成", () => {
    const stages = breakdownStageStates({ status: "failed", currentStage: "match_assets" });
    assert.deepEqual(
      stages.map((stage) => stage.status),
      ["succeeded", "failed", "pending"],
    );
    assert.equal(BREAKDOWN_STAGE_STATUS_META.failed.label, "失败");
  });
});

/* ---------- match 四态 meta（设计 §3） ---------- */

describe("match 四态 meta", () => {
  it("四态齐、文案与色调按设计：缺失是生产常态不用红", () => {
    assert.deepEqual(Object.keys(MATCH_STATUS_META).sort(), ["matched", "missing", "partially_matched", "retrieval_unavailable"]);
    assert.deepEqual(MATCH_STATUS_META.matched, { label: "已有", tone: "success", hint: MATCH_STATUS_META.matched.hint });
    assert.equal(MATCH_STATUS_META.partially_matched.label, "部分满足");
    assert.equal(MATCH_STATUS_META.partially_matched.tone, "warning");
    assert.equal(MATCH_STATUS_META.missing.label, "缺失");
    assert.equal(MATCH_STATUS_META.missing.tone, "neutral", "缺失不用红；红只留给出错");
    assert.equal(MATCH_STATUS_META.retrieval_unavailable.label, "资产库暂不可查");
    assert.equal(MATCH_STATUS_META.retrieval_unavailable.tone, "accent");
    assert.match(MATCH_STATUS_META.retrieval_unavailable.hint, /需求已拆出，但资产库暂时不可查；可先决定/);
  });

  it("运行七状态文案表与剧本页口径一致", () => {
    assert.equal(BREAKDOWN_RUN_STATUS_META.draft.label, "待确认");
    assert.equal(BREAKDOWN_RUN_STATUS_META.superseded.label, "已被替换");
    assert.equal(BREAKDOWN_RUN_STATUS_META.failed.tone, "danger");
  });
});

/* ---------- 匿名汇总（契约 §7：不泄露名字/ID/缩略图） ---------- */

describe("匿名汇总", () => {
  it("clearance_blocked ×2 → 「另有 2 个候选因版权或项目范围不可见」", () => {
    assert.equal(anonymousHiddenSummary(["clearance_blocked", "clearance_blocked"]), "另有 2 个候选因版权或项目范围不可见");
  });
  it("clearance_blocked 与 outside_project_scope 合并计数；普通缺失原因不参与", () => {
    assert.equal(anonymousHiddenSummary(["clearance_blocked", "outside_project_scope", "no_candidate"]), "另有 2 个候选因版权或项目范围不可见");
  });
  it("没有需要匿名说明的 → null", () => {
    assert.equal(anonymousHiddenSummary(["no_candidate"]), null);
    assert.equal(anonymousHiddenSummary([]), null);
  });
});

/* ---------- 候选两层谓词（契约 §7） ---------- */

describe("候选两层谓词", () => {
  it("clearance_blocked 可见不可选：原因一行写明", () => {
    const blocked = candidate({ candidateId: "c1", canSelect: false, canAddToControlPackage: false, selectionBlockers: ["clearance_blocked"] });
    assert.equal(candidateAcceptBlocker("shot", blocked), "版权许可未完成，不能选用");
    assert.equal(canAcceptCandidate("shot", blocked), false);
  });
  it("review_not_approved / outside_project_scope 各给各的人话", () => {
    const review = candidate({ candidateId: "c2", canSelect: false, selectionBlockers: ["review_not_approved"] });
    assert.equal(candidateAcceptBlocker("shot", review), "审核未通过，不能选用");
    const outside = candidate({ candidateId: "c3", canSelect: false, selectionBlockers: ["outside_project_scope"] });
    assert.equal(candidateAcceptBlocker("shot", outside), "不在本项目可用范围，不能选用");
  });
  it("shot 双 true 闸：仅实体暂缺媒体 → 「还缺媒体文件，不能进控制包」；其他作用域可选来建立满足关系", () => {
    const entityOnly = candidate({
      candidateId: "c4",
      assetMediaId: null,
      canAddToControlPackage: false,
      controlPackageBlockers: ["missing_media"],
    });
    assert.equal(candidateAcceptBlocker("shot", entityOnly), "还缺媒体文件，不能进控制包");
    assert.equal(canAcceptCandidate("shot", entityOnly), false);
    assert.equal(candidateAcceptBlocker("scene", entityOnly), null, "scene 可选，但只记为满足");
    assert.equal(acceptActionLabel("shot"), "用这个");
    assert.equal(acceptActionLabel("episode"), "记为满足");
  });
});

/* ---------- 决策中立纯函数 resolveSelectedCandidate ---------- */

describe("决策中立纯函数 resolveSelectedCandidate", () => {
  const pool = Array.from({ length: 6 }, (_, index) => candidate({ candidateId: `cand-${index + 1}`, displayName: `候选 ${index + 1}` }));

  it("已选候选在已加载集合内 → resolved（两个裁决选项都没批时的正常路径）", () => {
    const view = resolveSelectedCandidate({ loadedCandidates: pool.slice(0, 5), selectedCandidateId: "cand-3" });
    assert.deepEqual(view, { kind: "resolved", candidate: pool[2] });
  });

  it("已选候选不在已加载集合 → placeholder（不伪造名字与缩略图）", () => {
    const view = resolveSelectedCandidate({ loadedCandidates: pool.slice(0, 5), selectedCandidateId: "cand-6" });
    assert.deepEqual(view, { kind: "placeholder" });
    assert.equal(SELECTED_CANDIDATE_PLACEHOLDER, "已选的参考不在本页，展开加载更多后可见");
  });

  it("裁决②形态：传入摘要字段 → summary 分支（一行接入的预留）", () => {
    const view = resolveSelectedCandidate({
      loadedCandidates: pool.slice(0, 5),
      selectedCandidateId: "cand-6",
      selectedCandidateSummary: { displayName: "手持跟拍小样·夜景", thumbnailUrl: null },
    });
    assert.deepEqual(view, { kind: "summary", summary: { displayName: "手持跟拍小样·夜景", thumbnailUrl: null } });
  });

  it("裁决①形态：已选候选必内嵌 → 必走 resolved，本函数零改动", () => {
    const view = resolveSelectedCandidate({ loadedCandidates: pool, selectedCandidateId: "cand-6" });
    assert.deepEqual(view, { kind: "resolved", candidate: pool[5] });
  });

  it("同时在集合内又有摘要时，真候选优先（不拿摘要冒充详情）", () => {
    const view = resolveSelectedCandidate({
      loadedCandidates: pool,
      selectedCandidateId: "cand-6",
      selectedCandidateSummary: { displayName: "别的名字", thumbnailUrl: null },
    });
    assert.equal(view.kind, "resolved");
  });
});

/* ---------- 逐项决定（契约 §8.2：只写草稿，幂等，换决定 version+1） ---------- */

describe("逐项决定", () => {
  it("accept → 草稿accepted、run version +1；同内容重复提交幂等不加版本", () => {
    const cand = candidate({ candidateId: "cand-1" });
    makeDraftRun([requirement({ id: "req-1", match: { status: "matched", candidates: [cand], missingReasons: [] } })]);
    const first = decideRehearsal("run-1", "req-1", { action: "accept_candidate", candidateId: "cand-1" }, T0);
    assert.ok(first.ok);
    assert.equal(first.idempotent, false);
    assert.equal(first.state.run.version, 2);
    assert.deepEqual(first.state.requirements[0]!.decision, { status: "accepted", selectedCandidateId: "cand-1" });

    const repeat = decideRehearsal("run-1", "req-1", { action: "accept_candidate", candidateId: "cand-1" }, T0);
    assert.ok(repeat.ok);
    assert.equal(repeat.idempotent, true);
    assert.equal(repeat.state.run.version, 2, "同内容重复提交不重复写、不加版本");
  });

  it("换决定覆盖旧草稿、version +1；keep_missing/dismiss 不带 candidateId", () => {
    const cand = candidate({ candidateId: "cand-1" });
    makeDraftRun([requirement({ id: "req-1", match: { status: "matched", candidates: [cand], missingReasons: [] } })]);
    decideRehearsal("run-1", "req-1", { action: "accept_candidate", candidateId: "cand-1" }, T0);
    const changed = decideRehearsal("run-1", "req-1", { action: "keep_missing" }, T0);
    assert.ok(changed.ok);
    assert.equal(changed.state.run.version, 3);
    assert.deepEqual(changed.state.requirements[0]!.decision, { status: "kept_missing", selectedCandidateId: null });
    const dismissed = decideRehearsal("run-1", "req-1", { action: "dismiss" }, T0);
    assert.deepEqual(dismissed.state.requirements[0]!.decision, { status: "dismissed", selectedCandidateId: null });
  });

  it("被 blocker 挡住的候选不能 accept（两层谓词在决定侧同样生效）", () => {
    const blocked = candidate({ candidateId: "cand-x", canSelect: false, canAddToControlPackage: false, selectionBlockers: ["clearance_blocked"] });
    makeDraftRun([requirement({ id: "req-1", match: { status: "partially_matched", candidates: [blocked], missingReasons: [] } })]);
    const outcome = decideRehearsal("run-1", "req-1", { action: "accept_candidate", candidateId: "cand-x" }, T0);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.message, "版权许可未完成，不能选用");
    assert.equal(outcome.state.run.version, 1, "被拒的决定不写草稿不加版本");
  });

  it("非 draft 状态不能决定", () => {
    createRehearsalRun({
      idempotencyKey: "k-q",
      projectId: "project-1",
      scope: { kind: "shot", shotId: "shot-1" },
      scopeLabel: "x",
      sourceText: "文本",
      requirements: [requirement({ id: "req-1" })],
      returnDestination: { label: "回生产页", path: "/x" },
      now: T0,
      runId: "run-queued",
    });
    const outcome = decideRehearsal("run-queued", "req-1", { action: "dismiss" }, T0);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.message, "这次拆解当前不能决定");
  });
});

/* ---------- finalize 原子提交（契约 §8.3）与 422 未决定项定位 ---------- */

describe("finalize 原子提交", () => {
  it("任一未决定 → 422 incomplete_breakdown_decisions 并列出未决定项（按 ordinal 顺序）", () => {
    makeDraftRun([
      requirement({ id: "req-1", match: { status: "matched", candidates: [candidate({ candidateId: "c1" })], missingReasons: [] } }),
      requirement({ id: "req-2" }),
      requirement({ id: "req-3" }),
    ]);
    decideRehearsal("run-1", "req-1", { action: "accept_candidate", candidateId: "c1" }, T0);
    const outcome = finalizeRehearsalRun("run-1", T0);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.status, 422);
    assert.equal(outcome.code, "incomplete_breakdown_decisions");
    assert.equal(outcome.message, "还有生产需求等你决定");
    assert.deepEqual(outcome.requirementIds, ["req-2", "req-3"]);
    assert.deepEqual(undecidedRequirementIds(getRehearsalRun("run-1")!.requirements), ["req-2", "req-3"]);

    /* 422 映射到界面行为：底部红字计数 + 过滤切待决定 + 逐卡标红 */
    const copy = breakdownErrorCopy(outcome);
    assert.equal(copy.behavior, "bottom_incomplete");
    assert.deepEqual(copy.requirementIds, ["req-2", "req-3"]);
  });

  it("全部已决定 → 一次性 confirmed；shot 作用域结果带控制包引用计数", () => {
    makeDraftRun([
      requirement({ id: "req-1", match: { status: "matched", candidates: [candidate({ candidateId: "c1" })], missingReasons: [] } }),
      requirement({ id: "req-2", match: { status: "missing", candidates: [], missingReasons: ["no_candidate"] } }),
    ]);
    decideRehearsal("run-1", "req-1", { action: "accept_candidate", candidateId: "c1" }, T0);
    decideRehearsal("run-1", "req-2", { action: "keep_missing" }, T0);
    const outcome = finalizeRehearsalRun("run-1", T0);
    assert.ok(outcome.ok);
    if (!outcome.ok) return;
    assert.equal(outcome.state.run.status, "confirmed");
    assert.deepEqual(outcome.state.result, {
      requirementIds: ["req-1", "req-2"],
      fulfillmentIds: ["fulfillment-req-1"],
      controlPackageRefIds: ["control-ref-req-1"],
    });

    /* 重复提交 → 409 already_finalized */
    const again = finalizeRehearsalRun("run-1", T0);
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.status, 409);
    assert.equal(again.code, "breakdown_already_finalized");
  });

  it("非 draft 提交 → 409 stale（排队中的运行不能 finalize）", () => {
    createRehearsalRun({
      idempotencyKey: "k-s",
      projectId: "project-1",
      scope: { kind: "shot", shotId: "shot-1" },
      scopeLabel: "x",
      sourceText: "文本",
      requirements: [],
      returnDestination: { label: "回生产页", path: "/x" },
      now: T0,
      runId: "run-stale",
    });
    const outcome = finalizeRehearsalRun("run-stale", T0);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.status, 409);
    assert.equal(outcome.code, "stale_breakdown_version");
  });
});

/* ---------- 放弃与恢复（契约 §8.4） ---------- */

describe("放弃与恢复", () => {
  it("draft → discarded；重复放弃返回当前状态", () => {
    makeDraftRun([requirement({ id: "req-1" })]);
    decideRehearsal("run-1", "req-1", { action: "dismiss" }, T0);
    const discarded = discardRehearsalRun("run-1", T0);
    assert.ok(discarded);
    assert.equal(discarded.run.status, "discarded");
    const again = discardRehearsalRun("run-1", T0);
    assert.equal(again?.run.version, discarded.run.version, "重复放弃不再加版本");
  });

  it("resume 产生新 run：旧 run 变 superseded，决定快照保留、候选重新匹配", () => {
    makeDraftRun([
      requirement({ id: "req-1", match: { status: "matched", candidates: [candidate({ candidateId: "c1" })], missingReasons: [] } }),
      requirement({ id: "req-2" }),
    ]);
    decideRehearsal("run-1", "req-1", { action: "accept_candidate", candidateId: "c1" }, T0);
    discardRehearsalRun("run-1", T0);
    const resumed = resumeRehearsalRun("run-1", { idempotencyKey: "resume-key", now: T0, newRunId: "run-2" });
    assert.ok(resumed);
    assert.equal(resumed.previous.run.status, "superseded");
    assert.equal(resumed.next.run.status, "queued");
    assert.equal(resumed.next.run.version, 1);
    assert.equal(resumed.next.supersedesRunId, "run-1");
    assert.deepEqual(resumed.next.requirements[0]!.decision, { status: "accepted", selectedCandidateId: "c1" }, "人工决定快照保留");

    /* draft 状态不能 resume */
    makeDraftRun([requirement({ id: "req-9" })], "run-3");
    assert.equal(resumeRehearsalRun("run-3", { idempotencyKey: "x" }), null);
  });
});

/* ---------- §10 错误码 → 人话映射（逐字） ---------- */

describe("错误码映射（§10 八条）", () => {
  it("八条 code 逐字采用契约人话列，行为归类正确", () => {
    const cases: Array<[string, string, string]> = [
      ["invalid_breakdown_input", "描述内容不完整，请补充后再试", "input_inline"],
      ["breakdown_scope_not_found", "没有找到对应的制作内容", "fullscreen_not_found"],
      ["breakdown_already_finalized", "这次拆解已经处理过", "toast_to_confirmed"],
      ["stale_breakdown_version", "内容刚被其他人更新，请刷新后再提交", "banner_refresh"],
      ["breakdown_confirmation_conflict", "有参考素材已经不可用，请重新确认", "toast_highlight"],
      ["incomplete_breakdown_decisions", "还有生产需求等你决定", "bottom_incomplete"],
      ["breakdown_output_invalid", "拆解结果不完整，请重试", "banner_retry_run"],
      ["ai_gateway_unavailable", "AI 服务暂不可用，已保留当前内容", "capability_unavailable"],
    ];
    for (const [code, message, behavior] of cases) {
      const copy = breakdownErrorCopy({ status: 400, code });
      assert.equal(copy.message, message, code);
      assert.equal(copy.behavior, behavior, code);
    }
  });

  it("details.requirement_ids 透传；未知 code 回落 message，不透传模型原始错误", () => {
    const conflict = breakdownErrorCopy({ code: "breakdown_confirmation_conflict", details: { requirement_ids: ["req-7", "req-8"] } });
    assert.deepEqual(conflict.requirementIds, ["req-7", "req-8"]);
    /* 前端归一形状（彩排状态机/将来 FromUnknown 产出）同样可用 */
    const direct = breakdownErrorCopy({ code: "incomplete_breakdown_decisions", requirementIds: ["req-2"] });
    assert.deepEqual(direct.requirementIds, ["req-2"]);
    const fallback = breakdownErrorCopy({ message: "网络抖动" });
    assert.equal(fallback.message, "网络抖动");
    assert.equal(fallback.behavior, "fallback");
    assert.equal(breakdownErrorCopy(null).behavior, "fallback");
  });
});

/* ---------- 「候选 ≠ 成员」草稿标记（设计 §3 不说谎） ---------- */

describe("草稿标记不说谎", () => {
  it("finalize 前一律「待采用」，成功后才换「已采用」", () => {
    const accepted = { status: "accepted", selectedCandidateId: "c1" } as const;
    assert.equal(decisionDraftLabel(accepted, "林秋棠定妆", false), "待采用 · 林秋棠定妆");
    assert.equal(decisionDraftLabel(accepted, "林秋棠定妆", true), "已采用 · 林秋棠定妆");
  });
  it("占位形态下不给名字（已选参考），就缺着/不需要如实", () => {
    assert.equal(decisionDraftLabel({ status: "accepted", selectedCandidateId: "c9" }, null, false), "待采用 · 已选参考");
    assert.equal(decisionDraftLabel({ status: "kept_missing", selectedCandidateId: null }, null, false), "就缺着");
    assert.equal(decisionDraftLabel({ status: "dismissed", selectedCandidateId: null }, null, false), "不需要");
    assert.equal(decisionDraftLabel({ status: "unreviewed", selectedCandidateId: null }, null, false), null);
  });
});

/* ---------- 摘要 / 过滤 / lane 分组 ---------- */

describe("摘要 / 过滤 / lane 分组", () => {
  it("summarize 与 filter 在标准 fixture 上的口径", () => {
    const requirements = demoBreakdownRequirements();
    const summary = summarizeRequirements(requirements);
    assert.deepEqual(summary, { requirementCount: 6, matchedCount: 3, partiallyMatchedCount: 1, missingCount: 2, needsDecisionCount: 5 });
    assert.equal(filterRequirements(requirements, "undecided").length, 5);
    assert.deepEqual(
      filterRequirements(requirements, "missing").map((item) => item.id),
      ["req-04", "req-05"],
    );
    assert.equal(filterRequirements(requirements, "all").length, 6);
  });

  it("lane 分组读词表同一快照；未知 lane_key 归「其他」，不炸 UI", () => {
    const groups = groupRequirementsByLane(demoBreakdownRequirements(), BUILTIN_LANE_VOCABULARY);
    assert.deepEqual(
      groups.map((group) => `${group.domainLabel}/${group.laneLabel}:${group.items.length}`),
      ["实体参考/角色:2", "实体参考/场景:2", "实体参考/道具:1", "风格参考/运镜:1"],
    );
    const unknown = groupRequirementsByLane([requirement({ id: "req-u", laneKey: "hologram" })], BUILTIN_LANE_VOCABULARY);
    assert.equal(unknown[0]!.domainLabel, "其他");
    assert.equal(unknown[0]!.laneLabel, "hologram");
  });
});

/* ---------- 按作用域文案（设计 §2 幕 4/幕 5 变体） ---------- */

describe("按作用域文案", () => {
  it("确认弹窗一句人话按作用域变体", () => {
    assert.equal(finalizeConfirmCopy("shot"), "确认采用？选中的参考会写入这个分镜的控制包，缺失项不创建生成任务。");
    assert.equal(finalizeConfirmCopy("scene"), "确认采用？保存本场的生产需求与满足关系，不会改动任何控制包。");
    assert.equal(finalizeConfirmCopy("episode"), "确认采用？保存本集的生产需求与满足关系，不会改动任何控制包。");
    assert.equal(finalizeConfirmCopy("free_text"), "确认采用？保存为项目的前期需求，不产生分镜或控制包。");
  });
  it("满足关系 ≠ 实际使用：只有 shot 说「写入控制包参考」", () => {
    const shot = confirmedResultCopy("shot", { requirements: 6, fulfillments: 2, controlRefs: 2 });
    assert.match(shot, /写入控制包参考 2 项/);
    const scene = confirmedResultCopy("scene", { requirements: 6, fulfillments: 2, controlRefs: 0 });
    assert.ok(!scene.includes("控制包参考"), "非 shot 作用域不说进控制包");
    assert.match(scene, /记下可以满足，不代表本次实际使用/);
  });
  it("viewer 底部条说明", () => {
    assert.equal(BREAKDOWN_VIEWER_NOTE, "只有项目负责人和编辑能确认采用");
  });
});

/* ---------- demo fixture 分支覆盖（设计 §6.2） ---------- */

describe("demo fixture 覆盖全部分支", () => {
  it("标准形态：四态齐、blocker 可见候选、匿名汇总、已选候选不在前 5", () => {
    const requirements = demoBreakdownRequirements();
    assert.equal(requirements.length, 6);
    const statuses = requirements.map((item) => item.match.status);
    assert.ok(statuses.includes("matched") && statuses.includes("partially_matched") && statuses.includes("missing"));

    /* clearance_blocked 可见候选：在 candidates 里（能看）、canSelect=false（不能选） */
    const heroine = requirements.find((item) => item.id === "req-03")!;
    const blocked = heroine.match.candidates.find((item) => item.candidateId === "cand-lin-2")!;
    assert.equal(blocked.displayName, "神秘女子侧影");
    assert.equal(blocked.canSelect, false);
    assert.ok(blocked.selectionBlockers.includes("clearance_blocked"));
    assert.equal(candidateAcceptBlocker("shot", blocked), "版权许可未完成，不能选用");

    /* 匿名汇总：req-05 不渲染任何候选卡，只给数字 */
    const study = requirements.find((item) => item.id === "req-05")!;
    assert.equal(study.match.candidates.length, 0);
    assert.equal(anonymousHiddenSummary(study.match.missingReasons), "另有 2 个候选因版权或项目范围不可见");

    /* 部分满足明说「还差：发饰」 */
    const partial = heroine.match.candidates.find((item) => item.candidateId === "cand-lin-1")!;
    assert.deepEqual(partial.unmetAttributes, ["发饰"]);

    /* 已选候选不在内嵌前 5：切片模拟已加载集合 → 占位；展开后 → 真卡 */
    const tracking = requirements.find((item) => item.id === "req-06")!;
    assert.equal(tracking.match.candidates.length, 6);
    assert.deepEqual(tracking.decision, { status: "accepted", selectedCandidateId: "cand-cam-6" });
    const embedded = tracking.match.candidates.slice(0, BREAKDOWN_EMBEDDED_CANDIDATE_COUNT);
    assert.equal(
      resolveSelectedCandidate({ loadedCandidates: embedded, selectedCandidateId: "cand-cam-6" }).kind,
      "placeholder",
    );
    const expanded = resolveSelectedCandidate({ loadedCandidates: tracking.match.candidates, selectedCandidateId: "cand-cam-6" });
    assert.equal(expanded.kind, "resolved");
    if (expanded.kind === "resolved") assert.equal(expanded.candidate.displayName, "手持跟拍小样·夜景");

    /* 缺失项的生成草稿（generation_brief）：只在缺失需求上 */
    assert.ok(requirements.find((item) => item.id === "req-04")!.generationBrief);
    assert.equal(requirements.find((item) => item.id === "req-01")!.generationBrief, null);
  });

  it("资产库暂不可查变体：检索失败不连坐需求，每条都可先决定", () => {
    const requirements = demoBreakdownRetrievalRequirements();
    assert.ok(requirements.length > 0);
    for (const item of requirements) {
      assert.equal(item.match.status, "retrieval_unavailable");
      assert.equal(item.decision.status, "unreviewed");
    }
  });
});

/* ---------- 源码断言（边界守卫，沿用 s17 风格） ---------- */

function readSrc(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/** 剥注释（与 s17 同口径），只留可执行代码与字符串。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("源码断言：接线与边界", () => {
  const appSource = readSrc("./app.tsx");
  const routingSource = readSrc("./routing.ts");
  const projectPagesSource = readSrc("./pages/project-pages.tsx");
  const runPageSource = readSrc("./pages/breakdown-run-page.tsx");
  const cardSource = readSrc("./components/requirement-card.tsx");
  const moduleSource = readSrc("./requirement-breakdown.ts");
  const workbenchSource = readSrc("./pages/workbench-page.tsx");
  const scriptBreakdownSource = readSrc("./pages/script-breakdown-page.tsx");

  it("统一运行页路由一行接好（/projects/:projectId/requirement-breakdowns/:runId）", () => {
    assert.ok(appSource.includes('from "./pages/breakdown-run-page"'), "app 未引入运行页");
    assert.ok(appSource.includes("requirement-breakdowns"), "app 未接运行页路由");
    assert.ok(routingSource.includes("projectRequirementBreakdownPath"), "routing 缺路径助手");
  });

  it("shot 入口=生产页卡片 kebab「拆解控制包需求」，按契约 §9 口径 gated、只走彩排", () => {
    assert.ok(projectPagesSource.includes("拆解控制包需求"), "kebab 入口缺失");
    assert.ok(projectPagesSource.includes("createRehearsalRun"), "入口未创建彩排 run");
    assert.ok(projectPagesSource.includes("demoMode && canCreate"), "入口未按 owner|editor 与离线演示 gated");
  });

  it("页面不接真后端：运行页与需求卡都不 import api.ts，纯逻辑模块零网络", () => {
    assert.ok(!runPageSource.includes('from "../api"'), "运行页不得 import api.ts（契约未批）");
    assert.ok(!cardSource.includes('from "../api"'), "需求卡不得 import api.ts");
    assert.ok(!moduleSource.includes('from "./api"') && !moduleSource.includes("fetch("), "纯逻辑模块零网络");
  });

  it("旧版拆解失败不再给无效续跑入口，明确引导重新拆解", () => {
    assert.ok(scriptBreakdownSource.includes('detail.run.errorCode === "prompt_version_outdated"'));
    assert.ok(scriptBreakdownSource.includes("拆解规则已经更新，请用页面上方的「重新拆解」开始一次新任务。"));
  });

  it("决策中立：页面与卡片只用 resolveSelectedCandidate 一个收敛点，占位文案如实", () => {
    assert.ok(cardSource.includes("resolveSelectedCandidate"), "卡片未走决策中立纯函数");
    assert.ok(cardSource.includes("SELECTED_CANDIDATE_PLACEHOLDER"), "占位文案未走统一常量");
    assert.ok(moduleSource.includes("已选的参考不在本页，展开加载更多后可见"), "占位文案被改");
  });

  it("422 演练在页面有行为：底部红字 + 过滤切待决定 + 滚动定位", () => {
    assert.ok(runPageSource.includes("bottom_incomplete"), "422 行为未接");
    assert.ok(runPageSource.includes("scrollIntoView"), "422 未滚动定位到第一项");
  });

  it("S83 地盘与旧剧本流未被改动；「套个模板」不碰", () => {
    assert.ok(!workbenchSource.includes("requirement-breakdown"), "workbench-page.tsx 不得引用本包（S83 未合流）");
    assert.ok(!workbenchSource.includes("拆解控制包需求"), "工作台内入口等 S83");
    assert.ok(!scriptBreakdownSource.includes("requirement-breakdown"), "旧剧本页兼容窗口内原样");
    assert.ok(workbenchSource.includes("IMAGE_PRESET_GROUPS"), "「套个模板」退场评估单列，本包不删");
  });

  it("viewer 只读口径在页面：说明文案 + 决定按钮 disabled", () => {
    assert.ok(runPageSource.includes("BREAKDOWN_VIEWER_NOTE"), "viewer 底部条说明缺失");
    assert.ok(runPageSource.includes("as=viewer"), "彩排只读形态切换缺失");
  });

  it("用词纪律：新文件用户可见文案不含禁词", () => {
    const banned = ["金路径", "闭环", "链路", "落地", "落点", "抓手", "心智"];
    for (const [name, source] of [
      ["requirement-breakdown.ts", moduleSource],
      ["breakdown-run-page.tsx", runPageSource],
      ["requirement-card.tsx", cardSource],
    ] as const) {
      const stripped = stripComments(source);
      for (const token of banned) {
        assert.ok(!stripped.includes(token), `${name} 命中禁词「${token}」`);
      }
    }
  });
});
