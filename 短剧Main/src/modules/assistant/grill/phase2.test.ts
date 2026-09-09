/**
 * Grill Engine 阶段2 集成测试
 *
 * 验证 buildAssistantSystemPrompt 是否正确读取 user_preferences
 * 并将 user_role / preferred_genre 注入到 system prompt 中。
 *
 * 约束：不接真实数据库，用 mock UserPreferenceRepository。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAssistantSystemPrompt, assistantSystemPrompt } from "../runtime.js";
import type { UserPreferenceRepository } from "./absorb.js";
import type { AssistantContext } from "../types.js";

// ── Mock UserPreferenceRepository ──────────────────────

function makeMockPrefRepo(
  prefs: {
    preferredGenre?: string | null;
    preferredTone?: string | null;
    styleTags?: string[];
    metadata?: Record<string, unknown>;
  } | null,
): UserPreferenceRepository {
  return {
    async upsert() { /* no-op for tests */ },
    async getByUserId() {
      if (!prefs) return null;
      return {
        preferredGenre: prefs.preferredGenre ?? null,
        preferredTone: prefs.preferredTone ?? null,
        styleTags: prefs.styleTags ?? [],
        metadata: prefs.metadata ?? {},
      };
    },
    async hasAnyPreference() {
      if (!prefs) return false;
      return Boolean(
        prefs.preferredGenre ||
        prefs.preferredTone ||
        (prefs.styleTags && prefs.styleTags.length > 0) ||
        (prefs.metadata && Object.keys(prefs.metadata).length > 0),
      );
    },
    async getField() {
      if (!prefs) return undefined;
      return prefs.metadata?.user_role;
    },
  };
}

function makeCtx(userId = "test-user"): AssistantContext {
  return {
    sessionId: "test-session",
    userId,
    projectId: "test-project",
    shotId: "test-shot",
  };
}

// ── 测试 ───────────────────────────────────────────────

describe("阶段2: buildAssistantSystemPrompt 动态注入", () => {
  it("GRILL_ENABLED=false (prefRepo=null) → 返回基础 prompt，无额外注入", async () => {
    const ctx = makeCtx();
    const result = await buildAssistantSystemPrompt(ctx, null);
    const base = assistantSystemPrompt(ctx);

    assert.equal(result, base);
    assert.ok(!result.includes("分镜视角"));
    assert.ok(!result.includes("镜头调度"));
    assert.ok(!result.includes("可执行性"));
  });

  it("user_role=screenwriter → system prompt 包含'分镜视角'", async () => {
    const ctx = makeCtx("screenwriter-user");
    const prefRepo = makeMockPrefRepo({
      metadata: { user_role: "screenwriter" },
    });

    const prompt = await buildAssistantSystemPrompt(ctx, prefRepo);

    assert.ok(prompt.includes("分镜视角"), `expected prompt to contain '分镜视角', got: ${prompt}`);
    assert.ok(prompt.includes("叙事节奏"));
  });

  it("user_role=director → system prompt 包含'镜头调度'", async () => {
    const ctx = makeCtx("director-user");
    const prefRepo = makeMockPrefRepo({
      metadata: { user_role: "director" },
    });

    const prompt = await buildAssistantSystemPrompt(ctx, prefRepo);

    assert.ok(prompt.includes("镜头调度"), `expected prompt to contain '镜头调度', got: ${prompt}`);
    assert.ok(prompt.includes("画面感"));
  });

  it("user_role=producer → system prompt 包含'可执行性'", async () => {
    const ctx = makeCtx("producer-user");
    const prefRepo = makeMockPrefRepo({
      metadata: { user_role: "producer" },
    });

    const prompt = await buildAssistantSystemPrompt(ctx, prefRepo);

    assert.ok(prompt.includes("可执行性"), `expected prompt to contain '可执行性', got: ${prompt}`);
    assert.ok(prompt.includes("进度和资源"));
  });

  it("user_role=screenwriter + preferredGenre=sweet → 同时包含角色和风格", async () => {
    const ctx = makeCtx("combo-user");
    const prefRepo = makeMockPrefRepo({
      preferredGenre: "sweet",
      metadata: { user_role: "screenwriter" },
    });

    const prompt = await buildAssistantSystemPrompt(ctx, prefRepo);

    assert.ok(prompt.includes("分镜视角"));
    assert.ok(prompt.includes("甜宠"), `expected '甜宠' (enumValueToLabel), got: ${prompt}`);
  });

  it("无 user_preferences 记录 → 返回基础 prompt", async () => {
    const ctx = makeCtx("no-pref-user");
    const prefRepo = makeMockPrefRepo(null);

    const prompt = await buildAssistantSystemPrompt(ctx, prefRepo);
    const base = assistantSystemPrompt(ctx);

    assert.equal(prompt, base);
  });

  it("有偏好但无 user_role → 只注入 preferredGenre", async () => {
    const ctx = makeCtx("genre-only-user");
    const prefRepo = makeMockPrefRepo({
      preferredGenre: "rebirth",
    });

    const prompt = await buildAssistantSystemPrompt(ctx, prefRepo);

    assert.ok(prompt.includes("重生复仇"), `expected '重生复仇' (enumValueToLabel), got: ${prompt}`);
    assert.ok(!prompt.includes("分镜视角"));
    assert.ok(!prompt.includes("镜头调度"));
    assert.ok(!prompt.includes("可执行性"));
  });

  it("user_role=unknown → 不注入角色描述", async () => {
    const ctx = makeCtx("unknown-role-user");
    const prefRepo = makeMockPrefRepo({
      metadata: { user_role: "unknown_role" },
    });

    const prompt = await buildAssistantSystemPrompt(ctx, prefRepo);
    const base = assistantSystemPrompt(ctx);

    assert.equal(prompt, base);
  });
});
