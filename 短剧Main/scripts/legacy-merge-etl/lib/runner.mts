/**
 * ETL 运行编排:以实体闭包为单位 plan/apply/rollback。
 * 真源:docs/contracts/common-to-v020-mapping.md §3/§4。
 *
 * 铁律实现:
 *  - dry-run 默认:只写运行/闭包账(mode='dry_run'),不动目标表与 crosswalk。
 *  - 闭包事务:单闭包成功/失败/回滚同生共死;失败不阻塞其他闭包。
 *  - 幂等:crosswalk 四元组唯一 + 目标侧业务唯一索引;重跑已迁行跳过、复用 target_id。
 *  - users/projects 只允许 manual_confirmed(契约 §3):无人工决定文件一律候选。
 */

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { quoteIdent } from "./guards.mts";
import { assertExtractionSafe, assertWhitelistSelfConsistent, selectList } from "./redlines.mts";
import {
  transformUser, transformProject, transformGrant, transformAssetEntity,
  transformAssetRef, transformStoryboardBundle, transformPricingRule,
  type CommonUserRow, type CommonProjectRow, type CommonGrantRow,
  type CommonAssetEntityRow, type CommonAssetRefRow, type CommonStoryboardRow,
  type CommonPromptRow, type CommonPricingRuleRow, type ManualDecision,
} from "./transforms.mts";
import { classifyClosure, conservationFailures, type VerifyBucket } from "./verify.mts";
import type { AssetQuarantineEntry } from "./quarantine.mts";

/** 源查询里需要 ::text 原样透传的时间列(避免驱动时区换算)。 */
const TIMESTAMP_TEXT_COLUMNS = new Set([
  "created_at", "updated_at", "granted_at", "effective_from", "effective_to", "start_time", "end_time",
]);

export interface EtlRunConfig {
  sourceUrl: string;
  targetUrl: string;
  sourceSchema: string;
  targetSchema: string;
  mode: "dry_run" | "apply";
  importOwnerId: string | null;
  userDecisions: Map<string, ManualDecision>;
  projectDecisions: Map<string, ManualDecision>;
  withPrompts: boolean;
  composeDirectorPrompt: boolean;
  autoCreateEpisodes: boolean;
  startedBy: string | null;
  freezeAt: string;
  domains: Set<"user" | "project" | "asset" | "pricing_rule">;
  /** 人工指定隔离的源 asset_entities.id → 理由(manual_quarantined,对称 manual_confirmed)。 */
  assetQuarantine?: Map<string, AssetQuarantineEntry>;
}

export interface ClosureTally {
  planned: number;
  migrated: number;
  conflict: number;
  quarantined: number;
  failed: number;
  candidates: number;
  skipped: number;
}

export interface RunSummary {
  runId: string;
  mode: "dry_run" | "apply";
  tally: ClosureTally;
  buckets: Record<VerifyBucket, number>;
}

function sourceSelectSql(schema: string, table: string, where: string): string {
  const columns = selectList(table).split(", ").map((column) => {
    const name = column.replaceAll('"', "");
    return TIMESTAMP_TEXT_COLUMNS.has(name) ? `${column}::text AS ${column}` : column;
  });
  const sql = `SELECT ${columns.join(", ")} FROM ${quoteIdent(schema)}."${table}" ${where}`;
  assertExtractionSafe(sql);
  return sql;
}

const JSONB_TARGET_COLUMNS = new Set([
  "metadata", "style_tags", "clearance", "version_snapshot",
  "reference_asset_snapshots", "scope_json", "stats_json",
  "source_counts_json", "target_ids_json", "verify_json",
]);

async function insertRow(
  client: Client,
  schema: string,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const columns = Object.keys(row);
  const values = columns.map((column) => row[column]);
  const placeholders = columns.map((column, index) =>
    JSONB_TARGET_COLUMNS.has(column) ? `$${index + 1}::jsonb` : `$${index + 1}`,
  );
  const params = values.map((value) =>
    typeof value === "object" && value !== null && !(value instanceof Date) ? JSON.stringify(value) : value,
  );
  await client.query(
    `INSERT INTO ${quoteIdent(schema)}."${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders.join(", ")})`,
    params as unknown[],
  );
}

interface CrosswalkEntry {
  sourceTable: string;
  sourcePk: string;
  targetTable: string;
  targetId: string | null;
  matchRule: "manual_confirmed" | "deterministic_key" | "content_hash" | "import_new";
  decision: "matched" | "new" | "conflict" | "quarantined";
  notes?: string;
  decidedBy?: string;
}

class RunContext {
  constructor(
    public readonly cfg: EtlRunConfig,
    public readonly source: Client,
    public readonly target: Client,
    public readonly runId: string,
  ) {
    this.targetSchema = quoteIdent(cfg.targetSchema);
  }
  readonly targetSchema: string;
  readonly takenUsernames = new Set<string>();
  readonly crosswalkCache = new Map<string, { targetId: string | null; decision: string }>();

  async loadExistingState(): Promise<void> {
    const usernames = await this.target.query<{ username: string }>(
      `SELECT lower(username) AS username FROM ${this.targetSchema}.users`,
    );
    for (const row of usernames.rows) this.takenUsernames.add(row.username);
    const crosswalk = await this.target.query<{
      source_table: string; source_pk: string; target_id: string | null; decision: string;
    }>(
      `SELECT source_table, source_pk, target_id, decision FROM ${this.targetSchema}.legacy_identity_crosswalk WHERE source_system='common' AND source_schema=$1`,
      [this.cfg.sourceSchema],
    );
    for (const row of crosswalk.rows) {
      this.crosswalkCache.set(`${row.source_table}:${row.source_pk}`, { targetId: row.target_id, decision: row.decision });
    }
  }

  alreadyDecided(sourceTable: string, sourcePk: string): { targetId: string | null; decision: string } | undefined {
    return this.crosswalkCache.get(`${sourceTable}:${sourcePk}`);
  }

  async writeCrosswalk(client: Client, entry: CrosswalkEntry): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO ${this.targetSchema}.legacy_identity_crosswalk
        (id, source_system, source_schema, source_table, source_pk, target_table, target_id,
         match_rule, decision, import_run_id, decided_by, notes)
       VALUES ($1, 'common', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id, this.cfg.sourceSchema, entry.sourceTable, entry.sourcePk, entry.targetTable,
        entry.targetId, entry.matchRule, entry.decision, this.runId,
        entry.decidedBy ?? null, entry.notes ?? null,
      ],
    );
    this.crosswalkCache.set(`${entry.sourceTable}:${entry.sourcePk}`, { targetId: entry.targetId, decision: entry.decision });
    return id;
  }
}

interface ClosureRecord {
  id: string;
  type: "user" | "project" | "asset" | "pricing_rule";
  key: string;
  sourceCounts: Record<string, number>;
  decisions: Record<"new" | "matched" | "conflict" | "quarantined", number>;
  skippedByRule: number;
  degradationCount: number;
  hardFailures: string[];
  candidates: string[];
  targetIds: Record<string, unknown[]>;
}

function newClosure(type: ClosureRecord["type"], key: string): ClosureRecord {
  return {
    id: randomUUID(), type, key,
    sourceCounts: {}, decisions: { new: 0, matched: 0, conflict: 0, quarantined: 0 },
    skippedByRule: 0, degradationCount: 0, hardFailures: [], candidates: [],
    targetIds: {},
  };
}

function pushTarget(closure: ClosureRecord, table: string, id: unknown): void {
  (closure.targetIds[table] ??= []).push(id);
}

async function insertClosureRecord(ctx: RunContext, closure: ClosureRecord): Promise<void> {
  await insertRow(ctx.target, ctx.cfg.targetSchema, "legacy_import_closures", {
    id: closure.id,
    run_id: ctx.runId,
    closure_type: closure.type,
    closure_key: closure.key,
    status: "planned",
    source_counts_json: closure.sourceCounts,
    target_ids_json: {},
    verify_json: {},
  });
}

async function finalizeClosureRecord(
  ctx: RunContext,
  closure: ClosureRecord,
  status: string,
  bucket: VerifyBucket | null,
  verify: Record<string, unknown>,
  error?: { code: string; message: string },
): Promise<void> {
  const now = new Date().toISOString();
  const migratedAt = status === "migrated" ? now : null;
  await ctx.target.query(
    `UPDATE ${ctx.targetSchema}.legacy_import_closures
       SET status=$3, verify_bucket=$4, source_counts_json=$5::jsonb, target_ids_json=$6::jsonb,
           verify_json=$7::jsonb, error_code=$8, error_message=$9,
           migrated_at=$10, updated_at=$11
     WHERE id=$1 AND run_id=$2`,
    [
      closure.id, ctx.runId, status, bucket,
      JSON.stringify(closure.sourceCounts), JSON.stringify(closure.targetIds),
      JSON.stringify(verify), error?.code ?? null, error?.message ?? null, migratedAt, now,
    ],
  );
}

// ---------------------------------------------------------------------------
// users 域(契约 §4.1)
// ---------------------------------------------------------------------------

async function processUsers(ctx: RunContext, tally: ClosureTally): Promise<void> {
  const sql = sourceSelectSql(ctx.cfg.sourceSchema, "users", `WHERE status <> 'deleted' ORDER BY id`);
  const result = await ctx.source.query<CommonUserRow>(sql);
  for (const sourceRow of result.rows) {
    const closure = newClosure("user", `user:${sourceRow.id}`);
    closure.sourceCounts.users = 1;
    await insertClosureRecord(ctx, closure);
    const existing = ctx.alreadyDecided("users", sourceRow.id);
    if (existing) {
      tally.skipped += 1;
      if (existing.decision === "new" || existing.decision === "matched") {
        await finalizeClosureRecord(ctx, closure, "migrated", "identical", { note: "已由先前运行迁入(幂等跳过)", reused_target_id: existing.targetId });
      } else {
        // conflict/quarantined 已记账:人工处置并清账前不重试,重跑不得重复写 crosswalk(四元组唯一)。
        await finalizeClosureRecord(ctx, closure, existing.decision, "needs_human", { note: `先前运行已记 ${existing.decision},待人工处置(幂等跳过)` });
      }
      continue;
    }
    const decision = ctx.cfg.userDecisions.get(sourceRow.id);
    const transformed = transformUser(sourceRow, {
      usernameTaken: (username) => ctx.takenUsernames.has(username),
      decision,
    });
    if (transformed.notes) closure.degradationCount += transformed.outcome === "ready" ? 1 : 0;
    if (transformed.outcome === "candidate") {
      tally.candidates += 1;
      closure.candidates.push(sourceRow.id);
      await finalizeClosureRecord(ctx, closure, "planned", null, { candidate: true, reason: transformed.reason, notes: transformed.notes });
      continue;
    }
    if (transformed.outcome === "quarantine" || transformed.outcome === "conflict") {
      const decisionName = transformed.outcome === "quarantine" ? "quarantined" : "conflict";
      closure.decisions[decisionName] += 1;
      tally[decisionName === "quarantined" ? "quarantined" : "conflict"] += 1;
      if (ctx.cfg.mode === "apply") {
        await ctx.writeCrosswalk(ctx.target, {
          sourceTable: "users", sourcePk: sourceRow.id, targetTable: "users", targetId: null,
          matchRule: "manual_confirmed", decision: decisionName,
          notes: `${transformed.reason}${transformed.notes ? ` | ${transformed.notes}` : ""}`,
        });
      }
      await finalizeClosureRecord(ctx, closure, decisionName, "needs_human", { reason: transformed.reason, notes: transformed.notes });
      continue;
    }
    // ready
    if (ctx.cfg.mode !== "apply") {
      closure.decisions.new += 1;
      await finalizeClosureRecord(ctx, closure, "planned", null, { would_insert: true, username: (transformed.row as { username: string }).username, notes: transformed.notes });
      tally.planned += 1;
      continue;
    }
    const newId = randomUUID();
    const client = ctx.target;
    try {
      await client.query("BEGIN");
      await insertRow(client, ctx.cfg.targetSchema, "users", { id: newId, ...transformed.row });
      const crosswalkId = await ctx.writeCrosswalk(client, {
        sourceTable: "users", sourcePk: sourceRow.id, targetTable: "users", targetId: newId,
        matchRule: "manual_confirmed", decision: "new", notes: transformed.notes,
        decidedBy: decision!.decidedBy,
      });
      pushTarget(closure, "users", newId);
      pushTarget(closure, "legacy_identity_crosswalk", crosswalkId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    ctx.takenUsernames.add((transformed.row as { username: string }).username);
    closure.decisions.new += 1;
    tally.migrated += 1;
    const hardFailures = conservationFailures(closure);
    closure.hardFailures.push(...hardFailures);
    await finalizeClosureRecord(ctx, closure, "migrated", classifyClosure(closure), { hardFailures, notes: transformed.notes });
  }
}

// ---------------------------------------------------------------------------
// project 闭包(契约 §4.2:项目行 + owner 成员行 + grants + refs + 被引用实体 + 提示词)
// ---------------------------------------------------------------------------

async function processProjects(ctx: RunContext, tally: ClosureTally): Promise<void> {
  const projectsSql = sourceSelectSql(ctx.cfg.sourceSchema, "projects", "ORDER BY id");
  const projects = await ctx.source.query<CommonProjectRow>(projectsSql);
  for (const project of projects.rows) {
    const closure = newClosure("project", `project:${project.id}`);
    await insertClosureRecord(ctx, closure);
    const failClosure = async (status: string, bucket: VerifyBucket | null, verify: Record<string, unknown>) => {
      tally[status === "conflict" ? "conflict" : status === "quarantined" ? "quarantined" : "planned"] += 1;
      await finalizeClosureRecord(ctx, closure, status, bucket, verify);
    };
    const existing = ctx.alreadyDecided("projects", project.id);
    if (existing) {
      tally.skipped += 1;
      if (existing.decision === "new" || existing.decision === "matched") {
        await finalizeClosureRecord(ctx, closure, "migrated", "identical", { note: "已由先前运行迁入(幂等跳过)", reused_target_id: existing.targetId });
      } else {
        // conflict/quarantined 已记账:人工处置并清账前不重试,重跑不得重复写 crosswalk(四元组唯一)。
        await finalizeClosureRecord(ctx, closure, existing.decision, "needs_human", { note: `先前运行已记 ${existing.decision},待人工处置(幂等跳过)` });
      }
      continue;
    }

    // owner 经用户 crosswalk 解析
    const ownerDecision = ctx.alreadyDecided("users", project.owner_user_id);
    const ownerTargetId = ownerDecision && (ownerDecision.decision === "new" || ownerDecision.decision === "matched")
      ? ownerDecision.targetId : null;
    const nameCheckRows = ownerTargetId
      ? (await ctx.target.query<{ name: string }>(
          `SELECT lower(name) AS name FROM ${ctx.targetSchema}.projects WHERE owner_user_id=$1 AND deleted_at IS NULL`,
          [ownerTargetId],
        )).rows.map((row) => row.name)
      : [];
    const decision = ctx.cfg.projectDecisions.get(project.id);
    const transformed = transformProject(project, {
      ownerTargetId,
      nameTaken: (name) => nameCheckRows.includes(name.toLowerCase()),
      decision,
    });
    closure.sourceCounts.projects = 1;
    if (transformed.outcome === "conflict" || transformed.outcome === "quarantine") {
      const decisionName = transformed.outcome === "quarantine" ? "quarantined" : "conflict";
      closure.decisions[decisionName] += 1;
      if (ctx.cfg.mode === "apply") {
        await ctx.writeCrosswalk(ctx.target, {
          sourceTable: "projects", sourcePk: project.id, targetTable: "projects", targetId: null,
          matchRule: "manual_confirmed", decision: decisionName,
          notes: `${transformed.reason}${transformed.notes ? ` | ${transformed.notes}` : ""}`,
        });
      }
      await failClosure(decisionName, "needs_human", { reason: transformed.reason, notes: transformed.notes });
      continue;
    }
    if (transformed.outcome === "candidate") {
      closure.candidates.push(project.id);
      tally.candidates += 1;
      await finalizeClosureRecord(ctx, closure, "planned", null, { candidate: true, reason: transformed.reason, notes: transformed.notes });
      continue;
    }
    if (ctx.cfg.mode !== "apply") {
      closure.decisions.new += 1;
      await failClosure("planned", null, { would_insert: true, name: (transformed.row as { name: string }).name, notes: transformed.notes });
      continue;
    }

    // ---- apply:闭包事务 ----
    const client = ctx.target;
    const importOwnerId = ctx.cfg.importOwnerId;
    if (!importOwnerId) throw new Error("apply 模式必须提供 --import-owner(批准的 import owner 用户 id)");
    const newProjectId = randomUUID();
    try {
      await client.query("BEGIN");
      await insertRow(client, ctx.cfg.targetSchema, "projects", { id: newProjectId, ...transformed.row });
      const projectCrosswalkId = await ctx.writeCrosswalk(client, {
        sourceTable: "projects", sourcePk: project.id, targetTable: "projects", targetId: newProjectId,
        matchRule: "manual_confirmed", decision: "new", notes: transformed.notes, decidedBy: decision!.decidedBy,
      });
      pushTarget(closure, "projects", newProjectId);
      pushTarget(closure, "legacy_identity_crosswalk", projectCrosswalkId);
      closure.decisions.new += 1;

      // owner 成员行由目标库 sync_project_owner_membership 触发器随 projects INSERT
      // 自动写入(016);回滚时 project_members 随 projects ON DELETE CASCADE 清掉,
      // 无需也不许手工重复插入(PK 冲突)。
      pushTarget(closure, "project_members", { project_id: newProjectId, user_id: ownerTargetId });

      // grants → members
      const grants = await ctx.source.query<CommonGrantRow>(
        sourceSelectSql(ctx.cfg.sourceSchema, "project_access_grants",
          `WHERE project_id = '${project.id}' AND source_type='explicit' AND is_active AND NOT is_disabled AND revoked_at IS NULL ORDER BY role_level DESC`),
      );
      closure.sourceCounts.project_access_grants = grants.rows.length;
      const seenMembers = new Set<string>([project.owner_user_id]);
      for (const grant of grants.rows) {
        if (seenMembers.has(grant.user_id)) {
          // 同人低级别 grant 去重(守恒:计入规则性跳过,已有代表行)。
          closure.skippedByRule += 1;
          continue;
        }
        const userDecision = ctx.alreadyDecided("users", grant.user_id);
        const grantTransformed = transformGrant(grant, {
          projectOwnerSourceId: project.owner_user_id,
          userTargetId: userDecision && (userDecision.decision === "new" || userDecision.decision === "matched") ? userDecision.targetId : null,
        });
        if (grantTransformed.outcome === "skip") {
          // 规则性跳过(与自动 owner 成员行去重):有代表行,计入守恒但不增决策数。
          closure.skippedByRule += 1;
          continue;
        }
        if (grantTransformed.outcome === "ready") {
          await insertRow(client, ctx.cfg.targetSchema, "project_members", {
            project_id: newProjectId, user_id: userDecision!.targetId, role: (grantTransformed.row as { role: string }).role,
            added_by_user_id: importOwnerId,
          });
          pushTarget(closure, "project_members", { project_id: newProjectId, user_id: userDecision!.targetId });
          seenMembers.add(grant.user_id);
          // project_members 是复合主键无 uuid,target_id 置空(CHECK 专门放行),
          // 归属项目记 notes;身份由 source 四元组承载。
          const crosswalkId = await ctx.writeCrosswalk(client, {
            sourceTable: "project_access_grants", sourcePk: grant.id, targetTable: "project_members",
            targetId: null, matchRule: "import_new", decision: "new",
            notes: `成员行入项目 ${newProjectId}(复合主键,target_id 置空)${grantTransformed.notes ? ` | ${grantTransformed.notes}` : ""}`,
          });
          pushTarget(closure, "legacy_identity_crosswalk", crosswalkId);
          closure.decisions.new += 1;
        } else {
          const decisionName = grantTransformed.outcome === "quarantine" ? "quarantined" : "conflict";
          closure.decisions[decisionName] += 1;
          const crosswalkId = await ctx.writeCrosswalk(client, {
            sourceTable: "project_access_grants", sourcePk: grant.id, targetTable: "project_members",
            targetId: null, matchRule: "import_new", decision: decisionName, notes: grantTransformed.reason,
          });
          pushTarget(closure, "legacy_identity_crosswalk", crosswalkId);
        }
      }

      // refs + 被引用实体
      await processAssetRefsAndEntities(ctx, client, closure, project.id, newProjectId, importOwnerId);

      // 分镜提示词(待 §2.7 决策,默认关)
      if (ctx.cfg.withPrompts) {
        await processStoryboards(ctx, client, closure, project.id, newProjectId);
      }

      closure.hardFailures.push(...conservationFailures(closure));
      const bucket = classifyClosure(closure);
      await client.query("COMMIT");
      tally.migrated += 1;
      await finalizeClosureRecord(ctx, closure, "migrated", bucket, { hardFailures: closure.hardFailures });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      tally.failed += 1;
      await finalizeClosureRecord(ctx, closure, "failed", "failed", {}, { code: "closure_tx_failed", message: message.slice(0, 512) });
    }
  }
}

async function processAssetRefsAndEntities(
  ctx: RunContext, client: Client, closure: ClosureRecord,
  sourceProjectId: string, newProjectId: string, importOwnerId: string,
): Promise<void> {
  const refs = await ctx.source.query<CommonAssetRefRow>(
    sourceSelectSql(ctx.cfg.sourceSchema, "project_asset_refs",
      `WHERE project_id = '${sourceProjectId}' AND status = 'active' ORDER BY created_at`),
  );
  closure.sourceCounts.project_asset_refs = refs.rows.length;
  const entityCache = new Map<string, string>(); // source entity id → new id(本闭包内)
  for (const ref of refs.rows) {
    let newEntityId = entityCache.get(ref.asset_entity_id) ?? null;
    if (!newEntityId) {
      const existing = ctx.alreadyDecided("asset_entities", ref.asset_entity_id);
      if (existing && (existing.decision === "new" || existing.decision === "matched") && existing.targetId) {
        newEntityId = existing.targetId;
      } else {
        const entities = await ctx.source.query<CommonAssetEntityRow>(
          sourceSelectSql(ctx.cfg.sourceSchema, "asset_entities", `WHERE id = '${ref.asset_entity_id}'`),
        );
        const entity = entities.rows[0];
        if (!entity) {
          closure.decisions.quarantined += 1;
          await ctx.writeCrosswalk(client, {
            sourceTable: "project_asset_refs", sourcePk: ref.id, targetTable: "project_asset_refs",
            targetId: null, matchRule: "import_new", decision: "quarantined",
            notes: `引用的 asset_entities ${ref.asset_entity_id} 在源库不存在`,
          });
          continue;
        }
        closure.sourceCounts.asset_entities = (closure.sourceCounts.asset_entities ?? 0) + 1;
        const quarantineEntry = ctx.cfg.assetQuarantine?.get(entity.id);
        if (quarantineEntry) {
          // 人工指定隔离(manual_quarantined):带病不导;引用它的 ref 一并隔离(守恒)。
          closure.decisions.quarantined += 1;
          await ctx.writeCrosswalk(client, {
            sourceTable: "asset_entities", sourcePk: entity.id, targetTable: "asset_entities",
            targetId: null, matchRule: "import_new", decision: "quarantined",
            notes: `人工指定隔离(by ${quarantineEntry.decidedBy}): ${quarantineEntry.reason}`,
          });
          closure.decisions.quarantined += 1;
          await ctx.writeCrosswalk(client, {
            sourceTable: "project_asset_refs", sourcePk: ref.id, targetTable: "project_asset_refs",
            targetId: null, matchRule: "import_new", decision: "quarantined",
            notes: `引用的 asset_entities ${ref.asset_entity_id} 被人工指定隔离,ref 连带隔离`,
          });
          continue;
        }
        const entityTransformed = transformAssetEntity(entity, { importOwnerId, importRunId: ctx.runId });
        if (entityTransformed.outcome !== "ready") {
          closure.decisions.quarantined += 1;
          await ctx.writeCrosswalk(client, {
            sourceTable: "asset_entities", sourcePk: entity.id, targetTable: "asset_entities",
            targetId: null, matchRule: "import_new", decision: "quarantined", notes: entityTransformed.reason,
          });
          // 引用它的 ref 一并隔离(守恒:每条源 ref 必须有决策)。
          closure.decisions.quarantined += 1;
          await ctx.writeCrosswalk(client, {
            sourceTable: "project_asset_refs", sourcePk: ref.id, targetTable: "project_asset_refs",
            targetId: null, matchRule: "import_new", decision: "quarantined",
            notes: `引用的 asset_entities ${ref.asset_entity_id} 被隔离,ref 连带隔离`,
          });
          continue;
        }
        newEntityId = randomUUID();
        await insertRow(client, ctx.cfg.targetSchema, "asset_entities", { id: newEntityId, ...entityTransformed.row });
        const entityCrosswalkId = await ctx.writeCrosswalk(client, {
          sourceTable: "asset_entities", sourcePk: entity.id, targetTable: "asset_entities",
          targetId: newEntityId, matchRule: "import_new", decision: "new", notes: entityTransformed.notes,
        });
        pushTarget(closure, "asset_entities", newEntityId);
        pushTarget(closure, "legacy_identity_crosswalk", entityCrosswalkId);
        closure.decisions.new += 1;
        if (entityTransformed.notes) closure.degradationCount += 1;
        entityCache.set(ref.asset_entity_id, newEntityId);
      }
    }
    // ref 本身
    const refTransformed = transformAssetRef(ref);
    const newRefId = randomUUID();
    await insertRow(client, ctx.cfg.targetSchema, "project_asset_refs", {
      id: newRefId, project_id: newProjectId, asset_entity_id: newEntityId,
      created_by_user_id: importOwnerId, ...refTransformed.row,
    });
    const refCrosswalkId = await ctx.writeCrosswalk(client, {
      sourceTable: "project_asset_refs", sourcePk: ref.id, targetTable: "project_asset_refs",
      targetId: newRefId, matchRule: "import_new", decision: "new",
    });
    pushTarget(closure, "project_asset_refs", newRefId);
    pushTarget(closure, "legacy_identity_crosswalk", refCrosswalkId);
    closure.decisions.new += 1;
  }
}

async function processStoryboards(
  ctx: RunContext, client: Client, closure: ClosureRecord,
  sourceProjectId: string, newProjectId: string,
): Promise<void> {
  const storyboards = await ctx.source.query<CommonStoryboardRow>(
    sourceSelectSql(ctx.cfg.sourceSchema, "project_director_storyboard_prompts",
      `WHERE project_id = '${sourceProjectId}' ORDER BY episode_no, shot_no`),
  );
  const prompts = await ctx.source.query<CommonPromptRow>(
    sourceSelectSql(ctx.cfg.sourceSchema, "project_prompts",
      `WHERE project_id = '${sourceProjectId}' ORDER BY updated_at DESC`),
  );
  closure.sourceCounts.project_director_storyboard_prompts = storyboards.rows.length;
  closure.sourceCounts.project_prompts = prompts.rows.length;
  const episodeCache = new Map<number, string>();
  const seenShotCodes = new Set<string>();
  const consumedPromptIds = new Set<string>();
  for (const storyboard of storyboards.rows) {
    const bundle = transformStoryboardBundle(storyboard, prompts.rows, { composeDirectorPrompt: ctx.cfg.composeDirectorPrompt });
    if (bundle.shot.outcome !== "ready") {
      closure.decisions.quarantined += 1;
      await ctx.writeCrosswalk(client, {
        sourceTable: "project_director_storyboard_prompts", sourcePk: storyboard.id,
        targetTable: "shots", targetId: null, matchRule: "import_new", decision: "quarantined",
        notes: bundle.shot.reason,
      });
      continue;
    }
    const episodeNo = storyboard.episode_no!;
    let episodeId = episodeCache.get(episodeNo) ?? null;
    if (!episodeId) {
      const found = await client.query<{ id: string }>(
        `SELECT id FROM ${ctx.targetSchema}.episodes WHERE project_id=$1 AND episode_no=$2 AND deleted_at IS NULL`,
        [newProjectId, episodeNo],
      );
      episodeId = found.rows[0]?.id ?? null;
      if (!episodeId && ctx.cfg.autoCreateEpisodes) {
        episodeId = randomUUID();
        await insertRow(client, ctx.cfg.targetSchema, "episodes", {
          id: episodeId, project_id: newProjectId, episode_no: episodeNo,
          sort_order: episodeNo, status: "active",
        });
        pushTarget(closure, "episodes", episodeId);
      }
      if (episodeId) episodeCache.set(episodeNo, episodeId);
    }
    if (!episodeId) {
      closure.decisions.quarantined += 1;
      await ctx.writeCrosswalk(client, {
        sourceTable: "project_director_storyboard_prompts", sourcePk: storyboard.id,
        targetTable: "shots", targetId: null, matchRule: "import_new", decision: "quarantined",
        notes: `episode ${episodeNo} 在目标库不存在且未开启 --auto-create-episodes(契约 §2.7 决策待 DC)`,
      });
      continue;
    }
    // (episode_id, shot_code) 目标侧有唯一索引:同闭包内重复直接隔离,
    // 不放到 INSERT 时才整闭包爆炸。
    const shotCode = (bundle.shot.row as { shot_code: string }).shot_code;
    const shotCodeKey = `${episodeId}:${shotCode}`;
    if (seenShotCodes.has(shotCodeKey)) {
      closure.decisions.quarantined += 1;
      await ctx.writeCrosswalk(client, {
        sourceTable: "project_director_storyboard_prompts", sourcePk: storyboard.id,
        targetTable: "shots", targetId: null, matchRule: "import_new", decision: "quarantined",
        notes: `shot_code ${shotCode} 与同项目另一分镜重复(episode ${episodeNo})`,
      });
      continue;
    }
    const shotRow = bundle.shot.row as Record<string, unknown>;
    const newShotId = randomUUID();
    await insertRow(client, ctx.cfg.targetSchema, "shots", { id: newShotId, episode_id: episodeId, ...shotRow });
    seenShotCodes.add(shotCodeKey);
    const shotCrosswalkId = await ctx.writeCrosswalk(client, {
      sourceTable: "project_director_storyboard_prompts", sourcePk: storyboard.id,
      targetTable: "shots", targetId: newShotId, matchRule: "import_new", decision: "new",
      notes: bundle.promptNotes.length > 0 ? bundle.promptNotes.join("; ") : undefined,
    });
    pushTarget(closure, "shots", newShotId);
    pushTarget(closure, "legacy_identity_crosswalk", shotCrosswalkId);
    closure.decisions.new += 1;
    if (bundle.promptNotes.length > 0) closure.degradationCount += bundle.promptNotes.length;
    // prompt 逐行落账(守恒:每条源 prompt 必须有一个 decision)。
    for (const promptId of bundle.promptDecisions.merged) {
      consumedPromptIds.add(promptId);
      closure.decisions.matched += 1;
      const promptCrosswalkId = await ctx.writeCrosswalk(client, {
        sourceTable: "project_prompts", sourcePk: promptId,
        targetTable: "shots", targetId: newShotId, matchRule: "import_new", decision: "matched",
        notes: "合并入 shot(image_prompt/video_prompt)",
      });
      pushTarget(closure, "legacy_identity_crosswalk", promptCrosswalkId);
    }
    for (const promptId of bundle.promptDecisions.conflicted) {
      consumedPromptIds.add(promptId);
      closure.decisions.conflict += 1;
      const promptCrosswalkId = await ctx.writeCrosswalk(client, {
        sourceTable: "project_prompts", sourcePk: promptId,
        targetTable: "shots", targetId: null, matchRule: "import_new", decision: "conflict",
        notes: "同镜头同类型多条 prompt,保留 updated_at 最新一条",
      });
      pushTarget(closure, "legacy_identity_crosswalk", promptCrosswalkId);
    }
    for (const promptId of bundle.promptDecisions.quarantined) {
      consumedPromptIds.add(promptId);
      closure.decisions.quarantined += 1;
      const promptCrosswalkId = await ctx.writeCrosswalk(client, {
        sourceTable: "project_prompts", sourcePk: promptId,
        targetTable: "shots", targetId: null, matchRule: "import_new", decision: "quarantined",
        notes: "未知 prompt_type(已证值域 storyboard_image/shot_video)",
      });
      pushTarget(closure, "legacy_identity_crosswalk", promptCrosswalkId);
    }
  }
  // 未被任何已迁 shot 消费的 prompt(不属于任何分镜,或所属分镜被隔离):逐条隔离。
  for (const prompt of prompts.rows) {
    if (consumedPromptIds.has(prompt.id)) continue;
    closure.decisions.quarantined += 1;
    const promptCrosswalkId = await ctx.writeCrosswalk(client, {
      sourceTable: "project_prompts", sourcePk: prompt.id,
      targetTable: "shots", targetId: null, matchRule: "import_new", decision: "quarantined",
      notes: "未被任何已迁 shot 消费(无对应分镜或所属分镜被隔离)",
    });
    pushTarget(closure, "legacy_identity_crosswalk", promptCrosswalkId);
  }
}

// ---------------------------------------------------------------------------
// 孤儿资产闭包(未被任何 active ref 引用的实体)
// ---------------------------------------------------------------------------

async function processOrphanAssets(ctx: RunContext, tally: ClosureTally): Promise<void> {
  if (ctx.cfg.mode === "apply" && !ctx.cfg.importOwnerId) {
    throw new Error("apply 模式必须提供 --import-owner(批准的 import owner 用户 id)");
  }
  const sql = sourceSelectSql(ctx.cfg.sourceSchema, "asset_entities",
    `WHERE id NOT IN (SELECT asset_entity_id FROM ${quoteIdent(ctx.cfg.sourceSchema)}."project_asset_refs" WHERE status='active') ORDER BY id`);
  assertExtractionSafe(sql);
  const entities = await ctx.source.query<CommonAssetEntityRow>(sql);
  for (const entity of entities.rows) {
    const closure = newClosure("asset", `asset:${entity.id}`);
    closure.sourceCounts.asset_entities = 1;
    await insertClosureRecord(ctx, closure);
    const existing = ctx.alreadyDecided("asset_entities", entity.id);
    if (existing) {
      tally.skipped += 1;
      if (existing.decision === "new" || existing.decision === "matched") {
        await finalizeClosureRecord(ctx, closure, "migrated", "identical", { note: "已由先前运行迁入(幂等跳过)" });
      } else {
        // conflict/quarantined 已记账:人工处置并清账前不重试,重跑不得重复写 crosswalk(四元组唯一)。
        await finalizeClosureRecord(ctx, closure, existing.decision, "needs_human", { note: `先前运行已记 ${existing.decision},待人工处置(幂等跳过)` });
      }
      continue;
    }
    const importOwnerId = ctx.cfg.importOwnerId ?? "00000000-0000-0000-0000-000000000000";
    const quarantineEntry = ctx.cfg.assetQuarantine?.get(entity.id);
    if (quarantineEntry) {
      // 人工指定隔离(manual_quarantined):带病不导,留账待人工处置。
      closure.decisions.quarantined += 1;
      tally.quarantined += 1;
      if (ctx.cfg.mode === "apply") {
        await ctx.writeCrosswalk(ctx.target, {
          sourceTable: "asset_entities", sourcePk: entity.id, targetTable: "asset_entities",
          targetId: null, matchRule: "import_new", decision: "quarantined",
          notes: `人工指定隔离(by ${quarantineEntry.decidedBy}): ${quarantineEntry.reason}`,
        });
      }
      await finalizeClosureRecord(ctx, closure, "quarantined", "needs_human", { reason: `人工指定隔离: ${quarantineEntry.reason}`, decidedBy: quarantineEntry.decidedBy });
      continue;
    }
    const transformed = transformAssetEntity(entity, { importOwnerId, importRunId: ctx.runId });
    if (transformed.outcome !== "ready") {
      closure.decisions.quarantined += 1;
      tally.quarantined += 1;
      if (ctx.cfg.mode === "apply") {
        await ctx.writeCrosswalk(ctx.target, {
          sourceTable: "asset_entities", sourcePk: entity.id, targetTable: "asset_entities",
          targetId: null, matchRule: "import_new", decision: "quarantined", notes: transformed.reason,
        });
      }
      await finalizeClosureRecord(ctx, closure, "quarantined", "needs_human", { reason: transformed.reason });
      continue;
    }
    if (ctx.cfg.mode !== "apply") {
      closure.decisions.new += 1;
      await finalizeClosureRecord(ctx, closure, "planned", null, { would_insert: true, name: entity.name });
      tally.planned += 1;
      continue;
    }
    const newId = randomUUID();
    const client = ctx.target;
    try {
      await client.query("BEGIN");
      await insertRow(client, ctx.cfg.targetSchema, "asset_entities", { id: newId, ...transformed.row });
      const crosswalkId = await ctx.writeCrosswalk(client, {
        sourceTable: "asset_entities", sourcePk: entity.id, targetTable: "asset_entities",
        targetId: newId, matchRule: "import_new", decision: "new", notes: transformed.notes,
      });
      pushTarget(closure, "asset_entities", newId);
      pushTarget(closure, "legacy_identity_crosswalk", crosswalkId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    closure.decisions.new += 1;
    tally.migrated += 1;
    closure.hardFailures.push(...conservationFailures(closure));
    await finalizeClosureRecord(ctx, closure, "migrated", classifyClosure(closure), { hardFailures: closure.hardFailures });
  }
}

// ---------------------------------------------------------------------------
// pricing_rules(契约 §4.5)
// ---------------------------------------------------------------------------

async function processPricingRules(ctx: RunContext, tally: ClosureTally): Promise<void> {
  const catalogSql = sourceSelectSql(ctx.cfg.sourceSchema, "model_catalog", "WHERE is_enabled");
  const catalog = await ctx.source.query<{ provider_name: string; model_name: string; model_type: string }>(catalogSql);
  const catalogTypes = new Map<string, string>();
  for (const row of catalog.rows) catalogTypes.set(`${row.provider_name}${row.model_name}`, row.model_type);

  const rulesSql = sourceSelectSql(ctx.cfg.sourceSchema, "model_pricing_rules", "ORDER BY provider_name, model_name");
  const rules = await ctx.source.query<CommonPricingRuleRow>(rulesSql);
  for (const rule of rules.rows) {
    const closure = newClosure("pricing_rule", `pricing_rule:${rule.id}`);
    closure.sourceCounts.model_pricing_rules = 1;
    await insertClosureRecord(ctx, closure);
    const existing = ctx.alreadyDecided("model_pricing_rules", rule.id);
    if (existing) {
      tally.skipped += 1;
      if (existing.decision === "new" || existing.decision === "matched") {
        await finalizeClosureRecord(ctx, closure, "migrated", "identical", { note: "已由先前运行迁入(幂等跳过)" });
      } else {
        // conflict/quarantined 已记账:人工处置并清账前不重试,重跑不得重复写 crosswalk(四元组唯一)。
        await finalizeClosureRecord(ctx, closure, existing.decision, "needs_human", { note: `先前运行已记 ${existing.decision},待人工处置(幂等跳过)` });
      }
      continue;
    }
    const transformed = transformPricingRule(rule, {
      catalogType: catalogTypes.get(`${rule.provider_name}${rule.model_name}`),
      freezeAt: ctx.cfg.freezeAt,
      importRunId: ctx.runId,
    });
    if (transformed.outcome === "skip") {
      tally.skipped += 1;
      await finalizeClosureRecord(ctx, closure, "migrated", "identical", { skipped: true, reason: transformed.reason });
      continue;
    }
    if (transformed.outcome !== "ready") {
      closure.decisions.quarantined += 1;
      tally.quarantined += 1;
      if (ctx.cfg.mode === "apply") {
        await ctx.writeCrosswalk(ctx.target, {
          sourceTable: "model_pricing_rules", sourcePk: rule.id, targetTable: "pricing_rules",
          targetId: null, matchRule: "import_new", decision: "quarantined", notes: transformed.reason,
        });
      }
      await finalizeClosureRecord(ctx, closure, "quarantined", "needs_human", { reason: transformed.reason });
      continue;
    }
    if (ctx.cfg.mode !== "apply") {
      closure.decisions.new += 1;
      await finalizeClosureRecord(ctx, closure, "planned", null, { would_insert: true, rule: `${rule.provider_name}/${rule.model_name}` });
      tally.planned += 1;
      continue;
    }
    // 幂等键:WHERE NOT EXISTS (provider, model, media_kind, billing_unit, effective_from)
    const row = transformed.row as Record<string, unknown>;
    const newId = randomUUID();
    const client = ctx.target;
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ${ctx.targetSchema}.pricing_rules
          (id, provider, model, media_kind, billing_unit, unit_price_fen, currency, source, active, effective_from, effective_to, metadata)
         SELECT $1::uuid,$2::varchar,$3::varchar,$4::varchar,$5::varchar,$6::integer,$7::varchar,$8::varchar,$9::boolean,$10::timestamptz,$11::timestamptz,$12::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM ${ctx.targetSchema}.pricing_rules
           WHERE provider=$2 AND model=$3 AND media_kind=$4 AND billing_unit=$5 AND effective_from=$10)
         RETURNING id`,
        [
          newId, row["provider"], row["model"], row["media_kind"], row["billing_unit"],
          row["unit_price_fen"], row["currency"], row["source"], row["active"],
          row["effective_from"], row["effective_to"], JSON.stringify(row["metadata"]),
        ],
      );
      const landedId = inserted.rows[0]?.id ?? null;
      if (landedId) {
        const crosswalkId = await ctx.writeCrosswalk(client, {
          sourceTable: "model_pricing_rules", sourcePk: rule.id, targetTable: "pricing_rules",
          targetId: landedId, matchRule: "import_new", decision: "new", notes: transformed.notes,
        });
        pushTarget(closure, "pricing_rules", landedId);
        pushTarget(closure, "legacy_identity_crosswalk", crosswalkId);
        closure.decisions.new += 1;
      } else {
        closure.decisions.matched += 1;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    tally.migrated += 1;
    closure.hardFailures.push(...conservationFailures(closure));
    await finalizeClosureRecord(ctx, closure, "migrated", classifyClosure(closure), { hardFailures: closure.hardFailures, idempotent_skip: closure.decisions.matched > 0 });
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function executeRun(cfg: EtlRunConfig): Promise<RunSummary> {
  assertWhitelistSelfConsistent();
  const source = new Client({ connectionString: cfg.sourceUrl });
  const target = new Client({ connectionString: cfg.targetUrl });
  await source.connect();
  await target.connect();
  const runId = randomUUID();
  const tally: ClosureTally = { planned: 0, migrated: 0, conflict: 0, quarantined: 0, failed: 0, candidates: 0, skipped: 0 };
  try {
    await insertRow(target, cfg.targetSchema, "legacy_import_runs", {
      id: runId,
      source_system: "common",
      source_schema: cfg.sourceSchema,
      mode: cfg.mode,
      status: "running",
      scope_json: {
        domains: [...cfg.domains],
        withPrompts: cfg.withPrompts,
        composeDirectorPrompt: cfg.composeDirectorPrompt,
        autoCreateEpisodes: cfg.autoCreateEpisodes,
      },
      started_by: cfg.startedBy,
    });
    const ctx = new RunContext(cfg, source, target, runId);
    await ctx.loadExistingState();

    if (cfg.domains.has("user")) await processUsers(ctx, tally);
    if (cfg.domains.has("project")) await processProjects(ctx, tally);
    if (cfg.domains.has("asset")) await processOrphanAssets(ctx, tally);
    if (cfg.domains.has("pricing_rule")) await processPricingRules(ctx, tally);

    const bucketRows = await target.query<{ verify_bucket: VerifyBucket | null; count: string }>(
      `SELECT verify_bucket, count(*)::text AS count FROM ${ctx.targetSchema}.legacy_import_closures WHERE run_id=$1 GROUP BY verify_bucket`,
      [runId],
    );
    const buckets: Record<VerifyBucket, number> = { identical: 0, needs_human: 0, failed: 0 };
    for (const row of bucketRows.rows) if (row.verify_bucket) buckets[row.verify_bucket] = Number(row.count);
    const status = tally.failed > 0 || buckets.failed > 0
      ? "completed_with_issues"
      : (tally.conflict > 0 || tally.quarantined > 0 || buckets.needs_human > 0) ? "completed_with_issues" : "completed";
    await target.query(
      `UPDATE ${ctx.targetSchema}.legacy_import_runs
         SET status=$2, stats_json=$3::jsonb, finished_at=now() WHERE id=$1`,
      [runId, status, JSON.stringify({ tally, buckets })],
    );
    return { runId, mode: cfg.mode, tally, buckets };
  } catch (error) {
    await target.query(
      `UPDATE ${ctxTarget(cfg)}.legacy_import_runs SET status='aborted', finished_at=now(),
              error_message=$2 WHERE id=$1`,
      [runId, error instanceof Error ? error.message.slice(0, 512) : String(error)],
    ).catch(() => undefined);
    throw error;
  } finally {
    await source.end().catch(() => undefined);
    await target.end().catch(() => undefined);
  }
}

function ctxTarget(cfg: EtlRunConfig): string {
  return quoteIdent(cfg.targetSchema);
}

// ---------------------------------------------------------------------------
// 闭包粒度回滚(契约 §4.0:按 target_ids_json 反查删除,同事务删 crosswalk 行)
// ---------------------------------------------------------------------------

export async function rollbackClosure(cfg: {
  targetUrl: string;
  targetSchema: string;
  runId: string;
  closureKey: string;
}): Promise<{ deleted: Record<string, number> }> {
  const target = new Client({ connectionString: cfg.targetUrl });
  await target.connect();
  const schema = quoteIdent(cfg.targetSchema);
  const deleted: Record<string, number> = {};
  try {
    const found = await target.query<{
      id: string; status: string; target_ids_json: Record<string, unknown[]>;
    }>(
      `SELECT id, status, target_ids_json FROM ${schema}.legacy_import_closures WHERE run_id=$1 AND closure_key=$2`,
      [cfg.runId, cfg.closureKey],
    );
    const closure = found.rows[0];
    if (!closure) throw new Error(`闭包不存在: run=${cfg.runId} key=${cfg.closureKey}`);
    if (closure.status !== "migrated") {
      throw new Error(`只有 status='migrated' 的闭包可回滚(当前 ${closure.status};failed 闭包事务已回滚,无残留)`);
    }
    const ids = closure.target_ids_json;
    await target.query("BEGIN");
    // FK 安全顺序:shots → project_asset_refs → project_members → asset_entities →
    // episodes → projects → pricing_rules → users → crosswalk
    const deleteByIds = async (table: string, keyIds: unknown[], column = "id"): Promise<void> => {
      if (keyIds.length === 0) return;
      const result = await target.query(
        `DELETE FROM ${schema}."${table}" WHERE ${column} = ANY($1::uuid[])`, [keyIds],
      );
      deleted[table] = (deleted[table] ?? 0) + (result.rowCount ?? 0);
    };
    await deleteByIds("shots", (ids["shots"] ?? []) as string[]);
    await deleteByIds("project_asset_refs", (ids["project_asset_refs"] ?? []) as string[]);
    // project_members 是复合主键
    const members = (ids["project_members"] ?? []) as { project_id: string; user_id: string }[];
    for (const member of members) {
      const result = await target.query(
        `DELETE FROM ${schema}.project_members WHERE project_id=$1 AND user_id=$2`,
        [member.project_id, member.user_id],
      );
      deleted["project_members"] = (deleted["project_members"] ?? 0) + (result.rowCount ?? 0);
    }
    await deleteByIds("asset_entities", (ids["asset_entities"] ?? []) as string[]);
    await deleteByIds("episodes", (ids["episodes"] ?? []) as string[]);
    await deleteByIds("projects", (ids["projects"] ?? []) as string[]);
    await deleteByIds("pricing_rules", (ids["pricing_rules"] ?? []) as string[]);
    await deleteByIds("users", (ids["users"] ?? []) as string[]);
    await deleteByIds("legacy_identity_crosswalk", (ids["legacy_identity_crosswalk"] ?? []) as string[]);
    await target.query(
      `UPDATE ${schema}.legacy_import_closures
         SET status='rolled_back', rolled_back_at=now(), updated_at=now() WHERE id=$1`,
      [closure.id],
    );
    await target.query("COMMIT");
    return { deleted };
  } catch (error) {
    await target.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await target.end().catch(() => undefined);
  }
}
