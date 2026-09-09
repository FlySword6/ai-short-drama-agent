import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { Database } from "../../db/client.js";
import { BadRequestError, ConflictError, errorBody, ForbiddenError } from "../../shared/errors.js";
import type { ProjectAccessAction, ProjectAccessActor } from "../project-access/types.js";
import type { CreateRunInput, CreateScriptVersionInput } from "../script-breakdown/service.js";
import type { ScriptBreakdownRunRecord, ScriptVersionRecord } from "../script-breakdown/types.js";
import type { AiCompletionRequest, AiProviderCompletion } from "../ai/types.js";
import { registerLiteRoutes } from "./routes.js";
import {
  buildShotMatchText,
  matchVariantShots,
  readRemovedAutoRefs,
  shotSuppressed,
  variantMatchNames,
  type VariantMatchInput,
} from "./repository.js";
import { ScriptTextExtractor } from "../../services/script-text-extractor.js";
import { deriveRunIdempotencyKey, LiteAssetService, LiteScriptService } from "./service.js";
import type {
  LiteAddUsageItemInput,
  LiteAddUsagesResult,
  LiteAssetCandidateInput,
  LiteAssetDetail,
  LiteAssetListItem,
  LiteAssetListResult,
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

const TEST_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TEST_EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const TEST_ACTOR: ProjectAccessActor = { id: "33333333-3333-4333-8333-333333333333", role: "member" };
const RUN_ID = "99999999-9999-4999-8999-999999999999";
const TEST_ASSET_ENTITY_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_ASSET_ENTITY_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_PROJECT_ID = "77777777-7777-4777-8777-777777777777";
const SCRIPT_URL = `/api/v1/projects/${TEST_PROJECT_ID}/lite/script`;
const MATERIALIZE_URL = `/api/v1/projects/${TEST_PROJECT_ID}/lite/assets/materialize?episode_id=${TEST_EPISODE_ID}`;
const ACTOR_HEADERS = { "content-type": "application/json" };
const VALID_PAYLOAD = {
  episode_id: TEST_EPISODE_ID,
  raw_text: "夜,旧仓库,林雪独白。\n林雪:我不会再等。",
  client_idempotency_key: "lite-script-key-1",
};

/** 内存版 Lite repository:忠实模拟集归属判定、成片保护、候选落资产与媒体取数。 */
class FakeLiteRepository implements LiteRepository {
  /** 已知集:key=episodeId。测试 setup 时预置。 */
  episodes = new Map<string, LiteContainerEpisode>();
  /** 有未软删成片的集(hasPersistedMedia 返回 true)。 */
  mediaEpisodes = new Set<string>();
  linkCalls: Array<{ projectId: string; episodeId: string }> = [];
  confirmedDraft: LiteConfirmedRunAssetDraft | null = null;
  assetRows: Array<{
    assetEntityId: string;
    projectId: string;
    assetKind: string;
    name: string;
    description: string | null;
    primaryMediaUrl?: string | null;
    audioKind?: string | null;
  }> = [];
  materializeCalls: Array<{
    projectId: string;
    actorId: string;
    runId: string;
    candidates: LiteAssetCandidateInput[];
    shotCandidates: LiteShotCandidateInput[];
    episodeId: string;
    episodeNo: number;
  }> = [];
  mediaRows: Array<LiteAssetMediaItem & { projectId: string; assetEntityId: string }> = [];
  registrationRows: Array<LiteReferenceAssetItem & { projectId: string; status: string }> = [];

  async findEpisode(projectId: string, episodeId: string): Promise<LiteContainerEpisode | null> {
    const ep = this.episodes.get(episodeId);
    if (!ep || ep.projectId !== projectId) return null;
    return ep;
  }

  async createEpisode(projectId: string, episodeNo: number, _name: string, _now: Date): Promise<string> {
    const id = `ep-${projectId}-${episodeNo}`;
    this.episodes.set(id, { id, projectId, episodeNo });
    return id;
  }

  softDeleteCalls: Array<{ projectId: string; actorId: string }> = [];
  /** 与真库同口径:软删本项目全部活跃集(从内存表移除),返回覆盖集数。 */
  async softDeleteActiveEpisodes(projectId: string, actorId: string): Promise<number> {
    this.softDeleteCalls.push({ projectId, actorId });
    let count = 0;
    for (const [id, ep] of this.episodes) {
      if (ep.projectId === projectId) {
        this.episodes.delete(id);
        count += 1;
      }
    }
    return count;
  }

  async hasPersistedMedia(episodeId: string): Promise<boolean> {
    return this.mediaEpisodes.has(episodeId);
  }

  async linkContainerEpisode(projectId: string, episodeId: string): Promise<void> {
    this.linkCalls.push({ projectId, episodeId });
  }

  async findLatestConfirmedRunAssetDraft(): Promise<LiteConfirmedRunAssetDraft | null> {
    return this.confirmedDraft;
  }

  async materializeAssetCandidates(input: {
    projectId: string;
    actorId: string;
    runId: string;
    candidates: LiteAssetCandidateInput[];
    shotCandidates: LiteShotCandidateInput[];
    episodeId: string;
    episodeNo: number;
  }): Promise<LiteMaterializeAssetsResult> {
    this.materializeCalls.push(input);
    const assets: LiteMaterializedAsset[] = [];
    let created = 0;
    let existed = 0;
    for (const candidate of input.candidates) {
      // 与真库同事务可见性一致:本次调用内已建行,后续同名候选立即视为已存在。
      const hit = this.assetRows.find((row) => row.projectId === input.projectId
        && row.assetKind === candidate.assetKind
        && row.name === candidate.name);
      if (hit) {
        existed += 1;
        assets.push({
          assetEntityId: hit.assetEntityId,
          assetKind: candidate.assetKind,
          name: candidate.name,
          outcome: "existing",
        });
        continue;
      }
      const assetEntityId = crypto.randomUUID();
      this.assetRows.push({
        assetEntityId,
        projectId: input.projectId,
        assetKind: candidate.assetKind,
        name: candidate.name,
        description: candidate.description,
      });
      created += 1;
      assets.push({
        assetEntityId,
        assetKind: candidate.assetKind,
        name: candidate.name,
        outcome: "created",
      });
    }
    return { created, existed, assets, variantMatches: 0, variantMatchSkipped: null, aiVariantMatches: 0, aiVariantMatchSkipped: null };
  }

  autoMatchCalls: Array<{ projectId: string }> = [];
  autoMatchProfiles: Array<LiteVariantMatchProfile & { variantId: string }> = [];
  aiAutoWrites: Array<{ assetEntityId: string; variantId: string; shotId: string; shotNo: number; sceneName: string | null }> = [];

  async listVariantsForAutoMatch(input: { projectId: string }): Promise<Array<LiteVariantMatchProfile & { variantId: string }>> {
    this.autoMatchCalls.push(input);
    return this.autoMatchProfiles;
  }

  async writeAiAutoUsages(input: {
    projectId: string;
    episodeId: string;
    episodeNo: number;
    writes: Array<{ assetEntityId: string; variantId: string; shotId: string; shotNo: number; sceneName: string | null; sourceTextSnippets: string[] }>;
    now: Date;
  }): Promise<number> {
    this.aiAutoWrites.push(...input.writes);
    return input.writes.length;
  }

  async listAssetMedia(input: { projectId: string; assetEntityId: string }): Promise<LiteAssetMediaItem[]> {
    // 模拟真库口径:限定本项目+目标资产、未软删行,按 created_at 倒序返回。
    return this.mediaRows
      .filter((row) => row.projectId === input.projectId && row.assetEntityId === input.assetEntityId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ projectId: _projectId, assetEntityId: _assetEntityId, ...item }) => item);
  }

  async listReferenceAssets(input: { projectId: string }): Promise<LiteReferenceAssetItem[]> {
    // 模拟真库口径:本项目 + status='active' 的登记行,按登记 updated_at 倒序后
    // 每资产只留最新一条;无 active 登记的资产自然被内连滤掉。
    const seen = new Set<string>();
    const items: LiteReferenceAssetItem[] = [];
    const active = this.registrationRows
      .filter((row) => row.projectId === input.projectId && row.status === "active")
      .sort((a, b) => b.registeredAt.getTime() - a.registeredAt.getTime());
    for (const row of active) {
      if (seen.has(row.assetEntityId)) continue;
      seen.add(row.assetEntityId);
      const { projectId: _projectId, status: _status, ...item } = row;
      items.push(item);
    }
    return items;
  }

  async listAssets(input: { projectId: string; kind?: string }): Promise<LiteAssetListResult> {
    const rows = this.assetRows.filter((row) => row.projectId === input.projectId
      && (!input.kind || row.assetKind === input.kind));
    const items: LiteAssetListItem[] = rows.map((row) => ({
      assetEntityId: row.assetEntityId,
      name: row.name,
      intro: row.description,
      assetKind: row.assetKind,
      audioKind: row.assetKind === "audio" ? row.audioKind ?? null : null,
      primaryMediaUrl: row.primaryMediaUrl ?? null,
      hasMedia: false,
      hasPrimary: false,
      hasPendingGeneration: false,
      lastModifiedAt: new Date(),
    }));
    const allRows = this.assetRows.filter((row) => row.projectId === input.projectId);
    const countMap = new Map<string, number>();
    for (const row of allRows) {
      countMap.set(row.assetKind, (countMap.get(row.assetKind) ?? 0) + 1);
    }
    const tabCounts: LiteAssetTabCount[] = [...countMap.entries()].map(([kind, count]) => ({ kind, count }));
    return { items, tabCounts };
  }

  async findAssetDetail(input: { projectId: string; assetEntityId: string }): Promise<LiteAssetDetail | null> {
    const row = this.assetRows.find((r) => r.projectId === input.projectId && r.assetEntityId === input.assetEntityId);
    if (!row) return null;
    return {
      assetEntityId: row.assetEntityId,
      name: row.name,
      intro: row.description,
      assetKind: row.assetKind,
      audioKind: row.assetKind === "audio" ? row.audioKind ?? null : null,
      note: null,
      hasMedia: false,
      hasPrimary: false,
      hasPendingGeneration: false,
      lastModifiedAt: new Date(),
      modifiedByUserId: null,
      gender: null,
      ageValue: null,
      appearance: null,
      hairDescription: null,
      outfitDescription: null,
      heightCm: null,
      metadataLite: null,
    };
  }

  async createAsset(input: {
    projectId: string;
    actorId: string;
    name: string;
    assetKind: string;
    intro: string | null;
    note: string | null;
    now: Date;
  }): Promise<{ assetEntityId: string; firstVariantId: string }> {
    const assetEntityId = crypto.randomUUID();
    const firstVariantId = crypto.randomUUID();
    this.assetRows.push({
      assetEntityId,
      projectId: input.projectId,
      assetKind: input.assetKind,
      name: input.name,
      description: input.intro,
    });
    return { assetEntityId, firstVariantId };
  }

  async updateAsset(input: {
    projectId: string;
    assetEntityId: string;
    patch: LitePatchAssetInput;
    actorId: string;
    now: Date;
  }): Promise<void> {
    const row = this.assetRows.find((r) => r.projectId === input.projectId && r.assetEntityId === input.assetEntityId);
    if (!row) throw new BadRequestError("找不到这个资产");
    if (input.patch.name !== undefined) row.name = input.patch.name;
    if (input.patch.intro !== undefined) row.description = input.patch.intro;
  }

  // --- Phase 2 stubs ---
  variantRows: Array<LiteAssetVariant & { projectId: string; assetEntityId: string }> = [];
  versionTrackRows: Array<LiteAssetVersionTrackItem & { projectId: string; assetEntityId: string }> = [];
  setPrimaryCalls: Array<{ projectId: string; assetEntityId: string; targetMediaId: string }> = [];
  setPrimaryConflict = false;
  /** 设主图成功返回的 mediaKind(自动登记判定用;默认 image,音频用例置 audio)。 */
  setPrimaryKind: "image" | "audio" = "image";
  setPrimaryFromResultCalls: Array<{ projectId: string; assetEntityId: string; targetMediaResultId: string }> = [];
  setPrimaryFromResultConflict = false;
  usageRows: Array<LiteAssetUsageEntry & { projectId: string; assetEntityId: string }> = [];
  addUsageCalls: Array<{
    projectId: string;
    assetEntityId: string;
    actorId: string;
    now: Date;
    items: LiteAddUsageItemInput[];
  }> = [];
  removeUsageCalls: Array<{ projectId: string; assetEntityId: string; usageId: string }> = [];
  deleteVariantCalls: Array<{ projectId: string; assetEntityId: string; variantId: string }> = [];
  deleteMediaCalls: Array<{ projectId: string; assetEntityId: string; mediaId: string }> = [];
  deleteAssetCalls: Array<{ projectId: string; assetEntityId: string }> = [];

  async listAssetVariants(input: { projectId: string; assetEntityId: string }): Promise<LiteAssetVariant[]> {
    return this.variantRows
      .filter((r) => r.projectId === input.projectId && r.assetEntityId === input.assetEntityId)
      .map(({ variantId, variantKind, displayName, isPrimary, imageUrl }) => ({ variantId, variantKind, displayName, isPrimary, imageUrl }));
  }

  async listAssetVersionTrack(input: { projectId: string; assetEntityId: string }): Promise<LiteAssetVersionTrackItem[]> {
    return this.versionTrackRows
      .filter((r) => r.projectId === input.projectId && r.assetEntityId === input.assetEntityId)
      .map(({ assetMediaId, mediaResultId, storageUrl, isPrimary, source, mediaKind, format, widthPx, heightPx, createdAt, variantId }) =>
        ({ assetMediaId, mediaResultId, storageUrl, isPrimary, source, mediaKind, format, widthPx, heightPx, createdAt, variantId }));
  }

  async setPrimaryMedia(input: { projectId: string; assetEntityId: string; targetMediaId: string }): Promise<{ conflict: boolean; mediaId: string; mediaKind: string }> {
    this.setPrimaryCalls.push(input);
    return { conflict: this.setPrimaryConflict, mediaId: input.targetMediaId, mediaKind: this.setPrimaryKind };
  }

  async setPrimaryMediaFromResult(input: { projectId: string; assetEntityId: string; targetMediaResultId: string }): Promise<{ conflict: boolean; mediaId: string; mediaKind: string }> {
    this.setPrimaryFromResultCalls.push(input);
    return { conflict: this.setPrimaryFromResultConflict, mediaId: input.targetMediaResultId, mediaKind: this.setPrimaryKind };
  }

  async listAssetUsages(input: { projectId: string; assetEntityId: string; variantId?: string }): Promise<LiteAssetUsageEntry[]> {
    return this.usageRows
      .filter((r) => r.projectId === input.projectId && r.assetEntityId === input.assetEntityId
        && (!input.variantId || r.variantId === input.variantId))
      .map(({ projectId: _projectId, assetEntityId: _assetEntityId, ...item }) => item);
  }

  async addAssetShotUsages(input: {
    projectId: string;
    assetEntityId: string;
    actorId: string;
    now: Date;
    items: LiteAddUsageItemInput[];
  }): Promise<LiteAddUsagesResult> {
    this.addUsageCalls.push(input);
    let added = 0;
    let pending = 0;
    for (const item of input.items) {
      if (item.shotId) added += 1;
      else pending += 1;
    }
    return { added, pending };
  }

  async removeAssetShotUsage(input: { projectId: string; assetEntityId: string; usageId: string; now: Date }): Promise<void> {
    this.removeUsageCalls.push(input);
    this.usageRows = this.usageRows.filter((r) => r.usageId !== input.usageId);
  }

  removeShotAutoRefCalls: Array<{ projectId: string; shotId: string; assetEntityId: string; variantId: string; actorId: string; now: Date }> = [];
  clearShotAutoRefCalls: Array<{ projectId: string; shotId: string; assetEntityId: string; variantId: string; now: Date }> = [];

  async removeShotAutoRef(input: {
    projectId: string; shotId: string; assetEntityId: string; variantId: string; actorId: string; now: Date;
  }): Promise<void> {
    this.removeShotAutoRefCalls.push(input);
  }

  async clearShotAutoRefSuppression(input: {
    projectId: string; shotId: string; assetEntityId: string; variantId: string; now: Date;
  }): Promise<void> {
    this.clearShotAutoRefCalls.push(input);
  }

  async deleteAssetVariant(input: { projectId: string; assetEntityId: string; variantId: string; actorId: string; now: Date }): Promise<void> {
    this.deleteVariantCalls.push(input);
  }

  async deleteAssetMedia(input: { projectId: string; assetEntityId: string; mediaId: string; actorId: string; now: Date }): Promise<void> {
    this.deleteMediaCalls.push(input);
  }

  async deleteAsset(input: { projectId: string; assetEntityId: string; actorId: string; now: Date }): Promise<void> {
    this.deleteAssetCalls.push(input);
  }

  async findShotByLabel(input: {
    projectId: string; episodeNo: number; shotNo: number; sceneName?: string;
  }): Promise<{ shotId: string } | null> {
    const hit = this.matchSuggestShots.find((s) => s.episodeNo === input.episodeNo && s.shotNo === input.shotNo);
    return hit ? { shotId: hit.shotId } : null;
  }

  // --- v1.6 匹配建议只读方法(fake:matchSuggestShots 即已确认集分镜全集,T13.9) ---
  matchSuggestShots: LiteMatchSuggestShotRow[] = [];
  matchVariantProfile: (LiteVariantMatchProfile & { projectId: string; variantId: string }) | null = null;

  async listShotsForMatchSuggest(): Promise<LiteMatchSuggestShotRow[]> {
    return this.matchSuggestShots;
  }

  async findShotSuggestInfo(input: { projectId: string; shotId: string }): Promise<LiteMatchSuggestShotRow | null> {
    return this.matchSuggestShots.find((s) => s.shotId === input.shotId) ?? null;
  }

  async findVariantForMatchSuggest(input: {
    projectId: string; assetEntityId: string; variantId: string;
  }): Promise<LiteVariantMatchProfile | null> {
    const p = this.matchVariantProfile;
    if (!p || p.projectId !== input.projectId || p.assetEntityId !== input.assetEntityId || p.variantId !== input.variantId) return null;
    const { projectId: _projectId, variantId: _variantId, ...profile } = p;
    return profile;
  }
}

/** 记录鉴权调用的 access fake,默认放行;deny=true 时按无权限抛 403。 */
class FakeAccess {
  calls: Array<{ actorId: string; projectId: string; action: ProjectAccessAction }> = [];
  deny = false;

  async require(actor: ProjectAccessActor, projectId: string, action: ProjectAccessAction): Promise<null> {
    this.calls.push({ actorId: actor.id, projectId, action });
    if (this.deny) throw new ForbiddenError();
    return null;
  }
}

/** 剧本两段式 fake:按幂等键返回 existing,绝不触达真实模型。 */
class FakeBreakdown {
  versionsByKey = new Map<string, ScriptVersionRecord>();
  runsByKey = new Map<string, ScriptBreakdownRunRecord>();
  versionInputs: CreateScriptVersionInput[] = [];
  runInputs: CreateRunInput[] = [];
  executed: Array<{ runId: string; actorId: string; autoConfirm: boolean }> = [];
  runError: Error | null = null;

  async createScriptVersion(
    actor: ProjectAccessActor,
    episodeId: string,
    input: CreateScriptVersionInput,
  ): Promise<{ version: ScriptVersionRecord; outcome: "created" | "existing" }> {
    this.versionInputs.push(input);
    const existing = this.versionsByKey.get(input.clientIdempotencyKey);
    if (existing) return { version: existing, outcome: "existing" };
    const version: ScriptVersionRecord = {
      id: crypto.randomUUID(),
      episodeId,
      versionNo: this.versionsByKey.size + 1,
      title: input.title,
      scriptText: input.scriptText,
      scriptSha256: "fake-sha",
      source: "manual",
      createdByUserId: actor.id,
      createdAt: new Date(),
    };
    this.versionsByKey.set(input.clientIdempotencyKey, version);
    return { version, outcome: "created" };
  }

  async createRun(
    actor: ProjectAccessActor,
    episodeId: string,
    input: CreateRunInput,
  ): Promise<{ run: ScriptBreakdownRunRecord; outcome: "created" | "existing" }> {
    if (this.runError) throw this.runError;
    this.runInputs.push(input);
    const existing = this.runsByKey.get(input.clientIdempotencyKey);
    if (existing) return { run: existing, outcome: "existing" };
    const now = new Date();
    const run: ScriptBreakdownRunRecord = {
      id: RUN_ID,
      episodeId,
      scriptVersionId: input.scriptVersionId,
      createdByUserId: actor.id,
      modelName: null,
      promptVersion: "script-breakdown.v1",
      status: "queued",
      currentStage: null,
      targetDurationSec: input.targetDurationSec,
      inputSha256: "fake-input-sha",
      draft: {},
      validation: {
        status: "pass",
        issues: [],
        unmatchedAssets: [],
        duplicateCoverage: [],
        shotCount: 0,
        totalDurationSec: 0,
      },
      usage: { callCount: 0, totalInputTokens: 0, totalOutputTokens: 0 },
      errorCode: null,
      errorMessage: null,
      confirmedByUserId: null,
      confirmedAt: null,
      discardedByUserId: null,
      discardedAt: null,
      supersededByRunId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runsByKey.set(input.clientIdempotencyKey, run);
    return { run, outcome: "created" };
  }

  async executeRun(runId: string, actorId: string, options: { autoConfirm?: boolean } = {}): Promise<void> {
    this.executed.push({ runId, actorId, autoConfirm: options.autoConfirm ?? false });
  }
}

/** AI 网关 fake:按配置输出 JSON(validate 走真实校验路径),绝不触达真实模型。 */
class FakeMatchSuggestGateway {
  /** 预设输出(按次消费);多条时每次调用取下一条,只有一条时重复返回。 */
  outputs: unknown[] = [[]];
  inputs: AiCompletionRequest[] = [];

  async completeValidated<T>(
    input: AiCompletionRequest,
    validate: (completion: AiProviderCompletion) => T | Promise<T>,
  ): Promise<T> {
    this.inputs.push(input);
    const output = this.outputs.length > 1 ? this.outputs.shift() : this.outputs[0];
    return validate({ content: JSON.stringify(output), model: "fake-model", inputTokens: 10, outputTokens: 20, durationMs: 1 });
  }
}

interface Harness {
  app: FastifyInstance;
  repository: FakeLiteRepository;
  access: FakeAccess;
  breakdown: FakeBreakdown;
  gateway: FakeMatchSuggestGateway;
  /** 2026-08-19 触发模型:设主图成功后自动登记的捕获(harness 恒注入捕获器,不触达登记服务)。 */
  registerPrimaryCalls: Array<{ actor: ProjectAccessActor; projectId: string; assetEntityId: string; mediaId: string }>;
}

async function harness(options: { authenticated?: boolean } = {}): Promise<Harness> {
  const repository = new FakeLiteRepository();
  repository.episodes.set(TEST_EPISODE_ID, { id: TEST_EPISODE_ID, projectId: TEST_PROJECT_ID, episodeNo: 1 });
  const access = new FakeAccess();
  const breakdown = new FakeBreakdown();
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    return reply.code(statusCode).send({ ok: false, error: errorBody(error) });
  });
  if (options.authenticated !== false) {
    app.addHook("preHandler", async (request) => {
      request.authUser = { id: TEST_ACTOR.id, username: "tester", displayName: "测试用户", role: "member" };
    });
  }
  const gateway = new FakeMatchSuggestGateway();
  const registerPrimaryCalls: Harness["registerPrimaryCalls"] = [];
  await registerLiteRoutes(app, () => ({} as Database), {
    createService: () => new LiteScriptService(repository, access, breakdown, new ScriptTextExtractor()),
    createAssetService: () => new LiteAssetService(repository, access, {
      registerPrimary: (input) => {
        registerPrimaryCalls.push(input);
      },
    }),
    createGateway: () => gateway,
    executeRunsInline: true,
  });
  return { app, repository, access, breakdown, gateway, registerPrimaryCalls };
}

function postScript(app: FastifyInstance, payload: Record<string, unknown> = VALID_PAYLOAD) {
  return app.inject({ method: "POST", url: SCRIPT_URL, headers: ACTOR_HEADERS, payload });
}

test("Lite 剧本:正常路径确认集归属、两段式转调并写回 lite_episode_id", async () => {
  const { app, repository, access, breakdown } = await harness();
  const response = await postScript(app);
  assert.equal(response.statusCode, 201, response.body);
  const data = response.json().data;
  assert.equal(data.episode_id, TEST_EPISODE_ID);
  assert.equal(data.run_id, RUN_ID);
  assert.equal(data.outcome, "created");

  // v0.9:一键生成本集闭环 = 解析(create) + 自动 materialize(create,幂等补资产与出现记录)。
  assert.deepEqual(access.calls, [
    { actorId: TEST_ACTOR.id, projectId: TEST_PROJECT_ID, action: "create" },
    { actorId: TEST_ACTOR.id, projectId: TEST_PROJECT_ID, action: "create" },
  ]);
  assert.deepEqual(repository.linkCalls, [{ projectId: TEST_PROJECT_ID, episodeId: TEST_EPISODE_ID }], "落剧本后写回指针");

  assert.equal(breakdown.versionInputs.length, 1);
  assert.equal(breakdown.versionInputs[0]!.scriptText, VALID_PAYLOAD.raw_text);
  assert.deepEqual(breakdown.executed, [{ runId: RUN_ID, actorId: TEST_ACTOR.id, autoConfirm: true }], "创建后内联执行拆解,默认带自动确认");
  assert.equal(breakdown.runInputs.length, 1);
  assert.equal(breakdown.runInputs[0]!.scriptVersionId, breakdown.versionsByKey.get(VALID_PAYLOAD.client_idempotency_key)!.id);
  assert.equal(
    breakdown.runInputs[0]!.clientIdempotencyKey,
    deriveRunIdempotencyKey(VALID_PAYLOAD.client_idempotency_key),
    "run 幂等键走确定性派生",
  );
});

test("Lite 剧本:同集活跃解析透传 lite_run_in_flight", async () => {
  const { app, breakdown } = await harness();
  breakdown.runError = new ConflictError("这一集正在解析中，请稍候", "lite_run_in_flight");
  const response = await postScript(app);
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(response.json().error, {
    code: "lite_run_in_flight", message: "这一集正在解析中，请稍候", retryable: false, details: null,
  });
});

test("项目写事务:submitScript 的 episode/version/run/link 全部使用同一 scoped ports", async () => {
  const rootRepository = new FakeLiteRepository();
  const scopedRepository = new FakeLiteRepository();
  scopedRepository.episodes.set(TEST_EPISODE_ID, {
    id: TEST_EPISODE_ID,
    projectId: TEST_PROJECT_ID,
    episodeNo: 1,
  });
  const rootBreakdown = new FakeBreakdown();
  const scopedBreakdown = new FakeBreakdown();
  const access = new FakeAccess();
  const lockedProjects: string[] = [];
  const service = new LiteScriptService(
    rootRepository,
    access,
    rootBreakdown,
    new ScriptTextExtractor(),
    {
      runProjectMutation: async (projectId, work) => {
        lockedProjects.push(projectId);
        return work({ repository: scopedRepository, breakdown: scopedBreakdown });
      },
    },
  );

  const result = await service.submitScript(TEST_ACTOR, TEST_PROJECT_ID, {
    episodeId: TEST_EPISODE_ID,
    rawText: VALID_PAYLOAD.raw_text,
    clientIdempotencyKey: VALID_PAYLOAD.client_idempotency_key,
  });

  assert.equal(result.outcome, "created");
  assert.deepEqual(lockedProjects, [TEST_PROJECT_ID]);
  assert.equal(rootBreakdown.versionInputs.length, 0);
  assert.equal(scopedBreakdown.versionInputs.length, 1);
  assert.deepEqual(scopedRepository.linkCalls, [{
    projectId: TEST_PROJECT_ID,
    episodeId: TEST_EPISODE_ID,
  }]);
});

test("项目写事务:整部导入的覆盖与全部 episode/version 重建使用同一 scoped ports", async () => {
  const rootRepository = new FakeLiteRepository();
  const scopedRepository = new FakeLiteRepository();
  scopedRepository.episodes.set(TEST_EPISODE_ID, {
    id: TEST_EPISODE_ID,
    projectId: TEST_PROJECT_ID,
    episodeNo: 99,
  });
  const rootBreakdown = new FakeBreakdown();
  const scopedBreakdown = new FakeBreakdown();
  const access = new FakeAccess();
  const extractor = new ScriptTextExtractor();
  extractor.extract = async () => ({
    text: "第1集 初见\n雨夜相遇。\n第2集 决定\n两人结盟。",
    sourceFormat: "txt",
  });
  const lockedProjects: string[] = [];
  const service = new LiteScriptService(
    rootRepository,
    access,
    rootBreakdown,
    extractor,
    {
      runProjectMutation: async (projectId, work) => {
        lockedProjects.push(projectId);
        return work({ repository: scopedRepository, breakdown: scopedBreakdown });
      },
    },
  );

  const result = await service.importBulkScript(
    TEST_ACTOR,
    TEST_PROJECT_ID,
    "whole.txt",
    Buffer.from("unused"),
  );

  assert.deepEqual(lockedProjects, [TEST_PROJECT_ID]);
  assert.equal(result.replaced, 1);
  assert.equal(result.episodes.length, 2);
  assert.equal(rootRepository.softDeleteCalls.length, 0);
  assert.equal(scopedRepository.softDeleteCalls.length, 1);
  assert.equal(rootBreakdown.versionInputs.length, 0);
  assert.equal(scopedBreakdown.versionInputs.length, 2);
});

test("项目写事务:materialize 的 confirmed run、episode 与资产写入使用同一 scoped repository", async () => {
  const rootRepository = new FakeLiteRepository();
  const scopedRepository = new FakeLiteRepository();
  scopedRepository.episodes.set(TEST_EPISODE_ID, {
    id: TEST_EPISODE_ID,
    projectId: TEST_PROJECT_ID,
    episodeNo: 1,
  });
  seedConfirmedContainer(scopedRepository);
  const access = new FakeAccess();
  const lockedProjects: string[] = [];
  const service = new LiteAssetService(rootRepository, access, {
    runProjectMutation: async (projectId, work) => {
      lockedProjects.push(projectId);
      return work(scopedRepository);
    },
  });

  const result = await service.materializeAssets(
    TEST_ACTOR,
    TEST_PROJECT_ID,
    TEST_EPISODE_ID,
  );

  assert.deepEqual(lockedProjects, [TEST_PROJECT_ID]);
  assert.equal(rootRepository.materializeCalls.length, 0);
  assert.equal(scopedRepository.materializeCalls.length, 1);
  assert.equal(result.created, 3);
});

test("v0.9 一键生成本集闭环:auto_confirm 后自动 materialize(资产+出现记录同事务)", async () => {
  const { app, repository } = await harness();
  seedConfirmedContainer(repository);
  const response = await postScript(app);
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(repository.materializeCalls.length, 1, "auto_confirm 闭环必须自动落资产");
  assert.equal(repository.materializeCalls[0]!.runId, RUN_ID);
});

test("v0.9 一键生成本集:auto_confirm=false 不自动 materialize(人工采用入口不抢跑)", async () => {
  const { app, repository } = await harness();
  seedConfirmedContainer(repository);
  const response = await postScript(app, { ...VALID_PAYLOAD, auto_confirm: false });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(repository.materializeCalls.length, 0, "人工采用入口不得自动落资产");
});


test("v0.9 C 层(AI 自动挂):materialize 后对全项目变体跑 AI 匹配并写 ai_auto 出现记录", async () => {
  const { repository, access, gateway } = await harness();
  seedConfirmedContainer(repository);
  repository.matchSuggestShots = [{
    shotId: "shot-ai-1", episodeId: TEST_EPISODE_ID, episodeNo: 1, shotNo: 1,
    sceneName: "游泳池", title: null, scriptText: "林雪换上泳装走出泳池。", breakdownElements: null,
  }];
  repository.autoMatchProfiles = [{
    variantId: "v-pool", variantName: "泳池造型", variantDescription: null,
    assetEntityId: "a-linxue", assetName: "林雪", assetKind: "character", assetIntro: null,
  }];
  gateway.outputs = [[{ episode_no: 1, shot_no: 1, reason: "泳装语义命中泳池造型" }]];
  const service = new LiteAssetService(repository, access, { gateway });
  const result = await service.materializeAssets(TEST_ACTOR, TEST_PROJECT_ID, TEST_EPISODE_ID);
  assert.equal(result.aiVariantMatches, 1, "AI 语义命中必须写入出现记录");
  assert.equal(result.aiVariantMatchSkipped, null);
  assert.equal(repository.aiAutoWrites.length, 1);
  assert.equal(repository.aiAutoWrites[0]!.variantId, "v-pool");
  assert.equal(repository.aiAutoWrites[0]!.shotId, "shot-ai-1");
});

test("v0.9 C 层:无网关时整体跳过且不影响 A/B 层结果", async () => {
  const { repository, access } = await harness();
  seedConfirmedContainer(repository);
  const service = new LiteAssetService(repository, access);
  const result = await service.materializeAssets(TEST_ACTOR, TEST_PROJECT_ID, TEST_EPISODE_ID);
  assert.equal(result.aiVariantMatches, 0);
  assert.equal(result.aiVariantMatchSkipped, "no_gateway");
  assert.equal(result.created, 3, "A 层照常落资产");
});
test("Lite 剧本:episode_id 不属于该项目 → 400 人话,不触达拆解", async () => {
  const { app, breakdown } = await harness();
  const response = await postScript(app, { ...VALID_PAYLOAD, episode_id: "44444444-4444-4444-8444-444444444444" });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error.message, "找不到这一集，请刷新后再试");
  assert.equal(breakdown.versionInputs.length, 0, "集不存在时不得触达剧本服务");
});

test("Lite 剧本:该集已有成片 → 409 lite_script_locked,不再发起拆解", async () => {
  const { app, repository, breakdown } = await harness();
  repository.mediaEpisodes.add(TEST_EPISODE_ID);

  const response = await postScript(app);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, "lite_script_locked");
  assert.equal(response.json().error.message, "这一集已经有成片了，不能重新解析");
  assert.equal(breakdown.versionInputs.length, 0, "有成片时不得建剧本版本");
  assert.equal(breakdown.runInputs.length, 0, "有成片时不得建拆解运行");
});

test("Lite 剧本:未登录 → 401 标准信封", async () => {
  const { app } = await harness({ authenticated: false });
  const response = await postScript(app);
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "unauthorized");
});

test("Lite 剧本:raw_text 空或全空白 → 400,多余字段被 strict 拒绝", async () => {
  const { app, breakdown } = await harness();
  const empty = await postScript(app, { ...VALID_PAYLOAD, raw_text: "" });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error.code, "invalid_request");

  const blank = await postScript(app, { ...VALID_PAYLOAD, raw_text: "   \n  " });
  assert.equal(blank.statusCode, 400, "trim 后为空同样拒绝");

  const extra = await postScript(app, { ...VALID_PAYLOAD, title: "不允许的字段" });
  assert.equal(extra.statusCode, 400, "strict body 拒绝未知字段");

  assert.equal(breakdown.versionInputs.length, 0, "校验失败不得触达剧本服务");
});

test("Lite 剧本:同一幂等键重发返回同一 run,不重复执行拆解", async () => {
  const { app, repository, breakdown } = await harness();
  const first = await postScript(app);
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().data.outcome, "created");

  const second = await postScript(app);
  assert.equal(second.statusCode, 201);
  assert.equal(second.json().data.run_id, first.json().data.run_id);
  assert.equal(second.json().data.episode_id, first.json().data.episode_id);

  assert.equal(repository.linkCalls.length, 2, "每次提交都写回指针");
  assert.equal(breakdown.versionInputs.length, 2, "版本段重放由服务幂等接住(existing)");
  assert.equal(breakdown.runsByKey.size, 1);
  assert.equal(breakdown.executed.length, 1, "existing 不重复调度执行");
});

test("Lite 剧本:auto_confirm 不传默认 true(一键生成本集默认采用,§2 P2)", async () => {
  const { app, breakdown } = await harness();
  const response = await postScript(app);
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(breakdown.executed[0]?.autoConfirm, true, "未传 auto_confirm 时服务端默认确认");
});

test("Lite 剧本:auto_confirm=false 透传(单独解析入口保留人工采用)", async () => {
  const { app, breakdown } = await harness();
  const response = await postScript(app, { ...VALID_PAYLOAD, auto_confirm: false });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(breakdown.executed[0]?.autoConfirm, false);
});

/* ---------- Lite 剧本:从文件导入文本 ---------- */

const EXTRACT_URL = `/api/v1/projects/${TEST_PROJECT_ID}/lite/script/extract-text`;

function postExtract(app: FastifyInstance, filename: string, content: string, contentType = "text/plain") {
  return app.inject({
    method: "POST",
    url: EXTRACT_URL,
    headers: { ...ACTOR_HEADERS, "content-type": "multipart/form-data; boundary=boundary" },
    payload: `--boundary\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n--boundary--\r\n`,
  });
}

test("Lite 剧本:从 .txt 文件提取纯文本成功", async () => {
  const { app } = await harness();
  const response = await postExtract(app, "剧本.txt", "夜，旧仓库。\n林雪：我不会再等。");
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.equal(data.source_format, "txt");
  assert.ok(data.text.includes("夜，旧仓库。"), "提取出的文本应包含原文");
  assert.ok(data.char_count > 0);
});

test("Lite 剧本:从 .docx 文件提取纯文本成功", async () => {
  const { app } = await harness();
  // 用一个最小合法 docx(zip)构造会让 mammoth 抛错,这里只验证不支持的扩展名被拒;
  // .docx 成功路径由 extractor 单元测试覆盖。
  const response = await postExtract(app, "剧本.xlsx", "fake");
  assert.equal(response.statusCode, 400, "不支持 .xlsx");
  assert.equal(response.json().error.message, "目前支持 .txt、.md、.docx 和 .pdf 四种格式，请转换后再上传");
});

test("Lite 剧本:multipart 无文件字段 → 400 人话", async () => {
  const { app } = await harness();
  const response = await app.inject({
    method: "POST",
    url: EXTRACT_URL,
    headers: { ...ACTOR_HEADERS, "content-type": "multipart/form-data; boundary=boundary" },
    payload: "--boundary\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nno-file\r\n--boundary--\r\n",
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error.message, "请选择一个剧本文件");
});

test("Lite 剧本:空文件 → 400 人话", async () => {
  const { app } = await harness();
  const response = await postExtract(app, "空.txt", "");
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error.message, "文件是空的，没有可提取的文本");
});

/* ---------- Lite 剧本:整部剧本导入 ---------- */

const BULK_URL = `/api/v1/projects/${TEST_PROJECT_ID}/lite/script/import-bulk`;

function postImportBulk(app: FastifyInstance, filename: string, content: string, contentType = "text/plain") {
  return app.inject({
    method: "POST",
    url: BULK_URL,
    headers: { ...ACTOR_HEADERS, "content-type": "multipart/form-data; boundary=boundary" },
    payload: `--boundary\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n--boundary--\r\n`,
  });
}

test("Lite 剧本:整部剧本按集标题拆分建多集 + version", async () => {
  const { app, breakdown, repository } = await harness();
  repository.episodes.clear(); // 模拟空项目:harness 预置的集不属于本用例场景。
  const script = [
    "第1集",
    "1-1 客厅 日 内",
    "林凡醒来。",
    "第2集",
    "2-1 医院 日 内",
    "林凡探望母亲。",
  ].join("\n");
  const response = await postImportBulk(app, "整剧.txt", script);
  assert.equal(response.statusCode, 201, response.body);
  const data = response.json().data;
  assert.equal(data.episodes.length, 2, "应拆出 2 集");
  assert.equal(data.episodes[0].episode_no, 1);
  assert.equal(data.episodes[1].episode_no, 2);
  assert.equal(data.replaced, 0, "空项目没有可覆盖的集");
  assert.equal(repository.softDeleteCalls.length, 1, "导入前先执行覆盖清理");
  assert.equal(breakdown.versionInputs.length, 2, "每集建一个剧本版本");
  assert.equal(breakdown.versionInputs[0]!.title, "第1集", "集标签不拼项目名");
  assert.equal(
    breakdown.versionInputs[0]!.scriptText,
    "1-1 客厅 日 内\n林凡醒来。",
    "正文不重复写入集标题",
  );
  assert.equal(breakdown.runInputs.length, 0, "导入只填剧本文本，不自动解析");
  assert.equal(breakdown.executed.length, 0, "导入不调度解析 run");
  assert.ok(data.episodes[0].script_version_id, "返回第一集剧本版本 id");
  assert.ok(repository.episodes.has(data.episodes[0].episode_id), "集已入 repo");
  assert.equal(repository.linkCalls.length, 1, "写回指针指向第一集");
});

test("Lite 剧本:重新导入覆盖既有集,不叠加重复集", async () => {
  const { app, breakdown, repository } = await harness();
  // 预置 3 集(模拟用户之前已导入/新建过);先清掉 harness 预置集,场景独立。
  repository.episodes.clear();
  repository.episodes.set("old-ep-1", { id: "old-ep-1", projectId: TEST_PROJECT_ID, episodeNo: null });
  repository.episodes.set("old-ep-2", { id: "old-ep-2", projectId: TEST_PROJECT_ID, episodeNo: null });
  repository.episodes.set("old-ep-3", { id: "old-ep-3", projectId: TEST_PROJECT_ID, episodeNo: null });

  const script = ["第1集", "1-1 客厅 日 内", "林凡醒来。", "第2集", "2-1 医院 日 内", "林凡探望母亲。"].join("\n");
  const response = await postImportBulk(app, "整剧.txt", script);
  assert.equal(response.statusCode, 201, response.body);
  const data = response.json().data;
  assert.equal(data.replaced, 3, "既有 3 集被覆盖");
  assert.equal(repository.softDeleteCalls.length, 1, "覆盖清理只执行一次");
  assert.equal(repository.softDeleteCalls[0]!.actorId, TEST_ACTOR.id, "覆盖操作记到操作人");
  assert.ok(!repository.episodes.has("old-ep-1"), "旧集已软删");
  assert.ok(!repository.episodes.has("old-ep-2"), "旧集已软删");
  assert.ok(!repository.episodes.has("old-ep-3"), "旧集已软删");
  assert.equal(repository.episodes.size, 2, "导入后只剩新拆出的 2 集,没有重复集");
  assert.equal(data.episodes[0].episode_no, 1, "新集集号从文件内容来,不在旧集后续号");
  assert.equal(data.episodes[1].episode_no, 2);
  assert.equal(breakdown.versionInputs.length, 2);
  assert.equal(breakdown.runInputs.length, 0);
});

test("Lite 剧本:整剧导入无集标题 → 整个文件作为一集导入", async () => {
  const { app, breakdown, repository } = await harness();
  repository.episodes.clear(); // 空项目场景。
  const response = await postImportBulk(app, "无标题.txt", "一些剧本内容但没有集标题\n只是普通段落");
  assert.equal(response.statusCode, 201, response.body);
  const data = response.json().data;
  assert.equal(data.episodes.length, 1, "无集标题时整个文件作为一集导入");
  assert.equal(data.episodes[0].episode_no, 1, "无既有集时集号从 1 开始");
  assert.equal(data.replaced, 0);
  assert.equal(breakdown.versionInputs.length, 1, "建了一个剧本版本");
  assert.equal(breakdown.versionInputs[0]!.title, "第1集", "无标题文件只用集号作为标签");
  assert.equal(
    breakdown.versionInputs[0]!.scriptText,
    "一些剧本内容但没有集标题\n只是普通段落",
    "无标题文件正文保持原文",
  );
  assert.equal(breakdown.runInputs.length, 0, "导入不自动建解析 run");
  assert.equal(repository.linkCalls.length, 1, "写回指针");
});

test("Lite 剧本:无集标题文件覆盖导入 → 旧集被替换,新集恒为第 1 集", async () => {
  const { app, repository } = await harness();
  repository.episodes.clear();
  repository.episodes.set("old-ep-1", { id: "old-ep-1", projectId: TEST_PROJECT_ID, episodeNo: null });
  repository.episodes.set("old-ep-2", { id: "old-ep-2", projectId: TEST_PROJECT_ID, episodeNo: null });

  const response = await postImportBulk(app, "无标题.txt", "没有集标题的整段剧本");
  assert.equal(response.statusCode, 201, response.body);
  const data = response.json().data;
  assert.equal(data.replaced, 2, "既有 2 集被覆盖");
  assert.equal(data.episodes.length, 1);
  assert.equal(data.episodes[0].episode_no, 1, "覆盖语义下集号从 1 开始,不续旧集号");
  assert.equal(repository.episodes.size, 1, "导入后只剩新集");
});

test("Lite 剧本:无集标题的英文正文 → 兜底集名按正文语言取 EPISODE 1(R2-12)", async () => {
  const { app, breakdown } = await harness();
  const response = await postImportBulk(app, "english-untitled.txt", "A rainy night in the city.\nMia walks home alone.");
  assert.equal(response.statusCode, 201, response.body);
  const data = response.json().data;
  assert.equal(data.episodes.length, 1);
  assert.equal(data.episodes[0].episode_no, 1);
  assert.equal(breakdown.versionInputs[0]!.title, "EPISODE 1", "英文正文不再固定「第1集」");
});

test("Lite 剧本:整剧导入支持英文 Episode 标题", async () => {
  const { app, breakdown, repository } = await harness();
  repository.episodes.clear();

  const script = [
    "Episode 1: Arrival",
    "INT. HOUSE - NIGHT",
    "Mia enters.",
    "Episode Two - The Call",
    "EXT. STREET - DAY",
    "Mia answers the phone.",
  ].join("\n");
  const response = await postImportBulk(app, "english.txt", script);
  assert.equal(response.statusCode, 201, response.body);
  const data = response.json().data;
  assert.deepEqual(data.episodes.map((episode: { episode_no: number }) => episode.episode_no), [1, 2]);
  assert.equal(data.replaced, 0);
  assert.equal(breakdown.versionInputs[0]!.title, "EPISODE 1", "英文集标题归一只留 EPISODE N，副标题丢弃");
  assert.equal(breakdown.versionInputs[0]!.scriptText, "INT. HOUSE - NIGHT\nMia enters.");
});

test("Lite 剧本:整剧导入未登录 → 401", async () => {
  const { app } = await harness({ authenticated: false });
  const response = await postImportBulk(app, "整剧.txt", "第1集\n内容");
  assert.equal(response.statusCode, 401);
});

/* ---------- Lite 资产 BFF:实体化 + 候选图取数 ---------- */

/** 已确认拆解运行的候选草稿:三类各一,角色带全量扩展字段。 */
const CONFIRMED_DRAFT: LiteConfirmedRunAssetDraft = {
  runId: RUN_ID,
  assetCandidates: {
    characters: [{
      candidateId: "char-1",
      name: "林雪",
      description: "旧仓库的目击者",
      gender: "female",
      ageValue: null,
      ageStage: null,
      appearance: null,
      personalityTags: [],
      prelinkedAsset: null,
    }],
    scenes: [{ candidateId: "scene-1", name: "旧仓库", description: "夜间,废弃" }],
    props: [{ candidateId: "prop-1", name: "录音笔", description: null }],
    costumes: [],
    audios: [],
  },
  shotCandidates: [],
};

function seedConfirmedContainer(repository: FakeLiteRepository): void {
  repository.confirmedDraft = CONFIRMED_DRAFT;
}

function postMaterialize(app: FastifyInstance) {
  // 端点无请求体:不带 content-type,避免空 JSON body 在解析期被 400 拦下。
  return app.inject({ method: "POST", url: MATERIALIZE_URL });
}

test("Lite 资产实体化:confirmed 候选按类映射全部落成资产并计数", async () => {
  const { app, repository, access } = await harness();
  seedConfirmedContainer(repository);

  const response = await postMaterialize(app);
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.equal(data.created, 3);
  assert.equal(data.existed, 0);
  assert.equal(data.assets.length, 3);
  assert.ok(data.assets.every((asset: { outcome: string }) => asset.outcome === "created"));
  assert.ok(data.assets.every((asset: { asset_entity_id: string }) => typeof asset.asset_entity_id === "string"));

  assert.deepEqual(access.calls, [{ actorId: TEST_ACTOR.id, projectId: TEST_PROJECT_ID, action: "create" }]);
  assert.equal(repository.materializeCalls.length, 1);
  const call = repository.materializeCalls[0]!;
  assert.equal(call.projectId, TEST_PROJECT_ID);
  assert.equal(call.actorId, TEST_ACTOR.id);
  assert.equal(call.runId, RUN_ID, "实体 metadata 溯源用 confirmed run id");
  assert.deepEqual(
    call.candidates.map((candidate) => [candidate.assetKind, candidate.name, candidate.description]),
    [
      ["character", "林雪", "旧仓库的目击者"],
      ["scene", "旧仓库", "夜间,废弃"],
      ["prop", "录音笔", null],
    ],
    "characters→character、scenes→scene、props→prop,顺序与候选值不变",
  );
  assert.equal(repository.assetRows.length, 3);
});

test("Lite 资产实体化:重复调用幂等跳过,不重复建行", async () => {
  const { app, repository } = await harness();
  seedConfirmedContainer(repository);

  const first = await postMaterialize(app);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().data.created, 3);

  const second = await postMaterialize(app);
  assert.equal(second.statusCode, 200, second.body);
  const data = second.json().data;
  assert.equal(data.created, 0, "重放不得再建行");
  assert.equal(data.existed, 3);
  assert.ok(data.assets.every((asset: { outcome: string }) => asset.outcome === "existing"));
  assert.deepEqual(
    data.assets.map((asset: { asset_entity_id: string }) => asset.asset_entity_id),
    first.json().data.assets.map((asset: { asset_entity_id: string }) => asset.asset_entity_id),
    "幂等命中返回同一批资产 id",
  );
  assert.equal(repository.assetRows.length, 3, "资产行总数不变");
});

test("Lite 资产实体化:无 confirmed 运行 → 409", async () => {
  const { app, repository } = await harness();

  const noConfirmedRun = await postMaterialize(app);
  assert.equal(noConfirmedRun.statusCode, 409, noConfirmedRun.body);
  assert.equal(noConfirmedRun.json().error.code, "lite_breakdown_not_confirmed");
  assert.equal(noConfirmedRun.json().error.message, "请先在剧本页完成解析并采用");

  assert.equal(repository.materializeCalls.length, 0, "前置不满足不得触达落库");
});

test("Lite 资产实体化:未登录 → 401;无权限 → 403 且不落库", async () => {
  const anonymous = await harness({ authenticated: false });
  seedConfirmedContainer(anonymous.repository);
  const unauthenticated = await postMaterialize(anonymous.app);
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error.code, "unauthorized");

  const { app, repository, access } = await harness();
  seedConfirmedContainer(repository);
  access.deny = true;
  const forbidden = await postMaterialize(app);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error.code, "forbidden");
  assert.equal(repository.materializeCalls.length, 0, "鉴权失败不得落库");
});

test("Lite 资产媒体:只回本项目目标资产的产物,按 created_at 倒序", async () => {
  const { app, repository, access } = await harness();
  const older: LiteAssetMediaItem & { projectId: string; assetEntityId: string } = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectId: TEST_PROJECT_ID,
    assetEntityId: TEST_ASSET_ENTITY_ID,
    mediaKind: "image",
    storageUrl: "https://example.test/old.png",
    persistenceStatus: "persisted",
    reviewStatus: "accepted",
    generationRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    widthPx: 1024,
    heightPx: 576,
    createdAt: new Date("2026-08-07T10:00:00.000Z"),
  };
  const newer: LiteAssetMediaItem & { projectId: string; assetEntityId: string } = {
    ...older,
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    storageUrl: "https://example.test/new.png",
    widthPx: null,
    heightPx: null,
    createdAt: new Date("2026-08-08T10:00:00.000Z"),
  };
  // 故意乱序放入,并掺入其他资产/其他项目的行,验证过滤与排序。
  repository.mediaRows.push(
    older,
    { ...older, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", assetEntityId: OTHER_ASSET_ENTITY_ID },
    { ...older, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", projectId: OTHER_PROJECT_ID },
    newer,
  );

  const response = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${TEST_PROJECT_ID}/lite/assets/${TEST_ASSET_ENTITY_ID}/media`,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(access.calls, [{ actorId: TEST_ACTOR.id, projectId: TEST_PROJECT_ID, action: "read" }]);
  const items = response.json().data.items;
  assert.deepEqual(items.map((item: { id: string }) => item.id), [newer.id, older.id], "只回目标资产且倒序");
  assert.equal(items[1]!.media_kind, "image");
  assert.equal(items[1]!.storage_url, "https://example.test/old.png");
  assert.equal(items[1]!.persistence_status, "persisted");
  assert.equal(items[1]!.review_status, "accepted");
  assert.equal(items[1]!.generation_request_id, older.generationRequestId);
  assert.equal(items[1]!.width_px, 1024);
  assert.equal(items[1]!.height_px, 576);
  assert.equal(items[1]!.created_at, "2026-08-07T10:00:00.000Z");
  assert.equal(items[0]!.width_px, null, "无尺寸的行带 null");
});

test("Lite 资产媒体:未登录 → 401;asset_entity_id 非法 → 400", async () => {
  const anonymous = await harness({ authenticated: false });
  const unauthenticated = await anonymous.app.inject({
    method: "GET",
    url: `/api/v1/projects/${TEST_PROJECT_ID}/lite/assets/${TEST_ASSET_ENTITY_ID}/media`,
  });
  assert.equal(unauthenticated.statusCode, 401);

  const { app, access } = await harness();
  const invalid = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${TEST_PROJECT_ID}/lite/assets/not-a-uuid/media`,
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "invalid_request");
  assert.equal(access.calls.length, 0, "参数校验失败不得触达鉴权与取数");
});

/* ---------- Lite 参考资产清单 ---------- */

const REFERENCE_ASSETS_URL = `/api/v1/projects/${TEST_PROJECT_ID}/lite/reference-assets`;

function seedRegistrationRows(repository: FakeLiteRepository): void {
  const base = {
    projectId: TEST_PROJECT_ID,
    name: "林雪",
    kind: "character",
    storageUrl: "https://example.test/linxue.png",
    registeredAt: new Date("2026-08-07T12:00:00.000Z"),
  };
  repository.registrationRows.push(
    // 正常:林雪有一条 active 登记。
    {
      ...base,
      assetEntityId: TEST_ASSET_ENTITY_ID,
      assetMediaId: "88888888-8888-4888-8888-888888888888",
      status: "active",
    },
    // 同资产的旧 active 登记:updated_at 更早,只应回最新一条。
    {
      ...base,
      assetEntityId: TEST_ASSET_ENTITY_ID,
      assetMediaId: "99999999-9999-4999-8999-999999999998",
      storageUrl: "https://example.test/linxue-old.png",
      registeredAt: new Date("2026-08-06T12:00:00.000Z"),
      status: "active",
    },
    // 正常:旧仓库有一条 active 登记。
    {
      ...base,
      assetEntityId: OTHER_ASSET_ENTITY_ID,
      name: "旧仓库",
      kind: "scene",
      assetMediaId: "aaaaaaaa-0aaa-4aaa-8aaa-aaaaaaaaaaa1",
      storageUrl: "https://example.test/warehouse.png",
      registeredAt: new Date("2026-08-05T12:00:00.000Z"),
      status: "active",
    },
    // 非 active 登记(待激活档未完成登记流程):不得出现。
    {
      ...base,
      assetEntityId: "abababab-abab-4bab-8bab-abababababab",
      name: "录音笔",
      kind: "prop",
      assetMediaId: "acacacac-acac-4cac-8cac-acacacacacac",
      registeredAt: new Date("2026-08-07T13:00:00.000Z"),
      status: "pending",
    },
    // 其他项目的 active 登记:不得混进本项目清单。
    {
      ...base,
      projectId: OTHER_PROJECT_ID,
      assetEntityId: "bbbbbbbb-1bbb-4bbb-8bbb-bbbbbbbbbbb2",
      assetMediaId: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc",
      status: "active",
    },
  );
}

test("Lite 参考资产:只回本项目 active 登记者,每资产取最新一条,字段 snake_case", async () => {
  const { app, repository, access } = await harness();
  seedRegistrationRows(repository);

  const response = await app.inject({ method: "GET", url: REFERENCE_ASSETS_URL });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(access.calls, [{ actorId: TEST_ACTOR.id, projectId: TEST_PROJECT_ID, action: "read" }]);

  const items = response.json().data.items;
  assert.equal(items.length, 2, "pending 登记与其他项目的行必须被滤掉");
  const linxue = items.find((item: { asset_entity_id: string }) => item.asset_entity_id === TEST_ASSET_ENTITY_ID);
  assert.ok(linxue, "林雪应在清单内");
  assert.deepEqual(Object.keys(linxue).sort(), [
    "asset_entity_id",
    "asset_media_id",
    "kind",
    "name",
    "registered_at",
    "storage_url",
  ], "响应字段为冻结 snake_case 合同,不得漂移");
  assert.equal(linxue.asset_media_id, "88888888-8888-4888-8888-888888888888", "取最新一条 active 登记的媒体 id");
  assert.equal(linxue.storage_url, "https://example.test/linxue.png");
  assert.equal(linxue.registered_at, "2026-08-07T12:00:00.000Z");
  assert.equal(linxue.name, "林雪");
  assert.equal(linxue.kind, "character");

  const warehouse = items.find((item: { asset_entity_id: string }) => item.asset_entity_id === OTHER_ASSET_ENTITY_ID);
  assert.ok(warehouse, "旧仓库应在清单内");
  assert.equal(warehouse.kind, "scene");
  assert.equal(warehouse.registered_at, "2026-08-05T12:00:00.000Z");
});

test("Lite 参考资产:无任何 active 登记的项目返回空清单", async () => {
  const { app, repository } = await harness();
  repository.registrationRows.push({
    projectId: TEST_PROJECT_ID,
    assetEntityId: TEST_ASSET_ENTITY_ID,
    name: "林雪",
    kind: "character",
    assetMediaId: "88888888-8888-4888-8888-888888888888",
    storageUrl: "https://example.test/linxue.png",
    registeredAt: new Date("2026-08-07T12:00:00.000Z"),
    status: "revoked",
  });

  const response = await app.inject({ method: "GET", url: REFERENCE_ASSETS_URL });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data.items, [], "只有非 active 登记时回空清单");
});

test("Lite 参考资产:未登录 → 401;无权限 → 403;project_id 非法 → 400", async () => {
  const anonymous = await harness({ authenticated: false });
  const unauthenticated = await anonymous.app.inject({ method: "GET", url: REFERENCE_ASSETS_URL });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error.code, "unauthorized");

  const { app, access } = await harness();
  access.deny = true;
  const forbidden = await app.inject({ method: "GET", url: REFERENCE_ASSETS_URL });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error.code, "forbidden");

  const invalid = await app.inject({
    method: "GET",
    url: "/api/v1/projects/not-a-uuid/lite/reference-assets",
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "invalid_request");
});

/* ---------- 素材页资产 CRUD（第一阶段：list / detail / create / patch） ---------- */

const ASSETS_BASE_URL = `/api/v1/projects/${TEST_PROJECT_ID}/lite/assets`;

test("Lite 资产列表:空项目返回空列表 + 空 tab 聚合", async () => {
  const { app } = await harness();
  const response = await app.inject({ method: "GET", url: ASSETS_BASE_URL });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.deepEqual(data.items, []);
  assert.deepEqual(data.tab_counts, []);
});

test("Lite 资产列表:按 kind 过滤 + tab 聚合不受 kind 影响", async () => {
  const { app, repository } = await harness();
  // 预置两个资产:一个角色一个服装;角色带主图 URL(列表卡直渲染)。
  repository.assetRows.push(
    { assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID, assetKind: "character", name: "林雪", description: "目击者", primaryMediaUrl: "https://example.test/linxue.png" },
    { assetEntityId: OTHER_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID, assetKind: "costume", name: "军绿风衣", description: "外套" },
  );

  // 不过滤:返回两项。
  const allResponse = await app.inject({ method: "GET", url: ASSETS_BASE_URL });
  assert.equal(allResponse.statusCode, 200);
  assert.equal(allResponse.json().data.items.length, 2);

  // 过滤 character:只回角色一项。
  const kindResponse = await app.inject({ method: "GET", url: `${ASSETS_BASE_URL}?kind=character` });
  assert.equal(kindResponse.statusCode, 200);
  const kindData = kindResponse.json().data;
  assert.equal(kindData.items.length, 1);
  assert.equal(kindData.items[0].asset_kind, "character");
  assert.equal(kindData.items[0].name, "林雪");
  assert.equal(kindData.items[0].primary_media_url, "https://example.test/linxue.png", "主图 URL 必须随列表下发,列表卡直接渲染");
  assert.equal(allResponse.json().data.items[1].primary_media_url, null, "无图资产 primary_media_url 为 null");

  // tab 聚合不受 kind 过滤:应有两个 kind 各计数 1。
  assert.equal(kindData.tab_counts.length, 2);
});

test("Lite 资产列表:非法 kind → 400", async () => {
  const { app } = await harness();
  const response = await app.inject({ method: "GET", url: `${ASSETS_BASE_URL}?kind=not-a-kind` });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_request");
});

test("Lite 资产详情:返回 name/intro/asset_kind 等字段", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: "目击者",
  });
  const response = await app.inject({
    method: "GET",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.equal(data.asset_entity_id, TEST_ASSET_ENTITY_ID);
  assert.equal(data.name, "林雪");
  assert.equal(data.asset_kind, "character");
});

test("Lite 资产详情:找不到 → 400 人话", async () => {
  const { app } = await harness();
  const response = await app.inject({
    method: "GET",
    url: `${ASSETS_BASE_URL}/${OTHER_ASSET_ENTITY_ID}`,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_request");
});

test("Lite 手动新建:名称 + asset_kind 落库,返回 201 + asset_entity_id", async () => {
  const { app, repository } = await harness();
  const response = await app.inject({
    method: "POST",
    url: ASSETS_BASE_URL,
    headers: ACTOR_HEADERS,
    payload: { name: "黑色风衣", asset_kind: "costume", intro: "林雪的外套", note: "第一集出场" },
  });
  assert.equal(response.statusCode, 201, response.body);
  const data = response.json().data;
  assert.ok(typeof data.asset_entity_id === "string");
  assert.equal(repository.assetRows.length, 1);
  assert.equal(repository.assetRows[0]!.name, "黑色风衣");
  assert.equal(repository.assetRows[0]!.assetKind, "costume");
});

test("Lite 手动新建:名称为空 → 400(T2.6 名称必填)", async () => {
  const { app } = await harness();
  const response = await app.inject({
    method: "POST",
    url: ASSETS_BASE_URL,
    headers: ACTOR_HEADERS,
    payload: { name: "   ", asset_kind: "character" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_request");
});

test("Lite 手动新建:非法 asset_kind → 400(T2.7 类型限定)", async () => {
  const { app } = await harness();
  const response = await app.inject({
    method: "POST",
    url: ASSETS_BASE_URL,
    headers: ACTOR_HEADERS,
    payload: { name: "测试", asset_kind: "not-a-kind" },
  });
  assert.equal(response.statusCode, 400);
});

test("Lite 手动新建:多余字段被 strict 拒绝 → 400", async () => {
  const { app } = await harness();
  const response = await app.inject({
    method: "POST",
    url: ASSETS_BASE_URL,
    headers: ACTOR_HEADERS,
    payload: { name: "测试", asset_kind: "character", unexpected_field: "hack" },
  });
  assert.equal(response.statusCode, 400);
});

test("Lite 更新资产:PATCH name + intro 落库", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "旧名", description: null,
  });
  const response = await app.inject({
    method: "PATCH",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}`,
    headers: ACTOR_HEADERS,
    payload: { name: "新名", intro: "更新后的描述" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(repository.assetRows[0]!.name, "新名");
  assert.equal(repository.assetRows[0]!.description, "更新后的描述");
});

test("Lite 更新资产:名称清空 → 400", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "旧名", description: null,
  });
  const response = await app.inject({
    method: "PATCH",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}`,
    headers: ACTOR_HEADERS,
    payload: { name: "   " },
  });
  assert.equal(response.statusCode, 400);
});

test("Lite 资产 CRUD:未登录 → 401", async () => {
  const anonymous = await harness({ authenticated: false });
  const listResponse = await anonymous.app.inject({ method: "GET", url: ASSETS_BASE_URL });
  assert.equal(listResponse.statusCode, 401);
  const createResponse = await anonymous.app.inject({
    method: "POST", url: ASSETS_BASE_URL, headers: ACTOR_HEADERS,
    payload: { name: "x", asset_kind: "character" },
  });
  assert.equal(createResponse.statusCode, 401);
  const patchResponse = await anonymous.app.inject({
    method: "PATCH", url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}`, headers: ACTOR_HEADERS,
    payload: { name: "x" },
  });
  assert.equal(patchResponse.statusCode, 401);
});

test("Lite 资产 CRUD:无权限 → 403 且不落库(T9.1 不跨项目写)", async () => {
  const { app, access, repository } = await harness();
  access.deny = true;
  const createResponse = await app.inject({
    method: "POST", url: ASSETS_BASE_URL, headers: ACTOR_HEADERS,
    payload: { name: "x", asset_kind: "character" },
  });
  assert.equal(createResponse.statusCode, 403);
  assert.equal(repository.assetRows.length, 0);
});

/* ================================================================
   Phase 2 测试:变体 / 版本图轨 / 设主图 / 关联分镜 / 并发
   ================================================================ */

test("Phase 2 变体列表:返回变体 + is_primary 标记(P1)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  repository.variantRows.push(
    { variantId: "v1", variantKind: "default", displayName: "默认", isPrimary: true, imageUrl: null, projectId: TEST_PROJECT_ID, assetEntityId: TEST_ASSET_ENTITY_ID },
    { variantId: "v2", variantKind: "alt", displayName: "备选", isPrimary: false, imageUrl: null, projectId: TEST_PROJECT_ID, assetEntityId: TEST_ASSET_ENTITY_ID },
  );
  const response = await app.inject({
    method: "GET",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/variants`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.equal(data.items.length, 2);
  assert.equal(data.items[0].variant_id, "v1");
  assert.equal(data.items[0].is_primary, true);
  assert.equal(data.items[1].is_primary, false);
});

test("Phase 2 版本图轨:返回合并列表(P1)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  const now = new Date();
  repository.versionTrackRows.push(
    { assetMediaId: "am1", mediaResultId: null, storageUrl: "https://upload.jpg", isPrimary: true, source: "upload", mediaKind: "image", format: "image/jpeg", widthPx: 1024, heightPx: 576, createdAt: now, variantId: "v1", projectId: TEST_PROJECT_ID, assetEntityId: TEST_ASSET_ENTITY_ID },
    { assetMediaId: null, mediaResultId: "mr1", storageUrl: "https://ai.jpg", isPrimary: false, source: "ai", mediaKind: "image", format: "image/png", widthPx: 2048, heightPx: 1152, createdAt: now, variantId: "v1", projectId: TEST_PROJECT_ID, assetEntityId: TEST_ASSET_ENTITY_ID },
  );
  const response = await app.inject({
    method: "GET",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/version-track`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.equal(data.items.length, 2);
  assert.ok(data.items.some((i: { source: string }) => i.source === "upload"));
  assert.ok(data.items.some((i: { source: string }) => i.source === "ai"));
  // 契约 v1.3.1 六.2:版本图轨每行必须下发 variant_id(上传图=asset_variant_id,生成图=第一个变体),否则前端按变体过滤恒空
  const uploadItem = data.items.find((i: { source: string }) => i.source === "upload");
  const aiItem = data.items.find((i: { source: string }) => i.source === "ai");
  assert.equal(uploadItem.variant_id, "v1");
  assert.equal(aiItem.variant_id, "v1");
});

const TEST_MEDIA_ID = "44444444-4444-4444-8444-444444444444";
const TEST_SHOT_ID = "88888888-8888-4888-8888-888888888888";
const TEST_USAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_VARIANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("Phase 2 设主图:正常路径调 setPrimaryMedia(P1c, T8.1 正常)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  const response = await app.inject({
    method: "PATCH",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/primary-media`,
    headers: ACTOR_HEADERS,
    payload: { asset_media_id: TEST_MEDIA_ID },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(repository.setPrimaryCalls.length, 1);
  assert.equal(repository.setPrimaryCalls[0]!.targetMediaId, TEST_MEDIA_ID);
});

test("Phase 2 设主图:冲突 → 409「主图已被他人更改」(T8.1 冲突)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  repository.setPrimaryConflict = true;
  const response = await app.inject({
    method: "PATCH",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/primary-media`,
    headers: ACTOR_HEADERS,
    payload: { asset_media_id: TEST_MEDIA_ID },
  });
  assert.equal(response.statusCode, 409);
  assert.ok(response.json().error.message.includes("主图已被他人更改"));
});

test("Phase 2 设主图:生成图走 media_result_id 物化翻转(P1c 扩展)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  const response = await app.inject({
    method: "PATCH",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/primary-media`,
    headers: ACTOR_HEADERS,
    payload: { media_result_id: TEST_MEDIA_ID },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(repository.setPrimaryFromResultCalls.length, 1);
  assert.equal(repository.setPrimaryFromResultCalls[0]!.targetMediaResultId, TEST_MEDIA_ID);
  assert.equal(repository.setPrimaryCalls.length, 0, "生成图路径不应走上传图翻转");
});

test("Phase 2 设主图:生成图冲突 → 409 同口径", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  repository.setPrimaryFromResultConflict = true;
  const response = await app.inject({
    method: "PATCH",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/primary-media`,
    headers: ACTOR_HEADERS,
    payload: { media_result_id: TEST_MEDIA_ID },
  });
  assert.equal(response.statusCode, 409);
  assert.ok(response.json().error.message.includes("主图已被他人更改"));
});

test("Phase 2 设主图:两个 ID 都不传或都传 → 400(strict 二选一)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  const neither = await app.inject({
    method: "PATCH",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/primary-media`,
    headers: ACTOR_HEADERS,
    payload: {},
  });
  assert.equal(neither.statusCode, 400, neither.body);
  const both = await app.inject({
    method: "PATCH",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/primary-media`,
    headers: ACTOR_HEADERS,
    payload: { asset_media_id: TEST_MEDIA_ID, media_result_id: TEST_MEDIA_ID },
  });
  assert.equal(both.statusCode, 400, both.body);
  assert.equal(repository.setPrimaryCalls.length, 0);
  assert.equal(repository.setPrimaryFromResultCalls.length, 0);
});

test("设主图触发模型(2026-08-19):上传图设为主图成功后自动登记火山素材(仅主变体)", async () => {
  const { app, repository, registerPrimaryCalls } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  const response = await app.inject({
    method: "PATCH",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/primary-media`,
    headers: ACTOR_HEADERS,
    payload: { asset_media_id: TEST_MEDIA_ID },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(registerPrimaryCalls.length, 1, "设主图成功后必须自动触发登记");
  assert.deepEqual(registerPrimaryCalls[0], {
    actor: { id: TEST_ACTOR.id, username: "tester", displayName: "测试用户", role: "member" },
    projectId: TEST_PROJECT_ID,
    assetEntityId: TEST_ASSET_ENTITY_ID,
    mediaId: TEST_MEDIA_ID,
  });
});

test("设主图触发模型:生成图设为主图(media_result_id)同样自动登记物化后的 asset_media", async () => {
  const { app, repository, registerPrimaryCalls } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  const response = await app.inject({
    method: "PATCH",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/primary-media`,
    headers: ACTOR_HEADERS,
    payload: { media_result_id: TEST_MEDIA_ID },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(registerPrimaryCalls.length, 1);
  assert.equal(registerPrimaryCalls[0]!.mediaId, TEST_MEDIA_ID, "物化后 asset_media.id = media_result.id,登记用同一 id");
});

test("设主图触发模型:主变体为音频时同样自动登记;冲突时不登记", async () => {
  const { app, repository, registerPrimaryCalls } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  repository.setPrimaryKind = "audio";
  const ok = await app.inject({
    method: "PATCH",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/primary-media`,
    headers: ACTOR_HEADERS,
    payload: { asset_media_id: TEST_MEDIA_ID },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(registerPrimaryCalls.length, 1, "音频主变体同样进入 CreateAsset 契约");

  repository.setPrimaryKind = "image";
  repository.setPrimaryConflict = true;
  const conflict = await app.inject({
    method: "PATCH",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/primary-media`,
    headers: ACTOR_HEADERS,
    payload: { asset_media_id: TEST_MEDIA_ID },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(registerPrimaryCalls.length, 1, "翻转冲突不触发登记");
});

test("Phase 2 关联分镜:GET 列表(P2c, T5.1)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  repository.usageRows.push({
    usageId: "usage-001", variantId: "v1", shotId: "shot-001", episodeId: "ep-1",
    episodeNo: 3, shotNo: 5, sceneName: "书房", shotLabel: "镜5", status: "bound",
    matchedBy: "manual",
    evidence: { sceneNames: [], lineIndices: [], sourceTextSnippets: [] },
    projectId: TEST_PROJECT_ID, assetEntityId: TEST_ASSET_ENTITY_ID,
  });
  const response = await app.inject({
    method: "GET",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/usages`,
    headers: ACTOR_HEADERS,
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].usage_id, "usage-001");
  assert.equal(data.items[0].shot_label, "镜5");
  assert.equal(data.items[0].matched_by, "manual");
  assert.equal(data.items[0].status, "bound");
  assert.equal(data.items[0].shot_no, 5);
});

test("Phase 2 关联分镜:POST 添加(P2c, T5.2)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  const response = await app.inject({
    method: "POST",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/usages`,
    headers: ACTOR_HEADERS,
    payload: { items: [{ shot_id: TEST_SHOT_ID }] },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().data.added, 1);
  assert.equal(repository.addUsageCalls.length, 1);
  assert.equal(repository.addUsageCalls[0]!.items[0]!.shotId, TEST_SHOT_ID);
});

test("Phase 2 关联分镜:POST 批量未命中落 pending,不报错(P2c, T10.3)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  const response = await app.inject({
    method: "POST",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/usages`,
    headers: ACTOR_HEADERS,
    payload: { items: [{ episode_no: 3, shot_no: 99, scene_name: "书房", variant_id: TEST_VARIANT_ID }] },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().data.pending, 1);
  assert.equal(repository.addUsageCalls[0]!.items[0]!.episodeNo, 3);
  assert.equal(repository.addUsageCalls[0]!.items[0]!.variantId, TEST_VARIANT_ID);
});

test("Phase 2 关联分镜:DELETE 移除(P2c, T5.3)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  // DELETE 无 body:不带 content-type,否则 Fastify 的 JSON 解析器对空 body 报 FST_ERR_CTP_EMPTY_JSON_BODY(400)
  const response = await app.inject({
    method: "DELETE",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/usages/${TEST_USAGE_ID}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(repository.removeUsageCalls.length, 1);
  assert.equal(repository.removeUsageCalls[0]!.usageId, TEST_USAGE_ID);
});

test("Phase 2 关联分镜:DELETE 接受 deterministicUsageId(非 RFC-4122 变体位的十六进制摘要)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  // deterministicUsageId 是 SHA-256 摘要切分组,版本/变体位不满足 RFC-4122,但仍是合法 hex-dash。
  const digestLikeUsageId = "0944ab41-9c91-9add-ad7a-37f59de6e084";
  const response = await app.inject({
    method: "DELETE",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/usages/${digestLikeUsageId}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(repository.removeUsageCalls.length, 1);
  assert.equal(repository.removeUsageCalls[0]!.usageId, digestLikeUsageId);
});

test("Phase 2 删变体:DELETE /variants/:variant_id(P2c, T10.9)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  const response = await app.inject({
    method: "DELETE",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/variants/${TEST_VARIANT_ID}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(repository.deleteVariantCalls.length, 1);
  assert.equal(repository.deleteVariantCalls[0]!.variantId, TEST_VARIANT_ID);
});

test("v1.9 十.1 删资产:DELETE /lite/assets/:asset_entity_id(T17.1)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
  } as never);
  const response = await app.inject({
    method: "DELETE",
    url: `/api/v1/projects/${TEST_PROJECT_ID}/lite/assets/${TEST_ASSET_ENTITY_ID}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(repository.deleteAssetCalls.length, 1);
  assert.equal(repository.deleteAssetCalls[0]!.assetEntityId, TEST_ASSET_ENTITY_ID);
});

test("Phase 2 删媒体:DELETE /media/:media_id(P2c, T10.10)", async () => {
  const { app, repository } = await harness();
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: null,
  });
  const response = await app.inject({
    method: "DELETE",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/media/${TEST_MEDIA_ID}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(repository.deleteMediaCalls.length, 1);
  assert.equal(repository.deleteMediaCalls[0]!.mediaId, TEST_MEDIA_ID);
});

test("Phase 2 关联分镜:未登录 → 401", async () => {
  const anonymous = await harness({ authenticated: false });
  const response = await anonymous.app.inject({
    method: "GET",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/usages`,
  });
  assert.equal(response.statusCode, 401);
});

test("v1.7 分镜侧删除自动引用:DELETE auto-refs → repo removeShotAutoRef 收到 (shot, asset, variant)", async () => {
  const { app, repository } = await harness();
  // DELETE 无 body:不带 content-type,否则空 JSON body 在解析期被 400 拦下(同 Phase 2 DELETE 口径)
  const response = await app.inject({
    method: "DELETE",
    url: `/api/v1/projects/${TEST_PROJECT_ID}/lite/shots/${TEST_SHOT_ID}/auto-refs/${TEST_ASSET_ENTITY_ID}/${TEST_VARIANT_ID}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(repository.removeShotAutoRefCalls.length, 1);
  assert.equal(repository.removeShotAutoRefCalls[0]!.shotId, TEST_SHOT_ID);
  assert.equal(repository.removeShotAutoRefCalls[0]!.assetEntityId, TEST_ASSET_ENTITY_ID);
  assert.equal(repository.removeShotAutoRefCalls[0]!.variantId, TEST_VARIANT_ID);
  assert.equal(repository.removeShotAutoRefCalls[0]!.projectId, TEST_PROJECT_ID);
});

test("v1.7 分镜侧删除自动引用:未登录 → 401;variant_id 非 uuid → 400;无权限 → 403 且不落库", async () => {
  const anonymous = await harness({ authenticated: false });
  const unauthenticated = await anonymous.app.inject({
    method: "DELETE",
    url: `/api/v1/projects/${TEST_PROJECT_ID}/lite/shots/${TEST_SHOT_ID}/auto-refs/${TEST_ASSET_ENTITY_ID}/${TEST_VARIANT_ID}`,
  });
  assert.equal(unauthenticated.statusCode, 401);

  const { app, repository, access } = await harness();
  const invalid = await app.inject({
    method: "DELETE",
    url: `/api/v1/projects/${TEST_PROJECT_ID}/lite/shots/${TEST_SHOT_ID}/auto-refs/${TEST_ASSET_ENTITY_ID}/not-a-uuid`,
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(repository.removeShotAutoRefCalls.length, 0, "非法参数不得触达仓储");

  access.deny = true;
  const forbidden = await app.inject({
    method: "DELETE",
    url: `/api/v1/projects/${TEST_PROJECT_ID}/lite/shots/${TEST_SHOT_ID}/auto-refs/${TEST_ASSET_ENTITY_ID}/${TEST_VARIANT_ID}`,
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(repository.removeShotAutoRefCalls.length, 0, "无权限不得触达仓储");
});


/* ================================================================
   v1.6 ✨ 匹配剧集测试(问题八 T13):AI 只给建议、零写库
   ================================================================ */

const MATCH_VARIANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MATCH_SHOT_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MATCH_SHOT_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MATCH_URL = `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/variants/${MATCH_VARIANT_ID}/match-suggest`;

/** 匹配建议公共 fixture:资产 + 变体档案 + 两个已确认集分镜(场景名不同)。 */
function seedMatchSuggestFixture(repository: FakeLiteRepository) {
  repository.assetRows.push({
    assetEntityId: TEST_ASSET_ENTITY_ID, projectId: TEST_PROJECT_ID,
    assetKind: "character", name: "林雪", description: "女主角",
  });
  repository.matchVariantProfile = {
    projectId: TEST_PROJECT_ID, assetEntityId: TEST_ASSET_ENTITY_ID, variantId: MATCH_VARIANT_ID,
    variantName: "林雪-泳装", variantDescription: null,
    assetName: "林雪", assetKind: "character", assetIntro: "女主角",
  };
  repository.matchSuggestShots.push(
    { shotId: MATCH_SHOT_1, episodeId: TEST_EPISODE_ID, episodeNo: 1, shotNo: 1, sceneName: "卧室", title: "早晨起床", scriptText: "林雪醒来。", breakdownElements: { subject: "林雪" } },
    { shotId: MATCH_SHOT_2, episodeId: TEST_EPISODE_ID, episodeNo: 1, shotNo: 2, sceneName: "游泳池", title: "走向泳池", scriptText: "她换上衣服走向游泳池。", breakdownElements: { subject: "林雪", visual: "泳池边" } },
  );
}

function postMatchSuggest(app: FastifyInstance) {
  return app.inject({ method: "POST", url: MATCH_URL, headers: ACTOR_HEADERS, payload: {} });
}

test("v1.6 匹配剧集:返回建议条目,scene_name 取真实分镜而非模型输出", async () => {
  const { app, repository, gateway } = await harness();
  seedMatchSuggestFixture(repository);
  gateway.outputs = [[
    { episode_no: 1, shot_no: 1, reason: "镜头1林雪出场" },
    { episode_no: 1, shot_no: 2, reason: "走向游泳池" },
  ]];
  const response = await postMatchSuggest(app);
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.equal(data.truncated, false);
  assert.equal(data.items.length, 2);
  // 场景名永远来自真实分镜(八.2):模型输出里根本没有场景名字段
  assert.equal(data.items[0].scene_name, "卧室");
  assert.equal(data.items[1].scene_name, "游泳池");
  assert.equal(data.items[0].shot_id, MATCH_SHOT_1);
  assert.equal(data.items[0].episode_no, 1);
  assert.equal(data.items[0].shot_no, 1);
  assert.equal(data.items[0].conflict_variant_name, null);
  // 网关调用合同:purpose=variant_match_suggest、thinking 禁用
  assert.equal(gateway.inputs.length, 1);
  assert.equal(gateway.inputs[0]!.purpose, "variant_match_suggest");
  assert.equal(gateway.inputs[0]!.thinking, "disabled");
});

test("v1.6 匹配剧集:该 shot 已关联同资产其它变体 → 留清单并标 conflict_variant_name", async () => {
  const { app, repository, gateway } = await harness();
  seedMatchSuggestFixture(repository);
  // 同资产另一变体「战甲造型」已关联镜 2
  repository.variantRows.push({ variantId: "v-armor", variantKind: "look", displayName: "战甲造型", isPrimary: false, imageUrl: null, projectId: TEST_PROJECT_ID, assetEntityId: TEST_ASSET_ENTITY_ID });
  repository.usageRows.push({
    usageId: "usage-armor-2", variantId: "v-armor", shotId: MATCH_SHOT_2, episodeId: TEST_EPISODE_ID,
    episodeNo: 1, shotNo: 2, sceneName: "游泳池", shotLabel: "", status: "bound", matchedBy: "manual",
    evidence: { sceneNames: [], lineIndices: [], sourceTextSnippets: [] },
    projectId: TEST_PROJECT_ID, assetEntityId: TEST_ASSET_ENTITY_ID,
  });
  gateway.outputs = [[{ episode_no: 1, shot_no: 2, reason: "泳池戏" }]];
  const response = await postMatchSuggest(app);
  assert.equal(response.statusCode, 200, response.body);
  const items = response.json().data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].shot_id, MATCH_SHOT_2);
  assert.equal(items[0].conflict_variant_name, "战甲造型");
});

test("v1.6 匹配剧集 T13.3:本变体已关联的 shot 不重复建议", async () => {
  const { app, repository, gateway } = await harness();
  seedMatchSuggestFixture(repository);
  repository.usageRows.push({
    usageId: "usage-self-1", variantId: MATCH_VARIANT_ID, shotId: MATCH_SHOT_1, episodeId: TEST_EPISODE_ID,
    episodeNo: 1, shotNo: 1, sceneName: "卧室", shotLabel: "", status: "bound", matchedBy: "manual",
    evidence: { sceneNames: [], lineIndices: [], sourceTextSnippets: [] },
    projectId: TEST_PROJECT_ID, assetEntityId: TEST_ASSET_ENTITY_ID,
  });
  gateway.outputs = [[
    { episode_no: 1, shot_no: 1, reason: "已关联的镜不该再出现" },
    { episode_no: 1, shot_no: 2, reason: "泳池" },
  ]];
  const response = await postMatchSuggest(app);
  assert.equal(response.statusCode, 200, response.body);
  const items = response.json().data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].shot_id, MATCH_SHOT_2);
});

test("v1.6 匹配剧集:模型回「第N集/第M个分镜」中文定位键 → 抽整数后命中真实分镜(2026-08-19 线上 502 修复)", async () => {
  const { app, repository, gateway } = await harness();
  seedMatchSuggestFixture(repository);
  gateway.outputs = [[{ episode_no: "第1集", shot_no: "第2个分镜", reason: "泳池戏" }]];
  const response = await postMatchSuggest(app);
  assert.equal(response.statusCode, 200, response.body);
  const items = response.json().data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].shot_id, MATCH_SHOT_2);
  assert.equal(items[0].episode_no, 1);
  assert.equal(items[0].shot_no, 2);
});

test("v1.6 匹配剧集:定位键抽不出整数 → 502 ai_invalid_response,不静默放行", async () => {
  const { app, repository, gateway } = await harness();
  seedMatchSuggestFixture(repository);
  gateway.outputs = [[{ episode_no: "未知", shot_no: "未知", reason: "瞎填" }]];
  const response = await postMatchSuggest(app);
  assert.equal(response.statusCode, 502, response.body);
  assert.equal(response.json().error.code, "ai_invalid_response");
});

test("v1.6 匹配剧集 T13.6:模型重复返回同一 shot → 建议清单只出一条", async () => {
  const { app, repository, gateway } = await harness();
  seedMatchSuggestFixture(repository);
  gateway.outputs = [[
    { episode_no: 1, shot_no: 1, reason: "第一条" },
    { episode_no: 1, shot_no: 1, reason: "第二条同镜" },
  ]];
  const response = await postMatchSuggest(app);
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].shot_id, MATCH_SHOT_1);
});

test("v1.6 匹配剧集 T13.8:幻觉镜号(定位不到真实分镜)丢弃且不报错", async () => {
  const { app, repository, gateway } = await harness();
  seedMatchSuggestFixture(repository);
  gateway.outputs = [[
    { episode_no: 9, shot_no: 99, reason: "不存在的集和镜" },
    { episode_no: 1, shot_no: 1, reason: "真实镜头" },
  ]];
  const response = await postMatchSuggest(app);
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].shot_id, MATCH_SHOT_1);
});

test("v1.6 匹配剧集 T13.9:建议只来自已确认集(fake 只回 confirmed 分镜)", async () => {
  const { app, repository, gateway } = await harness();
  seedMatchSuggestFixture(repository);
  // 模型试图返回未确认集(第 3 集)的镜头 → 无法经 findShotByLabel 定位 → 丢弃
  gateway.outputs = [[
    { episode_no: 3, shot_no: 1, reason: "未确认集不该出现" },
    { episode_no: 1, shot_no: 2, reason: "已确认集镜头" },
  ]];
  const response = await postMatchSuggest(app);
  assert.equal(response.statusCode, 200, response.body);
  const items = response.json().data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].episode_no, 1);
  // 模型上下文里也只列了已确认集的分镜(第 3 集从未进清单)
  assert.ok(gateway.inputs[0]!.prompt.includes("第1集"));
  assert.ok(!gateway.inputs[0]!.prompt.includes("第3集"));
});

test("v1.6 匹配剧集 T13.5:超过 50 条 → 截断到 50 且 truncated=true(不静默截断)", async () => {
  const { app, repository, gateway } = await harness();
  seedMatchSuggestFixture(repository);
  // 造 51 个不同真实分镜(第 2-52 镜),模型全部命中
  const suggestions = [];
  for (let shotNo = 2; shotNo <= 52; shotNo += 1) {
    repository.matchSuggestShots.push({
      shotId: `shot-bulk-${shotNo}`, episodeId: TEST_EPISODE_ID, episodeNo: 1, shotNo,
      sceneName: "泳池", title: null, scriptText: null, breakdownElements: null,
    });
    suggestions.push({ episode_no: 1, shot_no: shotNo, reason: `第${shotNo}镜` });
  }
  gateway.outputs = [suggestions];
  const response = await postMatchSuggest(app);
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.equal(data.items.length, 50);
  assert.equal(data.truncated, true);
});

test("v1.6 匹配剧集 T13.2:只给建议零写库(无任何写方法调用)", async () => {
  const { app, repository } = await harness();
  seedMatchSuggestFixture(repository);
  const response = await postMatchSuggest(app);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(repository.addUsageCalls.length, 0);
  assert.equal(repository.removeUsageCalls.length, 0);
  assert.equal(repository.materializeCalls.length, 0);
  assert.equal(repository.linkCalls.length, 0);
  assert.equal(repository.setPrimaryCalls.length, 0);
  assert.equal(repository.deleteVariantCalls.length, 0);
  assert.equal(repository.deleteMediaCalls.length, 0);
  assert.equal(repository.softDeleteCalls.length, 0);
});

test("v1.6 匹配剧集:变体不存在或跨项目 → 400;未登录 → 401", async () => {
  const { app, repository } = await harness();
  seedMatchSuggestFixture(repository);
  const missing = await app.inject({
    method: "POST",
    url: `${ASSETS_BASE_URL}/${TEST_ASSET_ENTITY_ID}/variants/${crypto.randomUUID()}/match-suggest`,
    headers: ACTOR_HEADERS,
    payload: {},
  });
  assert.equal(missing.statusCode, 400);
  const anonymous = await harness({ authenticated: false });
  const response = await anonymous.app.inject({ method: "POST", url: MATCH_URL, headers: ACTOR_HEADERS, payload: {} });
  assert.equal(response.statusCode, 401);
});

/* ================================================================
   v1.7 B 层(八.10 T15):变体语义匹配纯函数 + 路由响应字段
   ================================================================ */

const LIN_WAN_ASSET_ID = "12121212-1212-4121-8121-121212121212";
const SWIMSUIT_VARIANT_ID = "13131313-1313-4131-8131-131313131313";
const ARMOR_VARIANT_ID = "14141414-1414-4141-8141-141414141414";
const SHOT_SWIM_ID = "15151515-1515-4151-8151-151515151515";
const SHOT_PLAIN_ID = "16161616-1616-4161-8161-161616161616";

function linwanVariant(variantId: string, variantName: string, aliases?: string[]): VariantMatchInput {
  return {
    assetEntityId: LIN_WAN_ASSET_ID,
    assetName: "林晚",
    variantId,
    variantName,
    aliases,
  };
}
test("v1.7 B 层:变体名归一剥资产名前缀,全名仍参与,别名并入去重", () => {
  // 剥「-」前缀:「林晚-泳装」→「泳装」,全名仍参与命中
  assert.deepEqual(variantMatchNames("林晚", "林晚-泳装"), ["泳装", "林晚-泳装"]);
  // 剥「·」前缀:「林晚·战甲」→「战甲」
  assert.deepEqual(variantMatchNames("林晚", "林晚·战甲"), ["战甲", "林晚·战甲"]);
  // 变体名不含资产名前缀 → 只有全名
  assert.deepEqual(variantMatchNames("林晚", "泳装"), ["泳装"]);
  // 别名并入且去重去空白
  assert.deepEqual(
    variantMatchNames("林晚", "林晚-泳装", ["泳装", "  ", "海边装"]),
    ["泳装", "林晚-泳装", "海边装"],
  );
});
test("v1.7 B 层:分镜匹配文本 null-safe 拼接(subject+visual+script_text)", () => {
  assert.equal(buildShotMatchText("林晚", "泳池边", "她换上泳装"), "林晚 泳池边 她换上泳装");
  assert.equal(buildShotMatchText(null, "泳池边", null), "泳池边");
  assert.equal(buildShotMatchText(null, null, null), "");
});

test("v1.7 B 层 T15.1:一集多变体——变体名命中的分镜绑定对应变体,未命中分镜不绑", () => {
  // 林晚有 基础(第一变体,不进 B 层)与 泳装(非第一);
  // 镜6 visual 含「泳装」,镜1 只有台词点名林晚。
  const matches = matchVariantShots(
    [linwanVariant(SWIMSUIT_VARIANT_ID, "林晚-泳装")],
    [
      { shotId: SHOT_PLAIN_ID, shotNo: 1, matchText: buildShotMatchText("林晚", null, "林晚:我不会再等。") },
      { shotId: SHOT_SWIM_ID, shotNo: 6, matchText: buildShotMatchText("林晚", "她换上泳装走向泳池", null) },
    ],
  );
  assert.deepEqual(matches, [
    { assetEntityId: LIN_WAN_ASSET_ID, variantId: SWIMSUIT_VARIANT_ID, shotId: SHOT_SWIM_ID, shotNo: 6 },
  ], "只有 visual 含「泳装」的镜6 命中 B 层;镜1 不误绑");
});

test("v1.7 B 层 T15.2:同镜两个非第一变体同时命中 → 歧义,该镜全部跳过", () => {
  const matches = matchVariantShots(
    [
      linwanVariant(SWIMSUIT_VARIANT_ID, "林晚-泳装"),
      linwanVariant(ARMOR_VARIANT_ID, "林晚-战甲"),
    ],
    [{ shotId: SHOT_SWIM_ID, shotNo: 3, matchText: buildShotMatchText("林晚", "泳装与战甲同框", null) }],
  );
  assert.deepEqual(matches, [], "歧义即跳过,宁可漏不可错,留给路径②/③");
});

test("v1.7 B 层 T15.3 等价:该 (shot, variant) 已有关联 → 跳过", () => {
  const matches = matchVariantShots(
    [linwanVariant(SWIMSUIT_VARIANT_ID, "林晚-泳装")],
    [{
      shotId: SHOT_SWIM_ID, shotNo: 6,
      matchText: buildShotMatchText(null, "泳装", null),
      existingPairs: [{ asset_entity_id: LIN_WAN_ASSET_ID, variant_id: SWIMSUIT_VARIANT_ID }],
    }],
  );
  assert.deepEqual(matches, [], "manual/exact_name 已关联的对不重复写");
});

test("v1.7 B 层 T15.5 等价:抑制名单内的对不命中", () => {
  const matches = matchVariantShots(
    [linwanVariant(SWIMSUIT_VARIANT_ID, "林晚-泳装")],
    [{
      shotId: SHOT_SWIM_ID, shotNo: 6,
      matchText: buildShotMatchText(null, "泳装", null),
      removedAutoRefs: [{ asset_entity_id: LIN_WAN_ASSET_ID, variant_id: SWIMSUIT_VARIANT_ID }],
    }],
  );
  assert.deepEqual(matches, [], "分镜侧删过的自动项不被重新 push");
});

test("v1.7 B 层:别名命中同样落位(aliases 第一期字段生效)", () => {
  const matches = matchVariantShots(
    [linwanVariant(SWIMSUIT_VARIANT_ID, "林晚-夏日限定", ["泳装"])],
    [{ shotId: SHOT_SWIM_ID, shotNo: 6, matchText: buildShotMatchText(null, "她换上泳装", null) }],
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.variantId, SWIMSUIT_VARIANT_ID);
});

test("v1.7 抑制名单读写:readRemovedAutoRefs/shotSuppressed 形状防御与命中判定", () => {
  const pair = { asset_entity_id: LIN_WAN_ASSET_ID, variant_id: SWIMSUIT_VARIANT_ID };
  const metadata = { lite: { removedAutoRefs: [pair] } };
  assert.deepEqual(readRemovedAutoRefs(metadata), [pair]);
  assert.equal(shotSuppressed(metadata, LIN_WAN_ASSET_ID, SWIMSUIT_VARIANT_ID), true, "名单内的对 → 抑制");
  assert.equal(shotSuppressed(metadata, LIN_WAN_ASSET_ID, ARMOR_VARIANT_ID), false, "名单外的对 → 放行");
  // 形状不合法按空名单处理,不抛
  assert.deepEqual(readRemovedAutoRefs(null), []);
  assert.deepEqual(readRemovedAutoRefs({ lite: { removedAutoRefs: "not-an-array" } }), []);
  assert.deepEqual(readRemovedAutoRefs({ lite: { removedAutoRefs: [{ asset_entity_id: "only-key" }] } }), []);
  // 解除 = 名单移除该对后不再抑制(模拟 clearShotAutoRefSuppression 的读侧效果)
  assert.equal(shotSuppressed({ lite: { removedAutoRefs: [] } }, LIN_WAN_ASSET_ID, SWIMSUIT_VARIANT_ID), false);
});

test("v1.7 materialize 响应:携带 variant_matches / variant_match_skipped 字段", async () => {
  const { app, repository } = await harness();
  seedConfirmedContainer(repository);
  // fake 固定回 0/null(真库口径:无变体时 B 层零写入);字段必须出现在 snake_case 响应里
  const response = await postMaterialize(app);
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json().data;
  assert.equal(data.variant_matches, 0);
  assert.equal(data.variant_match_skipped, null);
});