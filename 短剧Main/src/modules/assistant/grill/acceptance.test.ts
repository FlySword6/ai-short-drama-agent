/**
 * 验收测试 —— 对应"怎么算做完"第 1 条
 *
 * 验证三个验收点：
 * 1. 新用户首回合反问称呼和角色，不静默往下走
 * 2. user_role 写入 user_preferences 表，后续回合读出并影响 system prompt
 * 3. 老用户（有记录）不重复问
 *
 * 约束：不接真实数据库和真实 LLM，用 mock repository + mock provider。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GrillEngineImpl, type GrillEngineDeps } from "./engine.js";
import { getTaskProfile } from "./profiles.js";
import { absorbAnswer, type UserPreferenceRepository } from "./absorb.js";
import { buildAssistantSystemPrompt, assistantSystemPrompt } from "../runtime.js";
import { aiGatewayAsProvider, callLLMWithGuard } from "./callLLMWithGuard.js";
import type { AssistantContext } from "../types.js";
import type {
  AiCallRepository,
  AiCompletionProvider,
  AiCallReservation,
  ReserveAiCallInput,
  CompleteAiCallInput,
  FailAiCallInput,
} from "../../ai/types.js";
import type { AiGatewayService } from "../../ai/service.js";
import type { ConversationContext } from "./types.js";

// ── Mock AiCallRepository ──────────────────────────────

function makeMockAiCallRepo(): AiCallRepository {
  return {
    async reserve(_input: ReserveAiCallInput): Promise<AiCallReservation> {
      return { id: "mock-reservation-id" };
    },
    async complete(_input: CompleteAiCallInput): Promise<void> {
      /* no-op */
    },
    async fail(_input: FailAiCallInput): Promise<void> {
      /* no-op */
    },
  };
}

// ── Mock AiCompletionProvider ──────────────────────────
// LLM 返回值可控，模拟不同场景

function makeMockProvider(jsonResponse: Record<string, unknown> | null): AiCompletionProvider {
  return {
    async complete(input: {
      system: string;
      prompt: string;
      model?: string;
      maxTokens: number;
    }): Promise<{ content: string; model: string; inputTokens: number | null; outputTokens: number | null; durationMs: number }> {
      const content = jsonResponse ? JSON.stringify(jsonResponse) : '{"extracted": null}';
      return {
        content,
        model: "mock-model",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      };
    },
    providerForModel(_model: string): string {
      return "ark";
    },
  };
}

// ── Mock UserPreferenceRepository ──────────────────────
// 内存存储，支持读写验证

function makeInMemoryPrefRepo(): UserPreferenceRepository & {
  _store: Map<string, {
    preferredGenre: string | null;
    preferredTone: string | null;
    styleTags: string[];
    metadata: Record<string, unknown>;
  }>;
} {
  const store = new Map<string, {
    preferredGenre: string | null;
    preferredTone: string | null;
    styleTags: string[];
    metadata: Record<string, unknown>;
  }>();

  return {
    _store: store,
    async upsert(userId, data) {
      const existing = store.get(userId) ?? {
        preferredGenre: null,
        preferredTone: null,
        styleTags: [],
        metadata: {},
      };
      store.set(userId, {
        preferredGenre: data.preferredGenre ?? existing.preferredGenre,
        preferredTone: data.preferredTone ?? existing.preferredTone,
        styleTags: data.styleTags ?? existing.styleTags,
        metadata: { ...existing.metadata, ...(data.metadata ?? {}) },
      });
    },
    async getByUserId(userId) {
      const row = store.get(userId);
      if (!row) return null;
      return { ...row, metadata: { ...row.metadata } };
    },
    async hasAnyPreference(userId) {
      const row = store.get(userId);
      if (!row) return false;
      return Boolean(
        row.preferredGenre ||
        row.preferredTone ||
        (row.styleTags && row.styleTags.length > 0) ||
        (row.metadata && Object.keys(row.metadata).length > 0),
      );
    },
    async getField(userId, fieldName) {
      const row = store.get(userId);
      if (!row) return undefined;
      if (fieldName === "preferred_genre" || fieldName === "genre") return row.preferredGenre;
      if (fieldName === "preferred_tone" || fieldName === "tone") return row.preferredTone;
      if (fieldName === "style_tags") return row.styleTags;
      return row.metadata?.[fieldName];
    },
  };
}

it("Grill 网关适配器把既有用途、执行者和项目交给 completeValidated，且不重复预留", async () => {
  let captured: Record<string, unknown> | undefined;
  const gateway = {
    async completeValidated(input: Record<string, unknown>, validate: (completion: { content: string; model: string; inputTokens: number | null; outputTokens: number | null; durationMs: number }) => unknown) {
      captured = input;
      return validate({ content: "{}", model: "routed-model", inputTokens: 1, outputTokens: 2, durationMs: 3 });
    },
  };
  const repo: AiCallRepository = {
    async reserve() { throw new Error("gateway path must not reserve twice"); },
    async complete() {},
    async fail() {},
  };
  const result = await callLLMWithGuard(repo, aiGatewayAsProvider(gateway as unknown as Pick<AiGatewayService, "completeValidated">), {
    userId: "actor-1", purpose: "grill_candidate", projectId: "project-1", system: "system", prompt: "prompt", maxTokens: 500,
  });
  assert.equal(result?.model, "routed-model");
  assert.deepEqual(captured, {
    actorId: "actor-1", purpose: "grill_candidate", projectId: "project-1", system: "system", prompt: "prompt", maxTokens: 500,
  });
});

function makeCtx(userId = "test-user", ephemeralFields?: Record<string, unknown>): ConversationContext {
  return {
    userId,
    projectId: "test-project",
    ephemeralFields: ephemeralFields ?? {},
  };
}

function makeAssistantCtx(userId = "test-user"): AssistantContext {
  return {
    sessionId: "test-session",
    userId,
    projectId: "test-project",
    shotId: "test-shot",
  };
}

// ── 验收测试 ───────────────────────────────────────────

describe("验收: 首回合注册引导 + user_role 持久化 + 老用户跳过", () => {
  const profile = getTaskProfile("registration")!;

  // ── 验收点1: 新用户首回合反问，不静默往下走 ──

  it("验收1: 新用户首回合 → 反问 preferred_genre（critical 缺失），不静默往下走", async () => {
    const prefRepo = makeInMemoryPrefRepo();
    const deps: GrillEngineDeps = {
      aiCallRepo: makeMockAiCallRepo(),
      provider: makeMockProvider({ question: "你喜欢什么题材？", targetField: "preferred_genre" }),
      prefRepo,
    };
    const engine = new GrillEngineImpl(deps);

    // 新用户：ephemeralFields 为空，所有字段都缺失
    const ctx = makeCtx("new-user-1");

    const result = await engine.check(profile, "你好", ctx);

    // critical 字段 preferred_genre 缺失 → 必须 clarify 或 offer_candidates，不能 execute
    assert.notEqual(result.action, "execute", "新用户首回合不能静默 execute");
    assert.ok(
      result.action === "clarify" || result.action === "offer_candidates",
      `新用户首回合应反问或给候选，实际: ${result.action}`,
    );

    if (result.action === "clarify") {
      // 反问问题不能为空
      assert.ok(
        result.question.length > 0,
        `反问问题不能为空，实际: "${result.question}"`,
      );
      assert.equal(result.targetField, "preferred_genre", "首个反问目标必须是 critical 字段 preferred_genre");
    } else if (result.action === "offer_candidates") {
      // 给候选时必须有候选列表
      assert.ok(result.candidates.length > 0, "候选列表不能为空");
    }
  });

  // ── 验收点2: user_role 写入 user_preferences 并影响 system prompt ──

  it("验收2a: user_role 回答 → absorb 写入 user_preferences（metadata.user_role）", async () => {
    const prefRepo = makeInMemoryPrefRepo();
    const provider = makeMockProvider({ extracted: "director" });
    const deps: GrillEngineDeps = {
      aiCallRepo: makeMockAiCallRepo(),
      provider,
      prefRepo,
    };

    const ctx = makeCtx("user-2a", {
      // preferred_genre 已有值，preferred_tone 已有值
      preferred_genre: "sweet",
      preferred_tone: "hot_blooded",
      // user_role 缺失
    });

    // 直接调用 absorbAnswer（模拟用户回答 "我是导演"）
    const userRoleField = profile.requiredFields.find(f => f.name === "user_role")!;
    const result = await absorbAnswer(
      deps.aiCallRepo,
      deps.provider,
      prefRepo,
      "我是导演",
      userRoleField,
      ctx,
    );

    // extractByEnum 应将"导演"归一化为 director（enum 优先，不走 LLM）
    assert.equal(
      result.extracted,
      "director",
      `extractByEnum 应将"导演"归一化为"director"，实际: ${result.extracted}`,
    );

    // 验证写入 user_preferences 表
    const stored = await prefRepo.getByUserId("user-2a");
    assert.ok(stored, "user_preferences 记录必须存在");
    assert.equal(
      stored!.metadata?.user_role,
      "director",
      `metadata.user_role 必须为 "director"，实际: ${JSON.stringify(stored!.metadata)}`,
    );
  });

  it("验收2b: user_role 已写入 → buildAssistantSystemPrompt 读出并注入 system prompt", async () => {
    const prefRepo = makeInMemoryPrefRepo();

    // 模拟 user_role=director 已持久化
    await prefRepo.upsert("user-2b", {
      metadata: { user_role: "director" },
    });

    const ctx = makeAssistantCtx("user-2b");
    const prompt = await buildAssistantSystemPrompt(ctx, prefRepo);
    const base = assistantSystemPrompt(ctx);

    // system prompt 必须包含导演相关关键词
    assert.ok(prompt.includes("镜头调度"), `system prompt 应包含"镜头调度"，实际: ${prompt}`);
    assert.ok(prompt.includes("画面感"), `system prompt 应包含"画面感"，实际: ${prompt}`);
    assert.ok(prompt.length > base.length, "注入后的 prompt 必须比基础 prompt 长");
  });

  it("验收2c: user_role=screenwriter → system prompt 包含'分镜视角'", async () => {
    const prefRepo = makeInMemoryPrefRepo();

    await prefRepo.upsert("user-2c", {
      metadata: { user_role: "screenwriter" },
    });

    const ctx = makeAssistantCtx("user-2c");
    const prompt = await buildAssistantSystemPrompt(ctx, prefRepo);

    assert.ok(prompt.includes("分镜视角"), `system prompt 应包含"分镜视角"，实际: ${prompt}`);
    assert.ok(prompt.includes("叙事节奏"), `system prompt 应包含"叙事节奏"，实际: ${prompt}`);
  });

  // ── 验收点3: 老用户（有记录）不重复问 ──

  it("验收3a: 老用户（有 user_preferences 记录）→ hasAnyPreference 返回 true", async () => {
    const prefRepo = makeInMemoryPrefRepo();

    // 模拟老用户已有偏好
    await prefRepo.upsert("old-user-3a", {
      preferredGenre: "sweet",
      metadata: { user_role: "screenwriter" },
    });

    // hasAnyPreference 必须返回 true
    const hasPref = await prefRepo.hasAnyPreference("old-user-3a");
    assert.equal(hasPref, true, "老用户（有偏好记录）hasAnyPreference 必须返回 true");
  });

  it("验收3b: 新用户 → hasAnyPreference 返回 false，触发注册引导", async () => {
    const prefRepo = makeInMemoryPrefRepo();

    const hasPref = await prefRepo.hasAnyPreference("brand-new-user");
    assert.equal(hasPref, false, "新用户 hasAnyPreference 必须返回 false");

    // 模拟 routes.ts 逻辑：!hasPrefs → 进入 grill.check
    const deps: GrillEngineDeps = {
      aiCallRepo: makeMockAiCallRepo(),
      provider: makeMockProvider({ question: "你喜欢什么题材？", targetField: "preferred_genre" }),
      prefRepo,
    };
    const engine = new GrillEngineImpl(deps);

    const ctx = makeCtx("brand-new-user");
    const result = await engine.check(profile, "你好", ctx);

    assert.notEqual(result.action, "execute", "新用户必须被反问，不能 execute");
  });

  it("验收3c: 老用户所有字段已有值 → check 返回 execute，不反问", async () => {
    const prefRepo = makeInMemoryPrefRepo();

    // 模拟 routes.ts 逻辑：hasAnyPreference=true → 跳过 check
    // 这里验证即使强制调用 check，老用户在 ephemeralFields 中已有字段时也应 execute
    const deps: GrillEngineDeps = {
      aiCallRepo: makeMockAiCallRepo(),
      provider: makeMockProvider({}),
      prefRepo,
    };
    const engine = new GrillEngineImpl(deps);

    // 老用户的偏好已被加载到 ephemeralFields
    const ctx = makeCtx("old-user-3c", {
      preferred_genre: "sweet",
      user_role: "screenwriter",
      preferred_tone: "hot_blooded",
    });

    const result = await engine.check(profile, "帮我写个剧本", ctx);
    assert.equal(
      result.action,
      "pending_confirmation",
      "老用户（所有字段已有值）check 应返回 pending_confirmation，不反问",
    );
  });

  // ── 验收4: registration 不允许自动推断，逐个反问 ──

  it("验收4: registration 回答一个字段后不自动推断剩余字段，反问下一个缺失字段", async () => {
    const prefRepo = makeInMemoryPrefRepo();
    // mock provider 返回 sufficient + inferred，但 registration 不应走推断路径
    const deps: GrillEngineDeps = {
      aiCallRepo: makeMockAiCallRepo(),
      provider: makeMockProvider({
        sufficient: true,
        inferred: { user_role: "screenwriter", preferred_tone: "hot_blooded" },
      }),
      prefRepo,
    };
    const engine = new GrillEngineImpl(deps);

    // 用户已回答 preferred_genre="rebirth"（critical 满足），user_role 和 preferred_tone 仍缺失
    const ctx = makeCtx("user-4", {
      preferred_genre: "rebirth",
    });

    const result = await engine.check(profile, "重生逆袭", ctx);

    // 不能是 pending_confirmation（那意味着自动推断了）
    assert.notEqual(
      result.action,
      "pending_confirmation",
      "registration 不应在 preferred 字段缺失时自动推断并返回 pending_confirmation",
    );
    // 不能是 execute
    assert.notEqual(result.action, "execute", "registration 不应在字段缺失时 execute");

    // 必须是 clarify 或 offer_candidates（反问下一个缺失字段 user_role）
    assert.ok(
      result.action === "clarify" || result.action === "offer_candidates",
      `应反问下一个缺失字段，实际 action: ${result.action}`,
    );

    if (result.action === "clarify") {
      assert.equal(
        result.targetField,
        "user_role",
        `应反问 user_role（第一个缺失的 preferred 字段），实际 targetField: ${result.targetField}`,
      );
    }
  });

  it("验收4b: registration 用户显式说'你来猜' → 走推断路径，返回 pending_confirmation", async () => {
    const prefRepo = makeInMemoryPrefRepo();
    const deps: GrillEngineDeps = {
      aiCallRepo: makeMockAiCallRepo(),
      provider: makeMockProvider({
        sufficient: true,
        inferred: { user_role: "screenwriter", preferred_tone: "hot_blooded" },
      }),
      prefRepo,
    };
    const engine = new GrillEngineImpl(deps);

    // preferred_genre 已有值，用户说"你来猜"
    const ctx = makeCtx("user-4b", {
      preferred_genre: "rebirth",
    });

    const result = await engine.check(profile, "你来猜吧", ctx);

    assert.equal(
      result.action,
      "pending_confirmation",
      "用户显式 opt-in 推断时应返回 pending_confirmation",
    );
  });

  // ── 端到端验收 ──

  it("端到端: 新用户 → 反问 → 回答 → 写入 → 第二回合 system prompt 注入 → 老用户不再被反问", async () => {
    const prefRepo = makeInMemoryPrefRepo();
    const provider = makeMockProvider({ extracted: "screenwriter" });
    const deps: GrillEngineDeps = {
      aiCallRepo: makeMockAiCallRepo(),
      provider,
      prefRepo,
    };
    const engine = new GrillEngineImpl(deps);

    const userId = "e2e-user";

    // ── 步骤1: 新用户首回合 check → 应反问 ──
    const ctx1 = makeCtx(userId);
    const result1 = await engine.check(profile, "你好，我想写短剧", ctx1);
    assert.notEqual(result1.action, "execute", "首回合不能 execute");

    // ── 步骤2: 用户回答角色 → absorb 写入 ──
    // 先模拟 preferred_genre 已有值（通过前一轮 absorb）
    const ctx2 = makeCtx(userId, {
      preferred_genre: "sweet",
      preferred_tone: "hot_blooded",
    });

    const userRoleField = profile.requiredFields.find(f => f.name === "user_role")!;
    const absorbResult = await absorbAnswer(
      deps.aiCallRepo,
      deps.provider,
      prefRepo,
      "我是编剧",
      userRoleField,
      ctx2,
    );

    assert.equal(absorbResult.extracted, "screenwriter", "回答'我是编剧'应抽取为 screenwriter");

    // ── 步骤3: 验证写入 user_preferences ──
    const stored = await prefRepo.getByUserId(userId);
    assert.ok(stored, "user_preferences 必须有记录");
    assert.equal(
      stored!.metadata?.user_role,
      "screenwriter",
      `metadata.user_role 必须为 screenwriter，实际: ${JSON.stringify(stored!.metadata)}`,
    );

    // ── 步骤4: 第二回合 buildAssistantSystemPrompt → 注入 ──
    const assistantCtx = makeAssistantCtx(userId);
    const prompt = await buildAssistantSystemPrompt(assistantCtx, prefRepo);

    assert.ok(
      prompt.includes("分镜视角"),
      `第二回合 system prompt 必须包含"分镜视角"，实际: ${prompt}`,
    );
    assert.ok(
      prompt.includes("叙事节奏"),
      `第二回合 system prompt 必须包含"叙事节奏"，实际: ${prompt}`,
    );

    // ── 步骤5: 老用户不再被反问 ──
    const hasPref = await prefRepo.hasAnyPreference(userId);
    assert.equal(hasPref, true, "有偏好记录后 hasAnyPreference 必须返回 true");

    // 模拟 routes.ts 的预检逻辑：hasPref=true → 跳过 grill.check
    // 因此老用户不会再次触发注册引导反问
  });
});
