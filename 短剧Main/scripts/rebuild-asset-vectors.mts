/**
 * S6 对冲件：用自有 Doubao 嵌入模型重建 asset_entities 的语义检索向量。
 *
 * 背景：云 Milvus 集合 asset_entity_vectors_v2 的 476 条向量用了我们无权调用的嵌入
 * 接入点。本脚本从本地 PostgreSQL 的 common.asset_entities 出发，按
 * identity / profile / style 三个语义面分别构建文本、分别用我们自己的 Doubao
 * 嵌入模型嵌入，写入应用配置的唯一资产向量集合。运行时同步、重建、搜索与删除
 * 必须共享同一 collection，禁止再创建脚本私有集合。
 *
 * 用法：
 *   npx tsx scripts/rebuild-asset-vectors.mts            # dry-run（默认）
 *   npx tsx scripts/rebuild-asset-vectors.mts --apply     # 实际调用 embedding + 写入 Milvus
 *
 * 幂等策略：
 * MilvusVectorStore（src/integrations/milvusVectorStore.ts）目前只暴露
 * upsert / search / deleteByIds，没有"按 id 精确查询"或"列出已存在 id"的方法，
 * 本任务又不允许修改 src/，所以本脚本不在 --apply 前做显式的"已存在 id 集合"
 * 预查询。取而代之的是三条互相配合的保证：
 *
 *   1. 向量 id 是确定性复合键 "asset_entities:<uuid>:<facet>"（对齐云 v2 的设计，
 *      也是 src/services/searchService.ts 的 parseVectorHitKey 已经在解析的格式），
 *      同一资产同一面永远落在同一个 id 上，不会因为重复运行产生新的重复行。
 *   2. metadata.text_hash 记录了参与嵌入文本的 sha256 前 16 位 hex，供人工或未来
 *      的增量同步脚本比对"这次待写入的文本是否和上次写入时相同"，从而判断是否
 *      值得跳过重新嵌入（本脚本当前每次 --apply 对所有非空面无条件重新嵌入，
 *      不读这个 hash 做跳过决策——先把 hash 落盘，跳过逻辑留给后续按需加）。
 *   3. Milvus 的 upsert 对同一主键是覆盖写（delete + insert 语义），所以重复执行
 *      --apply 只会让同一 id 的向量 / 文本 / metadata 收敛到当次计算结果，不会
 *      产生重复条目——upsert 本身的幂等性就是本脚本依赖的兜底。
 *
 * 红线：
 *   - dry-run 只读本地 PostgreSQL 统计计划，不实例化 DoubaoEmbeddingClient /
 *     MilvusVectorStore，不发起任何 embedding 或 Milvus 网络调用，不写任何库。
 *   - --apply 才会真正调用 embedding 接口并写入 Milvus；本任务只交付脚本和
 *     dry-run 结果，不实际执行 --apply。
 */

import { createHash } from "node:crypto";
import { isNull } from "drizzle-orm";
import { createDatabase } from "../src/db/client.js";
import { settings } from "../src/config/env.js";
import { assetEntities, type AssetEntityRow } from "../src/db/schema.js";
import { DoubaoEmbeddingClient } from "../src/integrations/embeddingClient.js";
import { MilvusVectorStore } from "../src/integrations/milvusVectorStore.js";
import type { JsonObject } from "../src/domain/assets/types.js";
import { textValue } from "../src/shared/values.js";
import { errorMessage } from "../src/shared/errors.js";
import {
  buildAssetVectorId,
  REBUILD_ASSET_VECTOR_FACETS,
  type RebuildAssetVectorFacet,
} from "../src/domain/assets/vectorKeys.js";

const FACETS = REBUILD_ASSET_VECTOR_FACETS;
type Facet = RebuildAssetVectorFacet;

/**
 * 与 src/services/vectorSyncService.ts 里同名私有常量保持一致的"空占位符"判定，
 * 因为那边没有导出，这里按同样的口径本地复制一份，避免脚本把占位符当成有效文本嵌入。
 */
const EMPTY_TEXT_VALUES = new Set([
  "", "-", "--", "/", "暂无", "暂无信息", "未填", "未知", "不详", "空", "none", "null", "n/a",
]);

/** 粗略字符/token 换算，仅用于 dry-run 成本量级估算，不是真实分词，见 summarizeDryRun 里的 pricingNote/methodNote。 */
const APPROX_CHARS_PER_TOKEN = 1.5;

const apply = process.argv.slice(2).includes("--apply");

interface FacetPlanItem {
  vectorId: string;
  facet: Facet;
  assetId: string;
  assetKind: string;
  text: string;
  charLength: number;
  textHash: string;
  metadata: JsonObject;
}

async function main(): Promise<void> {
  if (!settings.databaseUrl) {
    throw new Error(
      "Missing DATABASE_URL or complete POSTGRES_* configuration (POSTGRES_HOST/POSTGRES_PORT/POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD)",
    );
  }

  const rows = await loadActiveAssetEntities();
  const plan = buildFacetPlan(rows);

  if (!apply) {
    process.stdout.write(`${JSON.stringify(summarizeDryRun(rows, plan), null, 2)}\n`);
    return;
  }

  if (!settings.arkApiKey) throw new Error("--apply requires ARK_API_KEY");
  if (!settings.doubaoEmbeddingModel) throw new Error("--apply requires DOUBAO_EMBEDDING_MODEL");
  if (!settings.milvusUri) throw new Error("--apply requires MILVUS_URI");

  const embedding = new DoubaoEmbeddingClient();
  const store = new MilvusVectorStore();

  let upserted = 0;
  let failed = 0;
  for (const [index, item] of plan.entries()) {
    try {
      const vector = await embedding.embedText(item.text);
      await store.upsert(item.vectorId, vector, item.text, item.metadata);
      upserted += 1;
    } catch (error) {
      failed += 1;
      process.stderr.write(`[apply] ${item.vectorId} failed: ${errorMessage(error)}\n`);
    }
    if ((index + 1) % 100 === 0 || index + 1 === plan.length) {
      process.stderr.write(`[apply] progress ${index + 1}/${plan.length} (failed=${failed})\n`);
    }
  }

  process.stdout.write(`${JSON.stringify({
    mode: "apply",
    collection: settings.milvusCollectionAssetEntity,
    planned: plan.length,
    upserted,
    failed,
  }, null, 2)}\n`);
}

async function loadActiveAssetEntities(): Promise<AssetEntityRow[]> {
  const handle = createDatabase();
  try {
    return await handle.db.select().from(assetEntities).where(isNull(assetEntities.deletedAt));
  } finally {
    await handle.pool.end();
  }
}

function buildFacetPlan(rows: AssetEntityRow[]): FacetPlanItem[] {
  const items: FacetPlanItem[] = [];
  for (const row of rows) {
    for (const facet of FACETS) {
      const text = buildFacetText(facet, row);
      if (!text) continue; // 空文本的面跳过
      const textHash = sha256Prefix(text);
      items.push({
        vectorId: buildAssetVectorId("asset_entities", row.id, facet),
        facet,
        assetId: row.id,
        assetKind: row.assetKind,
        text,
        charLength: text.length,
        textHash,
        metadata: {
          source_table: "asset_entities",
          source_id: row.id,
          facet,
          asset_kind: row.assetKind,
          text_hash: textHash,
          name: row.name,
          display_name: row.displayName,
        },
      });
    }
  }
  return items;
}

function buildFacetText(facet: Facet, row: AssetEntityRow): string {
  if (facet === "identity") return buildIdentityText(row);
  if (facet === "profile") return buildProfileText(row);
  return buildStyleText(row);
}

/** identity：name + display_name + asset_kind + category */
function buildIdentityText(row: AssetEntityRow): string {
  const lines: string[] = [];
  const name = cleanText(row.name);
  const displayName = cleanText(row.displayName);
  if (name && displayName && name !== displayName) lines.push(`${name}（${displayName}）`);
  else if (name || displayName) lines.push(name || displayName);
  const assetKind = cleanText(row.assetKind);
  if (assetKind) lines.push(`类型：${assetKind}`);
  const category = cleanText(row.category);
  if (category) lines.push(`分类：${category}`);
  return lines.join("\n");
}

/** profile：intro + appearance + gender/age_value/height_cm/hair_description/outfit_description 拼可读中文句 */
function buildProfileText(row: AssetEntityRow): string {
  const lines: string[] = [];
  const intro = cleanText(row.intro);
  if (intro) lines.push(intro);
  const appearance = cleanText(row.appearance);
  if (appearance) lines.push(`外观：${appearance}`);
  const attrs: string[] = [];
  const gender = cleanText(row.gender);
  if (gender) attrs.push(`性别${gender}`);
  if (row.ageValue !== null) attrs.push(`年龄${row.ageValue}岁`);
  if (row.heightCm !== null) attrs.push(`身高${row.heightCm}cm`);
  const hair = cleanText(row.hairDescription);
  if (hair) attrs.push(`发型${hair}`);
  if (attrs.length) lines.push(attrs.join("，"));
  const outfit = cleanText(row.outfitDescription);
  if (outfit) lines.push(`服装：${outfit}`);
  return lines.join("\n");
}

/** style：style_tags + category */
function buildStyleText(row: AssetEntityRow): string {
  const lines: string[] = [];
  const tags = (row.styleTags ?? []).map(cleanText).filter(Boolean);
  if (tags.length) lines.push(`风格：${tags.join("、")}`);
  const category = cleanText(row.category);
  if (category) lines.push(`分类：${category}`);
  return lines.join("\n");
}

function cleanText(value: unknown): string {
  const text = textValue(value).replace(/[；;。]+/g, " ").trim();
  return EMPTY_TEXT_VALUES.has(text.toLowerCase()) ? "" : text;
}

function sha256Prefix(text: string, length = 16): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, length);
}

function summarizeDryRun(rows: AssetEntityRow[], plan: FacetPlanItem[]) {
  const facetStats = new Map<Facet, { count: number; totalChars: number }>();
  const assetIdsWithAnyFacet = new Set<string>();
  let totalChars = 0;

  // 按资产（rows）统计 kind 分布，避免和下面按 facet-item（plan）统计的量级混在一起——
  // 一个资产可能贡献 0~3 个 facet-item，用 plan 数会把 kind 分布放大 2~3 倍。
  const assetKindCounts = new Map<string, number>();
  for (const row of rows) {
    assetKindCounts.set(row.assetKind, (assetKindCounts.get(row.assetKind) ?? 0) + 1);
  }

  for (const item of plan) {
    const bucket = facetStats.get(item.facet) ?? { count: 0, totalChars: 0 };
    bucket.count += 1;
    bucket.totalChars += item.charLength;
    facetStats.set(item.facet, bucket);
    assetIdsWithAnyFacet.add(item.assetId);
    totalChars += item.charLength;
  }

  const facetBreakdown = FACETS.map((facet) => {
    const bucket = facetStats.get(facet) ?? { count: 0, totalChars: 0 };
    return {
      facet,
      textCount: bucket.count,
      totalChars: bucket.totalChars,
      avgChars: bucket.count ? Math.round(bucket.totalChars / bucket.count) : 0,
    };
  });

  const estimatedInputTokens = Math.ceil(totalChars / APPROX_CHARS_PER_TOKEN);

  return {
    mode: "dry-run",
    collection: settings.milvusCollectionAssetEntity,
    sourceTable: "common.asset_entities",
    sourceFilter: "deleted_at IS NULL",
    assetsQueried: rows.length,
    assetsWithAtLeastOneFacet: assetIdsWithAnyFacet.size,
    assetKindBreakdown: Object.fromEntries(assetKindCounts),
    facetBreakdown,
    embeddingCallsPlanned: plan.length,
    tokenEstimate: {
      totalChars,
      approxCharsPerToken: APPROX_CHARS_PER_TOKEN,
      estimatedInputTokens,
      methodNote: "按总字符数 / 1.5 粗估 token 数（CJK 文本的经验系数），不是真实分词结果，仅用于量级判断。",
      pricingNote:
        "未能从火山引擎官方定价页确认 doubao-embedding 当前每 token 单价（定价页未公示具体数值，第三方聚合站也标注为未收录），因此只报输入 token 量级，不折算金额。需要精确成本请直接查 https://www.volcengine.com/docs/82379 或账号控制台账单。",
    },
    writes: 0,
    externalCalls: 0,
    note: "dry-run 只读取本地 PostgreSQL common.asset_entities（deleted_at IS NULL）统计计划，未实例化 DoubaoEmbeddingClient / MilvusVectorStore，未调用 embedding 接口，未连接 Milvus，未写入任何数据库。执行 --apply 才会真正嵌入并写入 Milvus collection。",
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error) || "Asset vector rebuild failed"}\n`);
  process.exitCode = 1;
});
