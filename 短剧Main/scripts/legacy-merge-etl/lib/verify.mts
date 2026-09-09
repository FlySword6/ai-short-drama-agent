/**
 * 校验口径(纯逻辑 + 可执行 SQL 清单)。
 * 真源:docs/contracts/common-to-v020-mapping.md §4(校验 SQL 形状)与任务包"三桶验收"。
 *
 * 三桶:
 *   identical    完全一致——硬校验全过,且无 quarantine/conflict/降级
 *   needs_human  有差异需人工确认——硬校验全过,但存在 quarantine/conflict/降级项
 *   failed       迁移失败——守恒/孤儿/哨兵/价格复核任一硬校验不过
 */

export type VerifyBucket = "identical" | "needs_human" | "failed";

export interface ClosureVerifyInput {
  /** 闭包内各源表行数(抽取到的)。 */
  sourceCounts: Record<string, number>;
  /** crosswalk 决策计数(按 decision 分桶)。 */
  decisions: Record<"new" | "matched" | "conflict" | "quarantined", number>;
  /** 规则性跳过计数(如 owner grant 与自动 owner 成员行去重)——有代表行,不算异常。 */
  skippedByRule: number;
  /** 降级/截断等留痕条数(notes 非空的 ready 行)。 */
  degradationCount: number;
  /** 硬校验失败项(守恒/孤儿/哨兵/价格复核),空数组 = 全过。 */
  hardFailures: string[];
}

export function classifyClosure(input: ClosureVerifyInput): VerifyBucket {
  if (input.hardFailures.length > 0) return "failed";
  if (input.decisions.conflict > 0 || input.decisions.quarantined > 0) return "needs_human";
  if (input.degradationCount > 0) return "needs_human";
  return "identical";
}

/** 守恒公式(data-truth §4.D):源行数 = matched + new + conflict + quarantined + 规则性跳过。 */
export function conservationFailures(input: ClosureVerifyInput): string[] {
  const failures: string[] = [];
  const totalSource = Object.values(input.sourceCounts).reduce((sum, count) => sum + count, 0);
  const totalDecided = input.decisions.matched + input.decisions.new + input.decisions.conflict + input.decisions.quarantined
    + input.skippedByRule;
  if (totalSource !== totalDecided) {
    failures.push(`守恒失败:源行数 ${totalSource} ≠ 决策总数 ${totalDecided}(含规则性跳过 ${input.skippedByRule})`);
  }
  return failures;
}

export interface VerificationQuery {
  name: string;
  /** 期望成立的条件(人类可读;SQL 返回的行数必须 = 0 或与快照一致)。 */
  expect: string;
  sql: string;
}

/**
 * 全局核对查询(apply 窗口后执行;{{schema}} 由调用方渲染为目标 schema)。
 * 与契约 §4.1/§4.2/§4.3/§4.5/§4.6 一一对应。
 */
export function buildGlobalVerificationQueries(runId: string): VerificationQuery[] {
  const queries: VerificationQuery[] = [
    {
      name: "users.守恒",
      expect: "本批源行数 = 四种 decision 之和(返回应只有一行且 mismatch=0)",
      sql: `SELECT (SELECT count(*) FROM {{schema}}.legacy_identity_crosswalk WHERE source_table='users' AND import_run_id='${runId}') AS decisions_total,
       (SELECT count(*) FROM {{schema}}.legacy_identity_crosswalk WHERE source_table='users' AND import_run_id='${runId}' AND decision IN ('matched','new')) AS landed
-- 与源库 SELECT count(*) FROM common.users WHERE status<>'deleted' 手工对账`,
    },
    {
      name: "users.哨兵口令",
      expect: "= 0 行(本批落库用户 100% 为不可解析哨兵)",
      sql: `SELECT u.id FROM {{schema}}.users u
JOIN {{schema}}.legacy_identity_crosswalk x ON x.target_id = u.id AND x.target_table='users'
WHERE x.import_run_id='${runId}' AND u.password_hash <> 'legacy-import:reset-required:v1'`,
    },
    {
      name: "projects.成员无孤儿",
      expect: "= 0 行",
      sql: `SELECT m.project_id, m.user_id FROM {{schema}}.project_members m
LEFT JOIN {{schema}}.projects p ON p.id = m.project_id
LEFT JOIN {{schema}}.users u ON u.id = m.user_id
WHERE p.id IS NULL OR u.id IS NULL`,
    },
    {
      name: "projects.每项目恰一个 owner",
      expect: "= 0 行",
      sql: `SELECT project_id FROM {{schema}}.project_members WHERE role='owner'
GROUP BY project_id HAVING count(*) <> 1`,
    },
    {
      name: "assets.refs 无孤儿",
      expect: "= 0 行",
      sql: `SELECT r.id FROM {{schema}}.project_asset_refs r
LEFT JOIN {{schema}}.projects p ON p.id = r.project_id
LEFT JOIN {{schema}}.asset_entities e ON e.id = r.asset_entity_id
WHERE r.deleted_at IS NULL AND (p.id IS NULL OR e.id IS NULL)`,
    },
    {
      name: "shots.无孤儿",
      expect: "= 0 行",
      sql: `SELECT s.id FROM {{schema}}.shots s
LEFT JOIN {{schema}}.episodes e ON e.id = s.episode_id
WHERE s.deleted_at IS NULL AND e.id IS NULL`,
    },
    {
      name: "shots.迁入镜头必有提示词",
      expect: "= 0 行(本批迁入的 shots 至少一类提示词非空)",
      sql: `SELECT s.id FROM {{schema}}.shots s
JOIN {{schema}}.legacy_identity_crosswalk x ON x.target_id = s.id AND x.target_table='shots'
WHERE x.import_run_id='${runId}' AND s.deleted_at IS NULL
  AND s.director_prompt IS NULL AND s.image_prompt IS NULL AND s.video_prompt IS NULL`,
    },
    {
      name: "pricing.价格复核",
      expect: "= 0 行(unit_price_fen ≠ round(legacy output_unit_price × 100))",
      sql: `SELECT id FROM {{schema}}.pricing_rules
WHERE source LIKE 'legacy:common.model_pricing_rules:%'
  AND unit_price_fen <> round(((metadata->'legacy_prices'->>'output_unit_price')::numeric) * 100)`,
    },
    {
      name: "pricing.media_kind 值域",
      expect: "= 0 行",
      sql: `SELECT id FROM {{schema}}.pricing_rules
WHERE source LIKE 'legacy:common.model_pricing_rules:%' AND media_kind NOT IN ('image','video','audio')`,
    },
    {
      name: "账目隔离(红线 R4)",
      expect: "窗口前后两快照完全一致(本包不迁生成历史)",
      sql: `SELECT (SELECT count(*) FROM {{schema}}.generation_requests) AS requests,
       (SELECT count(*) FROM {{schema}}.generation_attempts) AS attempts,
       (SELECT count(*) FROM {{schema}}.media_results) AS results`,
    },
    {
      name: "账本分离(红线 R7)",
      expect: "schema_migrations 行数恰 = 本地迁移文件数,无 ETL 伪造记录",
      sql: `SELECT version FROM {{schema}}.schema_migrations ORDER BY version`,
    },
  ];
  return queries;
}
