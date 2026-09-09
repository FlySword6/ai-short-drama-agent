import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  episodes,
  generationAttempts,
  generationRequests,
  mediaProvenanceParentEdges,
  mediaProvenanceSubjects,
  mediaResults,
  projectAssetRefs,
  projects,
  scenes,
  scriptBreakdownRuns,
  seedanceAssetRegistrations,
  shots,
  type ShotMetadata,
} from "../../db/schema.js";
import { BadRequestError } from "../../shared/errors.js";
import { buildVersionSnapshot, lockProjectAssetNamespace } from "../project-assets/repository.js";
import { draftFromUnknown } from "../script-breakdown/schemas.js";
import type {
  LiteAddUsageItemInput,
  LiteAddUsagesResult,
  LiteAssetCandidateInput,
  LiteAssetDetail,
  LiteAssetListItem,
  LiteAssetListResult,
  LiteAssetKind,
  LiteAssetMediaItem,
  LiteAssetTabCount,
  LiteAssetUsageEntry,
  LiteAssetVariant,
  LiteAssetVersionTrackItem,
  LiteConfirmedRunAssetDraft,
  LiteContainerEpisode,
  LiteMaterializeAssetsResult,
  LiteMaterializedAsset,
  LiteMatchSuggestShotRow,
  LitePatchAssetInput,
  LiteReferenceAssetItem,
  LiteRepository,
  LiteShotCandidateInput,
  LiteVariantMatchProfile,
} from "./types.js";

/**
 * Lite BFF 的数据访问。读 projects/episodes/media_results/shots/script_breakdown_runs;
 * 写路径只有三条,均为 R1 特许的项目内写:建容器集、回写 projects.lite_episode_id、
 * 候选落资产(asset_entities + project_asset_refs,写清单扩 refs 已经拍板)。
 */
export class DrizzleLiteRepository implements LiteRepository {
  constructor(private readonly db: Database) {}

  /** 多集模式:确认 episodeId 属于 projectId 且未软删。 */
  async findEpisode(projectId: string, episodeId: string): Promise<LiteContainerEpisode | null> {
    const rows = await this.db.select({ id: episodes.id, projectId: episodes.projectId, episodeNo: episodes.episodeNo })
      .from(episodes)
      .where(and(
        eq(episodes.id, episodeId),
        eq(episodes.projectId, projectId),
        isNull(episodes.deletedAt),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 整剧导入:建集(与完整版 createEpisode 同表同字段)。 */
  async createEpisode(projectId: string, episodeNo: number, name: string, now: Date): Promise<string> {
    const [row] = await this.db.insert(episodes).values({
      id: crypto.randomUUID(),
      projectId,
      episodeNo,
      name,
      sortOrder: episodeNo,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).returning({ id: episodes.id });
    return row!.id;
  }

  /** 整剧导入的覆盖语义:软删项目下全部未软删的集,返回被覆盖的集数。 */
  async softDeleteActiveEpisodes(projectId: string, actorId: string, now: Date): Promise<number> {
    const rows = await this.db.update(episodes)
      .set({ deletedAt: now, deletedByUserId: actorId, updatedAt: now })
      .where(and(
        eq(episodes.projectId, projectId),
        isNull(episodes.deletedAt),
      ))
      .returning({ id: episodes.id });
    return rows.length;
  }

  async hasPersistedMedia(episodeId: string): Promise<boolean> {
    // 成片判定口径照 delivery:media_results 内连 shots 限定到集,两侧都未软删
    // 才算成片仍在(已弃用的候选不挡用户重发剧本)。
    const rows = await this.db.select({ id: mediaResults.id })
      .from(mediaResults)
      .innerJoin(shots, eq(shots.id, mediaResults.shotId))
      .where(and(
        eq(shots.episodeId, episodeId),
        isNull(mediaResults.deletedAt),
        isNull(shots.deletedAt),
      ))
      .limit(1);
    return rows.length > 0;
  }

  async linkContainerEpisode(projectId: string, episodeId: string, now: Date): Promise<void> {
    await this.db.update(projects).set({ liteEpisodeId: episodeId, updatedAt: now })
      .where(eq(projects.id, projectId));
  }

  async findLatestConfirmedRunAssetDraft(episodeId: string): Promise<LiteConfirmedRunAssetDraft | null> {
    // 「最新」口径照 script-breakdown listRuns:created_at 倒序取一。
    const rows = await this.db.select({
      id: scriptBreakdownRuns.id,
      draftJson: scriptBreakdownRuns.draftJson,
    })
      .from(scriptBreakdownRuns)
      .where(and(
        eq(scriptBreakdownRuns.episodeId, episodeId),
        eq(scriptBreakdownRuns.status, "confirmed"),
      ))
      .orderBy(desc(scriptBreakdownRuns.createdAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // draft_json 是 camelCase 存储,回读走源模块同一校验口,形状非法在此暴露。
    const draft = draftFromUnknown(row.draftJson);
    return {
      runId: row.id,
      assetCandidates: draft.assetCandidates ?? null,
      shotCandidates: draft.shotCandidates ?? [],
    };
  }

  async materializeAssetCandidates(input: {
    projectId: string;
    actorId: string;
    runId: string;
    candidates: LiteAssetCandidateInput[];
    shotCandidates: LiteShotCandidateInput[];
    episodeNo: number;
    episodeId: string;
    now: Date;
  }): Promise<LiteMaterializeAssetsResult> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await lockProjectAssetNamespace(db, input.projectId);
      const assets: LiteMaterializedAsset[] = [];
      let created = 0;
      let existed = 0;
      for (const candidate of input.candidates) {
        // 幂等口径与 project-assets 同名冲突检查一致:refs 内连 entities,两侧未软删。
        const sameName = await db.select({ assetEntityId: assetEntities.id, metadata: assetEntities.metadata })
          .from(projectAssetRefs)
          .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
          .where(and(
            eq(projectAssetRefs.projectId, input.projectId),
            isNull(projectAssetRefs.deletedAt),
            isNull(assetEntities.deletedAt),
            eq(assetEntities.assetKind, candidate.assetKind),
            eq(assetEntities.name, candidate.name),
          ))
          .limit(1)
          .for("update");
        const hit = sameName[0];
        if (hit) {
          existed += 1;
          // 既有资产:幂等确保有第一个变体(无 active 变体才建)。
          await this.ensureFirstVariant(db, hit.assetEntityId, candidate.name, input.now);
          // v0.9:存量音频资产缺分类时补记 metadata.audio_kind(只补不盖,人工改过的不动)。
          if (candidate.assetKind === "audio" && candidate.audioKind
            && typeof (hit.metadata as Record<string, unknown> | null)?.audio_kind !== "string") {
            await db.update(assetEntities).set({
              metadata: { ...(hit.metadata as Record<string, unknown> ?? {}), audio_kind: candidate.audioKind },
              updatedAt: input.now,
            }).where(eq(assetEntities.id, hit.assetEntityId));
          }
          assets.push({
            assetEntityId: hit.assetEntityId,
            assetKind: candidate.assetKind,
            name: candidate.name,
            outcome: "existing",
          });
          continue;
        }

        // 个人资产口径照 assetEntityRepository 个人分支与 seedance 提升:
        // personal 不参与审核状态机,owner 本人即可被生成引用
        // (isDirectAssetUsableForGeneration),项目成员经项目引用获得口径。
        const entity = (await db.insert(assetEntities).values({
          id: crypto.randomUUID(),
          copiedFromAssetEntityId: null,
          sourceProjectId: input.projectId,
          sourceProjectName: null,
          ownerUserId: input.actorId,
          visibility: "personal",
          assetKind: candidate.assetKind,
          role: null,
          usageMode: null,
          name: candidate.name,
          displayName: candidate.name,
          intro: candidate.description,
          appearance: null,
          ageValue: null,
          gender: null,
          heightCm: null,
          hairDescription: null,
          outfitDescription: null,
          category: null,
          styleTags: [],
          approved: true,
          reuseScope: "all_projects",
          status: "approved",
          sourceFileUrl: null,
          metadata: {
            source: "lite_asset_materialize",
            source_breakdown_run_id: input.runId,
            source_candidate_id: candidate.candidateId,
            // v0.9:音频五类分类落 metadata.audio_kind(阶段①抽取,素材页/详情页展示)。
            ...(candidate.assetKind === "audio" && candidate.audioKind
              ? { audio_kind: candidate.audioKind }
              : {}),
          },
          createdAt: input.now,
          updatedAt: input.now,
          useCount: 0,
          deletedAt: null,
          deletedByUserId: null,
        }).returning())[0]!;

        const reference = (await db.insert(projectAssetRefs).values({
          id: crypto.randomUUID(),
          projectId: input.projectId,
          assetEntityId: entity.id,
          assetVariantId: null,
          assetMediaId: null,
          versionSnapshot: buildVersionSnapshot(input.now, entity, null, null),
          createdByUserId: input.actorId,
          createdAt: input.now,
          deletedAt: null,
          deletedByUserId: null,
        }).onConflictDoNothing().returning({ id: projectAssetRefs.id }))[0];
        if (reference) {
          // 采用次数口径照 project-assets:只在首次建立活跃项目引用时 +1。
          await db.update(assetEntities).set({
            useCount: sql`${assetEntities.useCount} + 1`,
          }).where(eq(assetEntities.id, entity.id));
        }
        // 新资产:建第一个变体(T10.6,脚本解析自动建第一个变体)。
        await this.ensureFirstVariant(db, entity.id, candidate.name, input.now);
        created += 1;
        assets.push({
          assetEntityId: entity.id,
          assetKind: candidate.assetKind,
          name: candidate.name,
          outcome: "created",
        });
      }
      // backfill:confirmed run 的分镜候选按 (asset_entity_id, variant_id) 二元组
      // 写 usages + 回填 shots.reference_asset_snapshots(exact_name,幂等,manual 不被覆盖)。
      // v0.9:匹配集 = 本次落库候选 ∪ 本项目全部五类资产(含用户手动新建的资产/变体)——
      // 存量资产只要本集分镜引用其名,同样写出现记录;A 层精确名、B 层变体语义,零 AI 调用。
      const existingRows = await db.select({
        assetEntityId: assetEntities.id,
        assetKind: assetEntities.assetKind,
        name: assetEntities.name,
      })
        .from(projectAssetRefs)
        .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
        .where(and(
          eq(projectAssetRefs.projectId, input.projectId),
          isNull(projectAssetRefs.deletedAt),
          isNull(assetEntities.deletedAt),
          inArray(assetEntities.assetKind, ["character", "scene", "prop", "costume", "audio"]),
        ));
      const seenIds = new Set(assets.map((asset) => asset.assetEntityId));
      const backfillAssets: LiteMaterializedAsset[] = [
        ...assets,
        ...existingRows
          .filter((row) => !seenIds.has(row.assetEntityId))
          .map((row) => ({ assetEntityId: row.assetEntityId, assetKind: row.assetKind as LiteAssetKind, name: row.name, outcome: "existing" as const })),
      ];
      const backfill = await this.backfillShotAssetReferences(db, {
        projectId: input.projectId,
        episodeId: input.episodeId,
        episodeNo: input.episodeNo,
        assets: backfillAssets,
        shotCandidates: input.shotCandidates,
        now: input.now,
      });
      return {
        created,
        existed,
        assets,
        variantMatches: backfill.variantMatches,
        variantMatchSkipped: backfill.variantMatchSkipped,
        aiVariantMatches: 0,
        aiVariantMatchSkipped: null,
      };
    });
  }

  /**
   * 幂等确保资产有第一个变体:无 active 变体时建 asset_variants 首行
   * (variant_kind="look", name=资产名, is_primary=true, sort_order=0, status="approved")。
   */
  private async ensureFirstVariant(db: Database, assetEntityId: string, assetName: string, now: Date): Promise<string> {
    const [existing] = await db.select({ id: assetVariants.id })
      .from(assetVariants)
      .where(and(
        eq(assetVariants.assetEntityId, assetEntityId),
        isNull(assetVariants.deletedAt),
      ))
      .orderBy(assetVariants.sortOrder)
      .limit(1);
    if (existing) return existing.id;
    const [row] = await db.insert(assetVariants).values({
      id: crypto.randomUUID(),
      assetEntityId,
      variantKind: "look",
      name: assetName,
      description: null,
      usageContext: null,
      status: "approved",
      isPrimary: true,
      sortOrder: 0,
      sourceFileUrl: null,
      sourceText: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    }).returning({ id: assetVariants.id });
    return row!.id;
  }

  /**
   * v1.3/v1.7 backfill:confirmed run 的分镜候选按名字与本次落库资产对拍,命中后
   * 经 shots.source_candidate_id 反查真实分镜,写 metadata.lite.usages(exact_name)+
   * 回填 shots.reference_asset_snapshots。两层:A 确定性层按资产名挂第一个变体
   * (v1.3,行为不变);B 变体语义层按变体名/别名对分镜 subject/visual/script_text
   * 保守子串命中、挂非第一变体(v1.7,八.10)。幂等:同 (shot_id, variant_id) 已有条目
   * 整体刷新;同 shot 已有 manual 关联不被覆盖;shots.metadata.lite.removedAutoRefs
   * 名单内的对两层都不复活。返回 { variantMatches, variantMatchSkipped }:B 层计数
   * 与整体跳过原因(B 层异常不阻断 materialize)。
   */
  private async backfillShotAssetReferences(
    db: Database,
    input: {
      projectId: string;
      episodeId: string;
      episodeNo: number;
      assets: LiteMaterializedAsset[];
      shotCandidates: LiteShotCandidateInput[];
      now: Date;
    },
  ): Promise<{ variantMatches: number; variantMatchSkipped: string | null }> {
    if (input.assets.length === 0 || input.shotCandidates.length === 0) {
      return { variantMatches: 0, variantMatchSkipped: null };
    }
    const candidateIds = input.shotCandidates.map((s) => s.candidateId);
    const shotRows = await db.select({
      id: shots.id,
      sourceCandidateId: shots.sourceCandidateId,
      scriptText: shots.scriptText,
      breakdownElements: shots.breakdownElements,
      metadata: shots.metadata,
      sortOrder: shots.sortOrder,
      referenceAssetSnapshots: shots.referenceAssetSnapshots,
    })
      .from(shots)
      .where(and(
        eq(shots.episodeId, input.episodeId),
        isNull(shots.deletedAt),
        inArray(shots.sourceCandidateId, candidateIds),
      ));
    if (shotRows.length === 0) return { variantMatches: 0, variantMatchSkipped: null };
    const shotByCandidateId = new Map(shotRows.map((r) => [r.sourceCandidateId, r]));

    // 按 (kind, name) 索引本次落库资产,收集每资产命中的 (shotId, 证据)。
    const assetByKindName = new Map(input.assets.map((a) => [`${a.assetKind}:${a.name}`, a]));
    const matchesByAsset = new Map<string, Array<{
      sourceCandidateId: string;
      shotId: string;
      shotNo: number;
      sceneNames: string[];
      lineIndices: number[];
      sourceTextSnippets: string[];
    }>>();
    for (const shotCandidate of input.shotCandidates) {
      const shot = shotByCandidateId.get(shotCandidate.candidateId);
      if (!shot) continue;
      const references: Array<[LiteAssetKind, string[]]> = [
        ["character", shotCandidate.characterNames],
        ["scene", shotCandidate.sceneNames],
        ["prop", shotCandidate.propNames],
        ["costume", shotCandidate.costumeNames],
        // v0.9:音频出现记录——阶段② assetDefinitions 的 audio 引用(只写 usages,不写生成快照)。
        ["audio", shotCandidate.audioNames],
      ];
      const seenInShot = new Set<string>();
      for (const [kind, names] of references) {
        for (const name of names) {
          const asset = assetByKindName.get(`${kind}:${name}`);
          if (!asset || seenInShot.has(asset.assetEntityId)) continue;
          seenInShot.add(asset.assetEntityId);
          const sourceSnippets = shot.scriptText
            ? shot.scriptText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
            : [];
          const list = matchesByAsset.get(asset.assetEntityId) ?? [];
          list.push({
            sourceCandidateId: shotCandidate.candidateId,
            shotId: shot.id,
            shotNo: shotCandidate.shotNo,
            sceneNames: shotCandidate.sceneNames,
            lineIndices: shotCandidate.lineIndices,
            sourceTextSnippets: sourceSnippets,
          });
          matchesByAsset.set(asset.assetEntityId, list);
        }
      }
    }
    // 匹配集为空也进资产行取数:B 层按全部本集资产的非第一变体命中分镜文本,
    // 不依赖 A 层 (kind, name) 对拍结果(八.10.2:「本集每个非第一变体」)。

    // 批量取命中资产的 metadata + 已有变体,写回 usages 与快照。
    const assetIds = [...matchesByAsset.keys()];
    const assetRows = await db.select({
      id: assetEntities.id,
      name: assetEntities.name,
      assetKind: assetEntities.assetKind,
      metadata: assetEntities.metadata,
    })
      .from(assetEntities)
      .where(inArray(assetEntities.id, assetIds));
    for (const assetRow of assetRows) {
      const matches = matchesByAsset.get(assetRow.id) ?? [];
      if (matches.length === 0) continue;
      const firstVariantId = await this.ensureFirstVariant(db, assetRow.id, assetRow.name, input.now);
      const metadata = assetRow.metadata as Record<string, unknown>;
      const lite = (metadata.lite as Record<string, unknown> | undefined) ?? {};
      const usages = Array.isArray(lite.usages)
        ? [...lite.usages as Array<Record<string, unknown>>]
        : [];
      let usagesChanged = false;
      const snapshotsToWrite: Array<{ shotId: string; snapshot: Record<string, unknown> }> = [];

      for (const match of matches) {
        // v1.7 抑制名单:分镜侧删除过的 (asset, variant) 对,A 层重跑不复活(八.10.4)。
        if (shotSuppressed(shotByCandidateId.get(match.sourceCandidateId)?.metadata ?? null, assetRow.id, firstVariantId)) continue;
        // manual 优先:同 shot 已有 manual 关联 → backfill 不覆盖。
        // 旧分组格式 {episode_id, shot_ids[]}(无 matched_by 字段)同样视为 manual,不被覆盖。
        const hasManual = usages.some((u) =>
          u.shot_id === match.shotId && u.matched_by === "manual",
        ) || usages.some((u) =>
          !u.matched_by
          && u.episode_id === input.episodeId
          && Array.isArray(u.shot_ids)
          && (u.shot_ids as unknown[]).includes(match.shotId),
        );
        if (hasManual) continue;
        const existingIdx = usages.findIndex((u) =>
          u.shot_id === match.shotId
          && u.variant_id === firstVariantId
          && u.matched_by === "exact_name",
        );
        const usageId = deterministicUsageId(
          "asset", assetRow.id, firstVariantId, input.episodeId, String(match.shotNo), "exact_name",
        );
        const entry: Record<string, unknown> = {
          usage_id: usageId,
          variant_id: firstVariantId,
          episode_id: input.episodeId,
          episode_no: input.episodeNo,
          shot_id: match.shotId,
          shot_no: match.shotNo,
          shot_candidate_id: null,
          scene_names: match.sceneNames,
          line_indices: match.lineIndices,
          source_text_snippets: match.sourceTextSnippets,
          status: "bound",
          matched_by: "exact_name",
        };
        if (existingIdx >= 0) {
          usages[existingIdx] = entry;
        } else {
          usages.push(entry);
        }
        usagesChanged = true;
        // v0.9:音频只写出现记录——生成消费链(resolveShotAssetVariantReferences)
        // 认四栏引用,音频快照写进去也是死数据。
        if (assetRow.assetKind !== "audio") {
          snapshotsToWrite.push({
            shotId: match.shotId,
            snapshot: {
              asset_entity_id: assetRow.id,
              variant_id: firstVariantId,
              name: assetRow.name,
              asset_kind: assetRow.assetKind,
              matched_by: "exact_name",
            },
          });
        }
      }

      if (usagesChanged) {
        lite.usages = usages;
        metadata.lite = lite;
        await db.update(assetEntities)
          .set({ metadata, updatedAt: input.now })
          .where(eq(assetEntities.id, assetRow.id));
      }
      if (snapshotsToWrite.length > 0) {
        await this.writeExactNameSnapshots(db, snapshotsToWrite, input.now);
      }
    }

    // --- B 层(八.10.2,v1.7):变体语义层。只处理非第一变体,按变体名/别名对本集真实
    // 分镜 subject/visual/script_text 保守子串命中;歧义即跳过;异常整体兜底,不阻断
    // materialize(A 层上面已写完)。写入与 A 层同形:exact_name usages + writeExactNameSnapshots。
    try {
      const variantRows = await db.select({
        id: assetVariants.id,
        assetEntityId: assetVariants.assetEntityId,
        name: assetVariants.name,
        metadata: assetVariants.metadata,
        sortOrder: assetVariants.sortOrder,
      })
        .from(assetVariants)
        .where(and(
          inArray(assetVariants.assetEntityId, input.assets.map((a) => a.assetEntityId)),
          isNull(assetVariants.deletedAt),
        ))
        .orderBy(asc(assetVariants.sortOrder));
      const variantsByAsset = new Map<string, typeof variantRows>();
      for (const row of variantRows) {
        const list = variantsByAsset.get(row.assetEntityId) ?? [];
        list.push(row);
        variantsByAsset.set(row.assetEntityId, list);
      }

      const variantInputs: VariantMatchInput[] = [];
      for (const asset of input.assets) {
        // v0.9:音频只走 A 层出现记录;B 层语义匹配认分镜 subject/visual 文本,音频变体不参与。
        if (asset.assetKind === "audio") continue;
        const rows = variantsByAsset.get(asset.assetEntityId) ?? [];
        for (const variant of rows.slice(1)) {
          variantInputs.push({
            assetEntityId: asset.assetEntityId,
            assetName: asset.name,
            variantId: variant.id,
            variantName: variant.name,
            aliases: readVariantAliases(variant.metadata),
          });
        }
      }
      if (variantInputs.length > 0) {
        // shotId → 候选分镜(三要素与证据来源;shotRows 均由 source_candidate_id 反查而来)。
        const candidateByCandidateId = new Map(input.shotCandidates.map((c) => [c.candidateId, c]));
        const candidateByShotId = new Map(
          shotRows
            .map((row) => [row.id, candidateByCandidateId.get(row.sourceCandidateId ?? "")] as const)
            .filter(([, candidate]) => candidate !== undefined),
        );
        const shotInputs: VariantMatchShotInput[] = shotRows.map((row) => {
          const elements = row.breakdownElements as Record<string, unknown> | null;
          const candidate = candidateByShotId.get(row.id);
          return {
            shotId: row.id,
            shotNo: candidate?.shotNo ?? row.sortOrder,
            matchText: buildShotMatchText(
              typeof elements?.subject === "string" ? elements.subject : null,
              typeof elements?.visual === "string" ? elements.visual : null,
              row.scriptText,
            ),
            removedAutoRefs: readRemovedAutoRefs(row.metadata),
            // 分镜快照侧已有任意关联的对(manual/exact_name)→ 不重复写。
            existingPairs: (Array.isArray(row.referenceAssetSnapshots) ? row.referenceAssetSnapshots : [])
              .filter((s): s is Record<string, unknown> => typeof (s as Record<string, unknown>).variant_id === "string")
              .map((s) => ({
                asset_entity_id: s.asset_entity_id as string,
                variant_id: s.variant_id as string,
              })),
          };
        });
        // B 层写入需要全部命中资产的当前行(A 层可能刚写过 usages,重新取最新)。
        const variantAssetIds = [...new Set(variantInputs.map((v) => v.assetEntityId))];
        const variantAssetRows = await db.select({
          id: assetEntities.id,
          name: assetEntities.name,
          assetKind: assetEntities.assetKind,
          metadata: assetEntities.metadata,
        })
          .from(assetEntities)
          .where(inArray(assetEntities.id, variantAssetIds));
        const assetRowsById = new Map(variantAssetRows.map((r) => [r.id, r]));
        const writesByAsset = new Map<string, Array<VariantShotMatch>>();
        for (const hit of matchVariantShots(variantInputs, shotInputs)) {
          const assetRow = assetRowsById.get(hit.assetEntityId);
          if (!assetRow) continue;
          const list = writesByAsset.get(hit.assetEntityId) ?? [];
          list.push(hit);
          writesByAsset.set(hit.assetEntityId, list);
        }

        let variantMatches = 0;
        for (const [assetEntityId, hits] of writesByAsset) {
          const assetRow = assetRowsById.get(assetEntityId)!;
          const metadata = assetRow.metadata as Record<string, unknown>;
          const lite = (metadata.lite as Record<string, unknown> | undefined) ?? {};
          const usages = Array.isArray(lite.usages)
            ? [...lite.usages as Array<Record<string, unknown>>]
            : [];

          let usagesChanged = false;
          const snapshotsToWrite: Array<{ shotId: string; snapshot: Record<string, unknown> }> = [];

          for (const hit of hits) {
            // 已有关联(manual/exact_name/pending,含旧分组格式)→ 跳过(八.10.2);
            // B 层只增不刷新,既有 exact_name 条目保留原样。
            const hasExisting = usages.some((u) =>
              u.shot_id === hit.shotId && u.variant_id === hit.variantId,
            ) || usages.some((u) =>
              !u.matched_by
              && Array.isArray(u.shot_ids)
              && (u.shot_ids as unknown[]).includes(hit.shotId),
            );
            if (hasExisting) continue;
            const usageId = deterministicUsageId(
              "asset", assetRow.id, hit.variantId, input.episodeId, String(hit.shotNo), "exact_name",
            );
            const match = matchesByAsset.get(assetEntityId)?.find((m) => m.shotId === hit.shotId);
            const candidate = candidateByShotId.get(hit.shotId);
            const scriptText = shotRows.find((r) => r.id === hit.shotId)?.scriptText ?? null;
            const snippets = match?.sourceTextSnippets ?? (scriptText
              ? scriptText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
              : []);
            usages.push({
              usage_id: usageId,
              variant_id: hit.variantId,
              episode_id: input.episodeId,
              episode_no: input.episodeNo,
              shot_id: hit.shotId,
              shot_no: hit.shotNo,
              shot_candidate_id: null,
              scene_names: match?.sceneNames ?? candidate?.sceneNames ?? [],
              line_indices: match?.lineIndices ?? candidate?.lineIndices ?? [],
              source_text_snippets: snippets,
              status: "bound",
              matched_by: "exact_name",
            });
            usagesChanged = true;
            variantMatches += 1;
            snapshotsToWrite.push({
              shotId: hit.shotId,
              snapshot: {
                asset_entity_id: assetRow.id,
                variant_id: hit.variantId,
                name: assetRow.name,
                asset_kind: assetRow.assetKind,
                matched_by: "exact_name",
              },
            });

          }

          if (usagesChanged) {
            lite.usages = usages;
            metadata.lite = lite;
            await db.update(assetEntities)
              .set({ metadata, updatedAt: input.now })
              .where(eq(assetEntities.id, assetEntityId));
          }
          if (snapshotsToWrite.length > 0) {
            await this.writeExactNameSnapshots(db, snapshotsToWrite, input.now);
          }
        }
        return { variantMatches, variantMatchSkipped: null };
      }
      return { variantMatches: 0, variantMatchSkipped: null };
    } catch (error) {
      // B 层失败不阻断 materialize(T15.7):A 层已写入不受影响,原因带回响应。
      return {
        variantMatches: 0,
        variantMatchSkipped: error instanceof Error ? error.message : "variant_match_failed",
      };
    }
  }

  /**
   * 批量回填 exact_name 快照:按 (asset_entity_id, variant_id) 替换同对的 exact_name
   * 快照;同对已有 manual 快照不覆盖(manual 优先)。
   */
  private async writeExactNameSnapshots(
    db: Database,
    entries: Array<{ shotId: string; snapshot: Record<string, unknown> }>,
    now: Date,
  ): Promise<void> {
    for (const { shotId, snapshot } of entries) {
      const [shot] = await db.select({ referenceAssetSnapshots: shots.referenceAssetSnapshots })
        .from(shots).where(eq(shots.id, shotId)).limit(1);
      if (!shot) continue;
      const snapshots = Array.isArray(shot.referenceAssetSnapshots) ? [...shot.referenceAssetSnapshots] : [];
      const assetId = snapshot.asset_entity_id;
      const variantId = snapshot.variant_id;
      const hasManual = snapshots.some((s) => {
        const e = s as Record<string, unknown>;
        return e.asset_entity_id === assetId && e.variant_id === variantId && e.matched_by === "manual";
      });
      if (hasManual) continue;
      const filtered = snapshots.filter((s) => {
        const e = s as Record<string, unknown>;
        return !(e.asset_entity_id === assetId && e.variant_id === variantId && e.matched_by === "exact_name");
      });
      filtered.push(snapshot);
      await db.update(shots).set({ referenceAssetSnapshots: filtered, updatedAt: now })
        .where(eq(shots.id, shotId));
    }
  }

  async listAssetMedia(input: { projectId: string; assetEntityId: string }): Promise<LiteAssetMediaItem[]> {
    // 候选图取数:generation_requests.target_asset_entity_id 命中的产物;
    // 额外限定本项目,别的项目对同一资产的生成不混进本项目的候选列表。
    return this.db.select({
      id: mediaResults.id,
      mediaKind: mediaResults.mediaKind,
      storageUrl: mediaResults.storageUrl,
      persistenceStatus: mediaResults.persistenceStatus,
      reviewStatus: mediaResults.reviewStatus,
      generationRequestId: mediaResults.requestId,
      widthPx: mediaResults.widthPx,
      heightPx: mediaResults.heightPx,
      createdAt: mediaResults.createdAt,
    })
      .from(mediaResults)
      .innerJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
      .where(and(
        eq(generationRequests.targetAssetEntityId, input.assetEntityId),
        eq(generationRequests.projectId, input.projectId),
        isNull(mediaResults.deletedAt),
      ))
      .orderBy(desc(mediaResults.createdAt));
  }

  async listReferenceAssets(input: { projectId: string }): Promise<LiteReferenceAssetItem[]> {
    // 链路:项目资产(refs 内连 entities,两侧未软删)→ 本项目生成产物
    // (generation_requests.target_asset_entity_id 命中且限定本项目,media_results 内连)
    // → seedance 登记(source_media_result_id 指 media_results.id,只认 status='active')
    // → 登记 asset_media_id 对应的 asset_media 行(storage_url 来源)。
    const rows = await this.db.select({
      assetEntityId: assetEntities.id,
      name: assetEntities.name,
      kind: assetEntities.assetKind,
      assetMediaId: seedanceAssetRegistrations.assetMediaId,
      storageUrl: assetMedia.storageUrl,
      registeredAt: seedanceAssetRegistrations.updatedAt,
    })
      .from(projectAssetRefs)
      .innerJoin(assetEntities, and(
        eq(assetEntities.id, projectAssetRefs.assetEntityId),
        isNull(assetEntities.deletedAt),
      ))
      .innerJoin(generationRequests, and(
        eq(generationRequests.targetAssetEntityId, assetEntities.id),
        eq(generationRequests.projectId, input.projectId),
      ))
      .innerJoin(mediaResults, eq(mediaResults.requestId, generationRequests.id))
      .innerJoin(seedanceAssetRegistrations, and(
        eq(seedanceAssetRegistrations.sourceMediaResultId, mediaResults.id),
        eq(seedanceAssetRegistrations.status, "active"),
      ))
      .innerJoin(assetMedia, eq(assetMedia.id, seedanceAssetRegistrations.assetMediaId))
      .where(and(
        eq(projectAssetRefs.projectId, input.projectId),
        isNull(projectAssetRefs.deletedAt),
      ))
      .orderBy(desc(seedanceAssetRegistrations.updatedAt));

    // 每资产只回最新一条 active 登记:已按登记 updated_at 倒序,首见即最新。
    const seen = new Set<string>();
    const items: LiteReferenceAssetItem[] = [];
    for (const row of rows) {
      if (seen.has(row.assetEntityId)) continue;
      seen.add(row.assetEntityId);
      items.push(row);
    }
    return items;
  }

  /** 素材列表页:按项目(+可选 kind)列资产实体,附 tab 聚合计数。 */
  async listAssets(input: { projectId: string; kind?: string }): Promise<LiteAssetListResult> {
    const baseCondition = [
      eq(projectAssetRefs.projectId, input.projectId),
      isNull(projectAssetRefs.deletedAt),
      isNull(assetEntities.deletedAt),
    ];
    const itemsCondition = input.kind
      ? [...baseCondition, eq(assetEntities.assetKind, input.kind)]
      : baseCondition;

    const rows = await this.db.select({
      assetEntityId: assetEntities.id,
      name: assetEntities.name,
      intro: assetEntities.intro,
      assetKind: assetEntities.assetKind,
      metadata: assetEntities.metadata,
      updatedAt: assetEntities.updatedAt,
    })
      .from(projectAssetRefs)
      .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
      .where(and(...itemsCondition))
      .orderBy(desc(assetEntities.updatedAt));

    // tab 聚合:不受 kind 过滤影响,全量按 asset_kind 计数。
    const countRows = await this.db.select({
      kind: assetEntities.assetKind,
      count: sql<number>`count(*)::int`,
    })
      .from(projectAssetRefs)
      .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
      .where(and(...baseCondition))
      .groupBy(assetEntities.assetKind);
    const tabCounts: LiteAssetTabCount[] = countRows.map((row) => ({ kind: row.kind, count: row.count }));

    // hasMedia/hasPrimary/hasPendingGeneration:查 asset_media + generation_attempts 真实标记。
    // primaryMediaUrl:主图行的 storage_url;无 is_primary 时回落「最新未软删图」——与详情页
    // displayVersion = 主图 ?? 版本轨最新图 同口径,兼容既有数据(上传图未标主图 / 仅 AI 生成图)。
    const assetIds = rows.map((row) => row.assetEntityId);
    const mediaSet = new Set<string>();
    const primarySet = new Set<string>();
    const primaryUrlByAsset = new Map<string, string>();
    const pendingSet = new Set<string>();
    if (assetIds.length > 0) {
      // 上传图:asset_media 未软删行;主图行带 storage_url 供列表卡展示,按创建时间倒序(最新在前)。
      const mediaRows = await this.db.select({
        assetEntityId: assetMedia.assetEntityId,
        isPrimary: assetMedia.isPrimary,
        storageUrl: assetMedia.storageUrl,
        createdAt: assetMedia.createdAt,
      })
        .from(assetMedia)
        .where(and(
          inArray(assetMedia.assetEntityId, assetIds),
          isNull(assetMedia.deletedAt),
        ))
        .orderBy(desc(assetMedia.createdAt));
      // AI 生成图:media_results via generation_requests(与详情版本轨同源,作回落候选)。
      const aiRows = await this.db.select({
        assetEntityId: generationRequests.targetAssetEntityId,
        storageUrl: mediaResults.storageUrl,
        createdAt: mediaResults.createdAt,
      })
        .from(mediaResults)
        .innerJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
        .where(and(
          inArray(generationRequests.targetAssetEntityId, assetIds),
          eq(generationRequests.projectId, input.projectId),
          isNull(mediaResults.deletedAt),
        ))
        .orderBy(desc(mediaResults.createdAt));
      for (const row of mediaRows) {
        if (row.assetEntityId) {
          mediaSet.add(row.assetEntityId);
          if (row.isPrimary) {
            primarySet.add(row.assetEntityId);
            if (row.storageUrl && !primaryUrlByAsset.has(row.assetEntityId)) {
              primaryUrlByAsset.set(row.assetEntityId, row.storageUrl);
            }
          }
        }
      }
      // 回落:无主图 URL 的资产,按「最新未软删图」补位(上传/生成合并按 createdAt 倒序,与详情同口径)。
      const candidates = [
        ...mediaRows.map((r) => ({ assetEntityId: r.assetEntityId, storageUrl: r.storageUrl, createdAt: r.createdAt })),
        ...aiRows.map((r) => ({ assetEntityId: r.assetEntityId, storageUrl: r.storageUrl, createdAt: r.createdAt })),
      ]
        .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
      for (const row of candidates) {
        if (!row.assetEntityId || primaryUrlByAsset.has(row.assetEntityId)) continue;
        if (row.storageUrl) primaryUrlByAsset.set(row.assetEntityId, row.storageUrl);
      }
      // 生成中:generation_requests 目标资产 JOIN generation_attempts 状态 pending/running
      const pendingRows = await this.db.select({
        targetAssetEntityId: generationRequests.targetAssetEntityId,
      })
        .from(generationRequests)
        .innerJoin(generationAttempts, eq(generationAttempts.requestId, generationRequests.id))
        .where(and(
          eq(generationRequests.projectId, input.projectId),
          inArray(generationRequests.targetAssetEntityId, assetIds),
          inArray(generationAttempts.status, ["pending", "running"]),
        ));
      for (const row of pendingRows) {
        if (row.targetAssetEntityId) pendingSet.add(row.targetAssetEntityId);
      }
    }

    const listItems: LiteAssetListItem[] = rows.map((row) => ({
      assetEntityId: row.assetEntityId,
      name: row.name,
      intro: row.intro,
      assetKind: row.assetKind,
      audioKind: row.assetKind === "audio" ? audioKindOfMetadata(row.metadata) : null,
      primaryMediaUrl: primaryUrlByAsset.get(row.assetEntityId) ?? null,
      hasMedia: mediaSet.has(row.assetEntityId),
      hasPrimary: primarySet.has(row.assetEntityId),
      hasPendingGeneration: pendingSet.has(row.assetEntityId),
      lastModifiedAt: row.updatedAt,
    }));

    return { items: listItems, tabCounts };
  }

  /** 资产详情:正式列 + metadata.lite 投影。 */
  async findAssetDetail(input: { projectId: string; assetEntityId: string }): Promise<LiteAssetDetail | null> {
    const rows = await this.db.select({
      assetEntityId: assetEntities.id,
      name: assetEntities.name,
      intro: assetEntities.intro,
      assetKind: assetEntities.assetKind,
      metadata: assetEntities.metadata,
      gender: assetEntities.gender,
      ageValue: assetEntities.ageValue,
      appearance: assetEntities.appearance,
      hairDescription: assetEntities.hairDescription,
      outfitDescription: assetEntities.outfitDescription,
      heightCm: assetEntities.heightCm,
      updatedAt: assetEntities.updatedAt,
    })
      .from(projectAssetRefs)
      .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
      .where(and(
        eq(projectAssetRefs.projectId, input.projectId),
        eq(projectAssetRefs.assetEntityId, input.assetEntityId),
        isNull(projectAssetRefs.deletedAt),
        isNull(assetEntities.deletedAt),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const metadataLite = (row.metadata as Record<string, unknown>)?.lite as Record<string, unknown> | undefined ?? null;
    const note = typeof metadataLite?.note === "string" ? metadataLite.note : null;

    // 真实标记:查 asset_media + generation_attempts
    const mediaRows = await this.db.select({ assetEntityId: assetMedia.assetEntityId, isPrimary: assetMedia.isPrimary })
      .from(assetMedia)
      .where(and(eq(assetMedia.assetEntityId, input.assetEntityId), isNull(assetMedia.deletedAt)));
    const hasMedia = mediaRows.length > 0;
    const hasPrimary = mediaRows.some((m) => m.isPrimary);
    const pendingRows = await this.db.select({ id: generationRequests.id })
      .from(generationRequests)
      .innerJoin(generationAttempts, eq(generationAttempts.requestId, generationRequests.id))
      .where(and(
        eq(generationRequests.targetAssetEntityId, input.assetEntityId),
        eq(generationRequests.projectId, input.projectId),
        inArray(generationAttempts.status, ["pending", "running"]),
      ))
      .limit(1);
    const hasPendingGeneration = pendingRows.length > 0;

    return {
      assetEntityId: row.assetEntityId,
      name: row.name,
      intro: row.intro,
      assetKind: row.assetKind,
      audioKind: row.assetKind === "audio" ? audioKindOfMetadata(row.metadata) : null,
      note,
      hasMedia,
      hasPrimary,
      hasPendingGeneration,
      lastModifiedAt: row.updatedAt,
      modifiedByUserId: null,
      gender: row.gender,
      ageValue: row.ageValue,
      appearance: row.appearance,
      hairDescription: row.hairDescription,
      outfitDescription: row.outfitDescription,
      heightCm: row.heightCm,
      metadataLite: metadataLite ?? null,
    };
  }

  /** 手动新建资产:建 asset_entities + project_asset_refs + 第一个变体,metadata.lite.usages 初始空数组。 */
  async createAsset(input: {
    projectId: string;
    actorId: string;
    name: string;
    assetKind: string;
    intro: string | null;
    note: string | null;
    now: Date;
  }): Promise<{ assetEntityId: string; firstVariantId: string }> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const metadata: Record<string, unknown> = {
        source: "lite_asset_manual",
        lite: {
          schema_version: 1,
          usages: [],
          ...(input.note ? { note: input.note } : {}),
        },
      };
      const entity = (await db.insert(assetEntities).values({
        id: crypto.randomUUID(),
        copiedFromAssetEntityId: null,
        sourceProjectId: input.projectId,
        sourceProjectName: null,
        ownerUserId: input.actorId,
        visibility: "personal",
        assetKind: input.assetKind,
        role: null,
        usageMode: null,
        name: input.name,
        displayName: input.name,
        intro: input.intro,
        appearance: null,
        ageValue: null,
        gender: null,
        heightCm: null,
        hairDescription: null,
        outfitDescription: null,
        category: null,
        styleTags: [],
        approved: true,
        reuseScope: "all_projects",
        status: "approved",
        sourceFileUrl: null,
        metadata,
        createdAt: input.now,
        updatedAt: input.now,
        useCount: 0,
        deletedAt: null,
        deletedByUserId: null,
      }).returning())[0]!;

      await db.insert(projectAssetRefs).values({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        assetEntityId: entity.id,
        assetVariantId: null,
        assetMediaId: null,
        versionSnapshot: buildVersionSnapshot(input.now, entity, null, null),
        createdByUserId: input.actorId,
        createdAt: input.now,
        deletedAt: null,
        deletedByUserId: null,
      }).onConflictDoNothing();

      await db.update(assetEntities).set({
        useCount: sql`${assetEntities.useCount} + 1`,
      }).where(eq(assetEntities.id, entity.id));

      const firstVariantId = await this.ensureFirstVariant(db, entity.id, input.name, input.now);
      return { assetEntityId: entity.id, firstVariantId };
    });
  }

  /** 更新资产:只改 name/intro/metadata.lite.note,保留 metadata 其他命名空间。 */
  async updateAsset(input: {
    projectId: string;
    assetEntityId: string;
    patch: LitePatchAssetInput;
    actorId: string;
    now: Date;
  }): Promise<void> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      // 先校验资产属于当前项目且未软删。
      const owned = await db.select({ id: assetEntities.id, metadata: assetEntities.metadata })
        .from(projectAssetRefs)
        .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
        .where(and(
          eq(projectAssetRefs.projectId, input.projectId),
          eq(projectAssetRefs.assetEntityId, input.assetEntityId),
          isNull(projectAssetRefs.deletedAt),
          isNull(assetEntities.deletedAt),
        ))
        .limit(1);
      const row = owned[0];
      if (!row) throw new BadRequestError("找不到这个资产，可能已经被删除");

      const set: Record<string, unknown> = { updatedAt: input.now };
      if (input.patch.name !== undefined) {
        set.name = input.patch.name;
        set.displayName = input.patch.name;
      }
      if (input.patch.intro !== undefined) set.intro = input.patch.intro;
      if (input.patch.note !== undefined) {
        // 保留 metadata 其他命名空间,只改 lite.note。
        const metadata = row.metadata as Record<string, unknown>;
        const lite = (metadata.lite as Record<string, unknown> | undefined) ?? {};
        lite.note = input.patch.note;
        metadata.lite = lite;
        set.metadata = metadata;
      }
      await db.update(assetEntities).set(set).where(eq(assetEntities.id, row.id));
    });
  }

  /** 资产变体列表:读 asset_variants,未软删,按 sort_order。 */
  async listAssetVariants(input: { projectId: string; assetEntityId: string }): Promise<LiteAssetVariant[]> {
    // 先校验资产属于当前项目
    const owned = await this.assertAssetOwned(input.projectId, input.assetEntityId);
    if (!owned) return [];
    const rows = await this.db.select({
      variantId: assetVariants.id,
      variantKind: assetVariants.variantKind,
      name: assetVariants.name,
      isPrimary: assetVariants.isPrimary,
      sortOrder: assetVariants.sortOrder,
    })
      .from(assetVariants)
      .where(and(
        eq(assetVariants.assetEntityId, input.assetEntityId),
        isNull(assetVariants.deletedAt),
      ))
      .orderBy(asc(assetVariants.sortOrder), asc(assetVariants.createdAt));
    /* 变体首图:上传图(asset_media image,主图优先)+ 生成图兜底(media_results,与版本轨同口径:
       target null 归第一变体、取最早生成图)——弹窗变体行/已选行显图(2026-08-19)。 */
    const variantIds = rows.map((row) => row.variantId);
    const firstVariantId = variantIds[0] ?? null;
    const mediaRows = variantIds.length === 0 ? [] : await this.db.select({
      variantId: assetMedia.assetVariantId,
      storageUrl: assetMedia.storageUrl,
      isPrimary: assetMedia.isPrimary,
    })
      .from(assetMedia)
      .where(and(
        eq(assetMedia.assetEntityId, input.assetEntityId),
        eq(assetMedia.mediaKind, "image"),
        inArray(assetMedia.assetVariantId, variantIds),
        isNull(assetMedia.deletedAt),
      ));
    const aiRows = variantIds.length === 0 ? [] : await this.db.select({
      targetVariantId: generationRequests.targetAssetVariantId,
      storageUrl: mediaResults.storageUrl,
      createdAt: mediaResults.createdAt,
    })
      .from(mediaResults)
      .innerJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
      .where(and(
        eq(generationRequests.targetAssetEntityId, input.assetEntityId),
        eq(generationRequests.projectId, input.projectId),
        eq(mediaResults.mediaKind, "image"),
        isNull(mediaResults.deletedAt),
      ));
    const earliestAiByVariant = new Map<string, { url: string; t: number }>();
    for (const row of aiRows) {
      const variantId = row.targetVariantId ?? firstVariantId;
      if (!variantId || !row.storageUrl) continue;
      const t = row.createdAt?.getTime() ?? 0;
      const current = earliestAiByVariant.get(variantId);
      if (!current || t < current.t) earliestAiByVariant.set(variantId, { url: row.storageUrl, t });
    }
    const imageByVariant = new Map<string, string>();
    for (const [variantId, ai] of earliestAiByVariant) imageByVariant.set(variantId, ai.url);
    for (const row of mediaRows) {
      if (!row.variantId || !row.storageUrl) continue;
      const current = imageByVariant.get(row.variantId);
      if (current === undefined || row.isPrimary) imageByVariant.set(row.variantId, row.storageUrl);
    }
    return rows.map((row) => ({
      variantId: row.variantId,
      variantKind: row.variantKind,
      displayName: row.name,
      isPrimary: row.isPrimary,
      imageUrl: imageByVariant.get(row.variantId) ?? null,
    }));
  }

  /**
   * 版本图素材轨:合并上传图(asset_media)+ 生成图(media_results via generation_requests)。
   * 上传图 source="upload";生成图 source="ai"。
   * v1.3 渲染语义:生成图归属资产第一个变体(variant_id = first variant);变体无上传主图时
   * 其最早生成图标记为有效主图(「落库绑定第一个变体 + AI 首图自动主图」过渡)。
   */
  async listAssetVersionTrack(input: { projectId: string; assetEntityId: string }): Promise<LiteAssetVersionTrackItem[]> {
    const owned = await this.assertAssetOwned(input.projectId, input.assetEntityId);
    if (!owned) return [];

    // 上传图:asset_media 行
    const uploadRows = await this.db.select({
      assetMediaId: assetMedia.id,
      storageUrl: assetMedia.storageUrl,
      isPrimary: assetMedia.isPrimary,
      mediaKind: assetMedia.mediaKind,
      format: assetMedia.format,
      widthPx: assetMedia.widthPx,
      heightPx: assetMedia.heightPx,
      createdAt: assetMedia.createdAt,
      assetVariantId: assetMedia.assetVariantId,
    })
      .from(assetMedia)
      .where(and(
        eq(assetMedia.assetEntityId, input.assetEntityId),
        isNull(assetMedia.deletedAt),
      ))
      .orderBy(desc(assetMedia.createdAt));

    // 生成图:media_results via generation_requests(限定本项目)
    const aiRows = await this.db.select({
      mediaResultId: mediaResults.id,
      storageUrl: mediaResults.storageUrl,
      mediaKind: mediaResults.mediaKind,
      format: mediaResults.mimeType,
      widthPx: mediaResults.widthPx,
      heightPx: mediaResults.heightPx,
      createdAt: mediaResults.createdAt,
      targetVariantId: generationRequests.targetAssetVariantId,
    })
      .from(mediaResults)
      .innerJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
      .where(and(
        eq(generationRequests.targetAssetEntityId, input.assetEntityId),
        eq(generationRequests.projectId, input.projectId),
        isNull(mediaResults.deletedAt),
      ))
      .orderBy(desc(mediaResults.createdAt));

    // 第一个变体(T10.5 AI 结果归属的过渡目标)
    const [firstVariant] = await this.db.select({ id: assetVariants.id })
      .from(assetVariants)
      .where(and(
        eq(assetVariants.assetEntityId, input.assetEntityId),
        isNull(assetVariants.deletedAt),
      ))
      .orderBy(assetVariants.sortOrder)
      .limit(1);
    const firstVariantId = firstVariant?.id ?? null;

    const uploadIds = new Set(uploadRows.map((r) => r.assetMediaId));
    const items: LiteAssetVersionTrackItem[] = [
      ...uploadRows.map((r) => ({
        assetMediaId: r.assetMediaId,
        mediaResultId: null as string | null,
        storageUrl: r.storageUrl,
        isPrimary: r.isPrimary,
        source: "upload" as const,
        mediaKind: r.mediaKind,
        format: r.format,
        widthPx: r.widthPx,
        heightPx: r.heightPx,
        createdAt: r.createdAt ?? new Date(0),
        variantId: r.assetVariantId,
      })),
      ...aiRows
        .filter((r) => {
          // 如果这条生成图已被引用为 asset_media 且在上传图列表里,跳过(避免重复)
          return !uploadIds.has(r.mediaResultId);
        })
        .map((r) => ({
          assetMediaId: null as string | null,
          mediaResultId: r.mediaResultId,
          storageUrl: r.storageUrl,
          isPrimary: false,
          source: "ai" as const,
          mediaKind: r.mediaKind,
          format: r.format,
          widthPx: r.widthPx,
          heightPx: r.heightPx,
          createdAt: r.createdAt ?? new Date(0),
          variantId: r.targetVariantId ?? firstVariantId,
        })),
    ];
    // 合并后按 createdAt DESC 排序
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // 有效主图:每变体无上传主图时,其最早生成图 is_primary=true。
    const variantsPresent = new Set(items.map((i) => i.variantId));
    for (const v of variantsPresent) {
      const hasUploadPrimary = items.some((i) => i.source === "upload" && i.variantId === v && i.isPrimary);
      if (hasUploadPrimary) continue;
      const aiItems = items.filter((i) => i.source === "ai" && i.variantId === v);
      if (aiItems.length === 0) continue;
      const earliest = aiItems.reduce((a, b) => (b.createdAt.getTime() < a.createdAt.getTime() ? b : a));
      earliest.isPrimary = true;
    }
    return items;
  }

  /** 设主图:事务内原子翻转。冲突返回 { conflict: true }。成功返回新主图 mediaId/mediaKind(供自动登记判定)。 */
  async setPrimaryMedia(input: {
    projectId: string;
    assetEntityId: string;
    targetMediaId: string;
  }): Promise<{ conflict: boolean; mediaId: string; mediaKind: string }> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const owned = await this.assertAssetOwned(input.projectId, input.assetEntityId, db);
      if (!owned) throw new BadRequestError("找不到这个资产，可能已经被删除");

      // 查当前主图
      const [currentPrimary] = await db.select({ id: assetMedia.id, mediaKind: assetMedia.mediaKind })
        .from(assetMedia)
        .where(and(
          eq(assetMedia.assetEntityId, input.assetEntityId),
          eq(assetMedia.isPrimary, true),
          isNull(assetMedia.deletedAt),
        ))
        .limit(1);

      // 如果目标已经是主图,无需操作
      if (currentPrimary?.id === input.targetMediaId) {
        return { conflict: false, mediaId: input.targetMediaId, mediaKind: currentPrimary.mediaKind };
      }

      // 目标行必须存在且未软删
      const [target] = await db.select({ mediaKind: assetMedia.mediaKind })
        .from(assetMedia)
        .where(and(eq(assetMedia.id, input.targetMediaId), isNull(assetMedia.deletedAt)))
        .limit(1);
      if (!target) throw new BadRequestError("目标图片不存在或已被删除");

      // 翻转:先清旧主图,再设新主图
      if (currentPrimary) {
        await db.update(assetMedia)
          .set({ isPrimary: false })
          .where(eq(assetMedia.id, currentPrimary.id));
      }
      const result = await db.update(assetMedia)
        .set({ isPrimary: true })
        .where(and(eq(assetMedia.id, input.targetMediaId), isNull(assetMedia.deletedAt)));
      if (result.rowCount === 0) {
        // 目标行被并发软删 → 翻转未生效
        throw new BadRequestError("目标图片不存在或已被删除");
      }
      return { conflict: false, mediaId: input.targetMediaId, mediaKind: target.mediaKind };
    });
  }

  /** 设主图(生成图):把 media_result 物化为 asset_media(id = media_result.id)并原子翻转为主图。
      R1 特许可逆操作;幂等——重复设同一张生成图为主图只翻转,不重复建行。 */
  async setPrimaryMediaFromResult(input: {
    projectId: string;
    assetEntityId: string;
    targetMediaResultId: string;
  }): Promise<{ conflict: boolean; mediaId: string; mediaKind: string }> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const owned = await this.assertAssetOwned(input.projectId, input.assetEntityId, db);
      if (!owned) throw new BadRequestError("找不到这个资产，可能已经被删除");

      // 目标生成图必须属于本项目、本资产且未软删
      const result = (await db.select({
        id: mediaResults.id,
        storageBucket: mediaResults.storageBucket,
        storagePath: mediaResults.storagePath,
        storageUrl: mediaResults.storageUrl,
        mediaKind: mediaResults.mediaKind,
        mimeType: mediaResults.mimeType,
        widthPx: mediaResults.widthPx,
        heightPx: mediaResults.heightPx,
        sha256: mediaResults.sha256,
        targetAssetVariantId: generationRequests.targetAssetVariantId,
      })
        .from(mediaResults)
        .innerJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
        .where(and(
          eq(mediaResults.id, input.targetMediaResultId),
          eq(generationRequests.projectId, input.projectId),
          eq(generationRequests.targetAssetEntityId, input.assetEntityId),
          isNull(mediaResults.deletedAt),
        ))
        .limit(1))[0];
      if (!result) throw new BadRequestError("找不到这张生成图，可能已被删除或不属于当前资产");

      // 变体归属:生成请求目标变体,缺失时落资产第一变体(与版本轨口径一致)
      const [firstVariant] = await db.select({ id: assetVariants.id })
        .from(assetVariants)
        .where(and(
          eq(assetVariants.assetEntityId, input.assetEntityId),
          isNull(assetVariants.deletedAt),
        ))
        .orderBy(assetVariants.sortOrder)
        .limit(1);
      const variantId = result.targetAssetVariantId ?? firstVariant?.id ?? null;

      const now = new Date();
      // 物化 asset_media(id = media_result.id → 版本轨 uploadIds.has() 去重命中,不会重复展示)
      await db.insert(assetMedia).values({
        id: result.id,
        assetEntityId: input.assetEntityId,
        assetVariantId: variantId,
        mediaKind: result.mediaKind,
        viewAngle: null,
        title: null,
        description: null,
        storageBucket: result.storageBucket,
        storagePath: result.storagePath,
        storageUrl: result.storageUrl,
        widthPx: result.widthPx,
        heightPx: result.heightPx,
        format: formatFromMime(result.mimeType),
        sha256: result.sha256,
        isPrimary: false,
        approved: true,
        sortOrder: 0,
        metadata: { source: "lite_primary_promotion", source_media_result_id: result.id },
        createdAt: now,
        deletedAt: null,
        deletedByUserId: null,
      }).onConflictDoUpdate({
        target: assetMedia.id,
        // 已物化(重复设主图)→ 只保留行,统一由下方翻转逻辑设置 is_primary
        set: { isPrimary: false },
      });
      // 溯源:物化资产媒体 + 结果的父子边(复用种子资产登记的既有模式,幂等)
      await createLitePromotedAssetProvenance(db, result.id, result.id, now);

      // 原子翻转:清旧主图,再设目标为主图
      await db.update(assetMedia)
        .set({ isPrimary: false })
        .where(and(
          eq(assetMedia.assetEntityId, input.assetEntityId),
          eq(assetMedia.isPrimary, true),
          isNull(assetMedia.deletedAt),
        ));
      await db.update(assetMedia)
        .set({ isPrimary: true })
        .where(and(
          eq(assetMedia.id, result.id),
          isNull(assetMedia.deletedAt),
        ));
      return { conflict: false, mediaId: result.id, mediaKind: result.mediaKind };
    });
  }

  /** 关联分镜列表:读 metadata.lite.usages,展开为扁平条目(新 flat + 旧分组归一化),可选按变体过滤。 */
  async listAssetUsages(input: { projectId: string; assetEntityId: string; variantId?: string }): Promise<LiteAssetUsageEntry[]> {
    const detail = await this.findAssetDetail(input);
    if (!detail) return [];
    let rows = this.readUsages(detail.metadataLite, input.assetEntityId);
    if (input.variantId) rows = rows.filter((u) => u.variantId === input.variantId);
    if (rows.length === 0) return [];

    // 批量查 shot 信息(bound 的 shotId)
    const shotIds = [...new Set(rows.map((u) => u.shotId).filter((id): id is string => !!id))];
    const shotInfo = new Map<string, { shotCode: string | null; title: string | null; sceneId: string | null; episodeId: string | null }>();
    if (shotIds.length > 0) {
      const shotRows = await this.db.select({
        id: shots.id,
        shotCode: shots.shotCode,
        title: shots.title,
        sceneId: shots.sceneId,
        episodeId: shots.episodeId,
      })
        .from(shots)
        .where(and(
          inArray(shots.id, shotIds),
          isNull(shots.deletedAt),
        ));
      for (const r of shotRows) shotInfo.set(r.id, r);
    }
    // 查场景名
    const sceneIds = [...new Set([...shotInfo.values()].map((r) => r.sceneId).filter((id): id is string => !!id))];
    const sceneMap = new Map<string, string>();
    if (sceneIds.length > 0) {
      const sceneRows = await this.db.select({ id: scenes.id, name: scenes.name })
        .from(scenes)
        .where(and(
          inArray(scenes.id, sceneIds),
          isNull(scenes.deletedAt),
        ));
      for (const r of sceneRows) sceneMap.set(r.id, r.name ?? "");
    }
    // 查集号
    const episodeIds = [...new Set([...shotInfo.values()].map((r) => r.episodeId).filter((id): id is string => !!id))];
    const episodeMap = new Map<string, { episodeNo: number | null }>();
    if (episodeIds.length > 0) {
      const epRows = await this.db.select({ id: episodes.id, episodeNo: episodes.episodeNo })
        .from(episodes)
        .where(and(
          inArray(episodes.id, episodeIds),
          isNull(episodes.deletedAt),
        ));
      for (const r of epRows) episodeMap.set(r.id, { episodeNo: r.episodeNo });
    }

    const entries: LiteAssetUsageEntry[] = [];
    for (const u of rows) {
      const info = u.shotId ? shotInfo.get(u.shotId) : undefined;
      const ep = info?.episodeId ? episodeMap.get(info.episodeId) : undefined;
      entries.push({
        usageId: u.usageId,
        variantId: u.variantId,
        shotId: u.shotId,
        episodeId: info?.episodeId ?? u.episodeId,
        episodeNo: u.episodeNo ?? ep?.episodeNo ?? null,
        shotNo: u.shotNo,
        sceneName: u.sceneNames[0]
          ?? (u.shotId ? (info?.sceneId ? (sceneMap.get(info.sceneId) ?? null) : null) : null),
        shotLabel: u.shotId ? (info ? (info.title || info.shotCode || "") : "") : "",
        status: u.status,
        matchedBy: u.matchedBy,
        evidence: {
          sceneNames: u.sceneNames,
          lineIndices: u.lineIndices,
          sourceTextSnippets: u.sourceTextSnippets,
        },
      });
    }
    return entries;
  }

  /** 按集号+分镜号+场景名查找 shot_id。优先 shots.sort_order(分镜号),回落 shot_code/title 数字。 */
  async findShotByLabel(input: {
    projectId: string;
    episodeNo: number;
    shotNo: number;
    sceneName?: string;
  }): Promise<{ shotId: string } | null> {
    return this.findShotByLabelTx(this.db, input);
  }

  /** findShotByLabel 的事务内版本(供批量关联复用同一事务)。 */
  private async findShotByLabelTx(
    db: Database,
    input: {
      projectId: string;
      episodeNo: number;
      shotNo: number;
      sceneName?: string;
    },
  ): Promise<{ shotId: string } | null> {
    // 1. 找 episode
    const [ep] = await db.select({ id: episodes.id })
      .from(episodes)
      .where(and(
        eq(episodes.projectId, input.projectId),
        eq(episodes.episodeNo, input.episodeNo),
        isNull(episodes.deletedAt),
      ))
      .limit(1);
    if (!ep) return null;

    // 2. 找该集所有分镜(带场景名)
    const rows = await db.select({
      id: shots.id,
      shotCode: shots.shotCode,
      title: shots.title,
      sortOrder: shots.sortOrder,
      sceneId: shots.sceneId,
    })
      .from(shots)
      .where(and(
        eq(shots.episodeId, ep.id),
        isNull(shots.deletedAt),
      ));

    // 3. 按分镜号匹配:sort_order(mapper 确定性映射)优先,回落 shot_code/title 数字
    const matched = rows.filter((r) => {
      if (r.sortOrder !== null && r.sortOrder === input.shotNo) return true;
      const codeTail = parseTrailingNumber(r.shotCode);
      if (codeTail !== null && codeTail === input.shotNo) return true;
      if (r.title) {
        const titleNum = parseInt(r.title.match(/\d+/)?.[0] ?? "", 10);
        if (Number.isFinite(titleNum) && titleNum === input.shotNo) return true;
      }
      return false;
    });
    if (matched.length === 0) return null;

    // 4. 场景名过滤(选填)
    if (input.sceneName && matched.length > 1) {
      const sceneIds = matched.map((r) => r.sceneId).filter((id): id is string => id !== null);
      const sceneMap = new Map<string, string>();
      if (sceneIds.length > 0) {
        const sceneRows = await db.select({ id: scenes.id, name: scenes.name })
          .from(scenes)
          .where(and(
            inArray(scenes.id, sceneIds),
            isNull(scenes.deletedAt),
          ));
        for (const r of sceneRows) sceneMap.set(r.id, r.name ?? "");
      }
      const sceneFiltered = matched.filter((r) =>
        r.sceneId && sceneMap.get(r.sceneId)?.includes(input.sceneName!),
      );
      if (sceneFiltered.length > 0) return { shotId: sceneFiltered[0]!.id };
    }

    return { shotId: matched[0]!.id };
  }

  /** 批量添加关联(单事务):命中真实分镜 → bound + manual 快照;未命中 → pending 待绑定。 */
  async addAssetShotUsages(input: {
    projectId: string;
    assetEntityId: string;
    actorId: string;
    now: Date;
    items: LiteAddUsageItemInput[];
  }): Promise<LiteAddUsagesResult> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const lockedAssetEntities = alias(assetEntities, "locked_asset_entities");
      const owned = await db.select({
        id: lockedAssetEntities.id,
        name: lockedAssetEntities.name,
        assetKind: lockedAssetEntities.assetKind,
        metadata: lockedAssetEntities.metadata,
      })
        .from(projectAssetRefs)
        .innerJoin(lockedAssetEntities, eq(projectAssetRefs.assetEntityId, lockedAssetEntities.id))
        .where(and(
          eq(projectAssetRefs.projectId, input.projectId),
          eq(projectAssetRefs.assetEntityId, input.assetEntityId),
          isNull(projectAssetRefs.deletedAt),
          isNull(lockedAssetEntities.deletedAt),
        ))
        .limit(1)
        .for("update", { of: lockedAssetEntities });
      const asset = owned[0];
      if (!asset) throw new BadRequestError("找不到这个资产，可能已经被删除");

      const metadata = asset.metadata as Record<string, unknown>;
      const lite = (metadata.lite as Record<string, unknown> | undefined) ?? {};
      const usages = Array.isArray(lite.usages) ? [...lite.usages as Array<Record<string, unknown>>] : [];
      let added = 0;
      let pending = 0;
      const snapshotWrites: Array<{ shotId: string; snapshot: Record<string, unknown> }> = [];
      // v1.7(八.10.4):manual 命中真实分镜即解除该 (asset, variant, shot) 的自动引用抑制。
      const suppressionClears = new Set<string>();

      for (const item of input.items) {
        const variantId = item.variantId ?? null;
        if (variantId) {
          const [v] = await db.select({ id: assetVariants.id })
            .from(assetVariants)
            .where(and(
              eq(assetVariants.id, variantId),
              eq(assetVariants.assetEntityId, input.assetEntityId),
              isNull(assetVariants.deletedAt),
            ))
            .limit(1);
          if (!v) throw new BadRequestError("找不到这个变体，可能已经被删除");
        }

        let shot: { id: string; episodeId: string; shotNo: number | null } | null = null;
        if (item.shotId) {
          const [s] = await db.select({
            id: shots.id,
            episodeId: shots.episodeId,
            shotNo: shots.sortOrder,
          })
            .from(shots)
            .innerJoin(episodes, eq(episodes.id, shots.episodeId))
            .where(and(
              eq(shots.id, item.shotId),
              eq(episodes.projectId, input.projectId),
              isNull(shots.deletedAt),
            ))
            .limit(1);
          if (!s) throw new BadRequestError("找不到这个分镜");
          shot = s;
        } else if (item.episodeNo !== undefined && item.shotNo !== undefined) {
          const found = await this.findShotByLabelTx(db, {
            projectId: input.projectId,
            episodeNo: item.episodeNo,
            shotNo: item.shotNo,
            sceneName: item.sceneName,
          });
          if (found) {
            const [s] = await db.select({
              id: shots.id,
              episodeId: shots.episodeId,
              shotNo: shots.sortOrder,
            }).from(shots).where(eq(shots.id, found.shotId)).limit(1);
            shot = s ?? null;
          }
        } else {
          throw new BadRequestError("关联分镜需要提供 shot_id 或 (episode_no + shot_no)");
        }

        if (shot) {
          const usageId = deterministicUsageId("asset", asset.id, variantId ?? "asset", shot.episodeId, shot.id, "manual");
          if (!usages.some((u) => u.usage_id === usageId)) {
            usages.push({
              usage_id: usageId,
              variant_id: variantId,
              episode_id: shot.episodeId,
              episode_no: null,
              shot_id: shot.id,
              shot_no: shot.shotNo,
              shot_candidate_id: null,
              scene_names: item.sceneName ? [item.sceneName] : [],
              line_indices: [],
              source_text_snippets: [],
              status: "bound",
              matched_by: "manual",
            });
            added += 1;
          }
          if (variantId) suppressionClears.add(`${shot.id}|${variantId}`);
          snapshotWrites.push({
            shotId: shot.id,
            snapshot: {
              asset_entity_id: asset.id,
              variant_id: variantId,
              name: asset.name,
              asset_kind: asset.assetKind,
              matched_by: "manual",
            },
          });
        } else {
          const usageId = deterministicUsageId(
            "asset", asset.id, variantId ?? "asset",
            String(item.episodeNo), String(item.shotNo), item.sceneName ?? "", "pending",
          );
          if (!usages.some((u) => u.usage_id === usageId)) {
            usages.push({
              usage_id: usageId,
              variant_id: variantId,
              episode_id: null,
              episode_no: item.episodeNo,
              shot_id: null,
              shot_no: item.shotNo,
              shot_candidate_id: null,
              scene_names: item.sceneName ? [item.sceneName] : [],
              line_indices: [],
              source_text_snippets: [],
              status: "pending",
              matched_by: "manual",
            });
            pending += 1;
          }
        }
      }

      if (added > 0 || pending > 0) {
        lite.usages = usages;
        metadata.lite = lite;
        await db.update(assetEntities).set({ metadata, updatedAt: input.now }).where(eq(assetEntities.id, asset.id));
      }
      if (snapshotWrites.length > 0) {
        await this.writeManualSnapshots(db, snapshotWrites, input.now);
      }
      for (const key of suppressionClears) {
        const [shotId, variantId] = key.split("|") as [string, string];
        await this.clearShotAutoRefSuppressionTx(db, shotId, asset.id, variantId, input.now);
      }
      return { added, pending };
    });
  }

  /** 移除关联(按 usage_id):只删该条目;bound 时同时移除 shot 上 (asset_entity_id, variant_id) 快照(manual 与 exact_name 都删)。 */
  async removeAssetShotUsage(input: {
    projectId: string;
    assetEntityId: string;
    usageId: string;
    now: Date;
  }): Promise<void> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const lockedAssetEntities = alias(assetEntities, "locked_asset_entities");
      const owned = await db.select({ id: lockedAssetEntities.id, metadata: lockedAssetEntities.metadata })
        .from(projectAssetRefs)
        .innerJoin(lockedAssetEntities, eq(projectAssetRefs.assetEntityId, lockedAssetEntities.id))
        .where(and(
          eq(projectAssetRefs.projectId, input.projectId),
          eq(projectAssetRefs.assetEntityId, input.assetEntityId),
          isNull(projectAssetRefs.deletedAt),
          isNull(lockedAssetEntities.deletedAt),
        ))
        .limit(1)
        .for("update", { of: lockedAssetEntities });
      const asset = owned[0];
      if (!asset) throw new BadRequestError("找不到这个资产，可能已经被删除");

      const metadata = asset.metadata as Record<string, unknown>;
      const lite = (metadata.lite as Record<string, unknown> | undefined) ?? {};
      if (!Array.isArray(lite.usages)) throw new BadRequestError("找不到这个关联");
      const usages = lite.usages as Array<Record<string, unknown>>;
      let removed = false;
      const snapshotRemovals: Array<{ shotId: string; variantId: string | null }> = [];
      const kept: Array<Record<string, unknown>> = [];

      for (const u of usages) {
        if (Array.isArray(u.shot_ids)) {
          // 旧分组格式:按确定性派生 usage_id 匹配单条 shotId
          const remaining: string[] = [];
          for (const shotId of u.shot_ids as string[]) {
            const derived = deterministicUsageId("asset", asset.id, "legacy", String(u.episode_id ?? ""), shotId);
            if (derived === input.usageId) {
              removed = true;
              snapshotRemovals.push({ shotId, variantId: null });
            } else {
              remaining.push(shotId);
            }
          }
          if (remaining.length > 0) kept.push({ ...u, shot_ids: remaining });
        } else if (u.usage_id === input.usageId) {
          removed = true;
          if (typeof u.shot_id === "string") {
            snapshotRemovals.push({ shotId: u.shot_id, variantId: (u.variant_id as string | null) ?? null });
          }
          // 丢弃该条目
        } else {
          kept.push(u);
        }
      }
      if (!removed) throw new BadRequestError("找不到这个关联");

      lite.usages = kept;
      metadata.lite = lite;
      await db.update(assetEntities).set({ metadata, updatedAt: input.now }).where(eq(assetEntities.id, asset.id));

      if (snapshotRemovals.length > 0) {
        await this.removeSnapshotsForVariant(db, asset.id, snapshotRemovals, input.now);
      }
    });
  }

  /** 删变体(软删):软删变体 + 其下 asset_media;清相关 usages 与快照;主变体被删 → 晋升最小 sort_order 剩余变体。 */
  async deleteAssetVariant(input: {
    projectId: string;
    assetEntityId: string;
    variantId: string;
    actorId: string;
    now: Date;
  }): Promise<void> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const owned = await this.assertAssetOwned(input.projectId, input.assetEntityId, db);
      if (!owned) throw new BadRequestError("找不到这个资产，可能已经被删除");

      const [variant] = await db.select({ id: assetVariants.id, isPrimary: assetVariants.isPrimary })
        .from(assetVariants)
        .where(and(
          eq(assetVariants.id, input.variantId),
          eq(assetVariants.assetEntityId, input.assetEntityId),
          isNull(assetVariants.deletedAt),
        ))
        .limit(1);
      if (!variant) throw new BadRequestError("找不到这个变体，可能已经被删除");

      // 1. 软删变体行
      await db.update(assetVariants)
        .set({ deletedAt: input.now, deletedByUserId: input.actorId, updatedAt: input.now })
        .where(eq(assetVariants.id, variant.id));
      // 2. 软删其下 asset_media
      await db.update(assetMedia)
        .set({ deletedAt: input.now, deletedByUserId: input.actorId })
        .where(and(
          eq(assetMedia.assetVariantId, variant.id),
          isNull(assetMedia.deletedAt),
        ));

      // 3. 清引用该变体的 usages + 相关 shot 快照
      const [entity] = await db.select({ metadata: assetEntities.metadata })
        .from(assetEntities).where(eq(assetEntities.id, input.assetEntityId)).limit(1);
      if (entity) {
        const metadata = entity.metadata as Record<string, unknown>;
        const lite = (metadata.lite as Record<string, unknown> | undefined) ?? {};
        if (Array.isArray(lite.usages)) {
          const snapshotRemovals: Array<{ shotId: string; variantId: string | null }> = [];
          const kept: Array<Record<string, unknown>> = [];
          for (const u of lite.usages as Array<Record<string, unknown>>) {
            if (u.variant_id === variant.id) {
              if (typeof u.shot_id === "string") snapshotRemovals.push({ shotId: u.shot_id, variantId: variant.id });
              // 丢弃
            } else {
              kept.push(u);
            }
          }
          if (snapshotRemovals.length > 0) {
            await this.removeSnapshotsForVariant(db, input.assetEntityId, snapshotRemovals, input.now);
          }
          lite.usages = kept;
          metadata.lite = lite;
          await db.update(assetEntities)
            .set({ metadata, updatedAt: input.now })
            .where(eq(assetEntities.id, input.assetEntityId));
        }
      }

      // 4. 主变体晋升
      if (variant.isPrimary) {
        const [next] = await db.select({ id: assetVariants.id })
          .from(assetVariants)
          .where(and(
            eq(assetVariants.assetEntityId, input.assetEntityId),
            isNull(assetVariants.deletedAt),
          ))
          .orderBy(assetVariants.sortOrder)
          .limit(1);
        if (next) {
          await db.update(assetVariants)
            .set({ isPrimary: true, updatedAt: input.now })
            .where(eq(assetVariants.id, next.id));
        }
      }
    });
  }

  /** 删媒体(软删,双 ID 空间):media_id 可为 asset_media.id 或 media_results.id。 */
  async deleteAssetMedia(input: {
    projectId: string;
    assetEntityId: string;
    mediaId: string;
    actorId: string;
    now: Date;
  }): Promise<void> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const owned = await this.assertAssetOwned(input.projectId, input.assetEntityId, db);
      if (!owned) throw new BadRequestError("找不到这个资产，可能已经被删除");

      // 1. asset_media 空间
      const [media] = await db.select({
        id: assetMedia.id,
        assetVariantId: assetMedia.assetVariantId,
        isPrimary: assetMedia.isPrimary,
      })
        .from(assetMedia)
        .where(and(
          eq(assetMedia.id, input.mediaId),
          isNull(assetMedia.deletedAt),
        ))
        .limit(1);
      if (media) {
        await db.update(assetMedia)
          .set({ deletedAt: input.now, deletedByUserId: input.actorId })
          .where(eq(assetMedia.id, media.id));
        if (media.isPrimary && media.assetVariantId !== null) {
          // 同变体最早剩余图晋升主图
          const [next] = await db.select({ id: assetMedia.id })
            .from(assetMedia)
            .where(and(
              eq(assetMedia.assetVariantId, media.assetVariantId),
              isNull(assetMedia.deletedAt),
            ))
            .orderBy(assetMedia.createdAt, assetMedia.sortOrder)
            .limit(1);
          if (next) {
            await db.update(assetMedia).set({ isPrimary: true }).where(eq(assetMedia.id, next.id));
          }
        }
        return;
      }

      // 2. media_results 空间(限定本项目 + target 资产)
      const [result] = await db.select({ id: mediaResults.id })
        .from(mediaResults)
        .innerJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
        .where(and(
          eq(mediaResults.id, input.mediaId),
          eq(generationRequests.projectId, input.projectId),
          eq(generationRequests.targetAssetEntityId, input.assetEntityId),
          isNull(mediaResults.deletedAt),
        ))
        .limit(1);
      if (result) {
        await db.update(mediaResults)
          .set({ deletedAt: input.now, deletedByUserId: input.actorId, updatedAt: input.now })
          .where(eq(mediaResults.id, result.id));
        return;
      }
      throw new BadRequestError("找不到这个素材，可能已经被删除");
    });
  }

  /**
   * v1.6 匹配建议的只读投影(问题八 8.2):本项目所有「已确认拆解集」
   * (script_breakdown_runs status='confirmed')的正式 shots 行,带三要素
   * (集号/分镜号/场景名)与剧本单元(title/script_text/breakdown_elements)。
   * 未确认集不进入候选范围。
   */
  async listShotsForMatchSuggest(input: { projectId: string }): Promise<LiteMatchSuggestShotRow[]> {
    const confirmedEpisodes = this.db
      .select({ episodeId: scriptBreakdownRuns.episodeId })
      .from(scriptBreakdownRuns)
      .where(eq(scriptBreakdownRuns.status, "confirmed"));
    const rows = await this.db
      .select({
        shotId: shots.id,
        episodeId: episodes.id,
        episodeNo: episodes.episodeNo,
        shotNo: shots.sortOrder,
        sceneName: scenes.name,
        title: shots.title,
        scriptText: shots.scriptText,
        breakdownElements: shots.breakdownElements,
      })
      .from(episodes)
      .innerJoin(shots, eq(shots.episodeId, episodes.id))
      .leftJoin(scenes, and(eq(scenes.id, shots.sceneId), isNull(scenes.deletedAt)))
      .where(and(
        eq(episodes.projectId, input.projectId),
        isNull(episodes.deletedAt),
        isNull(shots.deletedAt),
        inArray(episodes.id, confirmedEpisodes),
      ))
      .orderBy(asc(episodes.episodeNo), asc(shots.sortOrder));
    return rows.map((row) => ({
      shotId: row.shotId,
      episodeId: row.episodeId,
      episodeNo: row.episodeNo,
      shotNo: row.shotNo,
      sceneName: row.sceneName,
      title: row.title,
      scriptText: row.scriptText,
      breakdownElements: (row.breakdownElements as Record<string, unknown> | null) ?? null,
    }));
  }

  /** 按真实 shot_id 回一条三要素(建议校验定位到真实分镜后补齐展示信息)。 */
  async findShotSuggestInfo(input: { projectId: string; shotId: string }): Promise<LiteMatchSuggestShotRow | null> {
    const rows = await this.db
      .select({
        shotId: shots.id,
        episodeId: episodes.id,
        episodeNo: episodes.episodeNo,
        shotNo: shots.sortOrder,
        sceneName: scenes.name,
        title: shots.title,
        scriptText: shots.scriptText,
        breakdownElements: shots.breakdownElements,
      })
      .from(shots)
      .innerJoin(episodes, eq(episodes.id, shots.episodeId))
      .leftJoin(scenes, and(eq(scenes.id, shots.sceneId), isNull(scenes.deletedAt)))
      .where(and(
        eq(shots.id, input.shotId),
        eq(episodes.projectId, input.projectId),
        isNull(shots.deletedAt),
        isNull(episodes.deletedAt),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      shotId: row.shotId,
      episodeId: row.episodeId,
      episodeNo: row.episodeNo,
      shotNo: row.shotNo,
      sceneName: row.sceneName,
      title: row.title,
      scriptText: row.scriptText,
      breakdownElements: (row.breakdownElements as Record<string, unknown> | null) ?? null,
    };
  }

  /** 变体匹配档案(只读):变体名/描述 + 所属资产名/类型/简介;跨项目/软删/不存在返回 null。 */
  async findVariantForMatchSuggest(input: {
    projectId: string;
    assetEntityId: string;
    variantId: string;
  }): Promise<LiteVariantMatchProfile | null> {
    const rows = await this.db
      .select({
        variantName: assetVariants.name,
        variantDescription: assetVariants.description,
        assetEntityId: assetEntities.id,
        assetName: assetEntities.name,
        assetKind: assetEntities.assetKind,
        assetIntro: assetEntities.intro,
      })
      .from(assetVariants)
      .innerJoin(assetEntities, eq(assetEntities.id, assetVariants.assetEntityId))
      .innerJoin(projectAssetRefs, and(
        eq(projectAssetRefs.assetEntityId, assetEntities.id),
        eq(projectAssetRefs.projectId, input.projectId),
        isNull(projectAssetRefs.deletedAt),
      ))
      .where(and(
        eq(assetVariants.id, input.variantId),
        eq(assetVariants.assetEntityId, input.assetEntityId),
        isNull(assetVariants.deletedAt),
        isNull(assetEntities.deletedAt),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  /** v0.9 C 层:列本项目五类资产全部活动变体档案(含第一变体),供 AI 自动挂。 */
  async listVariantsForAutoMatch(input: { projectId: string }): Promise<Array<LiteVariantMatchProfile & { variantId: string }>> {
    const rows = await this.db
      .select({
        variantId: assetVariants.id,
        variantName: assetVariants.name,
        variantDescription: assetVariants.description,
        assetEntityId: assetEntities.id,
        assetName: assetEntities.name,
        assetKind: assetEntities.assetKind,
        assetIntro: assetEntities.intro,
      })
      .from(assetVariants)
      .innerJoin(assetEntities, eq(assetEntities.id, assetVariants.assetEntityId))
      .innerJoin(projectAssetRefs, and(
        eq(projectAssetRefs.assetEntityId, assetEntities.id),
        eq(projectAssetRefs.projectId, input.projectId),
        isNull(projectAssetRefs.deletedAt),
      ))
      .where(and(
        isNull(assetVariants.deletedAt),
        isNull(assetEntities.deletedAt),
        inArray(assetEntities.assetKind, ["character", "scene", "prop", "costume", "audio"]),
      ))
      .orderBy(asc(assetEntities.name), asc(assetVariants.sortOrder));
    return rows;
  }

  /**
   * v0.9 C 层写入:AI 语义匹配的出现记录(matched_by="ai_auto")。
   * 只写 usages、不写生成快照(生成参考仍由人控);manual 永不被覆盖;
   * 分镜侧抑制名单(removedAutoRefs)内的对不复活;同 (shot, variant) 幂等。
   */
  async writeAiAutoUsages(input: {
    projectId: string;
    episodeId: string;
    episodeNo: number;
    writes: Array<{
      assetEntityId: string;
      variantId: string;
      shotId: string;
      shotNo: number;
      sceneName: string | null;
      sourceTextSnippets: string[];
    }>;
    now: Date;
  }): Promise<number> {
    if (input.writes.length === 0) return 0;
    const assetIds = [...new Set(input.writes.map((w) => w.assetEntityId))];
    const shotRows = await this.db.select({ id: shots.id, metadata: shots.metadata })
      .from(shots)
      .where(and(inArray(shots.id, input.writes.map((w) => w.shotId)), isNull(shots.deletedAt)));
    const shotMetaById = new Map(shotRows.map((row) => [row.id, row.metadata]));
    const assetRows = await this.db.select({ id: assetEntities.id, metadata: assetEntities.metadata })
      .from(assetEntities)
      .where(inArray(assetEntities.id, assetIds));
    let written = 0;
    for (const assetRow of assetRows) {
      const writesForAsset = input.writes.filter((w) => w.assetEntityId === assetRow.id);
      if (writesForAsset.length === 0) continue;
      const metadata = assetRow.metadata as Record<string, unknown>;
      const lite = (metadata.lite as Record<string, unknown> | undefined) ?? {};
      const usages = Array.isArray(lite.usages) ? [...lite.usages as Array<Record<string, unknown>>] : [];
      let changed = false;
      for (const write of writesForAsset) {
        if (shotSuppressed(shotMetaById.get(write.shotId) ?? null, assetRow.id, write.variantId)) continue;
        const hasSamePair = usages.some((u) => u.shot_id === write.shotId && u.variant_id === write.variantId);
        if (hasSamePair) continue;
        const usageId = deterministicUsageId(
          "asset", assetRow.id, write.variantId, input.episodeId, String(write.shotNo), "ai_auto",
        );
        usages.push({
          usage_id: usageId,
          variant_id: write.variantId,
          episode_id: input.episodeId,
          episode_no: input.episodeNo,
          shot_id: write.shotId,
          shot_no: write.shotNo,
          shot_candidate_id: null,
          scene_names: write.sceneName ? [write.sceneName] : [],
          line_indices: [],
          source_text_snippets: write.sourceTextSnippets,
          status: "bound",
          matched_by: "ai_auto",
        });
        changed = true;
        written += 1;
      }
      if (changed) {
        lite.usages = usages;
        metadata.lite = lite;
        await this.db.update(assetEntities)
          .set({ metadata, updatedAt: input.now })
          .where(eq(assetEntities.id, assetRow.id));
      }
    }
    return written;
  }

  /**
   * v1.7(八.10.4)分镜侧删除自动引用:移除 shot 上 (asset_entity_id, variant_id)
   * 的 exact_name 快照(manual 快照不动),并把该对追加进
   * shots.metadata.lite.removedAutoRefs(去重)。shot 须属于本项目且未软删。
   */
  async removeShotAutoRef(input: {
    projectId: string;
    shotId: string;
    assetEntityId: string;
    variantId: string;
    actorId: string;
    now: Date;
  }): Promise<void> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const [shot] = await db.select({
        id: shots.id,
        referenceAssetSnapshots: shots.referenceAssetSnapshots,
        metadata: shots.metadata,
      })
        .from(shots)
        .innerJoin(episodes, eq(episodes.id, shots.episodeId))
        .where(and(
          eq(shots.id, input.shotId),
          eq(episodes.projectId, input.projectId),
          isNull(shots.deletedAt),
          isNull(episodes.deletedAt),
        ))
        .limit(1);
      if (!shot) throw new BadRequestError("找不到这个分镜，可能已经被删除");

      // 1. 移除该 (asset, variant) 对的 exact_name 快照(manual 不碰)。
      const snapshots = Array.isArray(shot.referenceAssetSnapshots) ? [...shot.referenceAssetSnapshots] : [];
      const filtered = snapshots.filter((s) => {
        const e = s as Record<string, unknown>;
        const isPair = e.asset_entity_id === input.assetEntityId
          && snapshotVariantMatches(e, input.variantId);
        return !(isPair && e.matched_by === "exact_name");
      });

      // 2. 追加 (asset, variant) 对进抑制名单(去重),保留其他 metadata 命名空间。
      const metadata = (shot.metadata ?? {}) as Record<string, unknown>;
      const lite = (metadata.lite as Record<string, unknown> | undefined) ?? {};
      const removed = readRemovedAutoRefs(metadata);
      const already = removed.some((pair) =>
        pair.asset_entity_id === input.assetEntityId && pair.variant_id === input.variantId);
      if (!already) {
        removed.push({ asset_entity_id: input.assetEntityId, variant_id: input.variantId });
      }
      lite.removedAutoRefs = removed;
      metadata.lite = lite;

      await db.update(shots)
        .set({ referenceAssetSnapshots: filtered, metadata: metadata as ShotMetadata, updatedAt: input.now })
        .where(eq(shots.id, shot.id));
    });
  }

  /**
   * v1.7(八.10.4)解除抑制:从 shots.metadata.lite.removedAutoRefs 移除该对
   * (不存在时静默 no-op)。独立入口供资产侧手动恢复;事务内版本见 Tx 变体。
   */
  async clearShotAutoRefSuppression(input: {
    projectId: string;
    shotId: string;
    assetEntityId: string;
    variantId: string;
    now: Date;
  }): Promise<void> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await this.clearShotAutoRefSuppressionTx(db, input.shotId, input.assetEntityId, input.variantId, input.now);
    });
  }

  // --- helpers ---

  /** 事务内解除抑制:从 shots.metadata.lite.removedAutoRefs 移除该对(不存在时 no-op)。 */
  private async clearShotAutoRefSuppressionTx(
    db: Database,
    shotId: string,
    assetEntityId: string,
    variantId: string,
    now: Date,
  ): Promise<void> {
    const [shot] = await db.select({ metadata: shots.metadata })
      .from(shots).where(eq(shots.id, shotId)).limit(1);
    if (!shot) return;
    const removed = readRemovedAutoRefs(shot.metadata);
    const kept = removed.filter((pair) =>
      !(pair.asset_entity_id === assetEntityId && pair.variant_id === variantId));
    if (kept.length === removed.length) return; // 名单本无该对,no-op
    const metadata = (shot.metadata ?? {}) as Record<string, unknown>;
    const lite = (metadata.lite as Record<string, unknown> | undefined) ?? {};
    lite.removedAutoRefs = kept;
    metadata.lite = lite;
    await db.update(shots).set({ metadata: metadata as ShotMetadata, updatedAt: now })
      .where(eq(shots.id, shotId));
  }

  /** 校验资产属于当前项目且未软删。传 db 时在事务内查询。 */
  private async assertAssetOwned(projectId: string, assetEntityId: string, db?: Database): Promise<boolean> {
    const query = db ?? this.db;
    const [row] = await query.select({ id: assetEntities.id })
      .from(projectAssetRefs)
      .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
      .where(and(
        eq(projectAssetRefs.projectId, projectId),
        eq(projectAssetRefs.assetEntityId, assetEntityId),
        isNull(projectAssetRefs.deletedAt),
        isNull(assetEntities.deletedAt),
      ))
      .limit(1);
    return !!row;
  }

  /**
   * 从 metadata.lite 读 usages,归一化为扁平条目:
   * 新 flat 格式逐条展开;旧 {episode_id, shot_ids} 分组格式展开为确定性子条目(usage_id 派生)。
   */
  private readUsages(
    metadataLite: Record<string, unknown> | null,
    assetEntityId: string,
  ): Array<{
    usageId: string;
    variantId: string | null;
    shotId: string | null;
    episodeId: string | null;
    episodeNo: number | null;
    shotNo: number | null;
    sceneNames: string[];
    lineIndices: number[];
    sourceTextSnippets: string[];
    status: "bound" | "pending";
    matchedBy: "manual" | "exact_name" | "ai_auto";
  }> {
    if (!metadataLite) return [];
    const usages = metadataLite.usages;
    if (!Array.isArray(usages)) return [];
    const out: Array<{
      usageId: string;
      variantId: string | null;
      shotId: string | null;
      episodeId: string | null;
      episodeNo: number | null;
      shotNo: number | null;
      sceneNames: string[];
      lineIndices: number[];
      sourceTextSnippets: string[];
      status: "bound" | "pending";
      matchedBy: "manual" | "exact_name" | "ai_auto";
    }> = [];
    for (const u of usages) {
      const entry = u as Record<string, unknown>;
      if (Array.isArray(entry.shot_ids)) {
        // 旧分组格式
        const episodeId = typeof entry.episode_id === "string" ? entry.episode_id : null;
        for (const shotId of entry.shot_ids as string[]) {
          out.push({
            usageId: deterministicUsageId("asset", assetEntityId, "legacy", episodeId ?? "", shotId),
            variantId: null,
            shotId,
            episodeId,
            episodeNo: null,
            shotNo: null,
            sceneNames: [],
            lineIndices: [],
            sourceTextSnippets: [],
            status: "bound",
            matchedBy: "manual",
          });
        }
        continue;
      }
      out.push({
        usageId: typeof entry.usage_id === "string"
          ? entry.usage_id
          : deterministicUsageId("asset", assetEntityId, JSON.stringify(entry)),
        variantId: typeof entry.variant_id === "string" ? entry.variant_id : null,
        shotId: typeof entry.shot_id === "string" ? entry.shot_id : null,
        episodeId: typeof entry.episode_id === "string" ? entry.episode_id : null,
        episodeNo: typeof entry.episode_no === "number" ? entry.episode_no : null,
        shotNo: typeof entry.shot_no === "number" ? entry.shot_no : null,
        sceneNames: Array.isArray(entry.scene_names) ? entry.scene_names as string[] : [],
        lineIndices: Array.isArray(entry.line_indices) ? entry.line_indices as number[] : [],
        sourceTextSnippets: Array.isArray(entry.source_text_snippets) ? entry.source_text_snippets as string[] : [],
        status: entry.status === "pending" ? "pending" : "bound",
        matchedBy: entry.matched_by === "exact_name" ? "exact_name" : entry.matched_by === "ai_auto" ? "ai_auto" : "manual",
      });
    }
    return out;
  }

  /** 批量回填 manual 快照:替换同 (asset_entity_id, variant_id) 的快照(manual 与 exact_name 都替换——manual 优先)。 */
  private async writeManualSnapshots(
    db: Database,
    entries: Array<{ shotId: string; snapshot: Record<string, unknown> }>,
    now: Date,
  ): Promise<void> {
    for (const { shotId, snapshot } of entries) {
      const [shot] = await db.select({ referenceAssetSnapshots: shots.referenceAssetSnapshots })
        .from(shots).where(eq(shots.id, shotId)).limit(1);
      if (!shot) continue;
      const snapshots = Array.isArray(shot.referenceAssetSnapshots) ? [...shot.referenceAssetSnapshots] : [];
      const assetId = snapshot.asset_entity_id;
      const variantId = snapshot.variant_id as string | null;
      const filtered = snapshots.filter((s) => {
        const e = s as Record<string, unknown>;
        if (e.asset_entity_id !== assetId) return true;
        return !snapshotVariantMatches(e, variantId);
      });
      filtered.push(snapshot);
      await db.update(shots).set({ referenceAssetSnapshots: filtered, updatedAt: now })
        .where(eq(shots.id, shotId));
    }
  }

  /** 按 (asset, variant) 从 shot 上移除快照(用户显式移除,manual 与 exact_name 都删)。 */
  private async removeSnapshotsForVariant(
    db: Database,
    assetEntityId: string,
    entries: Array<{ shotId: string; variantId: string | null }>,
    now: Date,
  ): Promise<void> {
    for (const { shotId, variantId } of entries) {
      const [shot] = await db.select({ referenceAssetSnapshots: shots.referenceAssetSnapshots })
        .from(shots).where(eq(shots.id, shotId)).limit(1);
      if (!shot) continue;
      const snapshots = Array.isArray(shot.referenceAssetSnapshots) ? [...shot.referenceAssetSnapshots] : [];
      const filtered = snapshots.filter((s) => {
        const e = s as Record<string, unknown>;
        if (e.asset_entity_id !== assetEntityId) return true;
        return !snapshotVariantMatches(e, variantId);
      });
      if (filtered.length !== snapshots.length) {
        await db.update(shots).set({ referenceAssetSnapshots: filtered, updatedAt: now })
          .where(eq(shots.id, shotId));
      }
    }
  }
  /** v1.9 十.1 删资产(软删):级联软删实体+本项目引用+全部变体+媒体;清 usages 与 shot 快照。R1 可逆软删。 */
  async deleteAsset(input: {
    projectId: string;
    assetEntityId: string;
    actorId: string;
    now: Date;
  }): Promise<void> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const owned = await this.assertAssetOwned(input.projectId, input.assetEntityId, db);
      if (!owned) throw new BadRequestError("找不到这个资产，可能已经被删除");

      // 1. 清全部 usages 对应的 shot 快照(资产级+变体级,manual 与 exact_name 都删)
      const [entity] = await db.select({ metadata: assetEntities.metadata })
        .from(assetEntities).where(eq(assetEntities.id, input.assetEntityId)).limit(1);
      if (entity) {
        const metadata = entity.metadata as Record<string, unknown>;
        const lite = (metadata.lite as Record<string, unknown> | undefined) ?? {};
        if (Array.isArray(lite.usages)) {
          const shotIds = [...new Set((lite.usages as Array<Record<string, unknown>>)
            .filter((u) => typeof u.shot_id === "string")
            .map((u) => u.shot_id as string))];
          for (const shotId of shotIds) {
            const [shot] = await db.select({ referenceAssetSnapshots: shots.referenceAssetSnapshots })
              .from(shots).where(eq(shots.id, shotId)).limit(1);
            if (!shot) continue;
            const snapshots = Array.isArray(shot.referenceAssetSnapshots) ? [...shot.referenceAssetSnapshots] : [];
            const filtered = snapshots.filter((s) => (s as Record<string, unknown>).asset_entity_id !== input.assetEntityId);
            if (filtered.length !== snapshots.length) {
              await db.update(shots).set({ referenceAssetSnapshots: filtered, updatedAt: input.now })
                .where(eq(shots.id, shotId));
            }
          }
        }
      }

      // 2. 软删全部变体
      await db.update(assetVariants)
        .set({ deletedAt: input.now, deletedByUserId: input.actorId, updatedAt: input.now })
        .where(and(
          eq(assetVariants.assetEntityId, input.assetEntityId),
          isNull(assetVariants.deletedAt),
        ));
      // 3. 软删其下媒体(媒体行自带 asset_entity_id,一次覆盖变体下与直属)
      await db.update(assetMedia)
        .set({ deletedAt: input.now, deletedByUserId: input.actorId })
        .where(and(
          eq(assetMedia.assetEntityId, input.assetEntityId),
          isNull(assetMedia.deletedAt),
        ));
      // 4. 软删本项目引用 + 实体(其他项目引用不动)
      await db.update(projectAssetRefs)
        .set({ deletedAt: input.now, deletedByUserId: input.actorId })
        .where(and(
          eq(projectAssetRefs.projectId, input.projectId),
          eq(projectAssetRefs.assetEntityId, input.assetEntityId),
          isNull(projectAssetRefs.deletedAt),
        ));
      await db.update(assetEntities)
        .set({ deletedAt: input.now, deletedByUserId: input.actorId, updatedAt: input.now })
        .where(eq(assetEntities.id, input.assetEntityId));
    });
  }

}

/* ---------- v1.7 B 层(八.10)纯函数:变体名归一、命中文本、保守子串匹配、抑制名单 ---------- */

/** B 层变体匹配的一个非第一变体输入(所属资产 + 变体名 + 可选别名)。 */
export interface VariantMatchInput {
  assetEntityId: string;
  assetName: string;
  variantId: string;
  variantName: string;
  aliases?: string[];
}

/** B 层变体匹配的一个真实分镜输入:匹配文本 + 分镜号 + 抑制名单 + 已有关联对。 */
export interface VariantMatchShotInput {
  shotId: string;
  shotNo: number;
  matchText: string;
  removedAutoRefs?: Array<{ asset_entity_id: string; variant_id: string }>;
  /** 该 shot 已有任意关联的 (asset, variant) 对(manual/exact_name/pending 快照)→ 跳过。 */
  existingPairs?: Array<{ asset_entity_id: string; variant_id: string }>;
}

/** B 层命中的一条(shot, variant)写入意图;歧义与已抑制的对不出现在结果里。 */
export interface VariantShotMatch {
  assetEntityId: string;
  variantId: string;
  shotId: string;
  shotNo: number;
}

/**
 * 变体名归一(八.10.2):剥一次资产名前缀(`{assetName}-` 或 `{assetName}·`,
 * 「林晚-泳装」→「泳装」),剥后全名仍参与命中;再并入 metadata.lite.aliases(可选)。
 * 不做拼音/分词/同义词扩展——确定性优先,语义缺口留给路径②。
 */
export function variantMatchNames(assetName: string, variantName: string, aliases?: string[]): string[] {
  const names: string[] = [];
  const push = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && !names.includes(trimmed)) names.push(trimmed);
  };
  for (const separator of ["-", "·"]) {
    const prefix = `${assetName}${separator}`;
    if (variantName.startsWith(prefix)) {
      push(variantName.slice(prefix.length));
      break;
    }
  }
  push(variantName);
  for (const alias of aliases ?? []) push(alias);
  return names;
}

/** 分镜匹配文本(八.10.2):subject + visual + script_text null-safe 拼接。 */
export function buildShotMatchText(subject: string | null, visual: string | null, scriptText: string | null): string {
  return [subject, visual, scriptText].filter((s): s is string => typeof s === "string" && s.length > 0).join(" ");
}

/** 读 shots.metadata.lite.removedAutoRefs(八.10.4);形状不合法按空名单处理。 */
export function readRemovedAutoRefs(metadata: unknown): Array<{ asset_entity_id: string; variant_id: string }> {
  const lite = (metadata as { lite?: { removedAutoRefs?: unknown } | null } | null)?.lite;
  const list = lite?.removedAutoRefs;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is { asset_entity_id: string; variant_id: string } =>
    typeof item === "object"
    && item !== null
    && typeof (item as Record<string, unknown>).asset_entity_id === "string"
    && typeof (item as Record<string, unknown>).variant_id === "string");
}

/** 读变体 metadata.lite.aliases(可选字符串数组);形状不合法按无别名处理。 */
export function readVariantAliases(metadata: unknown): string[] {
  const lite = (metadata as { lite?: { aliases?: unknown } | null } | null)?.lite;
  const aliases = lite?.aliases;
  if (!Array.isArray(aliases)) return [];
  return aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0);
}

/** 该 shot 的抑制名单是否已含 (asset, variant) 对——A/B 两层写入前都查。 */
export function shotSuppressed(
  metadata: unknown,
  assetEntityId: string,
  variantId: string,
): boolean {
  return readRemovedAutoRefs(metadata).some(
    (pair) => pair.asset_entity_id === assetEntityId && pair.variant_id === variantId,
  );
}

/**
 * B 层保守子串匹配(八.10.2,纯函数):任一候选名(剥前缀名/全名/别名)是分镜匹配
 * 文本的子串即命中;命中前先跳过——(asset, variant) 在分镜抑制名单(removedAutoRefs)
 * 或已有任意关联(existingPairs)的对;同一分镜上同一资产有 2+ 变体同时命中 → 歧义,
 * 该镜该资产全部跳过(宁可漏不可错,留给路径②/③)。确定性、无模型调用。
 */
export function matchVariantShots(
  variants: VariantMatchInput[],
  shots: VariantMatchShotInput[],
): VariantShotMatch[] {
  // 每镜每资产的命中变体:歧义判定按「同镜同资产 2+ 变体」。
  const hitsByShotAsset = new Map<string, VariantShotMatch[]>();
  for (const shot of shots) {
    if (!shot.matchText) continue;
    for (const variant of variants) {
      const pairBlocked = (pairs?: Array<{ asset_entity_id: string; variant_id: string }>) =>
        pairs?.some((pair) =>
          pair.asset_entity_id === variant.assetEntityId && pair.variant_id === variant.variantId) ?? false;
      if (pairBlocked(shot.removedAutoRefs) || pairBlocked(shot.existingPairs)) continue;
      const names = variantMatchNames(variant.assetName, variant.variantName, variant.aliases);
      if (!names.some((name) => shot.matchText.includes(name))) continue;
      const key = `${shot.shotId}|${variant.assetEntityId}`;
      const list = hitsByShotAsset.get(key) ?? [];
      list.push({
        assetEntityId: variant.assetEntityId,
        variantId: variant.variantId,
        shotId: shot.shotId,
        shotNo: shot.shotNo,
      });
      hitsByShotAsset.set(key, list);
    }
  }
  const matches: VariantShotMatch[] = [];
  for (const hits of hitsByShotAsset.values()) {
    if (hits.length === 1) matches.push(hits[0]!);
    // hits.length >= 2 → 歧义,全部跳过
  }
  return matches;
}

/**
 * 快照的 variant 匹配口径:null 兼容旧资产级快照(无 variant_id 字段/显式 null),
 * 非 null 精确匹配。
 */
function snapshotVariantMatches(e: Record<string, unknown>, variantId: string | null): boolean {
  if (variantId === null) {
    return e.variant_id === null || e.variant_id === undefined;
  }
  return e.variant_id === variantId;
}

/** 解析字符串末段数字("G05" → 5,"S01-004" → 4),无数字返回 null。 */
function parseTrailingNumber(value: string | null): number | null {
  if (!value) return null;
  const m = value.match(/(\d+)\s*$/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

/** 确定性 usage_id:同参输入生成同 id,保证幂等与旧格式归一化的稳定性。 */
function deterministicUsageId(...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("|")).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

/**
 * Lite 物化生成图为资产媒体时的溯源边:为 asset_media 建主体,并连到 media_result 主体
 * (source_channel/source_generation_attempt_id 从结果主体继承)。幂等:重复设主图不重复建行。
 * 与 seedance-assets 的 createPromotedAssetProvenance 同模式,assetMediaId 恒等于 mediaResultId。
 */
async function createLitePromotedAssetProvenance(
  db: Database,
  assetMediaId: string,
  mediaResultId: string,
  observedAt: Date,
): Promise<void> {
  let resultSubject = (await db.select({
    id: mediaProvenanceSubjects.id,
    sourceChannel: mediaProvenanceSubjects.sourceChannel,
    sourceGenerationAttemptId: mediaProvenanceSubjects.sourceGenerationAttemptId,
  }).from(mediaProvenanceSubjects)
    .where(eq(mediaProvenanceSubjects.mediaResultId, mediaResultId))
    .limit(1))[0] ?? null;
  if (!resultSubject) {
    await db.insert(mediaProvenanceSubjects).values({
      assetMediaId: null,
      mediaResultId,
      sourceChannel: "unknown",
      sourceGenerationAttemptId: null,
      providerAssetId: null,
      observedAt,
    }).onConflictDoNothing();
    resultSubject = (await db.select({
      id: mediaProvenanceSubjects.id,
      sourceChannel: mediaProvenanceSubjects.sourceChannel,
      sourceGenerationAttemptId: mediaProvenanceSubjects.sourceGenerationAttemptId,
    }).from(mediaProvenanceSubjects)
      .where(eq(mediaProvenanceSubjects.mediaResultId, mediaResultId))
      .limit(1))[0] ?? null;
  }
  if (!resultSubject) throw new Error("Promoted result provenance subject is missing");
  await db.insert(mediaProvenanceSubjects).values({
    assetMediaId,
    mediaResultId: null,
    sourceChannel: resultSubject.sourceChannel,
    sourceGenerationAttemptId: resultSubject.sourceGenerationAttemptId,
    providerAssetId: null,
    observedAt,
  }).onConflictDoNothing();
  const assetSubject = (await db.select({ id: mediaProvenanceSubjects.id })
    .from(mediaProvenanceSubjects)
    .where(eq(mediaProvenanceSubjects.assetMediaId, assetMediaId))
    .limit(1))[0] ?? null;
  if (!assetSubject) throw new Error("Promoted asset provenance subject is missing");
  await db.insert(mediaProvenanceParentEdges).values({
    childSubjectId: assetSubject.id,
    parentSubjectId: resultSubject.id,
    createdAt: observedAt,
  }).onConflictDoNothing();
}

/** mime 子类型 → asset_media.format(与 seedance-assets 同口径,限长 32 防超列宽)。 */
function formatFromMime(mimeType: string | null): string | null {
  if (!mimeType) return null;
  const subtype = mimeType.split("/")[1]?.toLowerCase();
  return subtype && subtype.length <= 32 ? subtype : null;
}

/** v0.9:读 metadata.audio_kind(音频五类分类);非法/缺失返回 null,展示侧回落「未分类」。 */
function audioKindOfMetadata(metadata: unknown): string | null {
  const value = (metadata as Record<string, unknown> | null)?.audio_kind;
  return typeof value === "string" && value.length > 0 ? value : null;
}
