import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../../db/client.js";
import type { AuthenticatedUser } from "../../../http/authenticate.js";
import type { AdminModelServicePort } from "./service.js";
import { registerAdminModelRoutes } from "./routes.js";
import type { AdminModelView, PricingRuleRecord, ReplacePricingRuleInput } from "./types.js";

const admin: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "model.admin",
  displayName: "模型管理员",
  role: "admin",
};
const regular: AuthenticatedUser = {
  id: "22222222-2222-4222-8222-222222222222",
  username: "regular.user",
  displayName: "普通用户",
  role: "member",
};
const oldPrice = price({
  id: "33333333-3333-4333-8333-333333333333",
  unitPriceFen: 60,
  active: false,
  effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
  effectiveTo: new Date("2026-07-20T00:00:00.000Z"),
});
const currentPrice = price({
  id: "44444444-4444-4444-8444-444444444444",
  unitPriceFen: 70,
  active: true,
  effectiveFrom: new Date("2026-07-20T00:00:00.000Z"),
  effectiveTo: null,
});

test("GET /api/v1/admin/models 返回能力配置状态和当前价", async () => {
  const model: AdminModelView = {
    id: "seedream-5-pro",
    displayName: "Seedream 5 Pro",
    mediaKind: "image",
    configurationStatus: "configured",
    providerId: "ark",
    actualModelId: "seedream-model-id",
    currentPrice,
  };
  const { app } = await createTestApp(admin, service({ models: [model] }));
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/models" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        count: 1,
        items: [{
          id: "seedream-5-pro",
          display_name: "Seedream 5 Pro",
          media_kind: "image",
          configuration_status: "configured",
          provider_id: "ark",
          actual_model_id: "seedream-model-id",
          current_price: priceJson(currentPrice),
        }],
      },
    });
  } finally {
    await app.close();
  }
});

test("GET /api/v1/admin/pricing-rules 返回当前和历史价格", async () => {
  const calls: Array<{ page: number; pageSize: number }> = [];
  const { app } = await createTestApp(admin, service({
    prices: [currentPrice, oldPrice],
    priceTotal: 2,
    onListPrices: async (page, pageSize) => {
      calls.push({ page, pageSize });
      return { items: [oldPrice], total: 2 };
    },
  }));
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/pricing-rules?page=2&page_size=1",
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.data.count, 2);
    assert.equal(body.data.page, 2);
    assert.equal(body.data.page_size, 1);
    assert.equal(body.data.has_more, false);
    assert.deepEqual(calls, [{ page: 2, pageSize: 1 }]);
    assert.deepEqual(body.data.items.map((item: Record<string, unknown>) => ({
      id: item.id,
      unit_price_fen: item.unit_price_fen,
      active: item.active,
    })), [
      { id: oldPrice.id, unit_price_fen: 60, active: false },
    ]);
  } finally {
    await app.close();
  }
});

test("POST /api/v1/admin/pricing-rules 以管理员身份追加新价格", async () => {
  const calls: Array<{ actorId: string; input: ReplacePricingRuleInput }> = [];
  const fake = service({
    onReplace: async (actorId, input) => {
      calls.push({ actorId, input });
      return currentPrice;
    },
  });
  const { app } = await createTestApp(admin, fake);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pricing-rules",
      payload: {
        provider: "ark",
        model: "seedream-model-id",
        media_kind: "image",
        billing_unit: "image",
        unit_price_fen: 70,
        currency: "CNY",
        expected_active_rule_id: currentPrice.id,
        source: "采购价目表",
        metadata: { approval_ref: "PRICE-7" },
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().data.item.unit_price_fen, 70);
    assert.deepEqual(calls, [{
      actorId: admin.id,
      input: {
        provider: "ark",
        model: "seedream-model-id",
        mediaKind: "image",
        billingUnit: "image",
        unitPriceFen: 70,
        currency: "CNY",
        expectedActiveRuleId: currentPrice.id,
        source: "采购价目表",
        metadata: { approval_ref: "PRICE-7" },
      },
    }]);
  } finally {
    await app.close();
  }
});

test("三个管理端点都拒绝未登录和非管理员，且不会初始化数据库", async () => {
  for (const request of [
    { method: "GET", url: "/api/v1/admin/models" },
    { method: "GET", url: "/api/v1/admin/pricing-rules" },
    {
      method: "POST",
      url: "/api/v1/admin/pricing-rules",
      payload: {
        provider: "ark",
        model: "seedream-model-id",
        media_kind: "image",
        billing_unit: "image",
        unit_price_fen: 70,
      },
    },
  ] as const) {
    for (const [user, expectedStatus] of [[undefined, 401], [regular, 403]] as const) {
      const { app } = await createTestApp(user, service(), true);
      try {
        const response = await app.inject(request);
        assert.equal(response.statusCode, expectedStatus, `${request.method} ${request.url}: ${response.body}`);
      } finally {
        await app.close();
      }
    }
  }
});

test("POST /api/v1/admin/pricing-rules 拒绝媒体类型不匹配的计费单位", async () => {
  const { app } = await createTestApp(admin, service());
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pricing-rules",
      payload: {
        provider: "ark",
        model: "seedance-model-id",
        media_kind: "video",
        billing_unit: "image",
        unit_price_fen: 80,
        expected_active_rule_id: null,
      },
    });
    assert.equal(response.statusCode, 400, response.body);
  } finally {
    await app.close();
  }
});

test("POST /api/v1/admin/pricing-rules 拒绝排期生效、非 CNY 和不安全视频价", async () => {
  const { app } = await createTestApp(admin, service());
  try {
    const invalidPayloads = [
      {
        provider: "ark",
        model: "seedream-model-id",
        media_kind: "image",
        billing_unit: "image",
        unit_price_fen: 70,
        currency: "CNY",
        expected_active_rule_id: null,
        effective_from: "2026-07-22T00:00:00.000Z",
      },
      {
        provider: "ark",
        model: "seedream-model-id",
        media_kind: "image",
        billing_unit: "image",
        unit_price_fen: 70,
        currency: "USD",
        expected_active_rule_id: null,
      },
      {
        provider: "ark",
        model: "seedance-model-id",
        media_kind: "video",
        billing_unit: "second",
        unit_price_fen: 79,
        currency: "CNY",
        expected_active_rule_id: null,
      },
    ];
    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/pricing-rules",
        payload,
      });
      assert.equal(response.statusCode, 400, response.body);
    }
  } finally {
    await app.close();
  }
});

test("POST /api/v1/admin/pricing-rules 拒绝绕过受控脚本写能力档", async () => {
  const calls: ReplacePricingRuleInput[] = [];
  const { app } = await createTestApp(admin, service({
    onReplace: async (_actorId, input) => {
      calls.push(input);
      return currentPrice;
    },
  }));
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pricing-rules",
      payload: {
        provider: "ark",
        model: "doubao-seedance-2-0-mini-260615",
        media_kind: "video",
        billing_unit: "second",
        unit_price_fen: 50,
        currency: "CNY",
        expected_active_rule_id: null,
        metadata: {
          price_source_kind: "待核",
          activation_scope: "dev_smoke_only",
          capability_tier: {
            tier_id: "vid-seedance20mini-916-720p",
            params: {
              aspect_ratio: "9:16",
              resolution: "720p",
              duration_seconds: 4,
              watermark: false,
              quantity: 1,
            },
            status: "active",
          },
        },
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /能力档只能使用受控解冻脚本/);
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

async function createTestApp(
  user: AuthenticatedUser | undefined,
  fakeService: AdminModelServicePort,
  databaseMustStayUntouched = false,
) {
  const app = Fastify({ logger: false });
  if (user) {
    app.addHook("preHandler", async (request) => {
      request.authUser = user;
    });
  }
  await registerAdminModelRoutes(
    app,
    () => {
      if (databaseMustStayUntouched) throw new Error("鉴权失败时不应访问数据库");
      return {} as Database;
    },
    {
      adminUsernames: [admin.username],
      createService: () => fakeService,
    },
  );
  return { app };
}

function service(options: {
  models?: AdminModelView[];
  prices?: PricingRuleRecord[];
  priceTotal?: number;
  onListPrices?: (page: number, pageSize: number) => Promise<{ items: PricingRuleRecord[]; total: number }>;
  onReplace?: (actorId: string, input: ReplacePricingRuleInput) => Promise<PricingRuleRecord>;
} = {}): AdminModelServicePort {
  return {
    listModels: async () => options.models ?? [],
    listPricingRules: options.onListPrices ?? (async () => ({
      items: options.prices ?? [],
      total: options.priceTotal ?? options.prices?.length ?? 0,
    })),
    replacePricingRule: options.onReplace ?? (async () => currentPrice),
  };
}

function price(overrides: Partial<PricingRuleRecord> = {}): PricingRuleRecord {
  const effectiveFrom = overrides.effectiveFrom ?? new Date("2026-07-20T00:00:00.000Z");
  return {
    id: "44444444-4444-4444-8444-444444444444",
    provider: "ark",
    model: "seedream-model-id",
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 70,
    currency: "CNY",
    source: "采购价目表",
    active: true,
    effectiveFrom,
    effectiveTo: null,
    metadata: { approval_ref: "PRICE-7" },
    createdAt: effectiveFrom,
    updatedAt: effectiveFrom,
    ...overrides,
  };
}

function priceJson(item: PricingRuleRecord) {
  return {
    id: item.id,
    provider: item.provider,
    model: item.model,
    media_kind: item.mediaKind,
    billing_unit: item.billingUnit,
    unit_price_fen: item.unitPriceFen,
    currency: item.currency,
    source: item.source,
    active: item.active,
    effective_from: item.effectiveFrom.toISOString(),
    effective_to: item.effectiveTo?.toISOString() ?? null,
    metadata: item.metadata,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
}
