/* capability-tiers 纯逻辑单测（合同 §2 形状 / §4 前端行为 / 裁决 4 降级退役） */
import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "./api";
import {
  DEMO_IMAGE_TIERS,
  FALLBACK_IMAGE_TIER,
  FALLBACK_VIDEO_TIER,
  TIER_UNCONFIGURED_CODE,
  TIER_UNCONFIGURED_MESSAGE,
  activeTiers,
  demoEstimatePoints,
  listCapabilityTiers,
  resolveProjectDefaultTier,
  resolveSelectedTier,
  tierLabel,
  tierPriceLabel,
  tierSubmitInput,
  type CapabilityTier,
} from "./capability-tiers";
import { listGenerationDimensions } from "./generation-dimensions";

function tier(overrides: Partial<CapabilityTier>): CapabilityTier {
  return {
    tier_id: "t1",
    model_label: "测试模型",
    display_name: "测试模型",
    provider_label: "火山方舟",
    media_type: "image",
    params: { aspect_ratio: "1:1", resolution: "2K", quantity: 1 },
    price: { unit: "per_image", points: 60 },
    status: "active",
    ...overrides,
  };
}

test("初始档=合同附表已登记两档：图片 16:9·2K·1 张·60 积分/张；视频 9:16·720p·4 秒·80 积分/秒", () => {
  assert.equal(tierLabel(FALLBACK_IMAGE_TIER), "16:9 · 2K · 1 张 · 60 积分/张");
  assert.equal(tierLabel(FALLBACK_VIDEO_TIER), "9:16 · 720p · 4 秒 · 80 积分/秒");
  assert.equal(FALLBACK_IMAGE_TIER.tier_id, "img-seedream5pro-169-2k-1");
  assert.equal(FALLBACK_VIDEO_TIER.tier_id, "vid-seedance20fast-916-720p-4s");
  assert.equal(FALLBACK_IMAGE_TIER.status, "active");
  assert.equal(FALLBACK_VIDEO_TIER.status, "active");
});

test("tierLabel：档价随档渲染（接口有 price 即带价签,合同 §4 固定标签口径）", () => {
  assert.equal(tierLabel(tier({ params: { aspect_ratio: "9:16", resolution: "2K", quantity: 4 } })), "9:16 · 2K · 4 张 · 60 积分/张");
  assert.equal(tierLabel(tier({ media_type: "video", params: { aspect_ratio: "16:9", resolution: "1080p", duration_seconds: 12 }, price: { unit: "per_second", points: 80 } })), "16:9 · 1080p · 12 秒 · 80 积分/秒");
});

/* S66 验收补：视频档缺 duration_seconds 时不得渲染「0 秒」（R59 的「0 秒」bug 本体守在这里；
   变异验证证实此前全量无一条断言覆盖 tierLabel 的时长分支，节点卡改对了确认卡仍可能复发）。 */
test("tierLabel：视频档缺/非法 duration_seconds 时省略时长段,不出现「0 秒」", () => {
  const noDuration = tier({ media_type: "video", params: { aspect_ratio: "16:9", resolution: "720p" }, price: { unit: "per_second", points: 80 } });
  assert.equal(tierLabel(noDuration), "16:9 · 720p · 80 积分/秒");
  assert.ok(!tierLabel(noDuration).includes("0 秒"));
  const zeroDuration = tier({ media_type: "video", params: { aspect_ratio: "16:9", resolution: "720p", duration_seconds: 0 }, price: { unit: "per_second", points: 80 } });
  assert.ok(!tierLabel(zeroDuration).includes("秒 ·"), "0 秒不得成段");
});

test("tierPriceLabel：档价缺失（0/负）不显示,不虚构价格", () => {
  assert.equal(tierPriceLabel(tier({ price: { unit: "per_image", points: 0 } })), "");
  assert.equal(tierPriceLabel(tier({ price: { unit: "per_image", points: -3 } })), "");
  assert.equal(tierLabel(tier({ price: { unit: "per_image", points: 0 } })), "1:1 · 2K · 1 张");
});

test("activeTiers：experimental/retired 不上界面", () => {
  const tiers = [
    tier({ tier_id: "a", status: "active" }),
    tier({ tier_id: "b", status: "experimental" }),
    tier({ tier_id: "c", status: "retired" }),
  ];
  assert.deepEqual(activeTiers(tiers).map((item) => item.tier_id), ["a"]);
});

test("resolveSelectedTier：命中按 id；缺省/找不到回落首个 active；空档 null", () => {
  const tiers = [tier({ tier_id: "a" }), tier({ tier_id: "b", status: "active" }), tier({ tier_id: "c", status: "retired" })];
  assert.equal(resolveSelectedTier(tiers, "b")?.tier_id, "b");
  assert.equal(resolveSelectedTier(tiers, null)?.tier_id, "a");
  assert.equal(resolveSelectedTier(tiers, "c")?.tier_id, "a", "retired 档不可选,回落首个 active");
  assert.equal(resolveSelectedTier([], null), null);
});

test("tierSubmitInput：档→提交参数映射（图片 ratio/size+张数；视频 ratio/resolution/时长）", () => {
  assert.deepEqual(tierSubmitInput(FALLBACK_IMAGE_TIER), {
    parameters: { ratio: "16:9", size: "2K" },
    quantity: 1,
  });
  assert.deepEqual(tierSubmitInput(FALLBACK_VIDEO_TIER), {
    parameters: { ratio: "9:16", resolution: "720p", duration_seconds: 4 },
    quantity: 1,
  });
  assert.deepEqual(tierSubmitInput(tier({
    tier_id: "img-gptimage2-916-1",
    params: { aspect_ratio: "9:16", quantity: 1 },
  })), {
    parameters: { ratio: "9:16" },
    quantity: 1,
  }, "档位未声明清晰度时不得偷补 2K");
  assert.equal(tierLabel(tier({
    tier_id: "img-gptimage2-916-1",
    params: { aspect_ratio: "9:16", quantity: 1 },
  })), "9:16 · 1 张 · 60 积分/张");
});

/* ---------- 裁决 4：404/501 降级退役,空数组=「档位未配置」,demo 仍走 fixture ---------- */

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

async function withMockBrowser(
  responses: Array<{ body: unknown; status?: number }>,
  run: (requests: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  const storage = new Map<string, string>();
  const items: CapturedRequest[] = [];
  let call = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
  });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    items.push({ url: String(input), init });
    const next = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await run(items);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

const liveTierRow = {
  tier_id: "img-seedream5pro-169-2k-1",
  media_type: "image",
  display_name: "Seedream 5 Pro",
  provider_label: "火山方舟",
  model_label: "Seedream 5 Pro",
  is_default: true,
  availability: "available",
  params: { aspect_ratio: "16:9", resolution: "2K", quantity: 1 },
  price: { unit: "per_image", points: 60 },
  status: "active",
};

test("listCapabilityTiers：真栈走接口并归一（experimental 行保留,activeTiers 再过滤）", async () => {
  await withMockBrowser([
    { body: { ok: true, data: { tiers: [liveTierRow, { ...liveTierRow, tier_id: "exp-1", status: "experimental" }] } } },
  ], async (requests) => {
    const result = await listCapabilityTiers("image", false);
    assert.equal(result.fallback, false);
    assert.deepEqual(result.tiers.map((item) => item.tier_id), ["img-seedream5pro-169-2k-1", "exp-1"]);
    assert.equal(tierLabel(result.tiers[0]!), "16:9 · 2K · 1 张 · 60 积分/张");
    assert.equal(requests[0]?.url, "/api/v1/generation/capability-tiers?media_type=image");
  });
});

test("裁决 4：404/501 不再静默回落本地档——错误原样抛出交页面错误态", async () => {
  for (const status of [404, 501]) {
    await withMockBrowser([
      { body: { ok: false, error: { code: "not_found", message: "不存在" } }, status },
    ], async () => {
      await assert.rejects(listCapabilityTiers("image", false), (reason: unknown) => {
        assert.ok(reason instanceof ApiClientError);
        assert.equal(reason.status, status);
        return true;
      });
    });
  }
});

test("裁决 4：接口返回空数组=「档位未配置」错误（报 Sol）,不静默用本地档", async () => {
  await withMockBrowser([
    { body: { ok: true, data: { tiers: [] } } },
  ], async () => {
    await assert.rejects(listCapabilityTiers("video", false), (reason: unknown) => {
      assert.ok(reason instanceof ApiClientError);
      assert.equal(reason.code, TIER_UNCONFIGURED_CODE);
      assert.equal(reason.message, TIER_UNCONFIGURED_MESSAGE);
      return true;
    });
  });
  // 行全脏（字段缺失整行丢弃）同样按未配置处理
  await withMockBrowser([
    { body: { ok: true, data: { tiers: [{ tier_id: "" }, "garbage"] } } },
  ], async () => {
    await assert.rejects(listCapabilityTiers("image", false), (reason: unknown) => {
      assert.ok(reason instanceof ApiClientError && reason.code === TIER_UNCONFIGURED_CODE);
      return true;
    });
  });
});

test("listCapabilityTiers：demo 模式走本地 fixture（图片=S83 多档,视频=初始档;不调接口,不打降级标）", async () => {
  await withMockBrowser([], async (requests) => {
    const image = await listCapabilityTiers("image", true);
    assert.equal(image.fallback, true);
    assert.deepEqual(image.tiers, DEMO_IMAGE_TIERS);
    assert.equal(image.tiers[0], FALLBACK_IMAGE_TIER, "demo 缺省选中口径:首档仍是合同初始档");
    const video = await listCapabilityTiers("video", true);
    assert.deepEqual(video.tiers, [FALLBACK_VIDEO_TIER]);
    assert.equal(requests.length, 0, "demo 模式不应发起任何请求");
  });
});

/* ---------- S83(V-36) → S83b：demo 图片多档 fixture 守卫 + demo 估价随档 ----------
   DC 判决 V-36 的根因是 demo 单档 → 维度全 single → 参数 popover 只剩固定标签。
   S83b（验收 R2）：档表只允许用 dev 库 pricing_rules 真实已登记档（真 tier_id 真价）,
   6 条真档（3 比例 × 1K 30 / 2K 60）缺省不放 1:1·1K,用真档留缺口演示置灰。
   以下守卫防 fixture 被缩回单档、被补成叉乘满档,或再次混入库外编造档。 */

/* dev 库 pricing_rules 真实登记档（合同 v0.3.0 附表 + scripts/seed-pricing-tiers.mts）：
   tier_id → 积分/张。守卫口径=demo 档表的每一档都必须在这张表里且价一致。 */
const REGISTERED_IMAGE_TIERS: ReadonlyMap<string, number> = new Map([
  ["img-seedream5pro-169-2k-1", 60],
  ["img-seedream5pro-916-2k-1", 60],
  ["img-seedream5pro-11-2k-1", 60],
  ["img-seedream5pro-169-1k-1", 30],
  ["img-seedream5pro-916-1k-1", 30],
  ["img-seedream5pro-11-1k-1", 30],
]);

test("S83 demo 图片档表：首档=合同初始档,5 档全部取自库里真实登记档(S83b:不造库外档、不自定价)", () => {
  assert.equal(DEMO_IMAGE_TIERS[0], FALLBACK_IMAGE_TIER, "缺省选中口径:首档必须仍是初始档");
  assert.equal(DEMO_IMAGE_TIERS.length, 5, "6 条真档缺省不放 1:1·1K(留查无组合缺口)");
  assert.ok(DEMO_IMAGE_TIERS.every((tier) => tier.status === "active"), "demo 档表不得混入非 active 档");
  assert.ok(DEMO_IMAGE_TIERS.every((tier) => tier.model_label === FALLBACK_IMAGE_TIER.model_label), "demo 档表必须同模型标签(模型行保持单值诚实态)");
  const ids = DEMO_IMAGE_TIERS.map((tier) => tier.tier_id);
  assert.equal(new Set(ids).size, ids.length, "tier_id 不得重复");
  for (const demoTier of DEMO_IMAGE_TIERS) {
    assert.equal(
      REGISTERED_IMAGE_TIERS.get(demoTier.tier_id),
      demoTier.price.points,
      `${demoTier.tier_id} 不在 dev 库已登记档内或价与库不符(S83b:禁止编造档/价)`,
    );
    assert.equal(demoTier.params.quantity, 1, `${demoTier.tier_id}:库里图片档全部 qty=1,不得造多张档`);
  }
});

test("S83 demo 档表驱动维度引擎：比例/清晰度成 chips,数量回单值固定标签;1:1 与 1K 互为缺口置灰", () => {
  const defaultTier = DEMO_IMAGE_TIERS[0]!; // 16:9·2K·1 张
  const byKey = Object.fromEntries(listGenerationDimensions(DEMO_IMAGE_TIERS, "image", defaultTier).map((dimension) => [dimension.key, dimension]));
  assert.equal(byKey.aspect_ratio?.single, false, "比例必须成 chips(V-36:不再是固定标签)");
  assert.equal(byKey.resolution?.single, false, "清晰度必须成 chips(1K/2K 真档)");
  assert.equal(byKey.quantity?.single, true, "库里图片档全部 qty=1 → 数量回到单值固定标签(数据事实)");
  assert.ok(byKey.aspect_ratio?.options.every((option) => option.feasible), "默认档下三个比例都可点");
  assert.deepEqual(
    byKey.resolution?.options.map((option) => [option.value, option.feasible]),
    [["2K", true], ["1K", true]],
    "默认档 16:9 下 2K/1K 都有真档,都可点",
  );
  assert.equal(byKey.model_label?.single, true, "同模型标签 → 模型行仍是固定标签(合同 §4 单值形态)");

  const square = DEMO_IMAGE_TIERS.find((item) => item.params.aspect_ratio === "1:1")!;
  const squareDims = Object.fromEntries(listGenerationDimensions(DEMO_IMAGE_TIERS, "image", square).map((dimension) => [dimension.key, dimension]));
  assert.deepEqual(
    squareDims.resolution?.options.map((option) => [option.value, option.feasible]),
    [["2K", true], ["1K", false]],
    "1:1 缺 1K 真档(缺口是故意少登记的真档,非编造) → 1K 置灰(查无组合不给选)",
  );

  const lowRes = DEMO_IMAGE_TIERS.find((item) => item.params.resolution === "1K")!;
  const lowResDims = Object.fromEntries(listGenerationDimensions(DEMO_IMAGE_TIERS, "image", lowRes).map((dimension) => [dimension.key, dimension]));
  assert.deepEqual(
    lowResDims.aspect_ratio?.options.map((option) => [option.value, option.feasible]),
    [["16:9", true], ["9:16", true], ["1:1", false]],
    "1K 只有 16:9/9:16 → 1:1 置灰",
  );
});

test("S83 demo 估价：随选中档推导——1K 30 / 2K 60 皆库价;同清晰度不同比例不虚构差价", () => {
  const points = new Map(DEMO_IMAGE_TIERS.map((demoTier) => [demoTier.tier_id, demoEstimatePoints(demoTier)]));
  assert.equal(points.get("img-seedream5pro-169-2k-1"), 60);
  assert.equal(points.get("img-seedream5pro-169-1k-1"), 30, "1K 档估价必须不同于 2K(V-36:切档费用变),30 为库价");
  assert.equal(points.get("img-seedream5pro-916-2k-1"), 60, "同 2K·1 张:比例不影响单价,不虚构差价");
  assert.equal(points.get("img-seedream5pro-916-1k-1"), 30);
  assert.ok(new Set(points.values()).size > 1, "档间估价必须有差异");
  assert.equal(demoEstimatePoints(FALLBACK_VIDEO_TIER), 320, "视频口径:档价 × 秒数(80 × 4)");
});

/* ---------- #172：项目设定参与默认选档 ----------
   issue #172 实锤:旧链「上次记忆 → is_default → 首档」完全不读项目画幅/清晰度,
   生成入口又无换档控件,9:16 项目直接出 21:9 横图。修复=项目设定插进缺省链。 */

function imageTier(tierId: string, aspectRatio: string, resolution: string, points: number, extra: Partial<CapabilityTier> = {}): CapabilityTier {
  return tier({
    tier_id: tierId,
    params: { aspect_ratio: aspectRatio, resolution, quantity: 1 },
    price: { unit: "per_image", points },
    ...extra,
  });
}

/* 测试站现状形状(issue 现场):被标 is_default 的是 21:9 档,9:16 两档无标记。 */
const ISSUE172_TIERS: CapabilityTier[] = [
  imageTier("img-seedream5pro-219-1k-1", "21:9", "1K", 25, { is_default: true }),
  imageTier("img-seedream5pro-169-1k-1", "16:9", "1K", 30),
  imageTier("img-seedream5pro-916-1k-1", "9:16", "1K", 30),
  imageTier("img-seedream5pro-916-2k-1", "9:16", "2K", 60),
];

test("#172：项目画幅+清晰度完全匹配 → 默认档=匹配档,不再落到 is_default 的 21:9", () => {
  assert.equal(resolveProjectDefaultTier(ISSUE172_TIERS, { aspectRatio: "9:16", resolution: "1K" })?.tier_id, "img-seedream5pro-916-1k-1");
  assert.equal(resolveProjectDefaultTier(ISSUE172_TIERS, { aspectRatio: "9:16", resolution: "2K" })?.tier_id, "img-seedream5pro-916-2k-1");
});

test("#172：清晰度查无完全匹配 → 保画幅,选同画幅最便宜的可用档", () => {
  assert.equal(
    resolveProjectDefaultTier(ISSUE172_TIERS, { aspectRatio: "9:16", resolution: "4K" })?.tier_id,
    "img-seedream5pro-916-1k-1",
    "9:16 没有 4K 档 → 同画幅里 1K(30) 比 2K(60) 便宜",
  );
});

test("#172：只设画幅 → 同画幅最便宜;只设清晰度 → 该清晰度最便宜(跨画幅)", () => {
  assert.equal(resolveProjectDefaultTier(ISSUE172_TIERS, { aspectRatio: "9:16", resolution: null })?.tier_id, "img-seedream5pro-916-1k-1");
  assert.equal(resolveProjectDefaultTier(ISSUE172_TIERS, { aspectRatio: null, resolution: "1K" })?.tier_id, "img-seedream5pro-219-1k-1", "1K 里最便宜的是 21:9 档(25)");
});

test("#172：完全没设定 / 设定查无可提交档 → null(调用方续走全局缺省链,不伪造匹配)", () => {
  assert.equal(resolveProjectDefaultTier(ISSUE172_TIERS, null), null);
  assert.equal(resolveProjectDefaultTier(ISSUE172_TIERS, { aspectRatio: null, resolution: null }), null);
  assert.equal(resolveProjectDefaultTier(ISSUE172_TIERS, { aspectRatio: "4:3", resolution: "1K" }), null, "画幅查无档 → null,不跨画幅乱选");
  assert.equal(resolveProjectDefaultTier([], { aspectRatio: "9:16", resolution: "1K" }), null);
});

test("#172：冻结/非 active 档不算可用档——精确匹配全不可提交时保画幅取可提交档", () => {
  const tiers = [
    imageTier("img-916-1k-frozen", "9:16", "1K", 10, { availability: "frozen", availability_reason: "该档未开通" }),
    imageTier("img-916-1k-experimental", "9:16", "1K", 5, { status: "experimental" }),
    imageTier("img-916-2k", "9:16", "2K", 60),
  ];
  assert.equal(resolveProjectDefaultTier(tiers, { aspectRatio: "9:16", resolution: "1K" })?.tier_id, "img-916-2k");
});

test("#172：完全匹配多档取最便宜;同价并列按 tier_id 字典序(确定性)", () => {
  const tiers = [
    imageTier("img-916-1k-pro", "9:16", "1K", 45),
    imageTier("img-916-1k-b", "9:16", "1K", 30),
    imageTier("img-916-1k-a", "9:16", "1K", 30),
  ];
  assert.equal(resolveProjectDefaultTier(tiers, { aspectRatio: "9:16", resolution: "1K" })?.tier_id, "img-916-1k-a");
});

test("#172：resolveSelectedTier 链位——显式选中 > 项目设定 > is_default > 首档;不传偏好行为不变", () => {
  const preference = { aspectRatio: "9:16", resolution: "1K" };
  assert.equal(resolveSelectedTier(ISSUE172_TIERS, null, preference)?.tier_id, "img-seedream5pro-916-1k-1", "项目设定优先于 is_default 的 21:9 档");
  assert.equal(resolveSelectedTier(ISSUE172_TIERS, "img-seedream5pro-169-1k-1", preference)?.tier_id, "img-seedream5pro-169-1k-1", "显式选中(会话记忆)仍最优先");
  assert.equal(resolveSelectedTier(ISSUE172_TIERS, null, { aspectRatio: "4:3", resolution: null })?.tier_id, "img-seedream5pro-219-1k-1", "项目设定查无档 → 回落 is_default");
  assert.equal(resolveSelectedTier(ISSUE172_TIERS, null)?.tier_id, "img-seedream5pro-219-1k-1", "不传偏好 = 旧链不变(项目没设定同此)");
});
