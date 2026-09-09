/* ============================================================
   version-single-source.test.ts — 版本号单一来源守卫

   起因(2026-07-29 实证):v0.2.1 发版后,后端 /api/v1/health 报 0.2.1,
   而前端登录页页脚仍显示 V0.2.0 —— DC 在测试环境撞见。
   根因:版本号有两个源头且无人对齐:
     - 后端 APP_VERSION ← 仓根 package.json.version
     - 前端 APP_VERSION ← frontend/shortdrama-rag-demo/package.json.version(version.ts 读它)
     - 部署清单 deploy/k8s/base/configmap.yaml 的 APP_VERSION 又是第三处
   发版时只 bump 了其中一处,用户看到两个版本号。

   这条守卫钉死三处必须一致。**发版 bump 版本号时,三处一起改。**
   ============================================================ */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJsonVersion(relativePath: string): Promise<string> {
  const raw = await readFile(path.join(repoRoot, relativePath), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  assert.ok(parsed.version, `${relativePath} 缺 version 字段`);
  return parsed.version;
}

test("版本号三处单一来源:后端 / 前端 / 部署清单必须一致", async () => {
  const backend = await readJsonVersion("package.json");
  const frontend = await readJsonVersion("frontend/shortdrama-rag-demo/package.json");

  const configmap = await readFile(path.join(repoRoot, "deploy/k8s/base/configmap.yaml"), "utf8");
  const matched = /APP_VERSION:\s*["']?([0-9]+\.[0-9]+\.[0-9]+)["']?/.exec(configmap);
  assert.ok(matched, "deploy/k8s/base/configmap.yaml 里找不到 APP_VERSION");
  const deployed = matched[1];

  assert.equal(
    frontend, backend,
    `前端与后端版本号不一致(前端 ${frontend} / 后端 ${backend})——` +
    "用户会在页脚看到旧版本号而接口报新版本。发版时两个 package.json 一起 bump。",
  );
  assert.equal(
    deployed, backend,
    `部署清单与代码版本号不一致(清单 ${deployed} / 代码 ${backend})——` +
    "镜像跑起来会用清单里的旧值覆盖。发版时 configmap 一起 bump。",
  );
});
