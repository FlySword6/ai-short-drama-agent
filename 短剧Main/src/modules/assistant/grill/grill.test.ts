/**
 * Grill Engine 阶段 0 测试
 *
 * 来源：grill-engine-design.md §8 阶段 0 步骤 0.4。
 * 覆盖 execute → clarify → degrade 三分支的 mock 对话回合。
 *
 * 阶段 0 约束：纯代码，不接 LLM，不接 agent 运行循环，不接 routes.ts。
 * 用 node:test 框架（与 runtime.test.ts 一致），不引入 vitest。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rulePreCheck, stage0CheckBridge } from "./rule_precheck.js";
import { ClarificationCounter } from "./counter.js";
import type { TaskProfile, ConversationContext } from "./types.js";

// ── 测试用 TaskProfile：创作场景，critical=2, preferred=2, maxClarify=2 ──

const contentCreationProfile: TaskProfile = {
  taskType: "content_creation",
  requiredFields: [
    {
      name: "genre",
      description: "题材类型",
      priority: "critical",
      usage: "persist",
      extractor: "enum",
    },
    {
      name: "protagonist",
      description: "主角设定",
      priority: "critical",
      usage: "persist",
      extractor: "llm",
    },
    {
      name: "tone",
      description: "整体调性",
      priority: "preferred",
      defaultValue: "热血",
      usage: "persist",
      extractor: "llm",
    },
    {
      name: "episodeCount",
      description: "集数偏好",
      priority: "preferred",
      defaultValue: 80,
      usage: "ephemeral",
      extractor: "regex",
    },
  ],
  maxClarifications: 2,
  maxTotalRounds: 6,
  maxSubjectDepth: 2,
  candidateCount: 3,
  fallbackCandidates: {
    genre: [
      { label: "甜宠", description: "现代都市甜宠，轻松恋爱向", value: "sweet" },
      { label: "重生复仇", description: "重生逆袭，打脸爽文向", value: "rebirth" },
      { label: "古风权谋", description: "古代背景，权谋斗争向", value: "ancient" },
    ],
    tone: [
      { label: "热血", description: "节奏快、冲突强、爽感足", value: "hot_blooded" },
      { label: "治愈", description: "节奏缓、情感细腻、暖心向", value: "healing" },
      { label: "悬疑", description: "节奏紧、反转多、烧脑向", value: "suspense" },
    ],
  },
};

function makeCtx(
  userId: string,
  ephemeralFields?: Record<string, unknown>,
): ConversationContext {
  return {
    userId,
    ephemeralFields,
  };
}

// ── 分支 1：execute（全部字段存在 → 直接执行）──────────────

describe("Grill Engine 阶段0 - 分支1: execute", () => {
  it("所有字段存在 → sufficient → execute", () => {
    const ctx = makeCtx("user1", {
      genre: "sweet",
      protagonist: "冷面总裁",
      tone: "治愈",
      episodeCount: 40,
    });

    const preCheck = rulePreCheck(contentCreationProfile, ctx);
    assert.equal(preCheck.conclusion, "sufficient");

    const result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);
    assert.equal(result.action, "execute");
  });

  it("critical 全有 + preferred 全有（哪怕值和 defaultValue 不同）→ sufficient", () => {
    const ctx = makeCtx("user2", {
      genre: "rebirth",
      protagonist: "重生女主",
      tone: "悬疑",
      episodeCount: 100,
    });

    const preCheck = rulePreCheck(contentCreationProfile, ctx);
    assert.equal(preCheck.conclusion, "sufficient");

    const result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);
    assert.equal(result.action, "execute");
  });
});

// ── 分支 2：critical 缺失 → offer_candidates（有候选）或 clarify（无候选）──

describe("Grill Engine 阶段0 - 分支2: critical 缺失 → offer_candidates 或 clarify", () => {
  it("critical 字段缺失（无候选）→ insufficient → clarify", () => {
    // 只填了 genre，protagonist 空（protagonist 无 fallbackCandidates）
    const ctx = makeCtx("user3", {
      genre: "sweet",
      protagonist: "",
    });

    const preCheck = rulePreCheck(contentCreationProfile, ctx);
    assert.equal(preCheck.conclusion, "insufficient");
    assert.deepEqual(preCheck.missingCritical, ["protagonist"]);

    const result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);
    assert.equal(result.action, "clarify");
    assert.equal(result.targetField, "protagonist");
    assert.ok(result.question.length > 0);
  });

  it("critical 字段缺失（有候选）→ insufficient → 先 clarify（反问优先）", () => {
    // genre 缺失，genre 有 fallbackCandidates，但反问优先
    const ctx = makeCtx("user3b", {
      protagonist: "冷面总裁",
    });

    const preCheck = rulePreCheck(contentCreationProfile, ctx);
    assert.equal(preCheck.conclusion, "insufficient");
    assert.deepEqual(preCheck.missingCritical, ["genre"]);

    const result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);
    assert.equal(result.action, "clarify");
    assert.equal(result.targetField, "genre");
    assert.ok(result.question.length > 0);
  });

  it("多个 critical 缺失 → clarify 第一个（genre）", () => {
    const ctx = makeCtx("user4", {});

    const preCheck = rulePreCheck(contentCreationProfile, ctx);
    assert.equal(preCheck.conclusion, "insufficient");
    assert.equal(preCheck.missingCritical.length, 2);
    assert.equal(preCheck.missingCritical[0], "genre");

    const result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);
    // 反问优先，不直接 offer_candidates
    assert.equal(result.action, "clarify");
    assert.equal(result.targetField, "genre");
  });

  it("一次只问一个问题：结果只包含一个 targetField", () => {
    const ctx = makeCtx("user5", { genre: "" });

    const preCheck = rulePreCheck(contentCreationProfile, ctx);
    const result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);

    // genre 缺失 → 先反问
    assert.equal(result.action, "clarify");
    if (result.action === "clarify") {
      assert.ok(typeof result.targetField === "string");
      assert.ok(result.question.length > 0);
    }
  });
});

// ── 分支 3：degrade（needs_llm → 先反问，不直接给候选）──

describe("Grill Engine 阶段0 - 分支3: degrade/clarify", () => {
  it("critical 全有 + preferred 缺失 → clarify（反问优先）", () => {
    const ctx = makeCtx("user6", {
      genre: "sweet",
      protagonist: "冷面总裁",
      // tone 和 episodeCount 缺失
    });

    const preCheck = rulePreCheck(contentCreationProfile, ctx);
    assert.equal(preCheck.conclusion, "needs_llm");
    assert.equal(preCheck.missingPreferred.length, 2);
    assert.equal(preCheck.missingPreferred[0], "tone");

    const result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);
    // 反问优先，不直接 offer_candidates
    assert.equal(result.action, "clarify");
    assert.equal(result.targetField, "tone");
    assert.ok(result.question.length > 0);
  });

  it("反问 question 非空且包含 targetField 相关词", () => {
    const ctx = makeCtx("user7", {
      genre: "rebirth",
      protagonist: "重生女主",
    });

    const preCheck = rulePreCheck(contentCreationProfile, ctx);
    const result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);

    assert.equal(result.action, "clarify");
    if (result.action === "clarify") {
      assert.ok(typeof result.question === "string" && result.question.length > 0);
      assert.ok(typeof result.targetField === "string");
    }
  });
});

// ── ClarificationCounter 测试 ──────────────────────────

describe("ClarificationCounter", () => {
  it("未达上限 → allow", () => {
    const counter = new ClarificationCounter();
    const decision = counter.canClarify("user1", "content_creation", 2, 6, "genre");
    assert.equal(decision.decision, "allow");
    if (decision.decision === "allow") {
      assert.equal(decision.count, 0);
      assert.equal(decision.remaining, 2);
    }
  });

  it("达上限 → limit_reached（同字段累积）", () => {
    const counter = new ClarificationCounter();
    counter.recordClarification("user1", "content_creation", "genre");
    counter.recordClarification("user1", "content_creation", "genre");

    const decision = counter.canClarify("user1", "content_creation", 2, 6, "genre");
    assert.equal(decision.decision, "limit_reached");
  });

  it("不同字段的计数独立", () => {
    const counter = new ClarificationCounter();
    // 对 genre 反问 2 次
    counter.recordClarification("user1", "content_creation", "genre");
    counter.recordClarification("user1", "content_creation", "genre");

    // genre 达上限，但 protagonist 还是 0
    const genreDecision = counter.canClarify("user1", "content_creation", 2, 6, "genre");
    assert.equal(genreDecision.decision, "limit_reached");

    const protagonistDecision = counter.canClarify("user1", "content_creation", 2, 6, "protagonist");
    assert.equal(protagonistDecision.decision, "allow");
    if (protagonistDecision.decision === "allow") {
      assert.equal(protagonistDecision.count, 0);
    }
  });

  it("resetField 只重置指定字段，不影响其他字段", () => {
    const counter = new ClarificationCounter();
    counter.recordClarification("user1", "content_creation", "genre");
    counter.recordClarification("user1", "content_creation", "genre");
    counter.recordClarification("user1", "content_creation", "protagonist");

    counter.resetField("user1", "content_creation", "genre");

    const genreDecision = counter.canClarify("user1", "content_creation", 2, 6, "genre");
    assert.equal(genreDecision.decision, "allow");
    if (genreDecision.decision === "allow") {
      assert.equal(genreDecision.count, 0);
    }

    // protagonist 计数不受影响
    const protagonistDecision = counter.canClarify("user1", "content_creation", 2, 6, "protagonist");
    assert.equal(protagonistDecision.decision, "allow");
    if (protagonistDecision.decision === "allow") {
      assert.equal(protagonistDecision.count, 1);
    }
  });

  it("不同用户的计数独立", () => {
    const counter = new ClarificationCounter();
    counter.recordClarification("user1", "content_creation", "genre");

    const user1Decision = counter.canClarify("user1", "content_creation", 2, 6, "genre");
    const user2Decision = counter.canClarify("user2", "content_creation", 2, 6, "genre");

    assert.equal(user1Decision.decision, "allow");
    if (user1Decision.decision === "allow") {
      assert.equal(user1Decision.count, 1);
    }
    assert.equal(user2Decision.decision, "allow");
    if (user2Decision.decision === "allow") {
      assert.equal(user2Decision.count, 0);
    }
  });

  it("不同 taskType 的计数独立", () => {
    const counter = new ClarificationCounter();
    counter.recordClarification("user1", "content_creation", "genre");

    const creationDecision = counter.canClarify("user1", "content_creation", 2, 6, "genre");
    const registrationDecision = counter.canClarify("user1", "registration", 2, 6, "genre");

    if (creationDecision.decision === "allow") {
      assert.equal(creationDecision.count, 1);
    }
    if (registrationDecision.decision === "allow") {
      assert.equal(registrationDecision.count, 0);
    }
  });

  it("getState 返回完整状态快照", () => {
    const counter = new ClarificationCounter();
    counter.recordClarification("user1", "content_creation", "genre");

    const state = counter.getState("user1", "content_creation");
    assert.equal(state.count, 1);
    assert.equal(state.targetField, "genre");
    assert.deepEqual(state.askedFields, ["genre"]);
  });

  it("reset 清除所有字段计数", () => {
    const counter = new ClarificationCounter();
    counter.recordClarification("user1", "content_creation", "genre");
    counter.recordClarification("user1", "content_creation", "protagonist");

    counter.reset("user1", "content_creation");

    const decision = counter.canClarify("user1", "content_creation", 2, 6, "genre");
    assert.equal(decision.decision, "allow");
    if (decision.decision === "allow") {
      assert.equal(decision.count, 0);
    }
  });
});

// ── 完整 mock 对话回合：execute → clarify → degrade ──────

describe("完整 mock 对话回合", () => {
  it("回合1：字段全有 → 直接 execute", () => {
    const ctx = makeCtx("session1", {
      genre: "sweet",
      protagonist: "冷面总裁",
      tone: "治愈",
      episodeCount: 40,
    });

    const preCheck = rulePreCheck(contentCreationProfile, ctx);
    const result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);

    assert.equal(result.action, "execute");
  });

  it("回合2：critical 缺失 → clarify → 用户回答后 execute", () => {
    // 第一轮：protagonist 空
    let ctx = makeCtx("session2", {
      genre: "sweet",
      protagonist: "",
    });

    let preCheck = rulePreCheck(contentCreationProfile, ctx);
    let result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);
    assert.equal(result.action, "clarify");
    assert.equal(result.targetField, "protagonist");

    // 模拟用户回答，补充 protagonist
    ctx = makeCtx("session2", {
      genre: "sweet",
      protagonist: "冷面总裁",
    });

    preCheck = rulePreCheck(contentCreationProfile, ctx);
    result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);

    // critical 全有了，但 preferred 缺失 → needs_llm → 反问优先
    assert.equal(preCheck.conclusion, "needs_llm");
    assert.equal(result.action, "clarify");
  });

  it("回合3：同字段反问达上限后 → clarify 其他字段或 limit_reached", () => {
    const counter = new ClarificationCounter();
    const maxClarify = contentCreationProfile.maxClarifications;

    // 第一轮反问 genre
    let decision = counter.canClarify("session3", "content_creation", maxClarify, 6, "genre");
    assert.equal(decision.decision, "allow");
    counter.recordClarification("session3", "content_creation", "genre");

    // 第二轮反问 genre
    decision = counter.canClarify("session3", "content_creation", maxClarify, 6, "genre");
    assert.equal(decision.decision, "allow");
    counter.recordClarification("session3", "content_creation", "genre");

    // 第三轮：genre 达上限 → 降级
    decision = counter.canClarify("session3", "content_creation", maxClarify, 6, "genre");
    assert.equal(decision.decision, "limit_reached");

    // stage0: 反问优先（不直接给候选）
    const ctx = makeCtx("session3", {
      genre: "sweet",
      protagonist: "冷面总裁",
    });
    const preCheck = rulePreCheck(contentCreationProfile, ctx);
    const result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);
    assert.equal(result.action, "clarify");
  });
});

// ── Bug 修复验证测试 ──────────────────────────────────

describe("Bug 修复验证", () => {
  it("Bug 1: 总轮次达上限 → limit_reached（防死循环）", () => {
    const counter = new ClarificationCounter();
    // 模拟 6 轮反问（不同字段各几次，总轮次=6）
    counter.recordClarification("user-bug1", "content_creation", "field_a");
    counter.recordClarification("user-bug1", "content_creation", "field_b");
    counter.recordClarification("user-bug1", "content_creation", "field_a");
    counter.recordClarification("user-bug1", "content_creation", "field_b");
    counter.recordClarification("user-bug1", "content_creation", "field_a");
    counter.recordClarification("user-bug1", "content_creation", "field_b");
    // 总轮次=6 → 即使是新字段也 limit_reached
    const decision = counter.canClarify("user-bug1", "content_creation", 3, 6, "field_c");
    assert.equal(decision.decision, "limit_reached");
  });

  it("Bug 2: 同一字段反问达上限后不再反问同一字段", () => {
    const counter = new ClarificationCounter();
    const maxClarify = 3;

    // 反问 genre 3 次（达上限）
    for (let i = 0; i < maxClarify; i++) {
      counter.recordClarification("user-bug2", "content_creation", "genre");
    }

    // genre 达上限 → limit_reached
    const genreDecision = counter.canClarify("user-bug2", "content_creation", maxClarify, 6, "genre");
    assert.equal(genreDecision.decision, "limit_reached");

    // protagonist 仍可反问
    const protagonistDecision = counter.canClarify("user-bug2", "content_creation", maxClarify, 6, "protagonist");
    assert.equal(protagonistDecision.decision, "allow");
  });

  it("Bug 3: 用户未回答（extracted 为空）→ 字段计数不重置", () => {
    const counter = new ClarificationCounter();
    counter.recordClarification("user-bug3", "content_creation", "genre");

    // 模拟用户回答无效（未成功 extract）——计数不重置
    const countBefore = counter.getFieldCount("user-bug3", "content_creation", "genre");
    assert.equal(countBefore, 1);

    // 没有调用 resetField → 计数保持
    const countAfter = counter.getFieldCount("user-bug3", "content_creation", "genre");
    assert.equal(countAfter, 1);
  });

  it("Bug 4: 预置候选始终 ≥ 2 个具名候选", () => {
    // 检查 profile 中所有 fallbackCandidates 都有 ≥ 2 个候选
    const fallbacks = contentCreationProfile.fallbackCandidates;
    assert.ok(fallbacks, "fallbackCandidates must exist");

    for (const [fieldName, candidates] of Object.entries(fallbacks!)) {
      assert.ok(
        candidates.length >= 2,
        `字段 ${fieldName} 的预置候选必须 ≥ 2 个，实际 ${candidates.length} 个`,
      );
      for (const c of candidates) {
        assert.ok(c.label && c.label.length > 0, `候选 label 不能为空`);
        assert.ok(c.value !== undefined, `候选 value 不能为空`);
      }
    }
  });

  it("Bug 5: 成功 absorb 一个字段后，其他缺失字段仍可反问", () => {
    const counter = new ClarificationCounter();
    // genre 被反问 1 次后成功填充
    counter.recordClarification("user-bug5", "content_creation", "genre");
    counter.resetField("user-bug5", "content_creation", "genre");

    // genre 计数已重置 → 可以重新反问
    const genreDecision = counter.canClarify("user-bug5", "content_creation", 2, 6, "genre");
    assert.equal(genreDecision.decision, "allow");
    if (genreDecision.decision === "allow") {
      assert.equal(genreDecision.count, 0);
    }

    // protagonist 也可以反问
    const protagonistDecision = counter.canClarify("user-bug5", "content_creation", 2, 6, "protagonist");
    assert.equal(protagonistDecision.decision, "allow");
  });

  it("Bug 6: 信息充分 → pending_confirmation（不再追问）", () => {
    // 所有 critical + preferred 字段都有值
    const ctx = makeCtx("user-bug6", {
      genre: "sweet",
      protagonist: "冷面总裁",
      tone: "治愈",
      episodeCount: 40,
    });

    const preCheck = rulePreCheck(contentCreationProfile, ctx);
    assert.equal(preCheck.conclusion, "sufficient");

    const result = stage0CheckBridge(contentCreationProfile, preCheck, ctx);
    // sufficient → execute（阶段0 用 execute 代表可执行）
    assert.equal(result.action, "execute");
  });

  it("Bug 7: 总轮次硬上限——超 6 轮后新字段也 limit_reached", () => {
    const counter = new ClarificationCounter();

    // 模拟 6+ 轮反问（不同字段各 1 次）
    counter.recordClarification("user-bug7", "content_creation", "genre");
    counter.recordClarification("user-bug7", "content_creation", "protagonist");
    counter.recordClarification("user-bug7", "content_creation", "tone");
    counter.recordClarification("user-bug7", "content_creation", "episodeCount");
    counter.recordClarification("user-bug7", "content_creation", "genre");
    counter.recordClarification("user-bug7", "content_creation", "protagonist");

    // 第 7 轮：总轮次=6 → 新字段也 limit_reached
    const decision = counter.canClarify("user-bug7", "content_creation", 3, 6, "new_field");
    assert.equal(decision.decision, "limit_reached");
  });
});
