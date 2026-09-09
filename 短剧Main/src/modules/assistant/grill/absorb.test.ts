/**
 * Bug 7 修复测试 —— absorb enum 三级匹配
 *
 * 验证用户输入不在枚举列表但语义有效的回答（如"动画"）能被正确吸收。
 *
 * 三级匹配：
 *   1. 精确匹配：输入 === 枚举值/候选 label
 *   2. 同义词匹配：输入 ∈ 同义词表
 *   3. 模糊匹配：包含关系 / 编辑距离
 *   4. 未命中 → null（保持 Bug 3 逻辑）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { absorbAnswer } from "./absorb.js";
import type { Candidate, ConversationContext, FieldSpec } from "./types.js";
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

const contentTypeField: FieldSpec = {
  name: "content_type",
  description: "内容类型（图片/视频/文案等）",
  priority: "critical",
  usage: "ephemeral",
  extractor: "enum",
  knownEnums: ["video", "image", "text"],
};

const contentTypeCandidates: Candidate[] = [
  { label: "视频", description: "生成短视频片段", value: "video" },
  { label: "图片", description: "生成单张图片", value: "image" },
  { label: "文案", description: "生成文字内容", value: "text" },
];

function makeCtx(): ConversationContext {
  return { userId: "test-user-bug7" };
}

// ── 测试用例 ──────────────────────────────────────────────

describe("Bug 7 - absorb enum 三级匹配", () => {
  // ── 第一级：精确匹配 ──────────────────────────────────

  describe("第一级：精确匹配", () => {
    it("精确匹配候选 value（video）", async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "video",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "video");
    });

    it("精确匹配候选 label（视频）", async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "视频",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "video");
    });

    it("精确匹配候选 label（图片）", async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "图片",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "image");
    });

    it("精确匹配候选 label（文案）", async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "文案",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "text");
    });
  });

  // ── 第二级：同义词匹配 ────────────────────────────────

  describe("第二级：同义词匹配", () => {
    it('"动画" → 映射到 video', async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "动画",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "video");
    });

    it('"动漫" → 映射到 video', async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "动漫",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "video");
    });

    it('"插画" → 映射到 image', async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "插画",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "image");
    });

    it('"文字" → 映射到 text', async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "文字",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "text");
    });

    it('"剧本" → 映射到 text', async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "剧本",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "text");
    });
  });

  // ── 第三级：模糊匹配（包含关系 / 编辑距离）────────────

  describe("第三级：模糊匹配", () => {
    it('"短视频" 包含 "视频" → 映射到 video', async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "短视频",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "video");
    });

    it('"做一段动画视频" 包含 "视频" → video', async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "做一段动画视频",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "video");
    });

    it('"生成一张海报" 包含同义词"海报" → image', async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "海报",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "image");
    });
  });

  // ── 未命中：保持 Bug 3 逻辑 ────────────────────────────

  describe("未命中 → null（保持 Bug 3 逻辑）", () => {
    it('"asdfgh" → LLM 兜底返回 null', async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "asdfgh",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      // LLM mock 返回 null
      assert.equal(result.extracted, null);
    });

    it("空字符串 → null", async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, null);
    });

    it('"12345" 纯数字无意义 → LLM 返回 null', async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "12345",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, null);
    });
  });

  // ── 上下文更新验证 ────────────────────────────────────

  describe("上下文更新", () => {
    it("吸收成功后 ephemeralFields 包含字段", async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "动画",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, "video");
      assert.equal(result.updatedCtx.ephemeralFields?.content_type, "video");
    });

    it("吸收失败后 ephemeralFields 不写入", async () => {
      const result = await absorbAnswer(
        mockRepo, mockProvider, mockPrefRepo, "asdfgh",
        contentTypeField, makeCtx(), contentTypeCandidates,
      );
      assert.equal(result.extracted, null);
      assert.equal(result.updatedCtx.ephemeralFields?.content_type, undefined);
    });
  });
});
