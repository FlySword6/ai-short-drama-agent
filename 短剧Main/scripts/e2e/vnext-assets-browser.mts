import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { users, sessions } from "../../src/db/schema.js";
import { hashPassword, hashSessionToken } from "../../src/modules/auth/service.js";

const databaseUrl = process.env.VNEXT_ASSETS_E2E_DATABASE_URL;
if (!databaseUrl) throw new Error("VNEXT_ASSETS_E2E_DATABASE_URL is required");
if (!["127.0.0.1", "localhost", "db"].includes(new URL(databaseUrl).hostname)) {
  throw new Error("VNEXT_ASSETS_E2E_DATABASE_URL must point at a local test database");
}

const port = Number(process.env.VNEXT_ASSETS_E2E_PORT ?? 0) || 4309 + Math.floor(Math.random() * 100);
const actorId = randomUUID();
const sessionId = randomUUID();
const sessionToken = `assets-e2e-${randomUUID()}`;
const baseInput = {
  source_system: "legacy_snapshot_a_e2e",
  source_id: `approved-scene-${randomUUID().slice(0, 8)}`,
  name: "雨夜街道 E2E",
  asset_kind: "scene",
  media_kind: "image",
  media_url: "https://assets.example.test/snapshot-a/rain-street-e2e.png",
  media_sha256: "a".repeat(64),
  snapshot_at: "2026-08-15T00:00:00.000Z",
  snapshot_version: "snapshot-a-e2e",
};

let server: ChildProcessWithoutNullStreams | undefined;

async function seedApproval(): Promise<void> {
  const handle = createDatabase(databaseUrl);
  try {
    await runMigrations(handle);
    const now = new Date();
    await handle.db.insert(users).values({
      id: actorId,
      username: "assets-e2e",
      displayName: "Assets E2E",
      passwordHash: await hashPassword("assets-e2e-password"),
      active: true,
      role: "admin",
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(sessions).values({
      id: sessionId,
      userId: actorId,
      tokenHash: hashSessionToken(sessionToken),
      credentialSource: "web",
      userAgent: "vnext-assets-e2e",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      createdAt: now,
    });
    await handle.pool.query(
      `INSERT INTO vnext.import_source_approvals (
        source_system, source_id, media_sha256, asset_kind, media_kind, name, snapshot_version, source_snapshot_at, approved, is_human
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, FALSE)`,
      [baseInput.source_system, baseInput.source_id, baseInput.media_sha256, baseInput.asset_kind, baseInput.media_kind, baseInput.name, baseInput.snapshot_version, baseInput.snapshot_at],
    );
    await handle.pool.query("GRANT vnext_app TO CURRENT_USER");
  } finally {
    await handle.pool.end();
  }
}

const e2eServerPath = fileURLToPath(new URL("./vnext-assets-e2e-server.mts", import.meta.url));

async function requestJson(pathname: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sessionToken}`,
      ...(init.headers ?? {}),
    },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

try {
  await seedApproval();
  server = spawn(process.execPath, ["--import", "tsx", e2eServerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      VNEXT_DATABASE_URL: databaseUrl,
      POSTGRES_SSL_MODE: "disable",
      PORT: String(port),
      NODE_ENV: "test",
      PAID_EXECUTION_ENABLED: "false",
      SEEDANCE_ASSET_REGISTRATION_ENABLED: "false",
      VNEXT_ASSETS_E2E_MEDIA_URL: baseInput.media_url,
      VNEXT_ASSETS_E2E_MEDIA_SHA256: baseInput.media_sha256,
    },
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not become ready: ${output}`)), 20_000);
    const check = setInterval(async () => {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
        if (health.ok) { clearInterval(check); clearTimeout(timer); resolve(); }
      } catch { /* wait */ }
    }, 250);
    server.once("exit", (code) => { clearInterval(check); clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
  });

  const library = await requestJson("/api/vnext/assets/legacy-library");
  assert.equal(library.status, 200, `legacy library route failed: ${library.status} ${JSON.stringify(library.body)}\nserver output:\n${output}`);
  assert.ok(Array.isArray((library.body as { data?: { items?: unknown[] } })?.data?.items));

  const created = await requestJson("/api/vnext/assets/snapshot-a", { method: "POST", body: JSON.stringify(baseInput) });
  assert.equal(created.status, 201, `first import must create through HTTP route: ${created.status} ${JSON.stringify(created.body)}\nserver output:\n${output}`);
  const asset = (created.body as { data?: { asset?: { id?: string; registration_status?: string; registration_failure_code?: string | null; registration_readback?: Record<string, unknown> | null } } })?.data?.asset;
  assert.ok(asset?.id, "HTTP import must return the persisted asset");
  assert.equal(asset?.registration_status, "failed", "image import without configured registration backend must fail closed");
  assert.equal(asset?.registration_failure_code, "snapshot_registration_unavailable", "failure code must explain no external request was sent");
  assert.deepEqual(asset?.registration_readback, null, "disabled registration must expose null provider readback evidence");
  const replayed = await requestJson("/api/vnext/assets/snapshot-a", { method: "POST", body: JSON.stringify(baseInput) });
  assert.equal(replayed.status, 200, "second import must replay without repeating external intent");
  assert.equal((replayed.body as { data?: { asset?: { id?: string } } })?.data?.asset?.id, asset?.id);

  const mutated = await requestJson("/api/vnext/assets/snapshot-a", {
    method: "POST",
    body: JSON.stringify({ ...baseInput, name: "未批准名称" }),
  });
  assert.notEqual(mutated.status, 201, "unapproved display name must fail closed through the HTTP route");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await bridgeBrowserToApplication(context, `http://vnext.local:${port}`, port);
    const page = await context.newPage();
    try {
      await page.addInitScript((value) => window.sessionStorage.setItem("shortdrama_v01_token", value), sessionToken);
      await page.goto(`http://vnext.local:${port}/vnext/projects`, { waitUntil: "networkidle" });
      await page.getByText("旧系统素材库").waitFor();
      await page.getByText("已导入的非真人参考素材").waitFor();
      await page.getByText(asset!.name).waitFor();
      await page.getByText(/注册失败/).waitFor();
      await page.getByText("火山素材登记未开启，未发送任何外部请求").waitFor();
    } finally {
      await page.close();
    }
    await context.close();
  } finally {
    await browser.close();
  }

  console.log("vNext assets API and UI seam E2E passed");
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server!.once("exit", resolve));
  }
}

async function bridgeBrowserToApplication(
  context: BrowserContext,
  origin: string,
  applicationPort: number,
): Promise<void> {
  const frontendDirectory = path.resolve("frontend", "shortdrama-rag-demo", "dist");
  await context.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      const response = await fetch(`http://127.0.0.1:${applicationPort}${url.pathname}${url.search}`, {
        method: request.method(),
        headers: request.headers(),
        body: request.postDataBuffer() ?? undefined,
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: Buffer.from(await response.arrayBuffer()),
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
