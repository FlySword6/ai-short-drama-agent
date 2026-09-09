import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { absorbAnswer } from "./absorb.js";
import type { ConversationContext, FieldSpec } from "./types.js";
import type { AiCallRepository, AiCompletionProvider } from "../../ai/types.js";

// ── Mock LLM（不应被调用，如果被调用说明三级匹配未命中）──

const mockProvider: AiCompletionProvider = {
  async complete() {
    return {
      content: '{"extracted": null}',
      model: "mock",
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    };
  },
};

const mockRepo: AiCallRepository = {
  async reserve() {
    return { id: "mock-reservation" };
  },
  async complete() {},
  async fail() {},
};

const mockPrefRepo = {
  async upsert() {},
  async getByUserId() {
    return { preferredGenre: null, preferredTone: null, styleTags: [], metadata: {} };
  },
  async hasAnyPreference() {
    return false;
  },
  async getField() {
    return null;
  },
};

// ── 测试数据 ──────────────────────────────────────────────

const subjectField: FieldSpec = {
  name: "subject_or_theme",
  description: "主题或题材方向",
  priority: "critical",
  usage: "ephemeral",
  extractor: "regex",
};

const styleField: FieldSpec = {
  name: "style_or_tone",
  description: "风格或调性",
  priority: "critical",
  usage: "ephemeral",
  extractor: "regex",
};

function makeCtx(): ConversationContext {
  return { userId: "test-vague" };
}

// ── 测试用例 ──────────────────────────────────────────────

describe("Bug: vague words 不应被吸收为有效值", () => {
  // 不知道类
  it("\"不知道\" 不应被提取为 subject_or_theme 的值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "不知道", subjectField, ctx);
    assert.equal(result.extracted, null);
  });

  it("\"没想好\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "没想好", subjectField, ctx);
    assert.equal(result.extracted, null);
  });

  it("\"说不好\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "说不好", styleField, ctx);
    assert.equal(result.extracted, null);
  });

  // 随便类
  it("\"都可以\" 不应被提取为 style_or_tone 的值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "都可以", styleField, ctx);
    assert.equal(result.extracted, null);
  });

  it("\"随便\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "随便", subjectField, ctx);
    assert.equal(result.extracted, null);
  });

  it("\"都行\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "都行", subjectField, ctx);
    assert.equal(result.extracted, null);
  });

  it("\"无所谓\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "无所谓", styleField, ctx);
    assert.equal(result.extracted, null);
  });

  // 你定类
  it("\"你定\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "你定", subjectField, ctx);
    assert.equal(result.extracted, null);
  });

  it("\"你看着办\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "你看着办", styleField, ctx);
    assert.equal(result.extracted, null);
  });

  it("\"听你的\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "听你的", subjectField, ctx);
    assert.equal(result.extracted, null);
  });

  // 敷衍类
  it("\"行吧\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "行吧", styleField, ctx);
    assert.equal(result.extracted, null);
  });

  it("\"没意见\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "没意见", subjectField, ctx);
    assert.equal(result.extracted, null);
  });

  it("\"咋都行\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "咋都行", styleField, ctx);
    assert.equal(result.extracted, null);
  });

  // 新增：没有类
  it("\"没有\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "没有", subjectField, ctx);
    assert.equal(result.extracted, null);
  });

  it("\"没什么\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "没什么", styleField, ctx);
    assert.equal(result.extracted, null);
  });

  // 模糊词+标点
  it("\"都可以。\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "都可以。", styleField, ctx);
    assert.equal(result.extracted, null);
  });

  it("\"不知道，\" 不应被提取为有效值", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "不知道，", subjectField, ctx);
    assert.equal(result.extracted, null);
  });

  // 模糊词作为正常回答子串时仍应被提取
  it("包含\"好\"字的正常回答仍能被提取", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "赛博朋克风格的城市夜景", subjectField, ctx);
    assert.notEqual(result.extracted, null);
  });

  it("正常回答仍能被提取", async () => {
    const ctx = makeCtx();
    const result = await absorbAnswer(mockRepo, mockProvider, mockPrefRepo, "赛博朋克城市", subjectField, ctx);
    // regex 抽取器对 subject_or_theme 会提取整个回答作为值
    assert.notEqual(result.extracted, null);
  });
});
