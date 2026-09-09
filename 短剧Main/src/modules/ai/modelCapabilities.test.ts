import assert from "node:assert/strict";
import test from "node:test";
import {
  ArkModelCapabilityParseError,
  CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS,
  ModelCapabilityLookup,
  parseArkModelCapability,
  parseTokenLimit,
  stageOutputBudget,
  type ModelCapabilityRecord,
  type ModelCapabilityStore,
} from "./modelCapabilities.js";

function record(overrides: Partial<ModelCapabilityRecord> = {}): ModelCapabilityRecord {
  return {
    modelName: "deepseek-v4-flash-ga",
    modelVersion: "260731",
    callableModelId: "deepseek-v4-flash-ga-260731",
    provider: "ark",
    contextWindowTokens: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 393_216,
    maxReasoningTokens: 393_216,
    rateLimitRpm: 500,
    rateLimitTpm: 1_000_000,
    dataSource: "provider_api",
    ...overrides,
  };
}

function store(rows: readonly ModelCapabilityRecord[]) {
  const calls: string[][] = [];
  const value: ModelCapabilityStore = {
    listCapabilities: async () => {
      calls.push(rows.map((row) => row.callableModelId));
      return rows;
    },
  };
  return { value, calls };
}

test("带单位的容量字符串按 1k=1024 换算成整数 token", () => {
  assert.equal(parseTokenLimit("1024k"), 1_048_576);
  assert.equal(parseTokenLimit("384k"), 393_216);
  assert.equal(parseTokenLimit("256k"), 262_144);
  assert.equal(parseTokenLimit("32k"), 32_768);
  assert.equal(parseTokenLimit("1m"), 1_048_576);
  // 纯数字与已带空格的写法都要吃下,供应商不保证格式稳定。
  assert.equal(parseTokenLimit("4096"), 4_096);
  assert.equal(parseTokenLimit(" 128K "), 131_072);
  assert.equal(parseTokenLimit(8_192), 8_192);
});

test("解析不出数字时返回 undefined,绝不猜一个值", () => {
  for (const bad of ["", "  ", "unlimited", "k", "abc", "-5", "0", "1.5.2k", null, undefined]) {
    assert.equal(parseTokenLimit(bad as never), undefined, `${String(bad)} 不该被解析成数字`);
  }
});

test("从 arkcli 单模型 JSON 抽出容量,调用 ID 由模型名与版本拼出", () => {
  const parsed = parseArkModelCapability({
    id: "deepseek-v4-flash-ga-260731",
    name: "deepseek-v4-flash-ga",
    primary_version: "260731",
    limits: {
      context_window: "1024k",
      max_input_token_length: "1024k",
      max_completion_token_length: "384k",
      max_reasoning_token_length: "384k",
    },
    rate_limit: { default_rate_limit: { rpm: 500, tpm: 1_000_000 } },
  });

  assert.equal(parsed.modelName, "deepseek-v4-flash-ga");
  assert.equal(parsed.modelVersion, "260731");
  assert.equal(parsed.callableModelId, "deepseek-v4-flash-ga-260731");
  assert.equal(parsed.maxOutputTokens, 393_216);
  assert.equal(parsed.contextWindowTokens, 1_048_576);
  assert.equal(parsed.rateLimitRpm, 500);
  assert.equal(parsed.rateLimitTpm, 1_000_000);
  assert.equal(parsed.dataSource, "provider_api");
});

test("arkcli 没返回 limits 或输出上限时抛出可识别错误,让同步器跳过而不是写脏数据", () => {
  assert.throws(
    () => parseArkModelCapability({ name: "doubao-embedding", primary_version: "240101" }),
    (error: unknown) => error instanceof ArkModelCapabilityParseError,
  );
  assert.throws(
    () => parseArkModelCapability({
      name: "some-model",
      primary_version: "240101",
      limits: { context_window: "32k" },
    }),
    (error: unknown) => error instanceof ArkModelCapabilityParseError,
  );
  // 缺版本号就拼不出调用 ID,同样不能落库。
  assert.throws(
    () => parseArkModelCapability({
      name: "some-model",
      limits: { max_completion_token_length: "32k" },
    }),
    (error: unknown) => error instanceof ArkModelCapabilityParseError,
  );
});

test("查表命中:按调用 ID 拿到模型自己的输出上限", async () => {
  const backing = store([record()]);
  const lookup = new ModelCapabilityLookup(backing.value);

  assert.equal(await lookup.maxOutputTokens("deepseek-v4-flash-ga-260731"), 393_216);
});

test("查表未命中:回落到保守默认值,不返回 0 或 undefined", async () => {
  const lookup = new ModelCapabilityLookup(store([record()]).value);

  const resolved = await lookup.maxOutputTokens("某个还没登记的模型");
  assert.equal(resolved, CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS);
  assert.ok(resolved > 0, "兜底必须是一个能真正发出请求的正数");
});

test("查表未命中时可分辨:调用方要能知道这是兜底而不是模型真实能力", async () => {
  const lookup = new ModelCapabilityLookup(store([record()]).value);

  assert.equal((await lookup.resolve("deepseek-v4-flash-ga-260731")).source, "registry");
  assert.equal((await lookup.resolve("未登记")).source, "fallback");
});

test("进程内缓存:多次查询只打一次库", async () => {
  const backing = store([record()]);
  const lookup = new ModelCapabilityLookup(backing.value);

  await lookup.maxOutputTokens("deepseek-v4-flash-ga-260731");
  await lookup.maxOutputTokens("doubao-seed-2-1-pro-260628");
  await lookup.maxOutputTokens("deepseek-v4-flash-ga-260731");

  assert.equal(backing.calls.length, 1, "每次调用都查库会把网关拖成 N+1");
});

test("缓存过期后重新查库,运维同步完不用重启服务", async () => {
  const backing = store([record()]);
  let clock = 0;
  const lookup = new ModelCapabilityLookup(backing.value, { ttlMs: 1_000, now: () => clock });

  await lookup.maxOutputTokens("deepseek-v4-flash-ga-260731");
  clock = 999;
  await lookup.maxOutputTokens("deepseek-v4-flash-ga-260731");
  assert.equal(backing.calls.length, 1);

  clock = 1_001;
  await lookup.maxOutputTokens("deepseek-v4-flash-ga-260731");
  assert.equal(backing.calls.length, 2);
});

test("查库失败时用保守兜底而不是让整个调用崩掉", async () => {
  const lookup = new ModelCapabilityLookup({
    listCapabilities: async () => { throw new Error("库连不上"); },
  });

  const resolved = await lookup.resolve("deepseek-v4-flash-ga-260731");
  assert.equal(resolved.maxOutputTokens, CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS);
  assert.equal(resolved.source, "fallback");
});

test("阶段输出预算留余量:拿到 384k 不等于就该传 384k", () => {
  // 留余量的三个理由见 stageOutputBudget 注释;这里只钉住可观察行为。
  const huge = stageOutputBudget(393_216);
  assert.ok(huge > 2_048, "剧本拆解就是被固定 2048 卡死的,必须能超过它");
  assert.ok(huge < 393_216, "整档打满会把超时与失败成本一起顶到最大");

  // 小容量模型不能被余量算法压到不可用。
  assert.ok(stageOutputBudget(4_096) > 0);
  assert.ok(stageOutputBudget(4_096) <= 4_096);
  assert.equal(stageOutputBudget(512), 512, "容量本就小于目标预算时按容量全给");

  // 单调不减:模型能力更强,预算不该更小。
  assert.ok(stageOutputBudget(262_144) >= stageOutputBudget(32_768));
  assert.ok(stageOutputBudget(32_768) >= stageOutputBudget(4_096));
});
