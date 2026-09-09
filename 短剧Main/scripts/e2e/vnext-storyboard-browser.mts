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
import { FixedStoryboardImageAdapter } from "../../src/modules/vnext/storyboard/adapter.js";
import { StoryboardService } from "../../src/modules/vnext/storyboard/service.js";

const databaseUrl = process.env.VNEXT_STORYBOARD_E2E_DATABASE_URL;
if (!databaseUrl) throw new Error("VNEXT_STORYBOARD_E2E_DATABASE_URL is required");

const handle = createDatabase(databaseUrl);
const vnextHandle = createVnextDatabase(databaseUrl);
const appSchema = quoteIdentifier(settings.postgresSchema);
const userId = randomUUID();
const token = `vnext-storyboard-e2e-${randomUUID()}`;
let app: FastifyInstance | undefined;

try {
  await runMigrations(handle);
  await handle.pool.query(
    `INSERT INTO ${appSchema}.users (id, username, display_name, password_hash)
     VALUES ($1, $2, 'vNext 故事板浏览器验收', 'test-only')`,
    [userId, `vnext-storyboard-${randomUUID()}`],
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
    createStoryboardService: (database) => new StoryboardService(database, new FixedStoryboardImageAdapter(), async () => undefined),
  });

  const projectResponse = await app.inject({
    method: "POST",
    url: "/api/vnext/projects",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "故事板浏览器项目" },
  });
  assert.equal(projectResponse.statusCode, 201);
  const projectId = projectResponse.json().data.id as string;
  const confirmationId = await seedConfirmedShotPlan(projectId);

  const virtualPort = 19_000 + Math.floor(Math.random() * 1_000);
  const origin = `http://vnext.local:${virtualPort}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const workbenchResponse = await app.inject({
      method: "GET",
      url: `/api/vnext/projects/${projectId}/script-workbench`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(workbenchResponse.statusCode, 200, workbenchResponse.body);
    assert.equal(workbenchResponse.json().data.formal_facts.confirmation_id, confirmationId);
    await bridgeBrowserToApplication(context, origin, app);
    const page = await context.newPage();
    await page.addInitScript((value) => window.sessionStorage.setItem("shortdrama_v01_token", value), token);
    await page.goto(`${origin}/vnext/projects/${projectId}`, { waitUntil: "networkidle" });
    await page.getByRole("region", { name: "故事板工作台" }).waitFor();
    await page.getByRole("button", { name: "生成故事板" }).click();
    const cards = page.locator(".storyboard-card");
    await cards.nth(1).waitFor();
    const unchangedBefore = await cards.nth(1).innerText();

    await cards.first().click();
    await page.getByLabel("重绘提示词").fill("雨夜霓虹中的重新构图");
    await page.getByRole("button", { name: "重绘此格" }).click();
    await page.getByText("v2 · redraw", { exact: false }).waitFor();
    assert.equal(await cards.nth(1).innerText(), unchangedBefore, "未重绘格的 ID、版本和媒体哈希必须保持不变");

    await page.reload({ waitUntil: "networkidle" });
    await page.getByText("v2 · redraw", { exact: false }).waitFor();
    const latest = await vnextHandle.pool.query<{ version: number }>(
      "SELECT version FROM vnext.storyboard_boards WHERE project_id=$1 ORDER BY version DESC LIMIT 1",
      [projectId],
    );
    assert.equal(latest.rows[0]?.version, 2);
    await page.close();
    await context.close();
  } finally {
    await browser.close();
  }

  process.stdout.write(`storyboard browser e2e passed: ${projectId} / ${confirmationId}\n`);
} finally {
  await app?.close().catch(() => undefined);
  await vnextHandle.pool.end().catch(() => undefined);
  await handle.pool.end().catch(() => undefined);
}

async function seedConfirmedShotPlan(projectId: string): Promise<string> {
  const sourceId = randomUUID();
  const runId = randomUUID();
  const confirmationId = randomUUID();
  const sceneId = randomUUID();
  await vnextHandle.pool.query(
    `INSERT INTO vnext.script_sources (id, project_id, source_kind, script_content, content_sha256, created_by_user_id)
     VALUES ($1, $2, 'paste', 'storyboard e2e fixture', $3, $4)`,
    [sourceId, projectId, "0".repeat(64), userId],
  );
  await vnextHandle.pool.query(
    `INSERT INTO vnext.script_parse_runs (id, project_id, source_id, client_idempotency_key, status, progress, current_stage, draft, created_by_user_id, confirmed_at)
     VALUES ($1, $2, $3, 'storyboard-e2e-run', 'confirmed', 100, 'confirmed', '{"schema_version":1,"characters":[],"scenes":[],"shots":[],"warnings":[]}'::jsonb, $4, now())`,
    [runId, projectId, sourceId, userId],
  );
  await vnextHandle.pool.query(
    `INSERT INTO vnext.script_confirmations (id, project_id, run_id, client_idempotency_key, confirmed_by_user_id)
     VALUES ($1, $2, $3, 'storyboard-e2e-confirm', $4)`,
    [confirmationId, projectId, runId, userId],
  );
  await vnextHandle.pool.query(
    `INSERT INTO vnext.shot_plan_scenes (id, project_id, confirmation_id, draft_key, title, summary, position)
     VALUES ($1, $2, $3, 'scene-1', '雨夜街口', '两人相遇', 0)`,
    [sceneId, projectId, confirmationId],
  );
  for (const position of [0, 1]) {
    await vnextHandle.pool.query(
      `INSERT INTO vnext.shot_plan_shots (id, project_id, confirmation_id, scene_id, draft_key, position, shot_size, camera_movement, action, rhythm, dialogue, sound)
       VALUES ($1, $2, $3, $4, $5, $6, '全景', '缓慢推进', $7, '紧张', '你终于来了', '雨声')`,
      [randomUUID(), projectId, confirmationId, sceneId, `shot-${position}`, position, position === 0 ? "角色走入画面" : "角色停在灯下"],
    );
  }
  return confirmationId;
}

async function bridgeBrowserToApplication(context: BrowserContext, origin: string, application: FastifyInstance): Promise<void> {
  const frontendDirectory = path.resolve("frontend", "shortdrama-rag-demo", "dist");
  await context.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      const response = await application.inject({
        method: request.method() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        url: `${url.pathname}${url.search}`,
        headers: request.headers(),
        payload: request.postDataBuffer() ?? undefined,
      });
      await route.fulfill({ status: response.statusCode, headers: response.headers as Record<string, string>, body: response.rawPayload });
      return;
    }
    const relative = url.pathname.startsWith("/assets/") ? url.pathname.slice(1) : "index.html";
    const file = await readFile(path.join(frontendDirectory, relative));
    await route.fulfill({ status: 200, contentType: contentType(relative), body: file });
  });
}

function contentType(fileName: string): string {
  if (fileName.endsWith(".js")) return "text/javascript";
  if (fileName.endsWith(".css")) return "text/css";
  if (fileName.endsWith(".svg")) return "image/svg+xml";
  return "text/html";
}
