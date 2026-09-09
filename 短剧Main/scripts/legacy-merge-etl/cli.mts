#!/usr/bin/env tsx
/**
 * 合流一期 ETL CLI。真源:docs/contracts/common-to-v020-mapping.md §4。
 *
 * 用法:
 *   tsx scripts/legacy-merge-etl/cli.mts plan     [--domains user,project] [选项]
 *   tsx scripts/legacy-merge-etl/cli.mts apply    --import-owner <uuid> [选项]
 *   tsx scripts/legacy-merge-etl/cli.mts verify   --run <runId> [选项]
 *   tsx scripts/legacy-merge-etl/cli.mts rollback --run <runId> --closure <closureKey> [选项]
 *
 * 选项:
 *   --source-url <url>        源库连接串(或 env LEGACY_ETL_SOURCE_URL)
 *   --target-url <url>        目标库连接串(或 env LEGACY_ETL_TARGET_URL)
 *   --source-schema <name>    源 schema(默认 common)
 *   --target-schema <name>    目标 schema(默认 public)
 *   --allow-remote            允许读非本机源库(Fable 获批窗口专用;目标仍只许本机)
 *   --allow-remote-target     允许写非本机目标库(R30 批准的 dev/test 导入专用;
 *                             必须与 --allow-remote 同显式给出,双开关齐备才放行)
 *   --import-owner <uuid>     apply 必需:迁入行的 owner/added_by 归属用户
 *   --decisions <path.json>   users/projects 人工决定文件(契约 §3 manual_confirmed)
 *   --asset-quarantine <path.json>  人工指定隔离的 asset_entities 名单(带病不导,留账待人工)
 *   --with-prompts            迁移分镜提示词闭包(默认关,契约 §2.7 决策待 DC)
 *   --compose-director-prompt 场景/运镜/灯光/声音拼接入 director_prompt(默认关)
 *   --auto-create-episodes    目标缺 episode 时自动创建(默认关 → 分镜隔离)
 *   --domains <a,b,c>         子集:user,project,asset,pricing_rule(默认全部)
 *   --started-by <name>       操作人标识(落运行账)
 *   --freeze-at <ISO 时间>    取价冻结时刻(默认当前时刻)
 *
 * 铁律:plan(dry-run)是默认姿态,只写运行/闭包账;apply 才写业务表,
 * 且必须显式命令 + --import-owner。未 --allow-remote 时源与目标都必须是本机。
 */

import { readFileSync } from "node:fs";
import { Client } from "pg";
import { assertSafeEndpoints, assertSafeSchemaName, quoteIdent, assertSafeWriteTarget } from "./lib/guards.mts";
import { parseAssetQuarantine, type AssetQuarantineEntry } from "./lib/quarantine.mts";
import { executeRun, rollbackClosure, type EtlRunConfig } from "./lib/runner.mts";
import { pgTimestampToMs, type ManualDecision } from "./lib/transforms.mts";
import { buildGlobalVerificationQueries } from "./lib/verify.mts";

interface CliArgs {
  command: string;
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): CliArgs {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) throw new Error(`无法解析参数: ${token}`);
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`--${name} 需要一个值`);
  return value;
}

function requireString(flags: Map<string, string | boolean>, name: string, envName?: string): string {
  const value = stringFlag(flags, name) ?? (envName ? process.env[envName] : undefined);
  if (!value) throw new Error(`缺少 --${name}${envName ? `(或 env ${envName})` : ""}`);
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loadDecisions(path: string | undefined): { users: Map<string, ManualDecision>; projects: Map<string, ManualDecision> } {
  const empty = { users: new Map<string, ManualDecision>(), projects: new Map<string, ManualDecision>() };
  if (!path) return empty;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    users?: Record<string, ManualDecision>;
    projects?: Record<string, ManualDecision>;
  };
  const validate = (domain: string, sourcePk: string, entry: ManualDecision): void => {
    if (!entry || entry.decision !== "new" || typeof entry.decidedBy !== "string" || entry.decidedBy.trim() === "") {
      throw new Error(`决定文件 ${domain}["${sourcePk}"] 非法:必须是 { "decision": "new", "decidedBy": "<审批人>" }(契约 §3 只许 manual_confirmed 新发,不自动合并)`);
    }
  };
  for (const [sourcePk, entry] of Object.entries(parsed.users ?? {})) {
    validate("users", sourcePk, entry);
    empty.users.set(sourcePk, entry);
  }
  for (const [sourcePk, entry] of Object.entries(parsed.projects ?? {})) {
    validate("projects", sourcePk, entry);
    empty.projects.set(sourcePk, entry);
  }
  return empty;
}

function loadAssetQuarantine(path: string | undefined): Map<string, AssetQuarantineEntry> {
  if (!path) return new Map<string, AssetQuarantineEntry>();
  return parseAssetQuarantine(JSON.parse(readFileSync(path, "utf8")));
}

function buildRunConfig(flags: Map<string, string | boolean>, mode: "dry_run" | "apply"): EtlRunConfig {
  const sourceUrl = requireString(flags, "source-url", "LEGACY_ETL_SOURCE_URL");
  const targetUrl = requireString(flags, "target-url", "LEGACY_ETL_TARGET_URL");
  const allowRemote = flags.has("allow-remote") || process.env.LEGACY_ETL_ALLOW_REMOTE === "1";
  const allowRemoteTarget = flags.has("allow-remote-target") || process.env.LEGACY_ETL_ALLOW_REMOTE_TARGET === "1";
  assertSafeEndpoints({ sourceUrl, targetUrl, allowRemote, allowRemoteTarget });
  const sourceSchema = assertSafeSchemaName(stringFlag(flags, "source-schema") ?? "common");
  const targetSchema = assertSafeSchemaName(stringFlag(flags, "target-schema") ?? "public");
  const importOwnerId = stringFlag(flags, "import-owner") ?? null;
  if (mode === "apply") {
    if (!importOwnerId || !UUID_PATTERN.test(importOwnerId)) {
      throw new Error("apply 必须提供 --import-owner <uuid>(批准的 import owner 用户)");
    }
  }
  const freezeAtRaw = stringFlag(flags, "freeze-at");
  const freezeAtMs = freezeAtRaw ? pgTimestampToMs(freezeAtRaw) : Date.now();
  if (freezeAtMs === null) throw new Error(`--freeze-at 时间戳无法解析: ${freezeAtRaw}`);
  const decisions = loadDecisions(stringFlag(flags, "decisions"));
  const domainsRaw = stringFlag(flags, "domains");
  const domains = new Set(
    (domainsRaw ? domainsRaw.split(",") : ["user", "project", "asset", "pricing_rule"])
      .map((domain) => {
        const trimmed = domain.trim();
        if (!["user", "project", "asset", "pricing_rule"].includes(trimmed)) {
          throw new Error(`未知域: ${trimmed}(可选 user,project,asset,pricing_rule)`);
        }
        return trimmed as "user" | "project" | "asset" | "pricing_rule";
      }),
  );
  return {
    sourceUrl, targetUrl, sourceSchema, targetSchema, mode,
    importOwnerId,
    userDecisions: decisions.users,
    projectDecisions: decisions.projects,
    withPrompts: flags.has("with-prompts"),
    composeDirectorPrompt: flags.has("compose-director-prompt"),
    autoCreateEpisodes: flags.has("auto-create-episodes"),
    startedBy: stringFlag(flags, "started-by") ?? null,
    freezeAt: new Date(freezeAtMs).toISOString(),
    domains,
    assetQuarantine: loadAssetQuarantine(stringFlag(flags, "asset-quarantine")),
  };
}

async function cmdVerify(flags: Map<string, string | boolean>): Promise<void> {
  const targetUrl = requireString(flags, "target-url", "LEGACY_ETL_TARGET_URL");
  const targetSchema = assertSafeSchemaName(stringFlag(flags, "target-schema") ?? "public");
  const runId = requireString(flags, "run");
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const run = await client.query<{ id: string; mode: string; status: string }>(
      `SELECT id, mode, status FROM ${quoteIdent(targetSchema)}.legacy_import_runs WHERE id=$1`, [runId],
    );
    if (!run.rows[0]) throw new Error(`运行不存在: ${runId}`);
    console.log(`运行 ${runId} mode=${run.rows[0].mode} status=${run.rows[0].status}`);
    let hardFails = 0;
    for (const query of buildGlobalVerificationQueries(runId)) {
      const sql = query.sql.replaceAll("{{schema}}", quoteIdent(targetSchema));
      let rows: Record<string, unknown>[];
      try {
        const result = await client.query(sql);
        rows = result.rows as Record<string, unknown>[];
      } catch (error) {
        // 核对查询本身执行失败(如账本表尚未建)就是一项人工处置发现,不得静默。
        hardFails += 1;
        console.log(`FAIL ${query.name} — 查询执行失败: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const zeroExpected = query.expect.startsWith("= 0 行");
      const bad = zeroExpected ? rows.length : 0;
      if (bad > 0) hardFails += 1;
      console.log(`${bad > 0 ? "FAIL" : "ok  "} ${query.name} — ${query.expect};实际返回 ${rows.length} 行`);
      for (const row of rows.slice(0, 10)) console.log(`     ${JSON.stringify(row)}`);
    }
    const closures = await client.query<{ verify_bucket: string | null; status: string; count: string }>(
      `SELECT verify_bucket, status, count(*)::text AS count FROM ${quoteIdent(targetSchema)}.legacy_import_closures WHERE run_id=$1 GROUP BY verify_bucket, status ORDER BY 1, 2`,
      [runId],
    );
    console.log("闭包账分布:");
    for (const row of closures.rows) console.log(`  bucket=${row.verify_bucket ?? "-"} status=${row.status} count=${row.count}`);
    if (hardFails > 0) {
      console.error(`全局核对 ${hardFails} 项未过——按契约先人工处置,不得宣布完成`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "plan": {
      const summary = await executeRun(buildRunConfig(flags, "dry_run"));
      console.log(`dry-run 完成 runId=${summary.runId}(只落账,未动业务表)`);
      console.log(JSON.stringify({ tally: summary.tally, buckets: summary.buckets }, null, 2));
      return;
    }
    case "apply": {
      const summary = await executeRun(buildRunConfig(flags, "apply"));
      console.log(`apply 完成 runId=${summary.runId}`);
      console.log(JSON.stringify({ tally: summary.tally, buckets: summary.buckets }, null, 2));
      if (summary.tally.failed > 0 || summary.buckets.failed > 0) process.exitCode = 1;
      return;
    }
    case "verify":
      await cmdVerify(flags);
      return;
    case "rollback": {
      const targetUrl = requireString(flags, "target-url", "LEGACY_ETL_TARGET_URL");
      const targetSchema = assertSafeSchemaName(stringFlag(flags, "target-schema") ?? "public");
      const allowRemote = flags.has("allow-remote") || process.env.LEGACY_ETL_ALLOW_REMOTE === "1";
      const allowRemoteTarget = flags.has("allow-remote-target") || process.env.LEGACY_ETL_ALLOW_REMOTE_TARGET === "1";
      assertSafeWriteTarget({ targetUrl, allowRemote, allowRemoteTarget });
      const runId = requireString(flags, "run");
      const closureKey = requireString(flags, "closure");
      const result = await rollbackClosure({ targetUrl, targetSchema, runId, closureKey });
      console.log(`闭包 ${closureKey} 已回滚:${JSON.stringify(result.deleted)}`);
      return;
    }
    default:
      console.error("用法: cli.mts plan|apply|verify|rollback [选项](见文件头注释)");
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`ETL 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
