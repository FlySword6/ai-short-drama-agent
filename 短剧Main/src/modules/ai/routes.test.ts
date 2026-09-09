import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { AppError } from "../../shared/errors.js";
import { registerAiRoutes } from "./routes.js";
import type { AiProductionAssistService } from "./service.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

function createService(calls: Array<{ method: string; args: unknown[] }>): Pick<
  AiProductionAssistService,
  "createPromptDraft" | "translatePrompt" | "listPromptModels" | "matchAssets"
> {
  return {
    createPromptDraft: async (...args) => {
      calls.push({ method: "createPromptDraft", args });
      return {
        autoPrompt: "雨夜巷口的男主回望，暖黄路灯与冷色雨雾，中景缓推胶片颗粒，避免字幕和水印。",
        supplement: "",
        promptText: "雨夜巷口的男主回望，暖黄路灯与冷色雨雾，中景缓推胶片颗粒，避免字幕和水印。",
        modelKey: "quality",
      };
    },
    translatePrompt: async (...args) => {
      calls.push({ method: "translatePrompt", args });
      return {
        translation: { auto: "A man turns in a rainy alley.", supplement: "Keep @MaleLead unchanged." },
        promptText: "A man turns in a rainy alley.\nKeep @MaleLead unchanged.",
        modelKey: "fast",
      };
    },
    listPromptModels: () => {
      calls.push({ method: "listPromptModels", args: [] });
      return {
        items: [
          {
            key: "quality",
            displayName: "豆包·精细",
            description: "适合复杂画面、风格控制和最终提示词整理",
            available: true,
            isDefault: true,
          },
          {
            key: "fast",
            displayName: "豆包·快速",
            description: "适合快速试写、翻译和轻量调整",
            available: true,
            isDefault: false,
          },
        ],
        defaultKey: "quality",
      };
    },
    matchAssets: async (...args) => {
      calls.push({ method: "matchAssets", args });
      return {
        items: [{
          assetId: "33333333-3333-4333-8333-333333333333",
          assetVariantId: null,
          assetKind: "image",
          role: "character_identity",
          usageMode: "reference",
          name: "雨夜男主角色板",
          description: "黑发男主，冷色雨夜",
          reason: "角色造型和雨夜氛围吻合。",
        }],
        count: 1,
        retrievalMode: "hybrid" as const,
        empty: false,
      };
    },
  };
}

async function createTestApp(options: { authenticated?: boolean } = {}) {
  const app = Fastify({ logger: false });
  const calls: Array<{ method: string; args: unknown[] }> = [];
  if (options.authenticated !== false) {
    app.addHook("preHandler", async (request) => {
      request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
    });
  }
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ ok: false, error: { code: error.code, message: error.message } });
    }
    return reply.code(500).send({ ok: false, error: { code: "internal_error" } });
  });
  await registerAiRoutes(app, () => ({} as Database), {
    createService: () => createService(calls),
  });
  return { app, calls };
}

test("AI 草稿接口要求登录，并把合法请求转换为服务层 camel case", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/prompt-draft",
      payload: {
        media_kind: "video",
        description: "雨夜巷口里男主回望",
        selected_assets: [{
          asset_id: "33333333-3333-4333-8333-333333333333",
        }],
        context: {
          project_id: projectId,
          related_object_type: "shot",
          related_object_id: "G01",
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        auto_prompt: "雨夜巷口的男主回望，暖黄路灯与冷色雨雾，中景缓推胶片颗粒，避免字幕和水印。",
        supplement: "",
        prompt_text: "雨夜巷口的男主回望，暖黄路灯与冷色雨雾，中景缓推胶片颗粒，避免字幕和水印。",
        model_key: "quality",
      },
    });
    assert.deepEqual(calls, [{
      method: "createPromptDraft",
      args: [{ id: actorId, role: "member" }, {
        mediaKind: "video",
        description: "雨夜巷口里男主回望",
        selectedAssets: [{
          assetId: "33333333-3333-4333-8333-333333333333",
          name: "",
        }],
        projectId,
        relatedObject: { type: "shot", id: "G01" },
      }],
    }]);
  } finally {
    await app.close();
  }
});

test("AI 草稿接口接受 media_kind=audio，并把对白初稿作为 supplement 透传", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/prompt-draft",
      payload: {
        media_kind: "audio",
        description: "男主向女主低声认错",
        name: "男主哀求",
        selected_assets: [{
          asset_id: "33333333-3333-4333-8333-333333333333",
        }],
        supplement: "求你原谅我",
        context: {
          project_id: projectId,
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        auto_prompt: "雨夜巷口的男主回望，暖黄路灯与冷色雨雾，中景缓推胶片颗粒，避免字幕和水印。",
        supplement: "",
        prompt_text: "雨夜巷口的男主回望，暖黄路灯与冷色雨雾，中景缓推胶片颗粒，避免字幕和水印。",
        model_key: "quality",
      },
    });
    assert.deepEqual(calls, [{
      method: "createPromptDraft",
      args: [{ id: actorId, role: "member" }, {
        mediaKind: "audio",
        description: "男主向女主低声认错",
        name: "男主哀求",
        selectedAssets: [{
          assetId: "33333333-3333-4333-8333-333333333333",
          name: "",
        }],
        supplement: "求你原谅我",
        projectId,
        relatedObject: undefined,
      }],
    }]);
  } finally {
    await app.close();
  }
});

test("AI 模型目录只暴露稳定档位，不暴露供应商模型 ID", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/ai/prompt-models" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.data.items.map((item: Record<string, unknown>) => item.key), ["quality", "fast"]);
    assert.equal(body.data.default_key, "quality");
    assert.doesNotMatch(response.body, /260628|260215|model_id/);
    assert.deepEqual(calls, [{ method: "listPromptModels", args: [] }]);
  } finally {
    await app.close();
  }
});

test("AI 翻译接口保留自动段和用户补充，并传递稳定模型档位", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/prompt-translate",
      payload: {
        prompt: { auto: "雨夜巷口，男主回望。", supplement: "保持 @男主 造型不变。" },
        target_language: "en",
        model_key: "fast",
        context: {
          project_id: projectId,
          related_object_type: "shot",
          related_object_id: "G01",
        },
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, {
      translation: {
        auto: "A man turns in a rainy alley.",
        supplement: "Keep @MaleLead unchanged.",
      },
      prompt_text: "A man turns in a rainy alley.\nKeep @MaleLead unchanged.",
      model_key: "fast",
    });
    assert.deepEqual(calls, [{
      method: "translatePrompt",
      args: [{ id: actorId, role: "member" }, {
        prompt: { auto: "雨夜巷口，男主回望。", supplement: "保持 @男主 造型不变。" },
        targetLanguage: "en",
        modelKey: "fast",
        projectId,
        relatedObject: { type: "shot", id: "G01" },
      }],
    }]);
  } finally {
    await app.close();
  }
});

test("AI 资产匹配接口保持 snake case 响应，并只透传描述", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/asset-match",
      payload: { description: "雨夜巷口的黑发男主" },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        items: [{
          asset_id: "33333333-3333-4333-8333-333333333333",
          asset_variant_id: null,
          asset_kind: "image",
          role: "character_identity",
          usage_mode: "reference",
          name: "雨夜男主角色板",
          description: "黑发男主，冷色雨夜",
          reason: "角色造型和雨夜氛围吻合。",
        }],
        count: 1,
        retrieval_mode: "hybrid",
        empty: false,
      },
    });
    assert.deepEqual(calls, [{ method: "matchAssets", args: [actorId, "雨夜巷口的黑发男主"] }]);
  } finally {
    await app.close();
  }
});

test("AI 路由拒绝未认证和不完整或非法的输入，且不调用服务", async () => {
  const anonymous = await createTestApp({ authenticated: false });
  try {
    const unauthorized = await anonymous.app.inject({
      method: "POST",
      url: "/api/v1/ai/asset-match",
      payload: { description: "雨夜" },
    });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(anonymous.calls.length, 0);
  } finally {
    await anonymous.app.close();
  }

  const authenticated = await createTestApp();
  try {
    const invalidDraft = await authenticated.app.inject({
      method: "POST",
      url: "/api/v1/ai/prompt-draft",
      payload: {
        media_kind: "video",
        description: "",
        context: { related_object_type: "shot" },
      },
    });
    assert.equal(invalidDraft.statusCode, 400);

    const invalidMatch = await authenticated.app.inject({
      method: "POST",
      url: "/api/v1/ai/asset-match",
      payload: { description: " ", unexpected: true },
    });
    assert.equal(invalidMatch.statusCode, 400);

    const oversizedDraft = await authenticated.app.inject({
      method: "POST",
      url: "/api/v1/ai/prompt-draft",
      payload: { media_kind: "video", description: "x".repeat(4_001) },
    });
    assert.equal(oversizedDraft.statusCode, 400);

    const oversizedAssetContext = await authenticated.app.inject({
      method: "POST",
      url: "/api/v1/ai/prompt-draft",
      payload: {
        media_kind: "video",
        description: "雨夜巷口",
        selected_assets: [{ asset_id: "33333333-3333-4333-8333-333333333333", description: "x".repeat(1_001) }],
      },
    });
    assert.equal(oversizedAssetContext.statusCode, 400);

    const tooManyAssets = await authenticated.app.inject({
      method: "POST",
      url: "/api/v1/ai/prompt-draft",
      payload: {
        media_kind: "video",
        description: "雨夜巷口",
        selected_assets: Array.from({ length: 13 }, (_, index) => ({ asset_id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}` })),
      },
    });
    assert.equal(tooManyAssets.statusCode, 400);

    const oversizedMatch = await authenticated.app.inject({
      method: "POST",
      url: "/api/v1/ai/asset-match",
      payload: { description: "x".repeat(2_001) },
    });
    assert.equal(oversizedMatch.statusCode, 400);

    const invalidModel = await authenticated.app.inject({
      method: "POST",
      url: "/api/v1/ai/prompt-draft",
      payload: { media_kind: "video", description: "雨夜巷口", model_key: "raw/provider/id" },
    });
    assert.equal(invalidModel.statusCode, 400);

    const invalidTranslation = await authenticated.app.inject({
      method: "POST",
      url: "/api/v1/ai/prompt-translate",
      payload: { prompt: { auto: "", supplement: "" }, target_language: "fr" },
    });
    assert.equal(invalidTranslation.statusCode, 400);
    assert.equal(authenticated.calls.length, 0);
  } finally {
    await authenticated.app.close();
  }
});
