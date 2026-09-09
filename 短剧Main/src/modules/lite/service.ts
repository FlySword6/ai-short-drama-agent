import { AppError, BadRequestError, ConflictError } from "../../shared/errors.js";
import { ScriptTextExtractor } from "../../services/script-text-extractor.js";
import type { ExtractedScriptText } from "../../services/script-text-extractor.js";
import { parseEpisodes, type EpisodeParseResult } from "../production/episodeParser.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import { sha256Hex } from "../script-breakdown/service.js";
import { z } from "zod";
import type { AiCompletionRequest, AiProviderCompletion } from "../ai/types.js";
import { parseJsonValue } from "../../shared/json.js";
import type {
  LiteAccessPort,
  LiteAddUsageItemInput,
  LiteAddUsagesResult,
  LiteAssetCandidateInput,
  LiteAssetDetail,
  LiteAssetListResult,
  LiteAssetMediaItem,
  LiteAssetUsageEntry,
  LiteAssetVariant,
  LiteAssetVersionTrackItem,
  LiteCreateAssetInput,
  ImportedEpisodeResult,
  ImportBulkScriptResult,
  LiteMaterializeAssetsResult,
  LiteMatchSuggestItem,
  LiteMatchSuggestShotRow,
  LitePatchAssetInput,
  LiteReferenceAssetItem,
  LiteRepository,
  LiteScriptBreakdownPort,
  LiteShotCandidateInput,
  LiteVariantMatchProfile,
  SubmitLiteScriptInput,
  SubmitLiteScriptResult,
} from "./types.js";

/** v1.6 匹配建议的 AI 网关窄口:AiGatewayService 结构性满足,测试注入 fake。 */
export interface LiteMatchSuggestGateway {
  completeValidated<T>(
    input: AiCompletionRequest,
    validate: (completion: AiProviderCompletion) => T | Promise<T>,
  ): Promise<T>;
}

/** 匹配建议上限(问题八 8.2):泛名命中爆炸时不静默截断,置 truncated 返回。 */
const MATCH_SUGGEST_MAX_ITEMS = 50;
const MATCH_SUGGEST_MAX_TOKENS = 4_000;

/** 定位键宽容:模型偶发回「第2集」/「第1个分镜」(模仿候选行格式)——抽出整数,抽不出才拒。
    幻觉防线不松:抽出的整数仍要过 findShotByLabel 命中真实分镜,否则丢弃。 */
const shotLocatorNumber = z.union([
  z.number().int().positive(),
  z.string().transform((value, ctx) => {
    const m = value.match(/\d+/);
    if (!m) {
      ctx.addIssue({ code: "custom", message: "定位键必须含整数" });
      return z.NEVER;
    }
    return Number(m[0]);
  }),
]);

/** 模型输出的结构化建议:定位键 (episode_no, shot_no),场景名由服务端补齐、模型不得返回。 */
const matchSuggestOutputSchema = z.array(z.object({
  episode_no: shotLocatorNumber,
  shot_no: shotLocatorNumber,
  reason: z.string().trim().max(300),
}));

const MATCH_SUGGEST_SYSTEM = [
  "你是影视剧组的资产-分镜匹配助手。用户会给你一个资产变体和一组已编号的候选分镜。",
  "你的任务：找出该资产变体最可能出现的分镜（语义判断，不要求名字精确对拍）。",
  "只允许输出 JSON：一个数组，每项包含 episode_no（集号）、shot_no（分镜号）、reason（一句中文理由）。",
  "episode_no 与 shot_no 必须是纯整数（如 2、1），不要带「第」「集」「个分镜」等任何文字。",
  "没有合适分镜时输出空数组 []。不得虚构清单之外的集号或分镜号，不得输出 JSON 以外的任何内容。",
].join("\n");

function matchSuggestPrompt(
  profile: LiteVariantMatchProfile,
  shots: LiteMatchSuggestShotRow[],
  excludedShotIds: Set<string>,
): string {
  const lines: string[] = [];
  lines.push(`资产变体：「${profile.variantName}」${profile.variantDescription ? `（${profile.variantDescription}）` : ""}`);
  lines.push(`所属资产：「${profile.assetName}」（类型：${profile.assetKind}）${profile.assetIntro ? `，简介：${profile.assetIntro}` : ""}`);
  lines.push("");
  lines.push("候选分镜清单（只从这些集号/分镜号里选）：");
  if (shots.length === 0) lines.push("（本项目没有已确认集的分镜）");
  for (const shot of shots) {
    const scene = shot.sceneName ? `[${shot.sceneName}]` : "";
    const bits = [shot.title ?? "", shot.scriptText ?? ""].filter((bit) => bit.trim().length > 0).join("｜");
    const elements = shot.breakdownElements && typeof shot.breakdownElements === "object"
      ? Object.entries(shot.breakdownElements)
        .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
        .map(([key, value]) => `${key}: ${value}`)
        .join("；")
      : "";
    const excluded = excludedShotIds.has(shot.shotId) ? "（已关联，勿建议）" : "";
    lines.push(`第${shot.episodeNo}集/第${shot.shotNo}个分镜${scene}${excluded} ${bits}${elements ? `｜拆解：${elements}` : ""}`);
  }
  lines.push("");
  if (excludedShotIds.size > 0) {
    lines.push(`该变体与资产已关联 ${excludedShotIds.size} 个分镜（shot_id 如下），不要重复建议：`);
    lines.push([...excludedShotIds].join(","));
    lines.push("");
  }
  lines.push("请输出 JSON 数组（可为空），每项 {\"episode_no\": 集号, \"shot_no\": 分镜号, \"reason\": \"一句中文理由\"}。");
  return lines.join("\n");
}

/**
 * Lite 剧本提交编排:确认集归属 → 成片锁 → 转调剧本两段式。
 * 不直接写草稿区,剧本与拆解的事实仍在 script-breakdown 模块。
 * 多集模式:集由前端显式新建(完整版 createEpisode),本服务只按传入 episodeId 落剧本。
 */
export interface LiteScriptMutationScope {
  repository: LiteRepository;
  breakdown: LiteScriptBreakdownPort;
}

export type RunLiteScriptMutation = <T>(
  projectId: string,
  work: (scope: LiteScriptMutationScope) => Promise<T>,
) => Promise<T>;

export type RunLiteAssetMutation = <T>(
  projectId: string,
  work: (repository: LiteRepository) => Promise<T>,
) => Promise<T>;

export class LiteScriptService {
  private readonly now: () => Date;
  private readonly runProjectMutation: RunLiteScriptMutation;

  constructor(
    private readonly repository: LiteRepository,
    private readonly access: LiteAccessPort,
    private readonly breakdown: LiteScriptBreakdownPort,
    private readonly extractor: ScriptTextExtractor,
    config: {
      now?: () => Date;
      logger?: { info(obj: Record<string, unknown>, msg: string): void };
      runProjectMutation?: RunLiteScriptMutation;
    } = {},
  ) {
    this.now = config.now ?? (() => new Date());
    this.logger = config.logger;
    this.runProjectMutation = config.runProjectMutation
      ?? (async (_projectId, work) => work({
        repository: this.repository,
        breakdown: this.breakdown,
      }));
  }

  private readonly logger?: { info(obj: Record<string, unknown>, msg: string): void };

  async submitScript(
    actor: ProjectAccessActor,
    projectId: string,
    input: SubmitLiteScriptInput,
  ): Promise<SubmitLiteScriptResult> {
    await this.access.require(actor, projectId, "create");

    this.logger?.info({ step: 1, fn: "LiteScriptService.submitScript", projectId, episodeId: input.episodeId, rawChars: input.rawText.length, autoConfirm: true }, "lite one-click submit: 收到一键生成本集提交");

    return this.runProjectMutation(projectId, async ({ repository, breakdown }) => {
      // 多集模式:集由前端显式新建,这里只确认归属。
      const episode = await repository.findEpisode(projectId, input.episodeId);
      if (!episode) {
        throw new BadRequestError("找不到这一集，请刷新后再试");
      }

      // 已有成片保护(服务端强制):有未软删成片的集不可重新解析。
      if (await repository.hasPersistedMedia(episode.id)) {
        throw new ConflictError("这一集已经有成片了，不能重新解析", "lite_script_locked");
      }

      const version = await breakdown.createScriptVersion(actor, episode.id, {
        title: null,
        scriptText: input.rawText,
        clientIdempotencyKey: input.clientIdempotencyKey,
      });
      const run = await breakdown.createRun(actor, episode.id, {
        scriptVersionId: version.version.id,
        targetDurationSec: null,
        clientIdempotencyKey: deriveRunIdempotencyKey(input.clientIdempotencyKey),
      });
      this.logger?.info({ step: 2, fn: "LiteScriptService.submitScript", runId: run.run.id, outcome: run.outcome, versionId: version.version.id }, "lite one-click submit: version+run 已建,后台执行已调度");

      // 更新 projects.lite_episode_id 指向最近操作集(URL ep 缺失时的 fallback)。
      await repository.linkContainerEpisode(projectId, episode.id, this.now());

      return { episodeId: episode.id, runId: run.run.id, outcome: run.outcome };
    });
  }

  /**
   * 从上传文件提取纯文本,供剧本页「从文件导入」填进粘贴框。
   * 60000 字上限是领域规则(与 raw_text 一致),在业务层强制。
   */
  async extractScriptText(
    actor: ProjectAccessActor,
    projectId: string,
    filename: string,
    buffer: Buffer,
  ): Promise<{ text: string; charCount: number; sourceFormat: "txt" | "docx" | "pdf" }> {
    await this.access.require(actor, projectId, "create");
    let extracted: ExtractedScriptText;
    try {
      extracted = await this.extractor.extract(filename, buffer);
    } catch {
      throw new BadRequestError("文件打不开或已损坏，请检查后重新上传");
    }
    if (extracted.text.length > 60_000) {
      throw new BadRequestError(
        `从文件提取出的文本超过 60,000 字上限（实际 ${extracted.text.length.toLocaleString()} 字），请精简后再上传`,
      );
    }
    return { text: extracted.text, charCount: extracted.text.length, sourceFormat: extracted.sourceFormat };
  }

  /**
   * 整部剧本导入:提取文本 → parseEpisodes 按集标题拆分 → 覆盖式替换项目全部集。
   * 「重新导入」不是追加:解析成功后先软删既有集(R1 特许的可逆操作),再逐集建
   * episode + version,保证导入结果与文件内容严格一致,不会叠出重复集。
   * 导入只落剧本文本到剧本页;是否解析由用户在具体集里显式触发。
   */
  async importBulkScript(
    actor: ProjectAccessActor,
    projectId: string,
    filename: string,
    buffer: Buffer,
  ): Promise<ImportBulkScriptResult> {
    await this.access.require(actor, projectId, "create");
    let extracted: ExtractedScriptText;
    try {
      extracted = await this.extractor.extract(filename, buffer);
    } catch {
      throw new BadRequestError("文件打不开或已损坏，请检查后重新上传");
    }
    if (extracted.text.length > 600_000) {
      throw new BadRequestError(
        `整部剧本提取出的文本超过 600,000 字上限（实际 ${extracted.text.length.toLocaleString()} 字），请精简后再上传`,
      );
    }
    let parsed: EpisodeParseResult;
    try {
      parsed = parseEpisodes(extracted.text);
    } catch (err) {
      // 没有集标题（unrecognized_episode_format）→ 整个文件作为一集导入。
      // 覆盖语义下集号恒从 1 开始,不再叠加到既有集之后。
      if (err instanceof AppError && err.code === "unrecognized_episode_format") {
        parsed = {
          preamble: "",
          episodes: [{ episodeNo: 1, title: singleEpisodeTitle(extracted.text), content: extracted.text }],
          warnings: [],
        };
      } else {
        throw err;
      }
    }

    return this.runProjectMutation(projectId, async ({ repository, breakdown }) => {
      // 项目锁覆盖完整替换写单元:旧集软删、集/版本重建和容器指针更新
      // 要么一起提交,要么一起回滚。
      const replaced = await repository.softDeleteActiveEpisodes(projectId, actor.id, this.now());
      const results: ImportedEpisodeResult[] = [];
      for (const ep of parsed.episodes) {
        const episodeId = await repository.createEpisode(projectId, ep.episodeNo, ep.title, this.now());
        const version = await breakdown.createScriptVersion(actor, episodeId, {
          title: ep.title,
          scriptText: ep.content,
          clientIdempotencyKey: `bulk-ep-${episodeId}`,
        });
        results.push({ episodeId, episodeNo: ep.episodeNo, scriptVersionId: version.version.id });
      }
      if (results.length > 0) {
        await repository.linkContainerEpisode(projectId, results[0]!.episodeId, this.now());
      }
      return { episodes: results, replaced };
    });
  }

  /**
   * 拆解执行透传:路由在创建后后台调度,BFF 本身不等 run 结果。
   * autoConfirm 由路由从请求体取(一键生成本集默认 true,§2 P2)。
   */
  executeRun(runId: string, actorId: string, options: { autoConfirm?: boolean } = {}): Promise<void> {
    return this.breakdown.executeRun(runId, actorId, options);
  }
}

/**
 * run 幂等键确定性派生。version 与 run 两表的幂等唯一索引各自独立
 * ((created_by_user_id, client_idempotency_key)),同键复用虽不会撞约束,
 * 但 run 表里的键会与 version 段同形、排障时无法区分来源;故 run 键用
 * sha256 派生——同一客户端键重放必得同一派生键(命中 existing 返回同 run),
 * 且长度恒定不超 255 上限。
 */
export function deriveRunIdempotencyKey(clientIdempotencyKey: string): string {
  return `lite-run:${sha256Hex(clientIdempotencyKey)}`;
}

/**
 * 无集标题文件的单集兜底名:按正文主导语言取名——中文正文「第1集」、
 * 英文正文「EPISODE 1」(用户反馈 R2-12:兜底集名不再固定「第1集」)。
 * 判定:统计汉字与拉丁字母数量,字母更多判英文;全空/无字母汉字也判中文。
 */
export function singleEpisodeTitle(text: string): string {
  const cjk = text.match(/[\u4e00-\u9fff]/gu)?.length ?? 0;
  const latin = text.match(/[a-z]/giu)?.length ?? 0;
  return latin > cjk ? "EPISODE 1" : "第1集";
}

/**
 * Lite 资产 BFF 编排:已确认拆解运行的资产候选幂等落成项目资产,以及目标
 * 资产候选图取数。事实仍在 asset_entities/project_asset_refs/media_results,
 * 本服务只做「容器集 → confirmed run → 候选 → 资产」的转调,不引入第二套写路径。
 */
export class LiteAssetService {
  private readonly now: () => Date;
  private readonly gateway: LiteMatchSuggestGateway | null;
  private readonly logger: { info(obj: Record<string, unknown>, msg: string): void } | null;
  private readonly runProjectMutation: RunLiteAssetMutation;
  private readonly registerPrimary: ((input: {
    actor: ProjectAccessActor;
    projectId: string;
    assetEntityId: string;
    mediaId: string;
  }) => Promise<void> | void) | null;

  constructor(
    private readonly repository: LiteRepository,
    private readonly access: LiteAccessPort,
    config: {
      now?: () => Date;
      /** v0.9 C 层(AI 自动挂):注入 AI 网关;未注入时 C 层整体跳过(确定性 A/B 层不受影响)。 */
      gateway?: LiteMatchSuggestGateway | null;
      logger?: { info(obj: Record<string, unknown>, msg: string): void };
      runProjectMutation?: RunLiteAssetMutation;
      /**
       * 2026-08-19 触发模型:成为主图/主音频后自动登记火山素材(仅 Lite 注入)。
       * 服务在翻转事务提交后 fire-and-forget 触发,绝不阻塞设主图 UX;失败由
       * 登记服务持久化到登记行,前端轮询展示并人工重试。未注入(完整版
       * set-primary/shot 定稿)保持纯人工登记。
       */
      registerPrimary?: ((input: {
        actor: ProjectAccessActor;
        projectId: string;
        assetEntityId: string;
        mediaId: string;
      }) => Promise<void> | void) | null;
    } = {},
  ) {
    this.now = config.now ?? (() => new Date());
    this.gateway = config.gateway ?? null;
    this.logger = config.logger ?? null;
    this.registerPrimary = config.registerPrimary ?? null;
    this.runProjectMutation = config.runProjectMutation
      ?? (async (_projectId, work) => work(this.repository));
  }

  async materializeAssets(
    actor: ProjectAccessActor,
    projectId: string,
    episodeId: string,
  ): Promise<LiteMaterializeAssetsResult> {
    await this.access.require(actor, projectId, "create");
    const materialized = await this.runProjectMutation(projectId, async (repository) => {
      const run = await repository.findLatestConfirmedRunAssetDraft(episodeId);
      if (!run?.assetCandidates) {
        throw new ConflictError("请先在剧本页完成解析并采用", "lite_breakdown_not_confirmed");
      }

      const { characters, scenes, props, costumes, audios } = run.assetCandidates;
      const candidates: LiteAssetCandidateInput[] = [
        ...characters.map((candidate) => ({
          candidateId: candidate.candidateId,
          assetKind: "character" as const,
          name: candidate.name,
          description: candidate.description,
        })),
        ...scenes.map((candidate) => ({
          candidateId: candidate.candidateId,
          assetKind: "scene" as const,
          name: candidate.name,
          description: candidate.description,
        })),
        ...props.map((candidate) => ({
          candidateId: candidate.candidateId,
          assetKind: "prop" as const,
          name: candidate.name,
          description: candidate.description,
        })),
        ...costumes.map((candidate) => ({
          candidateId: candidate.candidateId,
          assetKind: "costume" as const,
          name: candidate.name,
          description: candidate.description,
        })),
        ...audios.map((candidate) => ({
          candidateId: candidate.candidateId,
          assetKind: "audio" as const,
          name: candidate.name,
          description: candidate.description,
          audioKind: candidate.audioKind ?? null,
        })),
      ];
      if (candidates.length === 0) {
        return {
          result: {
            created: 0,
            existed: 0,
            assets: [],
            variantMatches: 0,
            variantMatchSkipped: null,
            aiVariantMatches: 0,
            aiVariantMatchSkipped: null,
          },
          episodeNo: 0,
          skipAutoMatch: true,
        };
      }
      const shotCandidates: LiteShotCandidateInput[] = run.shotCandidates.map((shot) => ({
        candidateId: shot.candidateId,
        shotNo: shot.shotNo,
        lineIndices: shot.lineIndices,
        characterNames: shot.characterNames,
        sceneNames: shot.sceneNames,
        propNames: shot.propNames,
        costumeNames: shot.costumeNames,
        audioNames: shot.audioNames ?? [],
      }));
      const ep = await repository.findEpisode(projectId, episodeId);
      if (!ep) throw new BadRequestError("找不到这个集");
      const result = await repository.materializeAssetCandidates({
        projectId,
        actorId: actor.id,
        runId: run.runId,
        candidates,
        shotCandidates,
        episodeId,
        episodeNo: ep.episodeNo ?? 0,
        now: this.now(),
      });
      return { result, episodeNo: ep.episodeNo ?? 0, skipAutoMatch: false };
    });
    if (materialized.skipAutoMatch) return materialized.result;

    // v0.9 C 层(AI 自动挂):A/B 层提交后再调用模型,不在数据库事务里持锁。
    const ai = await this.runAutoVariantMatch({
      actorId: actor.id,
      projectId,
      episodeId,
      episodeNo: materialized.episodeNo,
    });
    return {
      ...materialized.result,
      aiVariantMatches: ai.aiVariantMatches,
      aiVariantMatchSkipped: ai.aiVariantMatchSkipped,
    };
  }

  async listAssetMedia(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
  ): Promise<LiteAssetMediaItem[]> {
    await this.access.require(actor, projectId, "read");
    return this.repository.listAssetMedia({ projectId, assetEntityId });
  }

  /** 参考资产清单:只读,已登记 active 的资产才会出现;不触发任何写或付费动作。 */
  async listReferenceAssets(
    actor: ProjectAccessActor,
    projectId: string,
  ): Promise<LiteReferenceAssetItem[]> {
    await this.access.require(actor, projectId, "read");
    return this.repository.listReferenceAssets({ projectId });
  }

  /** 素材列表页:按项目(+可选 kind)列资产,附 tab 聚合计数。 */
  async listAssets(
    actor: ProjectAccessActor,
    projectId: string,
    kind?: string,
  ): Promise<LiteAssetListResult> {
    await this.access.require(actor, projectId, "read");
    return this.repository.listAssets({ projectId, kind });
  }

  /** 资产详情:正式列 + metadata.lite 投影。 */
  async getAssetDetail(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
  ): Promise<LiteAssetDetail> {
    await this.access.require(actor, projectId, "read");
    const detail = await this.repository.findAssetDetail({ projectId, assetEntityId });
    if (!detail) throw new BadRequestError("找不到这个资产，可能已经被删除");
    return detail;
  }

  /** 手动新建资产:不关联 script_breakdown_runs,metadata.lite.usages 初始空。 */
  async createAssetManually(
    actor: ProjectAccessActor,
    projectId: string,
    input: LiteCreateAssetInput,
  ): Promise<{ assetEntityId: string; firstVariantId: string }> {
    await this.access.require(actor, projectId, "create");
    const name = input.name.trim();
    if (!name) throw new BadRequestError("资产名称不能为空");
    return this.repository.createAsset({
      projectId,
      actorId: actor.id,
      name,
      assetKind: input.assetKind,
      intro: input.intro?.trim() || null,
      note: input.note?.trim() || null,
      now: this.now(),
    });
  }

  /** 更新资产:只改 name/intro/metadata.lite.note,保留 metadata 其他命名空间。 */
  async updateAsset(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
    patch: LitePatchAssetInput,
  ): Promise<void> {
    await this.access.require(actor, projectId, "create");
    const normalized: LitePatchAssetInput = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new BadRequestError("资产名称不能为空");
      normalized.name = name;
    }
    if (patch.intro !== undefined) normalized.intro = patch.intro?.trim() || null;
    if (patch.note !== undefined) normalized.note = patch.note?.trim() || null;
    await this.repository.updateAsset({
      projectId,
      assetEntityId,
      patch: normalized,
      actorId: actor.id,
      now: this.now(),
    });
  }

  /** 资产变体列表。 */
  async listAssetVariants(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
  ): Promise<LiteAssetVariant[]> {
    await this.access.require(actor, projectId, "read");
    return this.repository.listAssetVariants({ projectId, assetEntityId });
  }

  /** 版本图素材轨。 */
  async listAssetVersionTrack(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
  ): Promise<LiteAssetVersionTrackItem[]> {
    await this.access.require(actor, projectId, "read");
    return this.repository.listAssetVersionTrack({ projectId, assetEntityId });
  }

  /** 设主图:上传图走 asset_media_id,生成图走 media_result_id(物化后翻转),冲突时抛 ConflictError。 */
  async setPrimaryMedia(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
    target: { assetMediaId?: string; mediaResultId?: string },
  ): Promise<void> {
    await this.access.require(actor, projectId, "create");
    const result = target.mediaResultId
      ? await this.repository.setPrimaryMediaFromResult({
          projectId,
          assetEntityId,
          targetMediaResultId: target.mediaResultId,
        })
      : await this.repository.setPrimaryMedia({ projectId, assetEntityId, targetMediaId: target.assetMediaId! });
    if (result.conflict) {
      throw new ConflictError("主图已被他人更改，请刷新后重试", "lite_primary_media_changed");
    }
    // 触发模型(2026-08-19):成为主图/主音频后自动登记火山素材,只登记被选中的
    // 主变体,视频不进入 CreateAsset 契约。fire-and-forget,失败落登记行由前端重试。
    if ((result.mediaKind === "image" || result.mediaKind === "audio") && this.registerPrimary) {
      const pending = this.registerPrimary({ actor, projectId, assetEntityId, mediaId: result.mediaId });
      if (pending instanceof Promise) {
        void pending.catch((error) => {
          this.logger?.info(
            {
              projectId,
              assetEntityId,
              mediaId: result.mediaId,
              error: error instanceof Error ? error.message : String(error),
            },
            "lite primary variant automatic asset registration failed",
          );
        });
      }
    }
  }

  /** 关联分镜列表(可选按变体过滤)。 */
  async listAssetUsages(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
    variantId?: string,
  ): Promise<LiteAssetUsageEntry[]> {
    await this.access.require(actor, projectId, "read");
    return this.repository.listAssetUsages({ projectId, assetEntityId, variantId });
  }

  /** 批量添加关联分镜:命中真实分镜 → bound;未命中 → pending 待绑定。 */
  async addAssetShotUsages(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
    items: LiteAddUsageItemInput[],
  ): Promise<LiteAddUsagesResult> {
    await this.access.require(actor, projectId, "create");
    return this.repository.addAssetShotUsages({
      projectId,
      assetEntityId,
      actorId: actor.id,
      now: this.now(),
      items,
    });
  }

  /** 移除关联分镜(按 usage_id)。 */
  async removeAssetShotUsage(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
    usageId: string,
  ): Promise<void> {
    await this.access.require(actor, projectId, "create");
    await this.repository.removeAssetShotUsage({ projectId, assetEntityId, usageId, now: this.now() });
  }

  /** v1.7(八.10.5)分镜侧删除自动引用:移除该对 exact_name 快照并记抑制名单。 */
  async removeShotAutoRef(
    actor: ProjectAccessActor,
    projectId: string,
    shotId: string,
    assetEntityId: string,
    variantId: string,
  ): Promise<void> {
    await this.access.require(actor, projectId, "create");
    await this.repository.removeShotAutoRef({
      projectId,
      shotId,
      assetEntityId,
      variantId,
      actorId: actor.id,
      now: this.now(),
    });
  }

  /** v1.9 十.1 删资产(软删,级联变体/媒体/引用/快照)。 */
  async deleteAsset(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
  ): Promise<void> {
    await this.access.require(actor, projectId, "create");
    await this.repository.deleteAsset({ projectId, assetEntityId, actorId: actor.id, now: this.now() });
  }

  /** 删变体(软删)。 */
  async deleteAssetVariant(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
    variantId: string,
  ): Promise<void> {
    await this.access.require(actor, projectId, "create");
    await this.repository.deleteAssetVariant({ projectId, assetEntityId, variantId, actorId: actor.id, now: this.now() });
  }

  /** 删媒体(软删,双 ID 空间)。 */
  async deleteAssetMedia(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
    mediaId: string,
  ): Promise<void> {
    await this.access.require(actor, projectId, "create");
    await this.repository.deleteAssetMedia({ projectId, assetEntityId, mediaId, actorId: actor.id, now: this.now() });
  }

  /**
   * v1.6 变体级匹配建议(问题八 8.2):AI 只给建议、零写库——写入由用户勾选后走
   * 既有手动关联路径(addAssetShotUsages)。服务端校验不信模型:定位键必须命中
   * 真实分镜(场景名取自真实分镜),幻觉丢弃、同 shot 去重、已有关联排除、
   * 上限 50 条并置 truncated 标记。
   */
  async suggestVariantUsages(
    actor: ProjectAccessActor,
    projectId: string,
    assetEntityId: string,
    variantId: string,
    gateway: LiteMatchSuggestGateway,
  ): Promise<{ items: LiteMatchSuggestItem[]; truncated: boolean }> {
    await this.access.require(actor, projectId, "read");
    const profile = await this.repository.findVariantForMatchSuggest({ projectId, assetEntityId, variantId });
    if (!profile) throw new BadRequestError("找不到这个变体，可能已经被删除");
    // 已有关联 shot_id 全集作排除基础(问题八 8.2):本变体 manual/exact_name/pending
    // + 资产级 pending(八.9)。
    const usages = await this.repository.listAssetUsages({ projectId, assetEntityId });
    const excludedShotIds = new Set(
      usages
        .filter((u) => u.variantId === variantId || (u.variantId === null && u.status === "pending"))
        .map((u) => u.shotId)
        .filter((id): id is string => id !== null),
    );

    const validated = await this.runMatchSuggest(actor.id, projectId, profile, excludedShotIds, gateway);

    // 冲突标注(八.2):该 shot 已关联同资产其它变体 → 留在清单并标注其展示名。
    const variants = await this.repository.listAssetVariants({ projectId, assetEntityId });
    const conflictByShotId = new Map<string, string>();
    for (const usage of usages) {
      if (!usage.shotId || usage.variantId === variantId || usage.variantId === null) continue;
      if (conflictByShotId.has(usage.shotId)) continue;
      const variant = variants.find((v) => v.variantId === usage.variantId);
      if (variant) conflictByShotId.set(usage.shotId, variant.displayName);
    }
    for (const item of validated) {
      item.conflictVariantName = conflictByShotId.get(item.shotId) ?? null;
    }

    const truncated = validated.length > MATCH_SUGGEST_MAX_ITEMS;
    return { items: validated.slice(0, MATCH_SUGGEST_MAX_ITEMS), truncated };
  }

  /** 匹配建议共用核心:调 AI + 服务端校验(幻觉镜号丢弃、同 shot 去重、排除集)。 */
  private async runMatchSuggest(
    actorId: string,
    projectId: string,
    profile: LiteVariantMatchProfile,
    excludedShotIds: Set<string>,
    gateway: LiteMatchSuggestGateway,
  ): Promise<LiteMatchSuggestItem[]> {
    const suggestions = await gateway.completeValidated({
      actorId,
      purpose: "variant_match_suggest",
      projectId,
      system: MATCH_SUGGEST_SYSTEM,
      prompt: matchSuggestPrompt(profile, await this.repository.listShotsForMatchSuggest({ projectId }), excludedShotIds),
      thinking: "disabled",
      maxTokens: MATCH_SUGGEST_MAX_TOKENS,
    }, (completion) => {
      try {
        return matchSuggestOutputSchema.parse(parseJsonValue(completion.content));
      } catch {
        throw new AppError(502, "ai_invalid_response", "剧集匹配没成：AI 返回的结果不可读，请稍后重试。", true);
      }
    });
    // 服务端校验:定位键必须命中真实 shot,幻觉镜号丢弃;同一 shot 只出一条建议。
    const seenShotIds = new Set<string>();
    const validated: LiteMatchSuggestItem[] = [];
    for (const suggestion of suggestions) {
      const found = await this.repository.findShotByLabel({
        projectId,
        episodeNo: suggestion.episode_no,
        shotNo: suggestion.shot_no,
      });
      if (!found || seenShotIds.has(found.shotId) || excludedShotIds.has(found.shotId)) continue;
      seenShotIds.add(found.shotId);
      const info = await this.repository.findShotSuggestInfo({ projectId, shotId: found.shotId });
      if (!info) continue;
      validated.push({
        episodeNo: info.episodeNo,
        shotNo: info.shotNo,
        sceneName: info.sceneName,
        shotId: found.shotId,
        reason: suggestion.reason,
        conflictVariantName: null,
      });
    }
    return validated;
  }

  /**
   * v0.9 C 层(AI 自动挂,用户拍板 2026-08-19):对本项目全部变体跑 AI 语义匹配,
   * 校验后写出现记录(matched_by="ai_auto",只写 usages 不写生成快照)。
   * 无网关/无变体/异常 → 跳过并带原因,不阻断 materialize。
   */
  private async runAutoVariantMatch(input: {
    actorId: string;
    projectId: string;
    episodeId: string;
    episodeNo: number;
  }): Promise<{ aiVariantMatches: number; aiVariantMatchSkipped: string | null }> {
    if (!this.gateway) return { aiVariantMatches: 0, aiVariantMatchSkipped: "no_gateway" };
    try {
      const variants = await this.repository.listVariantsForAutoMatch({ projectId: input.projectId });
      if (variants.length === 0) return { aiVariantMatches: 0, aiVariantMatchSkipped: "no_variants" };
      const shots = await this.repository.listShotsForMatchSuggest({ projectId: input.projectId });
      if (shots.length === 0) return { aiVariantMatches: 0, aiVariantMatchSkipped: "no_shots" };
      const writes: Array<{
        assetEntityId: string;
        variantId: string;
        shotId: string;
        shotNo: number;
        sceneName: string | null;
        sourceTextSnippets: string[];
      }> = [];
      for (const variant of variants) {
        // 排除集:该变体已有关联(manual/exact_name/ai_auto/pending)的 shot 不再重复建议。
        const usages = await this.repository.listAssetUsages({ projectId: input.projectId, assetEntityId: variant.assetEntityId });
        const excluded = new Set(
          usages
            .filter((u) => u.variantId === variant.variantId || (u.variantId === null && u.status === "pending"))
            .map((u) => u.shotId)
            .filter((id): id is string => id !== null),
        );
        const items = await this.runMatchSuggest(input.actorId, input.projectId, variant, excluded, this.gateway);
        for (const item of items) {
          if (item.episodeNo !== input.episodeNo) continue; // 只挂本集
          const shot = shots.find((s) => s.shotId === item.shotId);
          writes.push({
            assetEntityId: variant.assetEntityId,
            variantId: variant.variantId,
            shotId: item.shotId,
            shotNo: item.shotNo,
            sceneName: item.sceneName,
            sourceTextSnippets: shot?.scriptText
              ? shot.scriptText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
              : [],
          });
        }
      }
      if (writes.length === 0) return { aiVariantMatches: 0, aiVariantMatchSkipped: null };
      const written = await this.repository.writeAiAutoUsages({
        projectId: input.projectId,
        episodeId: input.episodeId,
        episodeNo: input.episodeNo,
        writes,
        now: this.now(),
      });
      return { aiVariantMatches: written, aiVariantMatchSkipped: null };
    } catch (error) {
      this.logger?.info({ err: error }, "lite C-layer AI auto variant match skipped");
      return { aiVariantMatches: 0, aiVariantMatchSkipped: error instanceof Error ? error.message : "ai_auto_match_failed" };
    }
  }
}
