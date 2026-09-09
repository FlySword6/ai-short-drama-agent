/* 干净 clone 里前端构建产物不进版本库,后端根地址原本吐一段给接口调用方的错误信封,
   新人按文档跑完三步打开浏览器只能看到 JSON(issue #65)。这组断言锁住三件事:
   本机没构建时根地址给中文指引、构建过之后不被指引页顶掉、接口的错误信封一个字不变。 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { resolveRootEntryMode } from "../src/http/localEntryGuide.js";

const missingFrontendDirectory = path.join(tmpdir(), "shortdrama-frontend-dist-not-built");

async function buildFakeFrontend(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "shortdrama-frontend-dist-"));
  await writeFile(path.join(directory, "index.html"), "<!doctype html><title>登录</title>", "utf8");
  return directory;
}

test("根地址三态:有构建产物伺服前端,本机没有给指引,线上没有照旧走信封", () => {
  assert.equal(resolveRootEntryMode({ frontendAvailable: true, appEnvironment: "development" }), "frontend");
  assert.equal(resolveRootEntryMode({ frontendAvailable: true, appEnvironment: "production" }), "frontend");
  assert.equal(resolveRootEntryMode({ frontendAvailable: false, appEnvironment: "development" }), "guide");
  // 线上缺构建产物是发布事故:终端用户不该看见一页"去跑 npm run dev"。
  assert.equal(resolveRootEntryMode({ frontendAvailable: false, appEnvironment: "production" }), "api-only");
});

test("没构建前端时根地址给中文指引,而不是给接口调用方看的错误信封", async () => {
  const app = await createApp({ logger: false, frontendDistDirectory: missingFrontendDirectory });
  try {
    const res = await app.inject({ method: "GET", url: "/" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.ok(res.body.includes("http://localhost:5173"), "指引里要写清楚页面在哪个地址");
    assert.ok(res.body.includes("npm run build:frontend"), "也要给出让当前地址直接出页面的办法");
    // CONTRIBUTING 第三节 ④:用户能看到的字里不许出现 HTTP 状态码和英文错误原文。
    for (const forbidden of ["404", "not_found", "Not Found", "接口不存在"]) {
      assert.ok(!res.body.includes(forbidden), `指引页出现了不该给人看的字样:${forbidden}`);
    }
  } finally {
    await app.close();
  }
});

test("没构建前端时接口路径的错误信封一个字不变", async () => {
  const app = await createApp({ logger: false, frontendDistDirectory: missingFrontendDirectory });
  try {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/login" });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), {
      ok: false,
      error: { code: "not_found", message: "接口不存在", retryable: false, details: null },
    });
  } finally {
    await app.close();
  }
});

test("构建过前端之后根地址出页面,指引页不顶掉它", async () => {
  const app = await createApp({ logger: false, frontendDistDirectory: await buildFakeFrontend() });
  try {
    const res = await app.inject({ method: "GET", url: "/" });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes("<title>登录</title>"), "根地址应当伺服前端构建产物");
    // 前端路由要能直接刷新:非接口、非文档的 GET 交还给单页应用。
    const deepLink = await app.inject({ method: "GET", url: "/projects/1" });
    assert.equal(deepLink.statusCode, 200);
    assert.ok(deepLink.body.includes("<title>登录</title>"));
  } finally {
    await app.close();
  }
});
