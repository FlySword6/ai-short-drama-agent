import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerConfigStatusRoutes, type RegisterConfigStatusRoutesOptions } from "./routes.js";

const configuration: NonNullable<RegisterConfigStatusRoutesOptions["configuration"]> = {
  arkApiKey: "test-key",
  arkImageModel: "seedream-real-id",
  arkVideoModel: "seedance-real-id",
  arkLlmModel: "ark-llm-id",
  doubaoLlmModel: undefined,
  aiGatewayEnabled: true,
  piRemoteApiUrl: undefined,
  piRemoteApiToken: undefined,
  piRemoteModel: undefined,
  doubaoEmbeddingModel: "doubao-embedding-id",
  milvusUri: "http://milvus.example:19530",
  milvusUser: "vector-user",
  milvusPassword: "vector-password",
};

test("管理员读取配置槽位会拿到模型显示名，但绝不含连接或凭据", async () => {
  const app = await testApp({ username: "operator", role: "admin", configuration });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/config-status" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        slots: [
          { key: "image", configured: true, model_display_name: "seedream-real-id" },
          { key: "video", configured: true, model_display_name: "seedance-real-id" },
          { key: "llm", configured: true, model_display_name: "ark-llm-id" },
          { key: "vector", configured: true, model_display_name: "doubao-embedding-id" },
        ],
        ai_gateway: { enabled: true },
      },
    });
    assert.doesNotMatch(response.body, /test-key|vector-password|milvus\.example|ARK_API_KEY/i);
  } finally {
    await app.close();
  }
});

test("普通用户只能看到槽位是否可用", async () => {
  const app = await testApp({ username: "artist", role: "member", configuration });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/config-status" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data, {
      slots: [
        { key: "image", configured: true },
        { key: "video", configured: true },
        { key: "llm", configured: true },
        { key: "vector", configured: true },
      ],
      ai_gateway: { enabled: true },
    });
  } finally {
    await app.close();
  }
});

test("AI 网关开关状态对所有登录用户可读（纯布尔,非凭据）", async () => {
  const app = await testApp({
    username: "artist",
    role: "member",
    configuration: { ...configuration, aiGatewayEnabled: false },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/config-status" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data.ai_gateway, { enabled: false });
  } finally {
    await app.close();
  }
});

test("Pi 配齐时优先作为 LLM 槽位；缺少向量任一依赖就标记未配置", async () => {
  const app = await testApp({
    username: "operator",
    role: "admin",
    configuration: {
      ...configuration,
      piRemoteApiUrl: "http://pi.internal:8080",
      piRemoteApiToken: "pi-token",
      piRemoteModel: "pi-runtime-model",
      milvusPassword: undefined,
    },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/config-status" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data.slots, [
      { key: "image", configured: true, model_display_name: "seedream-real-id" },
      { key: "video", configured: true, model_display_name: "seedance-real-id" },
      { key: "llm", configured: true, model_display_name: "pi-runtime-model" },
      { key: "vector", configured: false, model_display_name: null },
    ]);
  } finally {
    await app.close();
  }
});

test("只配 DOUBAO_LLM_MODEL 的部署，LLM 槽位要跟运行时一样判为已配置", async () => {
  // 运行时（arkClient / assistant / ai service）读的是 arkLlmModel ?? doubaoLlmModel，
  // 测试环境正是只有 DOUBAO_LLM_MODEL 的情况，状态接口不能报 configured: false。
  const app = await testApp({
    username: "operator",
    role: "admin",
    configuration: { ...configuration, arkLlmModel: undefined, doubaoLlmModel: "doubao-llm-id" },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/config-status" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().data.slots.find((slot: { key: string }) => slot.key === "llm"),
      { key: "llm", configured: true, model_display_name: "doubao-llm-id" },
    );
  } finally {
    await app.close();
  }
});

test("两个模型都配时以 arkLlmModel 为准；两个都缺则 LLM 槽位未配置", async () => {
  const bothApp = await testApp({
    username: "operator",
    role: "admin",
    configuration: { ...configuration, doubaoLlmModel: "doubao-llm-id" },
  });
  try {
    const response = await bothApp.inject({ method: "GET", url: "/api/v1/admin/config-status" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().data.slots.find((slot: { key: string }) => slot.key === "llm"),
      { key: "llm", configured: true, model_display_name: "ark-llm-id" },
    );
  } finally {
    await bothApp.close();
  }

  const neitherApp = await testApp({
    username: "operator",
    role: "admin",
    configuration: { ...configuration, arkLlmModel: undefined, doubaoLlmModel: undefined },
  });
  try {
    const response = await neitherApp.inject({ method: "GET", url: "/api/v1/admin/config-status" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().data.slots.find((slot: { key: string }) => slot.key === "llm"),
      { key: "llm", configured: false, model_display_name: null },
    );
  } finally {
    await neitherApp.close();
  }
});

test("未登录不泄露配置状态", async () => {
  const app = Fastify({ logger: false });
  await registerConfigStatusRoutes(app, { configuration, adminUsernames: ["operator"] });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/config-status" });
    assert.equal(response.statusCode, 401, response.body);
  } finally {
    await app.close();
  }
});

async function testApp(input: {
  username: string;
  role: "admin" | "operator" | "member";
  configuration: NonNullable<RegisterConfigStatusRoutesOptions["configuration"]>;
}) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = {
      id: "user-id",
      username: input.username,
      displayName: input.username,
      role: input.role,
    };
  });
  await registerConfigStatusRoutes(app, {
    configuration: input.configuration,
    adminUsernames: ["operator"],
  });
  return app;
}
