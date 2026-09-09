/**
 * candidate.ts 测试
 *
 * 验证 generateCandidates 的三层逻辑：
 * 1. 始终优先 LLM 生成，候选不足 2 个时降级到预置候选
 * 2. 后续轮（有上下文）→ LLM 动态生成
 * 3. LLM 失败/返回不足 → 降级到预置候选
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateCandidates } from "./candidate.js";
import { getTaskProfile } from "./profiles.js";
import type {
  AiCallRepository,
  AiCompletionProvider,
  AiCallReservation,
  ReserveAiCallInput,
  CompleteAiCallInput,
  FailAiCallInput,
} from "../../ai/types.js";
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
// 可控 LLM 响应，用于模拟动态候选

function makeMockProvider(
  jsonResponse: Record<string, unknown> | null,
  callLog: { prompts: string[] },
): AiCompletionProvider {
  return {
    async complete(input: {
      system: string;
      prompt: string;
      model?: string;
      maxTokens: number;
    }): Promise<{ content: string; model: string; inputTokens: number | null; outputTokens: number | null; durationMs: number }> {
      callLog.prompts.push(input.prompt);
      const content = jsonResponse ? JSON.stringify(jsonResponse) : '{"candidates": []}';
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

function makeCtx(userId = "test-user", ephemeralFields?: Record<string, unknown>): ConversationContext {
  return {
    userId,
    projectId: "test-project",
    ephemeralFields: ephemeralFields ?? {},
  };
}

// ── 测试 ───────────────────────────────────────────────

describe("generateCandidates: 三层候选生成逻辑", () => {
  const profile = getTaskProfile("content_creation")!;

  it("首轮（无上下文）→ LLM 生成或预置候选", async () => {
    const callLog = { prompts: [] as string[] };
    const provider = makeMockProvider(
      { candidates: [{ label: "不该出现", description: "LLM不该被调用", value: "wrong" }] },
      callLog,
    );

    const field = profile.requiredFields.find(f => f.name === "content_type")!;
    const ctx = makeCtx("user-1"); // 空 ephemeralFields → 首轮

    const result = await generateCandidates(
      makeMockAiCallRepo(),
      provider,
      profile,
      field,
      "content_creation",
      "user-1",
      ctx,
    );

    // 实现设计：始终优先 LLM 生成，LLM 候选不足时降级到预置
    // mock LLM 只返回 1 个候选（不足 2 个）→ 降级到预置候选
    assert.ok(result, "应返回候选（LLM 不足时降级到预置）");
    assert.equal(result![0]!.label, "视频", "降级后首个预置候选应为'视频'");
  });

  it("后续轮（有上下文）→ LLM 动态生成针对性候选", async () => {
    const dynamicCandidates = {
      candidates: [
        { label: "霸总甜宠", description: "霸道总裁爱上灰姑娘", value: "boss_sweet" },
        { label: "复仇爽文", description: "重生复仇打脸反派", value: "revenge" },
        { label: "穿越古风", description: "现代女性穿越古代宫斗", value: "time_travel_palace" },
      ],
    };
    const callLog = { prompts: [] as string[] };
    const provider = makeMockProvider(dynamicCandidates, callLog);

    const field = profile.requiredFields.find(f => f.name === "subject_or_theme")!;
    const ctx = makeCtx("user-2", {
      content_type: "video", // 已收集 → 有上下文
    });

    const result = await generateCandidates(
      makeMockAiCallRepo(),
      provider,
      profile,
      field,
      "content_creation",
      "user-2",
      ctx,
    );

    assert.ok(result, "后续轮应返回 LLM 候选");
    assert.equal(result!.length, 3, "应返回 3 个 LLM 候选");
    assert.equal(result![0]!.label, "霸总甜宠", "首个候选应为 LLM 生成的'霸总甜宠'");
    assert.notEqual(result![0]!.label, "都市情感", "不应返回预置候选'都市情感'");

    // 关键断言：后续轮应调用 LLM
    assert.equal(callLog.prompts.length, 1, "后续轮应调用 1 次 LLM");
    // LLM prompt 应包含已收集的上下文
    assert.ok(
      callLog.prompts[0]!.includes("content_type=video"),
      "LLM prompt 应包含已收集的上下文",
    );
  });

  it("后续轮 LLM 返回不足 2 个候选 → 降级到预置候选", async () => {
    const callLog = { prompts: [] as string[] };
    const provider = makeMockProvider(
      { candidates: [{ label: "只有一个", description: "不足2个", value: "single" }] },
      callLog,
    );

    const field = profile.requiredFields.find(f => f.name === "style_or_tone")!;
    const ctx = makeCtx("user-3", {
      content_type: "video",
      subject_or_theme: "都市情感",
    });

    const result = await generateCandidates(
      makeMockAiCallRepo(),
      provider,
      profile,
      field,
      "content_creation",
      "user-3",
      ctx,
    );

    assert.ok(result, "LLM 不足时应降级到预置候选");
    assert.equal(result![0]!.label, "写实电影感", "降级后应为预置候选'写实电影感'");
    assert.equal(callLog.prompts.length, 1, "应调用过 1 次 LLM（虽降级）");
  });

  it("后续轮 LLM 返回 null → 降级到预置候选", async () => {
    const callLog = { prompts: [] as string[] };
    const provider = makeMockProvider(null, callLog);

    const field = profile.requiredFields.find(f => f.name === "content_type")!;
    const ctx = makeCtx("user-4", {
      subject_or_theme: "悬疑推理",
    });

    const result = await generateCandidates(
      makeMockAiCallRepo(),
      provider,
      profile,
      field,
      "content_creation",
      "user-4",
      ctx,
    );

    assert.ok(result, "LLM 失败时应降级到预置候选");
    assert.equal(result![0]!.label, "视频", "降级后应为预置候选'视频'");
  });

  it("无预置候选的字段 + 首轮 → 返回 null", async () => {
    // 用 content_creation profile 的 constraints（无 fallbackCandidates）
    const callLog = { prompts: [] as string[] };
    const provider = makeMockProvider({ candidates: [] }, callLog);

    const field = profile.requiredFields.find(f => f.name === "constraints")!;
    const ctx = makeCtx("user-5"); // 首轮，无上下文

    const result = await generateCandidates(
      makeMockAiCallRepo(),
      provider,
      profile,
      field,
      "content_creation",
      "user-5",
      ctx,
    );

    assert.equal(result, null, "LLM 空返回 + 无预置候选 → 返回 null");
    assert.equal(callLog.prompts.length, 1, "始终优先调用 LLM（虽然最终降级到 null）");
  });

  it("不同轮次收集不同上下文 → LLM prompt 包含不同上下文", async () => {
    const dynamicCandidates = {
      candidates: [
        { label: "动态候选A", description: "描述A", value: "a" },
        { label: "动态候选B", description: "描述B", value: "b" },
      ],
    };

    // 第2轮：只有 content_type
    const callLog2 = { prompts: [] as string[] };
    const provider2 = makeMockProvider(dynamicCandidates, callLog2);
    const field = profile.requiredFields.find(f => f.name === "style_or_tone")!;

    await generateCandidates(
      makeMockAiCallRepo(),
      provider2,
      profile,
      field,
      "content_creation",
      "user-6",
      makeCtx("user-6", { content_type: "video" }),
    );

    // 第3轮：content_type + subject_or_theme
    const callLog3 = { prompts: [] as string[] };
    const provider3 = makeMockProvider(dynamicCandidates, callLog3);

    await generateCandidates(
      makeMockAiCallRepo(),
      provider3,
      profile,
      field,
      "content_creation",
      "user-6",
      makeCtx("user-6", { content_type: "video", subject_or_theme: "都市情感" }),
    );

    assert.equal(callLog2.prompts.length, 1, "第2轮应调用 LLM");
    assert.equal(callLog3.prompts.length, 1, "第3轮应调用 LLM");
    assert.notEqual(callLog2.prompts[0], callLog3.prompts[0], "两轮的 LLM prompt 应不同");
    assert.ok(
      callLog3.prompts[0]!.includes("subject_or_theme"),
      "第3轮 prompt 应包含第2轮收集的 subject_or_theme",
    );
  });
});
