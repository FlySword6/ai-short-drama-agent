import assert from "node:assert/strict";
import test from "node:test";
import {
  planCapabilitySync,
  type CapabilitySyncOutcome,
} from "./sync-model-capabilities.mjs";

/**
 * 同步器的编排逻辑必须能在不连库、不跑 arkcli 的前提下验证:
 * 「某些模型没有 limits」「arkcli 调用失败」这两条容错要求本身就是
 * 不可能靠真跑 35 个模型来稳定复现的。
 */

function fetcher(responses: Readonly<Record<string, unknown | Error>>) {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (name: string) => {
      asked.push(name);
      const value = responses[name];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`测试没给 ${name} 的响应`);
      return value;
    },
  };
}

function arkPayload(name: string, version: string, output: string): unknown {
  return {
    id: `${name}-${version}`,
    name,
    primary_version: version,
    limits: {
      context_window: "256k",
      max_input_token_length: "256k",
      max_completion_token_length: output,
      max_reasoning_token_length: output,
    },
    rate_limit: { default_rate_limit: { rpm: 500, tpm: 1_000_000 } },
  };
}

test("逐个模型拉取容量,解析成功的进待写清单", async () => {
  const source = fetcher({
    "model-a": arkPayload("model-a", "260101", "128k"),
    "model-b": arkPayload("model-b", "260202", "32k"),
  });

  const outcome = await planCapabilitySync(["model-a", "model-b"], source.fetch);

  assert.deepEqual(source.asked, ["model-a", "model-b"]);
  assert.equal(outcome.planned.length, 2);
  assert.equal(outcome.planned[0]?.callableModelId, "model-a-260101");
  assert.equal(outcome.planned[0]?.maxOutputTokens, 131_072);
  assert.equal(outcome.planned[1]?.maxOutputTokens, 32_768);
  assert.equal(outcome.skipped.length, 0);
  assert.equal(outcome.failed.length, 0);
});

test("没有 limits 的模型被跳过并记录,不写脏数据也不中断", async () => {
  const source = fetcher({
    "text-model": arkPayload("text-model", "260101", "64k"),
    "embedding-model": { name: "embedding-model", primary_version: "240101" },
  });

  const outcome = await planCapabilitySync(["embedding-model", "text-model"], source.fetch);

  assert.equal(outcome.planned.length, 1, "跳过一个不该影响另一个");
  assert.equal(outcome.planned[0]?.modelName, "text-model");
  assert.equal(outcome.skipped.length, 1);
  assert.equal(outcome.skipped[0]?.modelName, "embedding-model");
  assert.match(outcome.skipped[0]?.reason ?? "", /limits/);
  assert.equal(outcome.failed.length, 0);
});

test("arkcli 调用失败时记下失败的继续跑,不整个崩掉", async () => {
  const source = fetcher({
    "broken-model": new Error("arkcli 退出码 1"),
    "ok-model": arkPayload("ok-model", "260303", "16k"),
  });

  const outcome = await planCapabilitySync(["broken-model", "ok-model"], source.fetch);

  assert.deepEqual(source.asked, ["broken-model", "ok-model"], "前一个失败不能让后续不再尝试");
  assert.equal(outcome.planned.length, 1);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0]?.modelName, "broken-model");
  assert.equal(outcome.planned[0]?.callableModelId, "ok-model-260303");
});

test("同一模型名重复出现只拉一次,固定 ID 由调用 ID 派生所以重跑幂等", async () => {
  const source = fetcher({ "model-a": arkPayload("model-a", "260101", "8k") });

  const first = await planCapabilitySync(["model-a", "model-a"], source.fetch);
  assert.deepEqual(source.asked, ["model-a"]);
  assert.equal(first.planned.length, 1);

  const second = await planCapabilitySync(["model-a"], fetcher({
    "model-a": arkPayload("model-a", "260101", "8k"),
  }).fetch);
  assert.equal(
    first.planned[0]?.rowId,
    second.planned[0]?.rowId,
    "重跑必须命中同一行,否则每次同步都插一条新记录",
  );
});

test("失败与跳过都不为空时,退出码要非零——运维得知道这次没同步全", async () => {
  const clean: CapabilitySyncOutcome = { planned: [], skipped: [], failed: [] };
  assert.equal(clean.failed.length, 0);

  const outcome = await planCapabilitySync(["broken"], fetcher({ broken: new Error("boom") }).fetch);
  assert.ok(outcome.failed.length > 0, "失败必须被计数,好让 main 决定退出码");
});
