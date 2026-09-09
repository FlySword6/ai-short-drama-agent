import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { AppError } from "../../shared/errors.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import {
  AUDIO_MAX_ORIGINAL_DURATION_SECONDS,
  AUDIO_MAX_REFERENCE_COUNT,
  AUDIO_MAX_REFERENCE_DURATION_SECONDS,
  AUDIO_MAX_TEXT_PROMPT_LENGTH,
} from "../generation/v01Contract.js";
import type { Database } from "../../db/client.js";
import { DrizzleAudioVersionRepository } from "./repository.js";
import { AudioVersionService } from "./service.js";
import { CachedVoiceCatalog } from "./voiceCatalog.js";
import { DisabledAudioExtractionPort } from "./service.js";
import type {
  AudioExtractionPort,
  AudioExtractionSourceRepository,
  AudioLockTarget,
  AudioVersion,
  VoiceCatalogProvider,
} from "./types.js";

const querySchema = z.object({
  language: z.string().trim().min(1).max(64).optional(),
  category: z.string().trim().min(1).max(64).optional(),
  gender: z.string().trim().min(1).max(64).optional(),
  age: z.string().trim().min(1).max(64).optional(),
  q: z.string().trim().min(1).max(128).optional(),
}).strict();
const mediaResultParamsSchema = z.object({ media_result_id: z.string().uuid() }).strict();
const extractionSchema = z.object({
  project_id: z.string().uuid(),
  source_media_result_id: z.string().uuid(),
}).strict();
const lockSchema = z.object({
  asset_entity_id: z.string().uuid(),
  asset_media_id: z.string().uuid(),
  project_asset_ref_id: z.string().uuid(),
}).strict();

export const AUDIO_GENERATION_SCHEMA_VERSION = "sound-workshop-generation-v1";

export function audioGenerationSchema(): Record<string, unknown> {
  return {
    schema_version: AUDIO_GENERATION_SCHEMA_VERSION,
    media_kind: "audio",
    submission_flow: {
      estimate: "/api/v1/generations/estimate",
      confirm: "/api/v1/generation-quotes/{quote_id}/confirm",
      submit: "/api/v1/generations",
    },
    limits: {
      text_prompt_max_chars: AUDIO_MAX_TEXT_PROMPT_LENGTH,
      original_duration_seconds: { min: 1, max: AUDIO_MAX_ORIGINAL_DURATION_SECONDS },
      reference_audio: {
        max_count: AUDIO_MAX_REFERENCE_COUNT,
        max_duration_seconds_each: AUDIO_MAX_REFERENCE_DURATION_SECONDS,
      },
      reference_image: { max_count: 1 },
      speech_rate: { min: -50, max: 100 },
      loudness_rate: { min: -50, max: 100 },
      pitch_rate: { min: -12, max: 12 },
    },
    defaults: {
      format: "mp3",
      sample_rate: 48_000,
      enable_subtitle: true,
      aigc_metadata_enabled: true,
      aigc_watermark_enabled: false,
    },
    capabilities: {
      background_music_generation: false,
      timecodes_in_spoken_prompt: false,
      candidate_lifecycle: true,
      paid_submission_requires_explicit_confirmation: true,
    },
  };
}

export interface AudioLifecycleRouteService {
  discard(mediaResultId: string, actorId: string): Promise<AudioVersion>;
  lock(mediaResultId: string, target: AudioLockTarget): Promise<AudioVersion>;
  get(mediaResultId: string): Promise<AudioVersion | undefined>;
}

export interface AudioProjectAccessService {
  requireReadable(actor: { id: string; role?: "admin" | "operator" | "member" }, projectId: string): Promise<unknown>;
  requireCreative(actor: { id: string; role?: "admin" | "operator" | "member" }, projectId: string): Promise<unknown>;
}

export interface AudioRouteDependencies {
  voiceCatalog?: Pick<CachedVoiceCatalog, "list">;
  voiceCatalogProvider?: VoiceCatalogProvider;
  voiceCatalogCacheTtlMs?: number;
  lifecycleService?: AudioLifecycleRouteService;
  extractionPort?: AudioExtractionPort;
  extractionSourceRepository?: AudioExtractionSourceRepository;
  /** Enables default lifecycle/access adapters without changing the shared router. */
  getDatabase?: () => Database;
  projectAccessService?: AudioProjectAccessService;
}

/**
 * Integration owner registers this factory from the shared HTTP router. A
 * provider must be explicitly supplied; there is no default remote call.
 */
export async function registerAudioRoutes(app: FastifyInstance, dependencies: AudioRouteDependencies = {}): Promise<void> {
  const catalog = dependencies.voiceCatalog ?? (dependencies.voiceCatalogProvider
    ? new CachedVoiceCatalog(dependencies.voiceCatalogProvider, dependencies.voiceCatalogCacheTtlMs)
    : undefined);
  // Do not touch the database while the application merely registers routes:
  // health/auth-only deployments and their tests must still boot without a
  // configured database.  Resolve these ordinary per-request adapters lazily.
  const lifecycle = () => dependencies.lifecycleService ?? (dependencies.getDatabase
    ? new AudioVersionService(new DrizzleAudioVersionRepository(dependencies.getDatabase()))
    : undefined);
  const projectAccess = () => dependencies.projectAccessService ?? (dependencies.getDatabase
    ? ProjectAccessService.fromDatabase(new ProjectAccessRepository(dependencies.getDatabase()))
    : undefined);
  const extractionSource = () => dependencies.extractionSourceRepository ?? (dependencies.getDatabase
    ? new DrizzleAudioVersionRepository(dependencies.getDatabase())
    : undefined);
  app.get("/api/v1/audio/generation-schema", async (request) => {
    requireCurrentUser(request);
    return success(audioGenerationSchema());
  });
  app.get("/api/v1/audio/voices", async (request) => {
    requireCurrentUser(request);
    if (!catalog) throw new AppError(503, "audio_voice_catalog_not_configured", "查看音色没成：音色库暂未准备好，请联系管理员处理。");
    const query = parseRequest(querySchema, request.query);
    const voices = await catalog.list({ ...query, query: query.q });
    // 词表为空(种子未播/全部停用)是 200 + 空数组 + reason,不是 503——
    // 503 只留给"目录服务没接线";筛选无命中是正常空结果,不带 reason。
    if (voices.length > 0) return success({ voices });
    const unfiltered = await catalog.list({});
    return unfiltered.length === 0
      ? success({ voices, reason: "音色词表为空：种子未播或全部停用，未发送任何外部请求" })
      : success({ voices });
  });

  app.get("/api/v1/audio/versions/:media_result_id", async (request) => {
    requireCurrentUser(request);
    const lifecycleService = lifecycle();
    const projectAccessService = projectAccess();
    if (!lifecycleService || !projectAccessService) {
      throw new AppError(503, "audio_lifecycle_not_configured", "查看音频没成：音频服务暂未准备好，请联系管理员处理。");
    }
    const { media_result_id: mediaResultId } = parseRequest(mediaResultParamsSchema, request.params);
    const version = await lifecycleService.get(mediaResultId);
    if (!version) throw new AppError(404, "audio_version_not_found", "查看音频没成：找不到这个音频，请刷新后再试。");
    await projectAccessService.requireReadable(requireCurrentUser(request), version.projectId);
    return success({ version });
  });

  app.post("/api/v1/audio/versions/:media_result_id/discard", async (request) => {
    const actor = requireCurrentUser(request);
    const lifecycleService = lifecycle();
    const projectAccessService = projectAccess();
    if (!lifecycleService || !projectAccessService) throw new AppError(503, "audio_lifecycle_not_configured", "废弃音频没成：音频服务暂未准备好，请联系管理员处理。");
    const { media_result_id: mediaResultId } = parseRequest(mediaResultParamsSchema, request.params);
    const version = await lifecycleService.get(mediaResultId);
    if (!version) throw new AppError(404, "audio_version_not_found", "废弃音频没成：找不到这个音频，请刷新后再试。");
    await projectAccessService.requireCreative(actor, version.projectId);
    return success({ version: await lifecycleService.discard(mediaResultId, actor.id) });
  });

  app.post("/api/v1/audio/versions/:media_result_id/lock", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    const actor = requireCurrentUser(request);
    const lifecycleService = lifecycle();
    const projectAccessService = projectAccess();
    if (!lifecycleService || !projectAccessService) throw new AppError(503, "audio_lifecycle_not_configured", "锁定音频没成：音频服务暂未准备好，请联系管理员处理。");
    const { media_result_id: mediaResultId } = parseRequest(mediaResultParamsSchema, request.params);
    const target = parseRequest(lockSchema, request.body);
    const version = await lifecycleService.get(mediaResultId);
    if (!version) throw new AppError(404, "audio_version_not_found", "锁定音频没成：找不到这个音频，请刷新后再试。");
    await projectAccessService.requireCreative(actor, version.projectId);
    return success({ version: await lifecycleService.lock(mediaResultId, {
      lockedAssetEntityId: target.asset_entity_id,
      lockedAssetMediaId: target.asset_media_id,
      projectAssetRefId: target.project_asset_ref_id,
    }) });
  });

  app.post("/api/v1/audio/extract", async (request) => {
    const actor = requireCurrentUser(request);
    const input = parseRequest(extractionSchema, request.body);
    const projectAccessService = projectAccess();
    if (!projectAccessService) throw new AppError(503, "audio_lifecycle_not_configured", "提取音轨没成：项目权限暂未准备好，请联系管理员处理。");
    await projectAccessService.requireCreative(actor, input.project_id);
    const sourceRepository = extractionSource();
    if (!sourceRepository) throw new AppError(503, "audio_extract_not_configured", "提取音轨没成：素材检查暂未准备好，请联系管理员处理。");
    const sourceProjectId = await sourceRepository.findProjectIdForExtractableVideo(input.source_media_result_id);
    if (sourceProjectId !== input.project_id) {
      throw new AppError(404, "audio_extract_source_not_found", "提取音轨没成：找不到当前项目中的源视频，请重新选择。");
    }
    // Extraction stays fail-closed until the review and provider integrations are wired.
    const extractionPort = dependencies.extractionPort ?? new DisabledAudioExtractionPort();
    return extractionPort.extract({
      projectId: input.project_id,
      sourceMediaResultId: input.source_media_result_id,
      actorId: actor.id,
    });
  });
}
