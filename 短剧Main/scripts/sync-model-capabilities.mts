#!/usr/bin/env tsx
/**
 * sync-model-capabilities —— 把火山方舟的模型容量同步进 model_capabilities 表。
 *
 * 为什么是脚本而不是服务启动时同步:arkcli 是外部命令行进程。把它放进服务
 * 启动路径或请求链路,等于让一个外部二进制的可用性决定 API 的可用性。
 * 这是运维动作,手动或定时跑。
 *
 * 数据来源:`arkcli models get <模型名>` 的 `limits` 与 `rate_limit`。
 * 注意 `arkcli models list` **不返回** limits,只有 `models get` 返回,
 * 所以必须逐个模型拉——35 个文本模型就是 35 次外部调用。
 *
 * 模型名清单:默认 `arkcli models list --modality text --page-all`(供应商实况,
 * 长期可用);`--names-file <path>` 可读一行一个模型名的本地清单(离线复跑用)。
 *
 * 三条容错都是硬要求:
 *   - "1024k" 这种带单位字符串在写入前换算成整数(口径在 modelCapabilities.ts);
 *   - 某些模型(embedding、router 等)没有 limits → 跳过并记录,不写脏数据;
 *   - 单个 arkcli 调用失败 → 记下失败继续跑剩下的,不整批崩掉。
 *
 * 用法:
 *   npx tsx scripts/sync-model-capabilities.mts                 # dry-run,只打印计划
 *   npx tsx scripts/sync-model-capabilities.mts --apply         # 真写库
 *   npx tsx scripts/sync-model-capabilities.mts --names-file /tmp/ark_model_names.txt
 *
 * 退出码:有模型拉取失败时非零,好让定时任务发现「这次没同步全」。
 * 跳过不算失败——没有 limits 是供应商的事实,不是同步器的故障。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createDatabase } from "../src/db/client.js";
import {
  ArkModelCapabilityParseError,
  DrizzleModelCapabilityStore,
  parseArkModelCapability,
  type ModelCapabilityRecord,
} from "../src/modules/ai/modelCapabilities.js";

const execFileAsync = promisify(execFile);

/** arkcli 单次调用的上限。逐个拉 35 个模型时一个卡住的调用不该拖垮整批。 */
const ARKCLI_TIMEOUT_MS = 60_000;

export interface PlannedCapability extends ModelCapabilityRecord {
  /**
   * 行 ID 由调用 ID 派生而非随机:同步器重跑必须命中同一行,
   * 否则每次同步都插一条新记录。
   */
  rowId: string;
}

export interface SkippedModel {
  modelName: string;
  reason: string;
}

export interface CapabilitySyncOutcome {
  planned: PlannedCapability[];
  skipped: SkippedModel[];
  failed: SkippedModel[];
}

export type ArkModelFetcher = (modelName: string) => Promise<unknown>;

/** 由调用 ID 稳定派生 UUID v4 形状的行 ID。 */
export function capabilityRowId(callableModelId: string): string {
  const digest = createHash("sha256").update("model_capabilities\0").update(callableModelId).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

/**
 * 逐个拉取并分类。纯编排,不连库不起进程,所以能被测试完整覆盖
 * ——「没有 limits」「arkcli 失败」这两条容错不可能靠真跑稳定复现。
 */
export async function planCapabilitySync(
  modelNames: readonly string[],
  fetchModel: ArkModelFetcher,
): Promise<CapabilitySyncOutcome> {
  const outcome: CapabilitySyncOutcome = { planned: [], skipped: [], failed: [] };
  const seen = new Set<string>();
  for (const modelName of modelNames) {
    if (seen.has(modelName)) continue;
    seen.add(modelName);
    let payload: unknown;
    try {
      payload = await fetchModel(modelName);
    } catch (error) {
      outcome.failed.push({ modelName, reason: errorText(error) });
      continue;
    }
    try {
      const record = parseArkModelCapability(payload as Parameters<typeof parseArkModelCapability>[0]);
      outcome.planned.push({ ...record, rowId: capabilityRowId(record.callableModelId) });
    } catch (error) {
      if (error instanceof ArkModelCapabilityParseError) {
        outcome.skipped.push({ modelName, reason: error.message });
        continue;
      }
      outcome.failed.push({ modelName, reason: errorText(error) });
    }
  }
  return outcome;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runArkcli(args: readonly string[]): Promise<unknown> {
  const { stdout } = await execFileAsync("arkcli", [...args], {
    timeout: ARKCLI_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

const arkcliFetcher: ArkModelFetcher = (modelName) => runArkcli(["models", "get", modelName]);

async function listTextModelNames(): Promise<string[]> {
  const payload = await runArkcli(["models", "list", "--modality", "text", "--page-all"]);
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error("arkcli models list 没返回 items 数组");
  return items
    .map((item) => (item as { name?: unknown }).name)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
}

async function readNamesFile(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, "utf8");
  return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}

interface CliArgs {
  apply: boolean;
  namesFile?: string;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--names-file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--names-file 需要一个路径");
      args.namesFile = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${token}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const modelNames = args.namesFile ? await readNamesFile(args.namesFile) : await listTextModelNames();
  process.stdout.write(`准备同步 ${modelNames.length} 个模型的容量\n`);

  const outcome = await planCapabilitySync(modelNames, arkcliFetcher);
  for (const item of outcome.planned) {
    process.stdout.write(
      `  ✓ ${item.callableModelId}: 输出上限 ${item.maxOutputTokens}`
      + `, 上下文 ${item.contextWindowTokens ?? "未知"}\n`,
    );
  }
  for (const item of outcome.skipped) process.stdout.write(`  – 跳过 ${item.modelName}: ${item.reason}\n`);
  for (const item of outcome.failed) process.stderr.write(`  ✖ 拉取失败 ${item.modelName}: ${item.reason}\n`);

  if (!args.apply) {
    process.stdout.write(
      `\ndry-run:可写 ${outcome.planned.length} 条,跳过 ${outcome.skipped.length} 条,`
      + `失败 ${outcome.failed.length} 条。加 --apply 才真写库。\n`,
    );
    if (outcome.failed.length > 0) process.exitCode = 1;
    return;
  }

  const handle = createDatabase();
  try {
    const store = new DrizzleModelCapabilityStore(handle.db);
    const now = new Date();
    let inserted = 0;
    let updated = 0;
    for (const item of outcome.planned) {
      const { rowId, ...record } = item;
      // 单条失败不该丢掉已经拉到的其余容量。
      try {
        if (await store.upsert(record, rowId, now) === "inserted") inserted += 1;
        else updated += 1;
      } catch (error) {
        outcome.failed.push({ modelName: record.callableModelId, reason: `写库失败: ${errorText(error)}` });
      }
    }
    process.stdout.write(
      `\n已写入:新增 ${inserted} 条、更新 ${updated} 条;`
      + `跳过 ${outcome.skipped.length} 条、失败 ${outcome.failed.length} 条。\n`,
    );
  } finally {
    await handle.pool.end();
  }
  if (outcome.failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${errorText(error)}\n`);
    process.exitCode = 1;
  });
}
