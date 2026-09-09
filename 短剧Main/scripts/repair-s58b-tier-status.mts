#!/usr/bin/env tsx
/**
 * repair-s58b-tier-status —— 收敛 S58 已播入数据库、但未被 S58b seed 自动覆盖的旧脏态。
 *
 * 安全语义:
 *   - 默认 dry-run；只有 --apply 才写。
 *   - --database-url 与 --schema 都必须显式提供，不读取 cwd .env 作为连接或 schema 默认值。
 *   - --apply 只允许回环地址，且拒绝 prod/test 数据库或 prod schema；远端 URL 仅可 dry-run。
 *   - 推算档只用 pricingRuleProvenance.ts 的 provenance 谓词识别，不使用数据库行 id 清单。
 *   - 28 个推算档变为 active=false、capability_tier.status=experimental，并移除其历史
 *     supports_input_video 键；旧 80 分视频固定档也移除该键，但保持 active/status 不变。
 *   - 23 个推算视频档与旧 80 分视频固定档只把 S58 的 value_sources.params 旧文案
 *     精确替换为 S58b seed 文案；价格、tier_id、档位 params 与既有状态逻辑均不扩写。
 *   - apply 在单事务内锁定目标快照；写前打印 before/projected-after，写后验证实际状态。
 *   - 已修复数据库复跑 changed_rows=0。
 *
 * 用法:
 *   npx tsx scripts/repair-s58b-tier-status.mts \
 *     --database-url postgresql://... --schema app
 *   npx tsx scripts/repair-s58b-tier-status.mts \
 *     --database-url postgresql://... --schema app --apply
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { isInferredExperimentalPricingRule } from "../src/shared/pricingRuleProvenance.js";

export const S58_INFERRED_ROW_COUNT = 28;
export const S58_VALUE_SOURCES_ROW_COUNT = 24;
export const LEGACY_NO_INPUT_VIDEO_TIER_ID = "vid-seedance20fast-916-720p-4s";
export const S58_INFERRED_VIDEO_VALUE_SOURCE_OLD_FRAGMENT =
  "supports_input_video:官方含视频输入单价更低,成本被覆盖;";
export const S58_INFERRED_VIDEO_VALUE_SOURCE_CURRENT_FRAGMENT =
  "官方公式不授权视频参考报价,本档不写 supports_input_video;";
export const S58_LEGACY_VIDEO_VALUE_SOURCE_OLD_FRAGMENT =
  "supports_input_video=true:视频参考报价放行位(v0.1.1 合同);";
export const S58_LEGACY_VIDEO_VALUE_SOURCE_CURRENT_FRAGMENT =
  "旧 80 分固定档仅覆盖无输入视频,不写 supports_input_video;";

export interface S58bRepairRow {
  id: string;
  active: boolean;
  metadata: Record<string, unknown>;
}

export interface S58bRepairCounts {
  total: number;
  active: number;
  inactive: number;
  experimental: number;
  inferred: number;
  inferredActive: number;
  inferredExperimental: number;
  supportsInputVideoKeys: number;
  inferredSupportsInputVideoKeys: number;
  legacySupportsInputVideoKeys: number;
  valueSourcesTargetRows: number;
  staleValueSourcesRows: number;
  currentValueSourcesRows: number;
  invalidValueSourcesRows: number;
}

export interface S58bRepairAction {
  id: string;
  active: boolean;
  metadata: Record<string, unknown>;
  reasons: string[];
}

export interface S58bRepairPlan {
  before: S58bRepairCounts;
  after: S58bRepairCounts;
  actions: S58bRepairAction[];
  errors: string[];
  legacyTierRows: number;
}

export interface S58bRepairCliOptions {
  apply: boolean;
  databaseUrl: string;
  schema: string;
}

interface PricingRuleDbRow {
  id: string;
  active: boolean;
  metadata: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function capabilityTier(metadata: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(metadata.capability_tier) ? metadata.capability_tier : null;
}

function capabilityTierId(metadata: Record<string, unknown>): string | null {
  const tierId = capabilityTier(metadata)?.tier_id;
  return typeof tierId === "string" ? tierId : null;
}

function capabilityTierStatus(metadata: Record<string, unknown>): string | null {
  const status = capabilityTier(metadata)?.status;
  return typeof status === "string" ? status : null;
}

interface ValueSourcesRewriteRule {
  oldFragment: string;
  currentFragment: string;
}

type ValueSourcesState = "stale" | "current" | "invalid";

function valueSourcesRewriteRule(
  metadata: Record<string, unknown>,
): ValueSourcesRewriteRule | null {
  const tierId = capabilityTierId(metadata);
  if (tierId === LEGACY_NO_INPUT_VIDEO_TIER_ID) {
    return {
      oldFragment: S58_LEGACY_VIDEO_VALUE_SOURCE_OLD_FRAGMENT,
      currentFragment: S58_LEGACY_VIDEO_VALUE_SOURCE_CURRENT_FRAGMENT,
    };
  }
  if (isInferredExperimentalPricingRule(metadata) && tierId?.startsWith("vid-")) {
    return {
      oldFragment: S58_INFERRED_VIDEO_VALUE_SOURCE_OLD_FRAGMENT,
      currentFragment: S58_INFERRED_VIDEO_VALUE_SOURCE_CURRENT_FRAGMENT,
    };
  }
  return null;
}

function valueSourcesParams(metadata: Record<string, unknown>): string | null {
  const valueSources = metadata.value_sources;
  if (!isRecord(valueSources)) return null;
  return typeof valueSources.params === "string" ? valueSources.params : null;
}

function fragmentCount(value: string, fragment: string): number {
  return value.split(fragment).length - 1;
}

function valueSourcesState(
  metadata: Record<string, unknown>,
  rule: ValueSourcesRewriteRule,
): ValueSourcesState {
  const params = valueSourcesParams(metadata);
  if (params === null) return "invalid";
  const oldCount = fragmentCount(params, rule.oldFragment);
  const currentCount = fragmentCount(params, rule.currentFragment);
  if (oldCount === 1 && currentCount === 0) return "stale";
  if (oldCount === 0 && currentCount === 1) return "current";
  return "invalid";
}

function rewriteValueSourcesParams(
  metadata: Record<string, unknown>,
  rule: ValueSourcesRewriteRule,
): Record<string, unknown> {
  const valueSources = metadata.value_sources;
  const params = valueSourcesParams(metadata);
  if (!isRecord(valueSources) || params === null) {
    throw new Error("value_sources.params 不是字符串");
  }
  return {
    ...metadata,
    value_sources: {
      ...valueSources,
      params: params.replace(rule.oldFragment, rule.currentFragment),
    },
  };
}

function summarize(rows: readonly S58bRepairRow[]): S58bRepairCounts {
  let active = 0;
  let experimental = 0;
  let inferred = 0;
  let inferredActive = 0;
  let inferredExperimental = 0;
  let supportsInputVideoKeys = 0;
  let inferredSupportsInputVideoKeys = 0;
  let legacySupportsInputVideoKeys = 0;
  let valueSourcesTargetRows = 0;
  let staleValueSourcesRows = 0;
  let currentValueSourcesRows = 0;
  let invalidValueSourcesRows = 0;

  for (const row of rows) {
    const isInferred = isInferredExperimentalPricingRule(row.metadata);
    const isExperimental = capabilityTierStatus(row.metadata) === "experimental";
    const hasSupportsKey = hasOwn(row.metadata, "supports_input_video");
    const isLegacy = capabilityTierId(row.metadata) === LEGACY_NO_INPUT_VIDEO_TIER_ID;
    if (row.active) active += 1;
    if (isExperimental) experimental += 1;
    if (isInferred) {
      inferred += 1;
      if (row.active) inferredActive += 1;
      if (isExperimental) inferredExperimental += 1;
      if (hasSupportsKey) inferredSupportsInputVideoKeys += 1;
    }
    if (hasSupportsKey) supportsInputVideoKeys += 1;
    if (isLegacy && hasSupportsKey) legacySupportsInputVideoKeys += 1;
    const rewriteRule = valueSourcesRewriteRule(row.metadata);
    if (rewriteRule) {
      valueSourcesTargetRows += 1;
      const state = valueSourcesState(row.metadata, rewriteRule);
      if (state === "stale") staleValueSourcesRows += 1;
      else if (state === "current") currentValueSourcesRows += 1;
      else invalidValueSourcesRows += 1;
    }
  }

  return {
    total: rows.length,
    active,
    inactive: rows.length - active,
    experimental,
    inferred,
    inferredActive,
    inferredExperimental,
    supportsInputVideoKeys,
    inferredSupportsInputVideoKeys,
    legacySupportsInputVideoKeys,
    valueSourcesTargetRows,
    staleValueSourcesRows,
    currentValueSourcesRows,
    invalidValueSourcesRows,
  };
}

/**
 * 纯逻辑修复规划器。传入值与返回值都不修改调用方对象。
 */
export function planS58bTierStatusRepair(rows: readonly S58bRepairRow[]): S58bRepairPlan {
  const actions: S58bRepairAction[] = [];
  const errors: string[] = [];
  const projectedRows: S58bRepairRow[] = [];
  let legacyTierRows = 0;

  for (const row of rows) {
    const inferred = isInferredExperimentalPricingRule(row.metadata);
    const legacy = capabilityTierId(row.metadata) === LEGACY_NO_INPUT_VIDEO_TIER_ID;
    if (legacy) legacyTierRows += 1;

    if (inferred && !capabilityTier(row.metadata)) {
      errors.push(`${row.id}:推算来源行缺少合法 metadata.capability_tier`);
      projectedRows.push({ ...row, metadata: { ...row.metadata } });
      continue;
    }

    let nextActive = row.active;
    let nextMetadata: Record<string, unknown> = { ...row.metadata };
    const reasons: string[] = [];

    if (inferred) {
      if (nextActive) {
        nextActive = false;
        reasons.push("active:true->false");
      }
      const tier = capabilityTier(nextMetadata)!;
      if (tier.status !== "experimental") {
        nextMetadata = {
          ...nextMetadata,
          capability_tier: { ...tier, status: "experimental" },
        };
        reasons.push("capability_tier.status->experimental");
      }
    }

    // S58 给全部视频档写过该键；推算 provenance 不构成视频参考定价授权，
    // 旧固定档也被合同永久限定为无输入视频。删除键而非写 false，和 S58b seed 形状一致。
    if ((inferred || legacy) && hasOwn(nextMetadata, "supports_input_video")) {
      delete nextMetadata.supports_input_video;
      reasons.push("remove supports_input_video");
    }

    const rewriteRule = valueSourcesRewriteRule(nextMetadata);
    if (rewriteRule) {
      const state = valueSourcesState(nextMetadata, rewriteRule);
      if (state === "invalid") {
        errors.push(`${row.id}:value_sources.params 不符合 S58/S58b 已知文案,拒绝猜改`);
      } else if (state === "stale") {
        nextMetadata = rewriteValueSourcesParams(nextMetadata, rewriteRule);
        reasons.push("normalize value_sources.params");
      }
    }

    const projected = { id: row.id, active: nextActive, metadata: nextMetadata };
    projectedRows.push(projected);
    if (reasons.length > 0) {
      actions.push({
        id: row.id,
        active: nextActive,
        metadata: nextMetadata,
        reasons,
      });
    }
  }

  return {
    before: summarize(rows),
    after: summarize(projectedRows),
    actions,
    errors,
    legacyTierRows,
  };
}

export function parseS58bRepairArgs(args: readonly string[]): S58bRepairCliOptions {
  let apply = false;
  let databaseUrl: string | undefined;
  let schema: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    } else if (arg === "--database-url") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--database-url 需要一个值");
      databaseUrl = value;
      index += 1;
    } else if (arg === "--schema") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--schema 需要一个值");
      schema = value;
      index += 1;
    } else {
      throw new Error(
        `未知参数:${arg}(支持 --dry-run / --apply / --database-url <url> / --schema <name>)`,
      );
    }
  }

  if (!databaseUrl?.trim()) {
    throw new Error("拒绝执行:--database-url 必填;本工具不会读取 cwd .env 的数据库默认值");
  }
  if (!schema?.trim()) {
    throw new Error("拒绝执行:--schema 必填;本工具不会读取 cwd .env 的 schema 默认值");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error("拒绝执行:--database-url 不是合法 URL");
  }
  if (parsedUrl.protocol !== "postgres:" && parsedUrl.protocol !== "postgresql:") {
    throw new Error("拒绝执行:--database-url 必须使用 postgres:// 或 postgresql://");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) {
    throw new Error("拒绝执行:--schema 不是合法 PostgreSQL 标识符");
  }
  if (apply) {
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
    if (!loopbackHosts.has(parsedUrl.hostname.toLowerCase())) {
      throw new Error("拒绝执行:--apply 只允许 127.0.0.1/localhost/::1 回环数据库");
    }
    if (schema.toLowerCase() === "prod") {
      throw new Error("拒绝执行:--apply 不允许 prod schema");
    }
    const databaseName = decodeURIComponent(parsedUrl.pathname.slice(1));
    if (/(^|[-_])(prod|production|test)([-_]|$)/i.test(databaseName)) {
      throw new Error("拒绝执行:--apply 不允许 prod/production/test 数据库");
    }
  }

  return { apply, databaseUrl, schema };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function toRepairRows(rows: readonly PricingRuleDbRow[]): S58bRepairRow[] {
  return rows.map((row) => {
    if (!isRecord(row.metadata)) {
      throw new Error(`${row.id}:metadata 不是 JSON 对象`);
    }
    return { id: row.id, active: row.active, metadata: row.metadata };
  });
}

async function readPricingRules(
  client: Pool | PoolClient,
  schema: string,
  lockRows: boolean,
): Promise<S58bRepairRow[]> {
  const table = `${quoteIdentifier(schema)}."pricing_rules"`;
  const lockClause = lockRows ? " FOR UPDATE" : "";
  const result = await client.query<PricingRuleDbRow>(
    `SELECT id::text AS id, active, metadata FROM ${table} ORDER BY id${lockClause}`,
  );
  return toRepairRows(result.rows);
}

function printCounts(label: string, counts: S58bRepairCounts): void {
  console.log(
    `[${label}] total=${counts.total} active=${counts.active} inactive=${counts.inactive}`
    + ` experimental=${counts.experimental} inferred=${counts.inferred}`
    + ` inferred_active=${counts.inferredActive}`
    + ` inferred_experimental=${counts.inferredExperimental}`
    + ` supports_input_video=${counts.supportsInputVideoKeys}`
    + ` value_sources_current=${counts.currentValueSourcesRows}`
    + ` value_sources_stale=${counts.staleValueSourcesRows}`
    + ` value_sources_invalid=${counts.invalidValueSourcesRows}`,
  );
}

function printPlan(mode: "DRY-RUN" | "APPLY", schema: string, plan: S58bRepairPlan): void {
  console.log(`[${mode}] schema=${schema}`);
  printCounts("before", plan.before);
  printCounts("after(projected)", plan.after);
  const removedSupports = plan.actions.filter(
    (action) => action.reasons.includes("remove supports_input_video"),
  ).length;
  const normalizedValueSources = plan.actions.filter(
    (action) => action.reasons.includes("normalize value_sources.params"),
  ).length;
  console.log(
    `[plan] changed_rows=${plan.actions.length}`
    + ` inferred_rows=${plan.before.inferred}`
    + ` supports_input_video_rows_changed=${removedSupports}`
    + ` value_sources_rows_changed=${normalizedValueSources}`,
  );
}

function assertExpectedRepairScope(plan: S58bRepairPlan): void {
  if (plan.errors.length > 0) {
    throw new Error(`拒绝写入:${plan.errors.join("; ")}`);
  }
  if (plan.before.inferred !== S58_INFERRED_ROW_COUNT) {
    throw new Error(
      `拒绝写入:预期 ${S58_INFERRED_ROW_COUNT} 个推算来源行,实际 ${plan.before.inferred}`,
    );
  }
  if (plan.legacyTierRows !== 1) {
    throw new Error(`拒绝写入:预期 1 个旧视频固定档,实际 ${plan.legacyTierRows}`);
  }
  if (plan.before.valueSourcesTargetRows !== S58_VALUE_SOURCES_ROW_COUNT) {
    throw new Error(
      `拒绝写入:预期 ${S58_VALUE_SOURCES_ROW_COUNT} 个视频 value_sources 目标行,`
      + `实际 ${plan.before.valueSourcesTargetRows}`,
    );
  }
  if (
    plan.after.inferredActive !== 0
    || plan.after.inferredExperimental !== S58_INFERRED_ROW_COUNT
    || plan.after.inferredSupportsInputVideoKeys !== 0
    || plan.after.legacySupportsInputVideoKeys !== 0
    || plan.after.valueSourcesTargetRows !== S58_VALUE_SOURCES_ROW_COUNT
    || plan.after.staleValueSourcesRows !== 0
    || plan.after.currentValueSourcesRows !== S58_VALUE_SOURCES_ROW_COUNT
    || plan.after.invalidValueSourcesRows !== 0
  ) {
    throw new Error(
      "拒绝写入:projected-after 未满足 S58b inactive/experimental/no-input-video/value_sources 合同",
    );
  }
}

function sameCounts(left: S58bRepairCounts, right: S58bRepairCounts): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function runDryRun(pool: Pool, options: S58bRepairCliOptions): Promise<void> {
  const rows = await readPricingRules(pool, options.schema, false);
  const plan = planS58bTierStatusRepair(rows);
  printPlan("DRY-RUN", options.schema, plan);
  assertExpectedRepairScope(plan);
  console.log(`[result] changed_rows=${plan.actions.length}; dry-run 未写库`);
}

async function runApply(pool: Pool, options: S58bRepairCliOptions): Promise<void> {
  const client = await pool.connect();
  const table = `${quoteIdentifier(options.schema)}."pricing_rules"`;
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    // FOR UPDATE 只能锁住已有行；表级锁同时挡住并发 INSERT/UPDATE/DELETE，
    // 保证“恰有 28 个 provenance 行”的写前快照直到提交都不产生幻行。
    await client.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
    const rows = await readPricingRules(client, options.schema, true);
    const plan = planS58bTierStatusRepair(rows);
    printPlan("APPLY", options.schema, plan);
    assertExpectedRepairScope(plan);

    for (const action of plan.actions) {
      const result = await client.query(
        `UPDATE ${table}
           SET active = $2, metadata = $3::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1::uuid`,
        [action.id, action.active, JSON.stringify(action.metadata)],
      );
      if (result.rowCount !== 1) {
        throw new Error(`${action.id}:更新行数异常(${result.rowCount ?? 0})`);
      }
    }

    const actualRows = await readPricingRules(client, options.schema, false);
    const actualPlan = planS58bTierStatusRepair(actualRows);
    if (!sameCounts(actualPlan.before, plan.after)) {
      throw new Error("写后计数与 projected-after 不一致,事务已回滚");
    }
    if (actualPlan.errors.length > 0 || actualPlan.actions.length !== 0) {
      throw new Error("写后仍存在待修复行,事务已回滚");
    }
    printCounts("after(actual)", actualPlan.before);
    await client.query("COMMIT");
    transactionStarted = false;
    console.log(`[result] changed_rows=${plan.actions.length}; apply 已提交`);
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const options = parseS58bRepairArgs(process.argv.slice(2));
  const pool = new Pool({
    connectionString: options.databaseUrl,
    application_name: "s72-repair-s58b-tier-status",
    max: 1,
  });
  try {
    if (options.apply) await runApply(pool, options);
    else await runDryRun(pool, options);
  } finally {
    await pool.end();
  }
}

const directRunPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (directRunPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
