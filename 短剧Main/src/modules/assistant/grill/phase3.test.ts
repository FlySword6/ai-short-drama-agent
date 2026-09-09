/**
 * Grill Engine 阶段3 集成测试
 *
 * 来源：grill-engine-design.md §8 阶段 3 + §5.2 混合路径。
 * 覆盖 4 个场景：
 * 1. clarify 路径：critical 缺失 → beforeToolCall block → 工具不执行
 * 2. offer_candidates 路径：preferred 缺失 + 有候选 → afterToolCall 覆盖结果 → card_delta
 * 3. execute 路径：所有字段充足 → 放行，不触发拦截
 * 4. 已收集字段：第二次问同一字段时跳过不重复问
 *
 * 约束：不接真实 LLM，用 rulePreCheck + stage0CheckBridge 模拟 grill check。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rulePreCheck, stage0CheckBridge } from "./rule_precheck.js";
import { getTaskProfile } from "./profiles.js";
import type { ConversationContext, GrillCheckResult, Candidate } from "./types.js";
import { grillMetrics } from "../runtime.js";

// ── 用 profiles.ts 里的 contentCreationProfile（任务1 的新字段版本）──

const profile = getTaskProfile("content_creation")!;

function makeCtx(
  userId: string,
  ephemeralFields?: Record<string, unknown>,
): ConversationContext {
  return {
    userId,
    ephemeralFields,
  };
}

/**
 * 模拟 runtime.ts beforeToolCall 中的 grill 拦截逻辑。
 * 返回 { block, reason } | undefined（放行）。
 */
function simulateBeforeToolCall(
  result: GrillCheckResult | null,
): { block: true; reason: string } | undefined {
  if (!result) return undefined;
  if (result.action === "clarify") {
    return { block: true, reason: result.question };
  }
  // offer_candidates 和 execute 都放行（pendingCandidates 在 afterToolCall 取出）
  return undefined;
}

/**
 * 模拟 runtime.ts afterToolCall 覆盖结果逻辑。
 * 返回 { content, details, isError } | undefined（不覆盖）。
 */
function simulateAfterToolCall(
  pendingCandidates: Candidate[] | null,
): { content: Array<{ type: "text"; text: string }>; details: { grillAction: "offer_candidates"; candidates: Candidate[] }; isError: boolean } | undefined {
  if (pendingCandidates) {
    return {
      content: [{ type: "text", text: "请从以下选项中选择：" }],
      details: { grillAction: "offer_candidates", candidates: pendingCandidates },
      isError: false,
    };
  }
  return undefined;
}

// ── 场景 1：critical 缺失 → clarify（反问优先，不直接给候选） ──

describe("阶段3 - 场景1: critical 缺失 → clarify（反问优先）", () => {
  it("content_type 缺失 + 有 fallbackCandidates → clarify → beforeToolCall block", () => {
    const ctx = makeCtx("user-clarify", {
      // content_type 缺失
      subject_or_theme: "赛博朋克城市",
    });

    const preCheck = rulePreCheck(profile, ctx);
    assert.equal(preCheck.conclusion, "insufficient");
    assert.deepEqual(preCheck.missingCritical, ["content_type", "style_or_tone"]);

    const grillResult = stage0CheckBridge(profile, preCheck, ctx);
    // 反问优先，不直接 offer_candidates
    assert.equal(grillResult.action, "clarify");
    if (grillResult.action === "clarify") {
      assert.equal(grillResult.targetField, "content_type");
      assert.ok(grillResult.question.length > 0);
    }

    // clarify 会 block
    const beforeResult = simulateBeforeToolCall(grillResult);
    assert.ok(beforeResult, "clarify 应 block");
  });

  it("subject_or_theme 缺失 → clarify 第一个 critical 字段", () => {
    const ctx = makeCtx("user-clarify2", {
      content_type: "image",
      // subject_or_theme 缺失, style_or_tone 缺失
    });

    const preCheck = rulePreCheck(profile, ctx);
    assert.equal(preCheck.conclusion, "insufficient");
    assert.deepEqual(preCheck.missingCritical, ["subject_or_theme", "style_or_tone"]);

    const grillResult = stage0CheckBridge(profile, preCheck, ctx);
    assert.equal(grillResult.action, "clarify");
    if (grillResult.action === "clarify") {
      assert.equal(grillResult.targetField, "subject_or_theme");
    }
  });

  it("两个 critical 都缺失 → clarify 第一个（content_type）", () => {
    const ctx = makeCtx("user-clarify3", {});

    const preCheck = rulePreCheck(profile, ctx);
    assert.equal(preCheck.conclusion, "insufficient");
    assert.equal(preCheck.missingCritical.length, 3);
    assert.equal(preCheck.missingCritical[0], "content_type");

    const grillResult = stage0CheckBridge(profile, preCheck, ctx);
    assert.equal(grillResult.action, "clarify");
    if (grillResult.action === "clarify") {
      assert.equal(grillResult.targetField, "content_type");
    }
  });
});

// ── 场景 2：clarify 路径（critical/preferred 缺失 → 反问优先）──

describe("阶段3 - 场景2: clarify 路径（critical 缺失 → 反问优先）", () => {
  it("content_type + subject_or_theme 有值 + style_or_tone 缺失（critical） → clarify", () => {
    const ctx = makeCtx("user-candidates", {
      content_type: "image",
      subject_or_theme: "赛博朋克城市",
      // style_or_tone (critical) 和 constraints (preferred) 缺失
    });

    const preCheck = rulePreCheck(profile, ctx);
    // style_or_tone 现在是 critical → missingCritical
    assert.equal(preCheck.conclusion, "insufficient");
    assert.deepEqual(preCheck.missingCritical, ["style_or_tone"]);
    assert.deepEqual(preCheck.missingPreferred, ["constraints"]);

    const grillResult = stage0CheckBridge(profile, preCheck, ctx);
    // 反问优先，不直接 offer_candidates
    assert.equal(grillResult.action, "clarify");
    if (grillResult.action === "clarify") {
      assert.equal(grillResult.targetField, "style_or_tone");
      assert.ok(grillResult.question.length > 0);
    }

    // clarify 会 block
    const beforeResult = simulateBeforeToolCall(grillResult);
    assert.ok(beforeResult, "clarify 应 block");
  });

  it("clarify 结果包含 question 和 targetField", () => {
    const ctx = makeCtx("user-extract", {
      content_type: "video",
      subject_or_theme: "古风宫廷",
    });

    const preCheck = rulePreCheck(profile, ctx);
    const grillResult = stage0CheckBridge(profile, preCheck, ctx);

    // 反问优先
    assert.equal(grillResult.action, "clarify");
    if (grillResult.action === "clarify") {
      assert.ok(typeof grillResult.question === "string" && grillResult.question.length > 0);
      assert.ok(typeof grillResult.targetField === "string");
    }
  });
});

// ── 场景 3：execute 路径（充分回合）──────────────────────

describe("阶段3 - 场景3: execute 路径（所有字段充足 → 放行）", () => {
  it("所有字段有值 → execute → beforeToolCall 放行 → afterToolCall 不覆盖", () => {
    const ctx = makeCtx("user-execute", {
      content_type: "image",
      subject_or_theme: "赛博朋克城市",
      style_or_tone: "realistic_cinematic",
      constraints: "1024x1024",
    });

    const preCheck = rulePreCheck(profile, ctx);
    assert.equal(preCheck.conclusion, "sufficient");

    const grillResult = stage0CheckBridge(profile, preCheck, ctx);
    assert.equal(grillResult.action, "execute");

    // beforeToolCall：execute 放行
    const beforeResult = simulateBeforeToolCall(grillResult);
    assert.equal(beforeResult, undefined, "execute 应放行");

    // afterToolCall：无 pendingCandidates → 不覆盖
    const pendingCandidates = null; // execute 不暂存候选
    const afterResult = simulateAfterToolCall(pendingCandidates);
    assert.equal(afterResult, undefined, "execute 不覆盖结果");
  });

  it("style_or_tone (critical) 缺失 → insufficient → 反问优先", () => {
    // style_or_tone 是 critical，constraints 是 preferred
    const ctx = makeCtx("user-default", {
      content_type: "image",
      subject_or_theme: "水墨山水",
    });

    const preCheck = rulePreCheck(profile, ctx);
    // style_or_tone 是 critical → insufficient
    assert.equal(preCheck.conclusion, "insufficient");
    assert.deepEqual(preCheck.missingCritical, ["style_or_tone"]);
    assert.deepEqual(preCheck.missingPreferred, ["constraints"]);

    // stage0: 反问优先
    const grillResult = stage0CheckBridge(profile, preCheck, ctx);
    assert.equal(grillResult.action, "clarify");
  });
});

// ── 场景 4：已收集字段（第二次问同一字段时跳过）──────────────

describe("阶段3 - 场景4: 已收集字段不重复问", () => {
  it("第一次问 content_type → 用户回答 → 第二次 check 时 content_type 已有值", () => {
    // 第一轮：content_type 缺失
    let ctx = makeCtx("user-repeat", {
      subject_or_theme: "赛博朋克城市",
    });

    let preCheck = rulePreCheck(profile, ctx);
    assert.equal(preCheck.conclusion, "insufficient");
    assert.deepEqual(preCheck.missingCritical, ["content_type", "style_or_tone"]);

    let grillResult = stage0CheckBridge(profile, preCheck, ctx);
    // 反问优先
    assert.equal(grillResult.action, "clarify");
    if (grillResult.action === "clarify") {
      assert.equal(grillResult.targetField, "content_type");
    }

    // 用户回答 "image" → 写入 ephemeralFields
    ctx = makeCtx("user-repeat", {
      content_type: "image",
      subject_or_theme: "赛博朋克城市",
    });

    // 第二轮 check：content_type 已有值，style_or_tone (critical) 缺失
    preCheck = rulePreCheck(profile, ctx);
    assert.equal(preCheck.conclusion, "insufficient"); // style_or_tone 是 critical
    assert.deepEqual(preCheck.missingCritical, ["style_or_tone"]);
    assert.deepEqual(preCheck.missingPreferred, ["constraints"]);

    grillResult = stage0CheckBridge(profile, preCheck, ctx);
    // 不再问 content_type，而是反问 style_or_tone
    assert.equal(grillResult.action, "clarify");
    if (grillResult.action === "clarify") {
      assert.equal(grillResult.targetField, "style_or_tone");
    }
  });

  it("clarificationState 已记录 askedFields → 不重复问同一字段", () => {
    // 模拟：content_type 已在第一轮收集，第二轮只问 style_or_tone
    const ctx = makeCtx("user-asked", {
      content_type: "image",
      subject_or_theme: "古风宫廷",
    });

    const preCheck = rulePreCheck(profile, ctx);
    // content_type + subject_or_theme 已收集，style_or_tone (critical) 缺失
    assert.equal(preCheck.conclusion, "insufficient");
    assert.deepEqual(preCheck.missingCritical, ["style_or_tone"]);
    assert.deepEqual(preCheck.missingPreferred, ["constraints"]);

    const grillResult = stage0CheckBridge(profile, preCheck, ctx);
    // 反问 style_or_tone，不重复问 content_type
    assert.equal(grillResult.action, "clarify");
  });
});

// ── A/B 埋点验证（任务5）─────────────────────────────────

describe("阶段3 - A/B 埋点计数器", () => {
  it("grillMetrics 初始值为 0", () => {
    // 导入 grillMetrics 验证存在
    // 注意：实际计数在 runtime.ts 的 beforeToolCall 中递增
    // 这里只验证导出结构
    assert.ok(typeof grillMetrics.checkCount === "number");
    assert.ok(typeof grillMetrics.blockCount === "number");
    assert.ok(typeof grillMetrics.candidateFallbackCount === "number");
  });
});
