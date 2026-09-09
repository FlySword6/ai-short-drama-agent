#!/usr/bin/env tsx
/**
 * S40 存量 clearance 体检(只读)。
 *
 * 扫描全部 asset_entities.clearance(含已软删行——软删行的权利位仍是正式事实),
 * 用与写入路径完全相同的校验(src/db/schema.ts 的 inspectAssetClearance)逐行判定,
 * 按不合法类型分组报告。合法但缺省了部分权利位的行单独计数——缺省位按
 * fail-safe 默认值生效,不算不合法。
 *
 * 不设 --fix,也不会有任何写操作:修这几个位等于改一条资产的商用权利,不可逆,
 * 处置存量须 Fable 取 DC 授权后另做。会话级 default_transaction_read_only=on
 * 兜底,即使将来有人误加写语句也会被 PostgreSQL 直接拒绝。
 *
 * 用法:
 *   npx tsx scripts/check-asset-clearance.mts
 *
 * 退出码:
 *   0  全部合法
 *   1  存在不合法行(报告写在 stdout)
 *   2  无法完成体检(缺数据库配置、连接失败等,原因写在 stderr)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { settings } from "../src/config/env.js";
import { buildDatabasePoolConfig } from "../src/db/client.js";
import { quoteIdentifier } from "../src/db/migrate.js";
import {
  assetClearanceKeys,
  inspectAssetClearance,
  type AssetClearanceIssue,
} from "../src/db/schema.js";

/** 每个不合法分组最多列出的行数;超出的只报数,防止输出被刷爆。 */
const GROUP_SAMPLE_LIMIT = 50;

const READ_ONLY_SESSION_OPTIONS = [
  "-c default_transaction_read_only=on",
  "-c statement_timeout=60000",
].join(" ");

export interface ClearanceAuditRow {
  id: string;
  deleted: boolean;
  clearance: unknown;
}

export interface ClearanceAuditInvalidRow {
  id: string;
  deleted: boolean;
  issues: string[];
}

export interface ClearanceAuditGroup {
  /** 问题类型标签: not_object | unknown_bit:<key> | non_boolean_bit:<key> */
  label: string;
  rows: ClearanceAuditInvalidRow[];
}

export interface ClearanceAuditSummary {
  total: number;
  valid: number;
  invalid: number;
  /** 合法但缺省了部分已知位的行数(缺省位按 fail-safe 默认值生效)。 */
  validWithDefaultedBits: number;
  /** 合法行中各已知位的缺省行数。 */
  defaultedBitCounts: Record<string, number>;
  groups: ClearanceAuditGroup[];
}

export function groupLabel(issue: AssetClearanceIssue): string {
  return issue.key === undefined ? issue.kind : `${issue.kind}:${issue.key}`;
}

/** 纯函数:逐行判定并分组。一行触发多类问题时,每类分组里都会出现它。 */
export function summarizeClearanceAudit(rows: ClearanceAuditRow[]): ClearanceAuditSummary {
  const groupMap = new Map<string, ClearanceAuditInvalidRow[]>();
  const defaultedBitCounts: Record<string, number> = {};
  let valid = 0;
  let validWithDefaultedBits = 0;
  let invalid = 0;

  for (const row of rows) {
    const issues = inspectAssetClearance(row.clearance);
    const entry: ClearanceAuditInvalidRow = {
      id: row.id,
      deleted: row.deleted,
      issues: issues.map((issue) => issue.message),
    };
    if (issues.length > 0) {
      invalid += 1;
      for (const label of new Set(issues.map(groupLabel))) {
        const bucket = groupMap.get(label) ?? [];
        bucket.push(entry);
        groupMap.set(label, bucket);
      }
      continue;
    }
    valid += 1;
    const record = row.clearance as Record<string, unknown>;
    const missing = assetClearanceKeys.filter((key) => !(key in record));
    if (missing.length > 0) {
      validWithDefaultedBits += 1;
      for (const key of missing) defaultedBitCounts[key] = (defaultedBitCounts[key] ?? 0) + 1;
    }
  }

  const groups = [...groupMap.entries()]
    .map(([label, groupRows]) => ({ label, rows: groupRows }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return {
    total: rows.length,
    valid,
    invalid,
    validWithDefaultedBits,
    defaultedBitCounts,
    groups,
  };
}

export function renderClearanceAuditReport(schema: string, summary: ClearanceAuditSummary): string {
  const lines: string[] = [];
  lines.push(`clearance 存量体检(只读,schema: ${schema})`);
  lines.push(`扫描 asset_entities 共 ${summary.total} 行`);
  lines.push(
    `✔ 合法 ${summary.valid} 行(其中 ${summary.validWithDefaultedBits} 行缺省了部分权利位,按 fail-safe 默认值生效)`,
  );
  const defaulted = assetClearanceKeys
    .filter((key) => (summary.defaultedBitCounts[key] ?? 0) > 0)
    .map((key) => `${key}×${summary.defaultedBitCounts[key]}`);
  if (defaulted.length > 0) {
    lines.push(`  缺省位分布: ${defaulted.join(", ")}`);
  }
  lines.push(`✖ 不合法 ${summary.invalid} 行`);
  for (const group of summary.groups) {
    lines.push(`  [${group.label}] ${group.rows.length} 行`);
    for (const row of group.rows.slice(0, GROUP_SAMPLE_LIMIT)) {
      lines.push(`    - ${row.id}${row.deleted ? "(已软删)" : ""} ${row.issues.join("; ")}`);
    }
    if (group.rows.length > GROUP_SAMPLE_LIMIT) {
      lines.push(`    …另有 ${group.rows.length - GROUP_SAMPLE_LIMIT} 行未列出`);
    }
  }
  if (summary.invalid > 0) {
    lines.push(
      `结论: FAIL——发现 ${summary.invalid} 行不合法 clearance。本脚本不做任何修改;处置存量需 DC 授权后另行进行。`,
    );
  } else {
    lines.push("结论: PASS——存量 clearance 全部合法。");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (!settings.databaseUrl) {
    process.stderr.write(
      "缺少数据库配置: 请设置 DATABASE_URL 或完整 POSTGRES_* 变量(可放 .env),再运行本体检。\n",
    );
    process.exitCode = 2;
    return;
  }
  const pool = new Pool({
    ...buildDatabasePoolConfig(settings.databaseUrl),
    max: 1,
    options: READ_ONLY_SESSION_OPTIONS,
  });
  try {
    const schema = settings.postgresSchema;
    const result = await pool.query<ClearanceAuditRow>(
      `SELECT id::text AS id, (deleted_at IS NOT NULL) AS deleted, clearance
         FROM ${quoteIdentifier(schema)}.asset_entities
        ORDER BY id`,
    );
    const summary = summarizeClearanceAudit(result.rows);
    process.stdout.write(`${renderClearanceAuditReport(schema, summary)}\n`);
    if (summary.invalid > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`体检未能完成: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
