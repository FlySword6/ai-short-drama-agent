import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createApp } from "../../src/app.js";
import { settings } from "../../src/config/env.js";
import { createDatabase } from "../../src/db/client.js";
import { quoteIdentifier, runMigrations } from "../../src/db/migrate.js";
import { hashSessionToken } from "../../src/modules/auth/service.js";
import { createVnextDatabase } from "../../src/modules/vnext/db.js";

/**
 * vNext 持续画布浏览器验收(#345):
 * - 干净库只跑正式迁移链(runMigrations),vNext 表必须随之就位,不走独立旁路脚本;
 * - 真实 app(createApp)+ 真实会话认证:未登录、无权限(非项目成员)都在浏览器里验;
 * - 入口走壳层 rail 的 vNext 导航项;画布保存→刷新恢复;「最近写入」来自真实修订事实。
 */
const port = 18000 + Math.floor(Math.random() * 1000);
const databaseUrl = process.env.VNEXT_E2E_DATABASE_URL;
if (!databaseUrl) throw new Error("VNEXT_E2E_DATABASE_URL is required");

const handle = createDatabase(databaseUrl);
const appSchema = quoteIdentifier(settings.postgresSchema);
const human = { id: randomUUID(), username: "vnext-e2e", displayName: "vNext E2E" };
const outsider = { id: randomUUID(), username: "vnext-outsider", displayName: "vNext Outsider" };
const humanToken = `vnext-e2e-web-${randomUUID()}`;
const agentToken = `vnext-e2e-agent-${randomUUID()}`;
const outsiderToken = `vnext-e2e-outsider-${randomUUID()}`;
const projectUrl = { current: "" };

try {
  const applied = await runMigrations(handle);
  assert.ok(applied.includes("vnext/001_vnext_projects_graph.sql"), "正式迁移链必须带 vNext 001");
  assert.ok(applied.includes("vnext/002_graph_revisions_actor_kind.sql"), "正式迁移链必须带 vNext 002");
  assert.ok(applied.includes("vnext/003_vnext_app_runtime_membership.sql"), "正式迁移链必须带 vNext 003");

  const future = new Date(Date.now() + 60 * 60 * 1000);
  const humanSessionId = randomUUID();
  for (const [user, token, sessionId] of [
    [human, humanToken, humanSessionId],
    [outsider, outsiderToken, randomUUID()],
  ] as const) {
    await handle.pool.query(
      `INSERT INTO ${appSchema}.users (id, username, display_name, password_hash) VALUES ($1, $2, $3, 'test-only')`,
      [user.id, user.username, user.displayName],
    );
    await handle.pool.query(
      `INSERT INTO ${appSchema}.sessions (id, user_id, token_hash, credential_source, expires_at) VALUES ($1, $2, $3, 'web', $4)`,
      [sessionId, user.id, hashSessionToken(token), future],
    );
  }
  await handle.pool.query(
    `INSERT INTO ${appSchema}.sessions
       (id, user_id, token_hash, credential_source, agent_type, credential_label, issued_by_session_id, expires_at)
     VALUES ($1, $2, $3, 'agent', 'vnext-e2e', 'vNext E2E Agent', $4, $5)`,
    [randomUUID(), human.id, hashSessionToken(agentToken), humanSessionId, future],
  );

  // vNext 数据面显式注入受 vnext_app 约束的专用连接(与生产 createApp 缺省懒建同款),
  // 浏览器验收同时证明真实应用在最小权限角色下跑通。
  const vnextHandle = createVnextDatabase(databaseUrl);
  const app = await createApp({ databaseHandle: handle, vnextDatabaseHandle: vnextHandle, logger: false });
  await app.listen({ host: "127.0.0.1", port });
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      // 未登录:深链 /vnext/projects 换乘登录落点,不得渲染 vNext 面。
      const anonymous = await browser.newPage();
      await anonymous.goto(`http://127.0.0.1:${port}/vnext/projects`, { waitUntil: "networkidle" });
      await anonymous.getByRole("button", { name: "进入片场" }).waitFor({ timeout: 15000 });
      assert.equal(await anonymous.getByText("vNext Studio").count(), 0, "未登录不得渲染 vNext 项目面");
      await anonymous.close();

      // 加载 → 失败 → 显式重试恢复。故障只拦一次项目列表 GET，不改后端事实。
      const failure = await browser.newPage();
      await failure.addInitScript((token) => window.sessionStorage.setItem("shortdrama_v01_token", token), humanToken);
      let failProjectsOnce = true;
      await failure.route("**/api/vnext/projects", async (route) => {
        if (failProjectsOnce && route.request().method() === "GET") {
          failProjectsOnce = false;
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: { code: "vnext_e2e_failure", message: "浏览器模拟的 vNext 读取失败", details: null },
            }),
          });
          return;
        }
        await route.fallback();
      });
      const failureNavigation = failure.goto(`http://127.0.0.1:${port}/vnext/projects`, { waitUntil: "domcontentloaded" });
      await failure.getByText("正在读取 vNext 项目").waitFor();
      await failureNavigation;
      await failure.getByText("浏览器模拟的 vNext 读取失败").waitFor();
      await failure.getByRole("button", { name: "重试", exact: true }).click();
      await failure.getByText("还没有 vNext 项目").waitFor();
      await failure.close();

      // 已登录:壳层 rail 的 vNext 入口进入项目列表。
      const page = await browser.newPage();
      // vNext API 状态与页面异常打到 stderr:画布链路回归时的第一手诊断。
      page.on("response", (response) => {
        if (response.url().includes("/api/vnext")) {
          process.stderr.write(`vnext-api ${response.status()} ${response.request().method()} ${response.url()}\n`);
        }
      });
      page.on("pageerror", (error) => process.stderr.write(`pageerror ${error.message}\n`));
      await page.addInitScript((token) => window.sessionStorage.setItem("shortdrama_v01_token", token), humanToken);
      await page.goto(`http://127.0.0.1:${port}/projects`, { waitUntil: "networkidle" });
      await page.getByRole("navigation").getByRole("button", { name: "vNext", exact: true }).click();
      await page.waitForURL(/\/vnext\/projects$/, { timeout: 15000 });
      await page.getByText("vNext Studio").waitFor();
      await page.getByText("还没有 vNext 项目").waitFor();

      // 空态 → 创建 → 画布保存(串行)→ 刷新后事实仍在。
      await page.getByPlaceholder("输入新项目名称").fill("浏览器恢复项目");
      await page.getByRole("button", { name: "创建 vNext 项目" }).click();
      await page.getByText("vNext Canvas").waitFor();
      projectUrl.current = page.url();
      await page.getByRole("button", { name: "添加场景" }).click();
      await page.getByText("修订 1 · 已同步").waitFor({ timeout: 8000 });
      await page.getByText("最近写入：人类").waitFor({ timeout: 8000 });
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText("修订 1 · 已同步").waitFor();
      assert.equal(await page.getByText("新场景").count(), 1, "刷新后必须恢复已保存的画布节点");

      // 浏览器里的冲突与恢复：拦住下一笔人类 PUT，先用真实 Agent 凭证前进同一
      // revision；人类旧 revision 必须 409，再由串行器重读、合并并保存为下一版。
      const projectId = new URL(projectUrl.current).pathname.split("/").at(-1);
      assert.ok(projectId);
      let conflictInjected = false;
      await page.route(`**/api/vnext/projects/${projectId}/graph`, async (route) => {
        if (!conflictInjected && route.request().method() === "PUT") {
          conflictInjected = true;
          const beforeAgent = await app.inject({
            method: "GET",
            url: `/api/vnext/projects/${projectId}/graph`,
            headers: { authorization: `Bearer ${agentToken}` },
          });
          assert.equal(beforeAgent.statusCode, 200);
          const snapshot = beforeAgent.json().data as {
            revision: number;
            document: { schema_version: 1; nodes: unknown[]; edges: unknown[] };
          };
          const agentWrite = await app.inject({
            method: "PUT",
            url: `/api/vnext/projects/${projectId}/graph`,
            headers: { authorization: `Bearer ${agentToken}` },
            payload: {
              expected_revision: snapshot.revision,
              document: {
                ...snapshot.document,
                nodes: [
                  ...snapshot.document.nodes,
                  { id: randomUUID(), kind: "note", label: "Agent 冲突增量", position: { x: 320, y: 180 } },
                ],
              },
            },
          });
          assert.equal(agentWrite.statusCode, 200, agentWrite.body);
        }
        await route.continue();
      });
      await page.getByRole("button", { name: "添加场景" }).click();
      await page.getByText("修订 3 · 已同步").waitFor({ timeout: 12000 });
      assert.equal(conflictInjected, true, "必须真实注入一次 revision 冲突");
      await page.getByText("Agent 冲突增量").waitFor();
      assert.equal(await page.getByText("新场景", { exact: true }).count(), 2, "冲突恢复必须同时保留人类本地增量");
      await page.unroute(`**/api/vnext/projects/${projectId}/graph`);

      // 页面打开期间真实 Agent 再写一版，3 秒事实轮询必须自动呈现 Agent 状态。
      const beforePoll = await app.inject({
        method: "GET",
        url: `/api/vnext/projects/${projectId}/graph`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      assert.equal(beforePoll.statusCode, 200);
      const pollSnapshot = beforePoll.json().data as {
        revision: number;
        document: { schema_version: 1; nodes: unknown[]; edges: unknown[] };
      };
      const pollWrite = await app.inject({
        method: "PUT",
        url: `/api/vnext/projects/${projectId}/graph`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: {
          expected_revision: pollSnapshot.revision,
          document: {
            ...pollSnapshot.document,
            nodes: [
              ...pollSnapshot.document.nodes,
              { id: randomUUID(), kind: "note", label: "Agent 在途增量", position: { x: 420, y: 220 } },
            ],
          },
        },
      });
      assert.equal(pollWrite.statusCode, 200, pollWrite.body);
      await page.getByText("修订 4 · 已同步").waitFor({ timeout: 12000 });
      await page.getByText(/最近写入：Agent/).waitFor();
      await page.getByText("Agent 在途增量").waitFor();

      // 同一个 SPA 会话从项目 A 直达项目 B：画布组件必须按 project id 重建，
      // 不得复用 A 的同步器闭包并把 B 的编辑误写回 A。
      const createSecond = await app.inject({
        method: "POST",
        url: "/api/vnext/projects",
        headers: { authorization: `Bearer ${humanToken}` },
        payload: { name: "浏览器切换项目" },
      });
      assert.equal(createSecond.statusCode, 201, createSecond.body);
      const secondProjectId = createSecond.json().data.id as string;
      await page.evaluate((path) => {
        window.history.pushState({}, "", path);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, `/vnext/projects/${secondProjectId}`);
      await page.getByText("修订 0 · 已同步").waitFor({ timeout: 12000 });
      await page.getByText("画布尚无写入").waitFor();
      assert.equal(await page.getByText("Agent 在途增量").count(), 0, "项目 B 不得显示项目 A 的节点");
      await page.getByRole("button", { name: "添加场景" }).click();
      await page.getByText("修订 1 · 已同步").waitFor({ timeout: 8000 });

      const [firstAfterSwitch, secondAfterSwitch] = await Promise.all([
        app.inject({
          method: "GET",
          url: `/api/vnext/projects/${projectId}/graph`,
          headers: { authorization: `Bearer ${humanToken}` },
        }),
        app.inject({
          method: "GET",
          url: `/api/vnext/projects/${secondProjectId}/graph`,
          headers: { authorization: `Bearer ${humanToken}` },
        }),
      ]);
      assert.equal(firstAfterSwitch.json().data.revision, 4, "项目 B 的保存不得改写项目 A");
      assert.equal(secondAfterSwitch.json().data.revision, 1, "项目 B 必须写入自己的 revision");

      // 无权限:非项目成员打开同一画布,按不存在/无权限错误态呈现,不渲染节点。
      const denied = await browser.newPage();
      await denied.addInitScript((token) => window.sessionStorage.setItem("shortdrama_v01_token", token), outsiderToken);
      await denied.goto(projectUrl.current, { waitUntil: "networkidle" });
      await denied.getByText(/不存在或你没有访问权限/).waitFor({ timeout: 15000 });
      await denied.close();
    } finally {
      await browser.close();
    }
  } finally {
    await app.close().catch(() => undefined);
    await vnextHandle.pool.end().catch(() => undefined);
  }
} finally {
  await handle.pool.end();
}
