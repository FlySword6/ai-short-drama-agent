/* ============================================================
   auth-pilot-p0.test.ts — issue #26 / #67 内部试点开门前端验收断言

   判据（goal 单）：
   ① 六个稳定错误码逐个有中文界面提示，不露英文错误串/HTTP 状态码：
      invite_code_required / invite_code_invalid / email_delivery_unavailable
      → 注册表单映射（register-form.tsx）；
      account_credit_insufficient / account_credit_daily_limit_exceeded /
      account_credit_unavailable → 生成链失败文案（error-copy.ts generationFailureCopy）；
   ② 登录 wire 合同：邮箱形标识发 email 键，遗留账号名发 username 键（#26 后端同一查找）；
   ③ 登录后可见余额/日额度/当日剩余：账户菜单行三数同见，rail 快览带 hover 明细。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiClientError, api } from "./api";
import { generationFailureCopy } from "./error-copy";
import { registerErrorMessage, sendCodeErrorMessage } from "./pages/register-form";
import { AccountCreditsMenuRow } from "./components/credits-pill";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/* ---------- 轻量 fetch mock（与 s11-fixes 同款捕获模式） ---------- */
interface CapturedRequest { url: string; init: RequestInit }
async function withMockFetch(
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

/* ---------- ① 六个稳定错误码逐个有中文提示 ---------- */

function assertPlainChinese(code: string, message: string): void {
  assert.ok(/[一-鿿]/.test(message), `「${code}」提示必须是中文：${message}`);
  assert.ok(!message.includes(code), `「${code}」不得裸露错误码本身：${message}`);
  assert.ok(!/\b(422|503|HTTP)\b/.test(message), `「${code}」不得裸露 HTTP 状态码：${message}`);
  assert.ok(!/[a-zA-Z]{4,}/.test(message.replace(/HTTP/g, "")), `「${code}」不得夹英文串：${message}`);
}

test("#67 六码：注册侧三码（invite_code_required/invite_code_invalid/email_delivery_unavailable）", () => {
  assertPlainChinese("invite_code_required", registerErrorMessage(new ApiClientError("x", { status: 422, code: "invite_code_required" })));
  assertPlainChinese("invite_code_invalid", registerErrorMessage(new ApiClientError("x", { status: 422, code: "invite_code_invalid" })));
  assertPlainChinese("email_delivery_unavailable", sendCodeErrorMessage(new ApiClientError("x", { status: 503, code: "email_delivery_unavailable" })));
});

test("#67 六码：生成侧三码（account_credit_insufficient/daily_limit_exceeded/unavailable）", () => {
  const insufficient = generationFailureCopy(new ApiClientError("x", { status: 422, code: "account_credit_insufficient" }), { costPoints: 1200, balancePoints: 800 });
  assertPlainChinese("account_credit_insufficient", insufficient);
  assert.ok(insufficient.includes("1200") && insufficient.includes("800") && insufficient.includes("400"), "余额不足要带数：需要/余额/还差");
  assert.ok(insufficient.includes("联系管理员调账"), "去向只有联系管理员调账");
  assert.ok(!insufficient.includes("充值") && !insufficient.includes("兑换邀请码"), "不得再指充值/兑换邀请码的错方向");
  assertPlainChinese("account_credit_insufficient", generationFailureCopy(new ApiClientError("x", { status: 422, code: "account_credit_insufficient" })));
  assertPlainChinese("account_credit_daily_limit_exceeded", generationFailureCopy(new ApiClientError("x", { status: 422, code: "account_credit_daily_limit_exceeded" })));
  assertPlainChinese("account_credit_unavailable", generationFailureCopy(new ApiClientError("x", { status: 503, code: "account_credit_unavailable" })));
});

/* ---------- ② 登录 wire 合同：email / username 键分流 ---------- */

test("#67 登录：邮箱形标识发 email 键，遗留账号名发 username 键", async () => {
  const payload = { data: { token: "t", expires_at: "2027-01-01T00:00:00Z", user: { id: "u", username: "kimi", display_name: "Kimi" } } };
  await withMockFetch([{ body: payload }], async (requests) => {
    await api.login("kimi@example.test", "pw");
    const body = JSON.parse(String(requests[0]!.init.body));
    assert.equal(body.email, "kimi@example.test", "邮箱应走 email 键");
    assert.ok(!("username" in body), "邮箱登录不应带 username 键");
  });
  await withMockFetch([{ body: payload }], async (requests) => {
    await api.login("admin", "pw");
    const body = JSON.parse(String(requests[0]!.init.body));
    assert.equal(body.username, "admin", "遗留账号名应走 username 键");
    assert.ok(!("email" in body), "账号名登录不应带 email 键");
  });
});

/* ---------- ③ 登录后可见余额/日额度/当日剩余 ---------- */

test("#67 账户菜单行：余额 + 今日剩余/日额度三数同见（全宽度）", () => {
  const html = renderToStaticMarkup(React.createElement(AccountCreditsMenuRow, { demoMode: true }));
  assert.ok(html.includes("余额"), "缺余额");
  assert.ok(html.includes("今日剩余"), "缺今日剩余");
  assert.ok(html.includes("1.24 万"), "余额值未格式化显示");
  assert.ok(html.includes("4.91 万"), "今日剩余值未显示");
  assert.ok(html.includes("/5 万"), "日额度未同见");
  assert.ok(!html.includes("min-[1180px]:hidden"), "菜单行不得再窄屏独占（pill 退役后它是唯一明细位）");
  assert.ok(html.includes("（示例）"), "demo 值必须明示示例");
});

test("#67 rail 积分快览：hover 明细与菜单行同一口径（creditsPillTitle 复用）", () => {
  const rail = readSource("./components/app-rail.tsx");
  assert.ok(rail.includes("creditsPillTitle"), "rail 快览 hover 明细未复用 creditsPillTitle");
  assert.ok(rail.includes("title={title}"), "rail 快览缺 hover 明细出口");
});
