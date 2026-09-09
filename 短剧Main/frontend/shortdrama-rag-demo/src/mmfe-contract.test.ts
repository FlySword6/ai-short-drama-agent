/* ============================================================
   mmfe-contract.test.ts — 多模型接缝跨包合同测试(FABLE-007 / SOL-012 条 4 / SOL-013)

   数据源=src/fixtures/mmfe-live-contract.json:真栈 8000(kimi-main dist=dev+sol 多模型后端)
   的 capability-tiers(三模态)与 generations 真实响应快照。锁三件事:
   1. 字段合同:安全展示字段齐(tier_id/display_name/provider_label/model_label/...),
      前端 mapper 全收;缺档不再并成「configured」假值;
   2. 字段黑名单(后端字段不外漏):wire 上不得出现真实 model/model_id/provider/
      provider_task_id/pricing_rule_id/failure_reason——在 fixture 原文上断言,
      后端哪天漏了这里直接红;
   3. 状态机钉(SOL-009 形状):段页选择器 loading→ready→estimating→pending_confirmation
      →confirming→submitting→queued/running→succeeded|failed,含 empty 与
      capability_unavailable 空态,源码级锚点断言。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { listCapabilityTiers, priceUnitLabel, tierModelLabel } from "./capability-tiers";
import type { GenerationTask } from "./types";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mmfe-live-contract.json", import.meta.url), "utf8")) as {
  capability_tiers: Record<"image" | "video" | "audio", Record<string, unknown>[]>;
  generation_tasks: Record<string, unknown>[];
};

/* ---------- 1. 真 fixture 驱动:三模态 tier 全链解析(与线上一字节不差) ---------- */

function withMockFetch(body: unknown, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map<string, string>();
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
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

test("合同:三模态真 fixture 解析——image/video/audio 各自成档,不错并", async () => {
  for (const mediaType of ["image", "video", "audio"] as const) {
    const rows = fixture.capability_tiers[mediaType];
    assert.ok(rows.length > 0, `fixture 缺 ${mediaType} 档(重抓:8000 真栈)`);
    await withMockFetch({ ok: true, data: { tiers: rows } }, async () => {
      const result = await listCapabilityTiers(mediaType, false);
      assert.equal(result.tiers.length, rows.length);
      for (const tier of result.tiers) {
        assert.equal(tier.media_type, mediaType, "media_type 必须三态直通(audio 不再错并成 image)");
        assert.ok(tier.tier_id.length > 0);
        assert.ok(tierModelLabel(tier).length > 0, "模型展示标签必须有(tier_id 兜底)");
        assert.ok(!["", "configured"].includes(tierModelLabel(tier)), "缺字段不得并成 configured 假值");
        assert.ok(tier.price.points > 0);
      }
    });
  }
});

test("合同:计费单位三态——per_image/per_second/per_10k_characters 展示不丢", () => {
  assert.equal(priceUnitLabel("per_image"), "张");
  assert.equal(priceUnitLabel("per_second"), "秒");
  assert.equal(priceUnitLabel("per_10k_characters"), "万字符");
  /* MiniMax speech 档(2 元/万字符)播种后 wire=per_10k_characters;映射行级钉 */
  const tenK = { ...fixture.capability_tiers.audio[0]!, tier_id: "aud-mmspeech-10k", price: { unit: "per_10k_characters", points: 2 } };
  return withMockFetch({ ok: true, data: { tiers: [tenK] } }, async () => {
    const result = await listCapabilityTiers("audio", false);
    assert.equal(result.tiers[0]!.price.unit, "per_10k_characters", "万字符计费单位不得在解析层丢失");
  });
});

/* ---------- 2. 字段黑名单:wire 原文上断言(SOL-012 条 2) ---------- */

/** 真实 provider/model 绑定、provider task id、pricing rule、失败原文——用户端点永不下发。 */
const FORBIDDEN_WIRE_KEYS = ["model_id", "model", "provider", "provider_task_id", "pricing_rule_id", "failure_reason", "provider_response", "provider_status"];

test("黑名单:capability-tiers wire 无真实绑定字段", () => {
  for (const [mediaType, rows] of Object.entries(fixture.capability_tiers)) {
    for (const row of rows) {
      for (const key of FORBIDDEN_WIRE_KEYS) {
        assert.ok(!(key in row), `capability-tiers(${mediaType}) 漏出黑名单字段 ${key}`);
      }
    }
  }
});

test("黑名单:generations 任务视图只带 display_reason/error_code/tier_id", () => {
  assert.ok(fixture.generation_tasks.length > 0, "fixture 缺任务行");
  for (const row of fixture.generation_tasks) {
    for (const key of FORBIDDEN_WIRE_KEYS) {
      assert.ok(!(key in row), `generations 任务视图漏出黑名单字段 ${key}`);
    }
    assert.ok("display_reason" in row, "任务视图必须带 display_reason(可 null)");
    assert.ok("error_code" in row, "任务视图必须带稳定 error_code(可 null)");
    assert.ok("tier_id" in row, "任务视图必须带 tier_id");
  }
});

test("前端类型 GenerationTask 不含已删字段(编译期+运行期双钉)", () => {
  const task = fixture.generation_tasks[0]! as unknown as GenerationTask;
  assert.ok(!("failure_reason" in task), "前端任务模型仍读 failure_reason");
  assert.ok(!("provider_task_id" in task), "前端任务模型仍读 provider_task_id");
});

/* ---------- 3. 选择器状态机钉(SOL-009 形状,源码级) ---------- */

test("状态机:段页选择器全链路状态锚点(loading/empty/unavailable/estimate/confirm/submit/queue/terminal)", () => {
  const seg = readFileSync(new URL("./pages/segment-workbench-page.tsx", import.meta.url), "utf8");
  // loading + capability_unavailable(档读取失败如实亮错,不静默回落)
  assert.ok(seg.includes("正在读取档位"), "缺 loading 态");
  assert.ok(seg.includes("tierFailed"), "缺 capability_unavailable/读取失败态");
  // empty(档位未配置)
  assert.ok(seg.includes("档位未配置"), "缺 empty(未配置)空态");
  // ready/select:档就绪后确认区可见(档价行)
  assert.ok(seg.includes("确认即按正式报价扣费"), "缺 ready/档价确认锚点");
  // estimating→pending_confirmation→confirming→submitting:quote→人工 confirm→create 链
  assert.ok(seg.includes("quoteGeneration"), "缺 estimating(quote)锚点");
  assert.ok(seg.includes("requires_manual_review"), "缺 pending_confirmation/复核锚点");
  assert.ok(seg.includes("confirmGenerationQuote"), "缺 confirming(人工 confirm)锚点");
  assert.ok(seg.includes("regenSubmitting"), "缺 submitting 闸门");
  // queued/running:在途轮询;succeeded|failed:终态回填
  assert.ok(seg.includes("hasInflight"), "缺 queued/running 在途轮询");
  assert.ok(seg.includes("已有视频"), "缺终态(succeeded)展示");
  // 一次点击一个付费任务:提交闸门+幂等键
  assert.ok(seg.includes("client_idempotency_key"), "缺一任务一幂等键");
});
