#!/usr/bin/env node
/**
 * 便携 test:node 清单(#288 从 test 分支回流)。
 *
 * 历史 test:node 依赖 `rg --files` 一行流,火山 CP 的 ci-prepare 自定义镜像不承诺
 * 宿主机工具链,清单逻辑因此收进本脚本(纯 Node,无外部命令依赖)。
 * package.json 只做 `node scripts/run-node-tests.mjs --list-files | xargs ...`;
 * tests/support/fast-lane.ts 的守门正是执行 `|` 左侧这条命令复算真实结果,
 * 所以 `--list-files` 的输出就是快车道的可观测契约。
 *
 * 排除规则沿用 2026-08-12 的后缀约定(与 fast-lane-container-guard 同源判据):
 * `-db.test.ts` / `.db.test.ts` / `-postgres.test.ts` 不进快车道——它们要真 PG
 * 或 Docker daemon,由各自的 scripts/run-*-db-test.sh 在显式 DB 门禁执行;
 * 留在快车道会以 skip 冒充通过(check-ci-db-coverage 盯套件与闸的映射)。
 */
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const FAST_LANE_EXCLUDED_SUFFIXES = [
  "-db.test.ts",
  ".db.test.ts",
  "-postgres.test.ts",
];

function isFastLaneTestFile(normalizedPath) {
  return (
    normalizedPath.endsWith(".test.ts") &&
    !FAST_LANE_EXCLUDED_SUFFIXES.some((suffix) => normalizedPath.endsWith(suffix))
  );
}

async function collect(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // 与 rg 默认口径一致:不扫隐藏目录(含 .git、.cp-build)和依赖树。
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }

    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(absolute, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const normalized = relative(process.cwd(), absolute).split(sep).join("/");
    if (isFastLaneTestFile(normalized)) {
      files.push(normalized);
    }
  }
}

async function listFastLaneTestFiles() {
  const files = [];
  await collect(process.cwd(), files);
  files.sort();
  if (files.length === 0) {
    throw new Error("No Node test files found");
  }
  return files;
}

const files = await listFastLaneTestFiles();

if (process.argv.includes("--list-files")) {
  process.stdout.write(`${files.join("\n")}\n`);
} else {
  console.error(`NODE_TEST_FILES count=${files.length}`);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...files],
    { env: process.env, stdio: "inherit" },
  );

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}
