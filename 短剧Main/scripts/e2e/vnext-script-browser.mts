import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { chromium, type BrowserContext, type Page } from "playwright";
import { settings } from "../../src/config/env.js";
import { createDatabase } from "../../src/db/client.js";
import { quoteIdentifier, runMigrations } from "../../src/db/migrate.js";
import { createAuthenticationHook } from "../../src/http/authenticate.js";
import { toHttpErrorResponse } from "../../src/http/errorResponse.js";
import { registerAuthRoutes } from "../../src/modules/auth/routes.js";
import { hashSessionToken } from "../../src/modules/auth/service.js";
import { createVnextDatabase } from "../../src/modules/vnext/db.js";
import { registerVnextRoutes } from "../../src/modules/vnext/routes.js";
import { FixedScriptDraftProvider } from "../../src/modules/vnext/script/provider.js";
import { VnextScriptService } from "../../src/modules/vnext/script/service.js";

const databaseUrl = process.env.VNEXT_SCRIPT_E2E_DATABASE_URL;
if (!databaseUrl) throw new Error("VNEXT_SCRIPT_E2E_DATABASE_URL is required");
const fixedScript = [
  "第1场 夜 外 天台",
  "林岚：你终于来了。",
  "顾川转身望向城市灯火。",
  "第2场 日 内 旧书店",
  "顾川：答案一直在这里。",
].join("\n");

const handle = createDatabase(databaseUrl);
const appSchema = quoteIdentifier(settings.postgresSchema);
const userId = randomUUID();
const token = `vnext-script-e2e-${randomUUID()}`;
const vnextHandle = createVnextDatabase(databaseUrl);
let app: FastifyInstance | undefined;

try {
  await runMigrations(handle);
  await handle.pool.query(
    `INSERT INTO ${appSchema}.users (id, username, display_name, password_hash)
     VALUES ($1, $2, 'vNext 剧本浏览器验收', 'test-only')`,
    [userId, `vnext-script-${randomUUID()}`],
  );
  await handle.pool.query(
    `INSERT INTO ${appSchema}.sessions (id, user_id, token_hash, credential_source, expires_at)
     VALUES ($1, $2, $3, 'web', now() + interval '1 hour')`,
    [randomUUID(), userId, hashSessionToken(token)],
  );

  app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const { statusCode, body } = toHttpErrorResponse(error);
    return reply.code(statusCode).send({ ok: false, error: body });
  });
  app.addHook("preHandler", createAuthenticationHook(() => handle.db));
  await registerAuthRoutes(app, () => handle.db);
  await registerVnextRoutes(app, () => vnextHandle.db, {
    createScriptService: (db) => new VnextScriptService(db, new FixedScriptDraftProvider()),
  });
  const virtualPort = 18_000 + Math.floor(Math.random() * 1_000);
  assert.notEqual(virtualPort, 8_000);
  const origin = `http://vnext.local:${virtualPort}`;
  const created = await app.inject({
    method: "POST",
    url: "/api/vnext/projects",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "剧本浏览器项目" },
  });
  assert.equal(created.statusCode, 201);
  const projectId = created.json().data.id as string;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await bridgeBrowserToApplication(context, origin, app);
    await verifyHappyPath(context.newPage(), origin, projectId);
    await verifyUploadPath(context.newPage(), origin);
    await verifyLoadFailureRecovery(context.newPage(), origin, projectId);
    for (const [code, title, withDraft] of [
      ["script_partial_failure", "部分解析失败", true],
      ["script_model_unavailable", "模型不可用", false],
      ["script_parse_timeout", "解析超时", false],
      ["script_schema_validation_failed", "结构校验失败", false],
    ] as const) {
      await verifyPersistedError(context.newPage(), origin, projectId, code, title, withDraft);
    }
    await context.close();
  } finally {
    await browser.close();
  }

  async function verifyHappyPath(pagePromise: Promise<Page>, origin: string, projectId: string): Promise<void> {
    const page = await pagePromise;
    try {
      await authenticate(page);
      await page.goto(`${origin}/vnext/projects/${projectId}`, { waitUntil: "domcontentloaded" });
      await page.getByText("正在恢复剧本与分镜状态…").waitFor();
      await page.getByPlaceholder("粘贴固定测试剧本").waitFor();
      await page.getByPlaceholder("粘贴固定测试剧本").fill(fixedScript);
      await page.getByRole("button", { name: "开始解析" }).click();
      await page.getByText(/读取剧本|整理角色与场景|校验分镜结构/).waitFor({ timeout: 8000 });
      await page.getByRole("button", { name: "确认形成正式分镜" }).waitFor({ timeout: 12000 });
      await page.getByText("林岚", { exact: true }).waitFor();
      await page.getByText("全景", { exact: true }).first().waitFor();
      await page.getByText("缓慢推进", { exact: true }).first().waitFor();
      await page.getByText("动作", { exact: true }).first().waitFor();
      await page.getByText("节奏", { exact: true }).first().waitFor();
      await page.getByText("对白", { exact: true }).first().waitFor();
      await page.getByText("声音", { exact: true }).first().waitFor();
      assert.deepEqual(await formalCounts(projectId), [0, 0, 0], "浏览器确认前正式事实必须为空");

      await page.getByRole("button", { name: "确认形成正式分镜" }).click();
      await page.getByText("已确认并恢复正式事实").waitFor({ timeout: 8000 });
      const afterConfirm = await formalCounts(projectId);
      assert.ok(afterConfirm.every((count) => count > 0));
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText("已确认并恢复正式事实").waitFor();
      await page.getByText(/已形成正式事实/).waitFor();
      assert.deepEqual(await formalCounts(projectId), afterConfirm, "刷新恢复不得重复正式化");
    } finally {
      await page.close();
    }
  }

  async function verifyUploadPath(pagePromise: Promise<Page>, origin: string): Promise<void> {
    const projectResponse = await app!.inject({
      method: "POST",
      url: "/api/vnext/projects",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "上传剧本项目" },
    });
    const uploadProjectId = projectResponse.json().data.id as string;
    const page = await pagePromise;
    try {
      await authenticate(page);
      await page.goto(`${origin}/vnext/projects/${uploadProjectId}`, { waitUntil: "networkidle" });
      await page.locator('input[type="file"]').setInputFiles({
        name: "fixed-script.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(fixedScript, "utf8"),
      });
      await page.getByText("已选择：fixed-script.txt").waitFor();
      await page.getByRole("button", { name: "开始解析" }).click();
      await page.getByRole("button", { name: "确认形成正式分镜" }).waitFor({ timeout: 12000 });
      assert.deepEqual(await formalCounts(uploadProjectId), [0, 0, 0]);
    } finally {
      await page.close();
    }
  }

  async function verifyLoadFailureRecovery(pagePromise: Promise<Page>, origin: string, projectId: string): Promise<void> {
    const page = await pagePromise;
    try {
      await authenticate(page);
      let failed = false;
      await page.route("**/script-workbench", async (route) => {
        if (!failed) {
          failed = true;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ ok: false, error: { code: "db_unavailable", message: "剧本工作台暂时不可用", retryable: true, details: null } }),
          });
          return;
        }
        await route.fallback();
      });
      await page.goto(`${origin}/vnext/projects/${projectId}`, { waitUntil: "domcontentloaded" });
      await page.getByText("剧本工作台暂时不可用").waitFor();
      await page.getByRole("button", { name: "重新读取", exact: true }).click();
      await page.getByText("已确认并恢复正式事实").waitFor();
    } finally {
      await page.close();
    }
  }

  async function verifyPersistedError(
    pagePromise: Promise<Page>,
    origin: string,
    projectId: string,
    code: string,
    title: string,
    withDraft: boolean,
  ): Promise<void> {
    const page = await pagePromise;
    try {
      await authenticate(page);
      await page.route("**/script-workbench", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: {
              run: {
                id: randomUUID(),
                project_id: projectId,
                status: code === "script_partial_failure" ? "partial_failure" : "failed",
                progress: withDraft ? 85 : 100,
                current_stage: "failed",
                draft: withDraft ? publicDraftFixture() : null,
                error: { code, message: "请按提示重试", retryable: true },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                confirmed_at: null,
              },
              formal_facts: null,
            },
          }),
        });
      });
      await page.goto(`${origin}/vnext/projects/${projectId}`, { waitUntil: "networkidle" });
      await page.getByText(new RegExp(title)).waitFor();
      const retryButton = page.getByRole("button", { name: "重试解析" });
      await retryButton.waitFor();
      const sourceInput = page.getByPlaceholder("粘贴固定测试剧本");
      await sourceInput.waitFor();
      assert.equal(await page.locator('input[type="file"]').isVisible(), true, "失败后上传入口必须仍可用");
      if (withDraft) {
        const diagnostics = page.getByRole("heading", { name: "解析诊断（2）" });
        await diagnostics.waitFor();
        await page.getByText("问题 1：第二场环境音缺少").waitFor();
        await page.getByText("问题 2：第三场对白归属不明").waitFor();
        await page.getByText(/请逐项检查对应场景或镜头/).waitFor();
        await page.getByText("分镜规划").waitFor();
        assert.equal(await retryButton.getAttribute("aria-describedby"), "vnext-script-diagnostics");
        const retryHandle = await retryButton.elementHandle();
        assert.ok(retryHandle);
        assert.equal(
          await diagnostics.evaluate((node, button) => (
            Boolean(node.compareDocumentPosition(button as Node) & Node.DOCUMENT_POSITION_FOLLOWING)
          ), retryHandle),
          true,
          "诊断必须显示在重试操作之前",
        );
        const correctedScript = `${fixedScript}\n林岚：这是修正后的对白。`;
        let resolveSubmission!: (payload: Record<string, unknown>) => void;
        const submission = new Promise<Record<string, unknown>>((resolve) => {
          resolveSubmission = resolve;
        });
        await page.route("**/script-runs", async (route) => {
          const payload = route.request().postDataJSON() as Record<string, unknown>;
          resolveSubmission(payload);
          await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              data: {
                outcome: "created",
                run: {
                  id: randomUUID(),
                  project_id: projectId,
                  status: "queued",
                  progress: 0,
                  current_stage: "queued",
                  draft: null,
                  error: null,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  confirmed_at: null,
                },
              },
            }),
          });
        });
        await sourceInput.fill(correctedScript);
        await diagnostics.waitFor();
        await page.getByRole("button", { name: "提交修正后的剧本" }).click();
        const payload = await submission;
        assert.equal(payload.script_content, correctedScript, "重新提交必须使用用户修正后的剧本");
        assert.equal(payload.source_kind, "paste");
      }
    } finally {
      await page.close();
    }
  }

  async function authenticate(page: Page): Promise<void> {
    await page.addInitScript((value) => window.sessionStorage.setItem("shortdrama_v01_token", value), token);
  }

  async function formalCounts(projectId: string): Promise<[number, number, number]> {
    const result = await handle.pool.query<{ characters: number; scenes: number; shots: number }>(
      `SELECT
        (SELECT count(*)::int FROM vnext.shot_plan_characters WHERE project_id=$1) AS characters,
        (SELECT count(*)::int FROM vnext.shot_plan_scenes WHERE project_id=$1) AS scenes,
        (SELECT count(*)::int FROM vnext.shot_plan_shots WHERE project_id=$1) AS shots`,
      [projectId],
    );
    const row = result.rows[0]!;
    return [row.characters, row.scenes, row.shots];
  }
} finally {
  await app?.close().catch(() => undefined);
  await vnextHandle.pool.end().catch(() => undefined);
  await handle.pool.end().catch(() => undefined);
}

function publicDraftFixture() {
  return {
    schema_version: 1,
    characters: [{ key: "character-a", name: "角色 A", description: "待确认角色" }],
    scenes: [{ key: "scene-a", title: "场景 A", summary: "待确认场景", position: 0 }],
    shots: [{
      key: "shot-a",
      scene_key: "scene-a",
      position: 0,
      shot_size: "全景",
      camera_movement: "推进",
      action: "进入画面",
      rhythm: "平稳",
      dialogue: "无对白",
      sound: "环境声",
    }],
    warnings: ["第二场环境音缺少", "第三场对白归属不明"],
  };
}

async function bridgeBrowserToApplication(
  context: BrowserContext,
  origin: string,
  application: NonNullable<typeof app>,
): Promise<void> {
  const frontendDirectory = path.resolve("frontend", "shortdrama-rag-demo", "dist");
  let delayedInitialWorkbenchRequest = false;
  await context.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      if (
        !delayedInitialWorkbenchRequest
        && request.method() === "GET"
        && url.pathname.includes("/script-workbench")
      ) {
        delayedInitialWorkbenchRequest = true;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const response = await application.inject({
        method: request.method() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        url: `${url.pathname}${url.search}`,
        headers: request.headers(),
        payload: request.postDataBuffer() ?? undefined,
      });
      await route.fulfill({
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
        body: response.rawPayload,
      });
      return;
    }
    const relative = url.pathname.startsWith("/assets/")
      ? url.pathname.slice(1)
      : "index.html";
    const file = await readFile(path.join(frontendDirectory, relative));
    await route.fulfill({
      status: 200,
      contentType: contentType(relative),
      body: file,
    });
  });
}

function contentType(fileName: string): string {
  if (fileName.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
  if (fileName.endsWith(".svg")) return "image/svg+xml";
  if (fileName.endsWith(".png")) return "image/png";
  return "text/html; charset=utf-8";
}
