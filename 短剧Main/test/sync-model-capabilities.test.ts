import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  capabilityRowId,
  parseArgs,
  planCapabilitySync,
} from "../scripts/sync-model-capabilities.mts";

const repoRoot = path.resolve(import.meta.dirname, "..");

function arkPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "doubao-seed-2-1-pro",
    primary_version: "260628",
    limits: {
      context_window: "256k",
      max_input_token_length: "256k",
      max_completion_token_length: "256k",
      max_reasoning_token_length: "256k",
    },
    rate_limit: { default_rate_limit: { rpm: 500, tpm: 1000000 } },
    ...overrides,
  };
}

test("同一个调用 ID 必须派生出同一个行 ID:同步器重跑靠它命中原行而不是插新行", () => {
  const first = capabilityRowId("doubao-seed-2-1-pro-260628");
  assert.equal(first, capabilityRowId("doubao-seed-2-1-pro-260628"));
  assert.notEqual(first, capabilityRowId("deepseek-v4-flash-ga-260731"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
});

test("缺容量的模型只进 skipped,不写脏数据也不算失败", async () => {
  const payloads = new Map<string, Record<string, unknown>>([
    ["doubao-seed-2-1-pro", arkPayload()],
    // 嵌入与路由类模型本身不返回 limits.max_completion_token_length。
    ["doubao-embedding", arkPayload({ name: "doubao-embedding", limits: {} })],
  ]);
  const outcome = await planCapabilitySync(
    ["doubao-seed-2-1-pro", "doubao-embedding"],
    async (modelName) => payloads.get(modelName),
  );
  assert.deepEqual(
    [outcome.planned.length, outcome.skipped.length, outcome.failed.length],
    [1, 1, 0],
  );
  assert.equal(outcome.skipped[0]?.modelName, "doubao-embedding");
  assert.equal(outcome.planned[0]?.callableModelId, "doubao-seed-2-1-pro-260628");
  assert.equal(outcome.planned[0]?.maxOutputTokens, 262144);
});

test("单个模型拉取失败只记一条 failed,剩下的照旧拉完", async () => {
  const outcome = await planCapabilitySync(
    ["broken", "doubao-seed-2-1-pro"],
    async (modelName) => {
      if (modelName === "broken") throw new Error("arkcli 超时");
      return arkPayload();
    },
  );
  assert.deepEqual(
    [outcome.planned.length, outcome.skipped.length, outcome.failed.length],
    [1, 0, 1],
  );
  assert.equal(outcome.failed[0]?.modelName, "broken");
  assert.match(outcome.failed[0]?.reason ?? "", /arkcli 超时/u);
});

test("同名模型只拉一次:清单去重,免得同一行被重复 upsert", async () => {
  let calls = 0;
  const outcome = await planCapabilitySync(
    ["doubao-seed-2-1-pro", "doubao-seed-2-1-pro"],
    async () => {
      calls += 1;
      return arkPayload();
    },
  );
  assert.equal(calls, 1);
  assert.equal(outcome.planned.length, 1);
});

test("--apply 必须显式给,不给就是干跑", () => {
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(["--apply"]), { apply: true });
  assert.deepEqual(
    parseArgs(["--names-file", "/tmp/names.txt"]),
    { apply: false, namesFile: "/tmp/names.txt" },
  );
  assert.throws(() => parseArgs(["--names-file"]), /需要一个路径/u);
  assert.throws(() => parseArgs(["--wat"]), /未知参数/u);
});

test("模型名默认取 arkcli 实况,--names-file 只是离线备用", async () => {
  const source = await readFile(
    path.join(repoRoot, "scripts", "sync-model-capabilities.mts"),
    "utf8",
  );
  // 缺省分支必须落在 arkcli 实况上:/tmp 下的清单会被系统清掉,
  // 定时任务如果默认读它,过一段时间就同步 0 个模型且看起来仍然成功。
  assert.match(
    source,
    /args\.namesFile\s*\?\s*await readNamesFile\(args\.namesFile\)\s*:\s*await listTextModelNames\(\)/u,
  );
  assert.match(source, /arkcli\b[\s\S]*?"models",\s*"list",\s*"--modality",\s*"text",\s*"--page-all"/u);
});
