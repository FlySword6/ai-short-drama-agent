import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "../../shared/errors.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import { breakdownSystemPrompt, breakdownUserPrompt, runBreakdownAgent, type BreakdownTurnResult } from "./agent/runner.js";
import { prelinkedCharacterAsset } from "./agent/workspace.js";
import type { BreakdownFillEvent } from "./agent/tools.js";
import {
  assertScriptBounds,
  chunkScriptLines,
  formatLinesForPrompt,
  ScriptInputError,
} from "./lines.js";
import { mapDraftToFormal } from "./mapper.js";
import { validateRunDraft } from "./validators.js";
import {
  DEGRADED_STORYBOARD_OUTPUT_SCHEMA_PROMPT,
  DEGRADED_STORYBOARD_SYSTEM_PROMPT,
  STORYBOARD_SKILL_TEXT,
  storyboardOutputSchemaPrompt,
} from "./storyboard-skill.js";
import { parseStoryboardOutput, type ParsedStoryboardShot } from "./storyboard-parse.js";
import {
  PROMPT_VERSION,
  type ApprovedAssetSummary,
  type ConfirmResult,
  type PersistedFillEvent,
  type RunUsage,
  type ScriptBreakdownAccessPort,
  type ScriptBreakdownDraft,
  type ScriptBreakdownGateway,
  type ScriptBreakdownRepository,
  type ScriptBreakdownRunRecord,
  type ScriptBreakdownStageRecord,
  type ScriptVersionRecord,
  type SceneDivision,
  type ScriptLine,
  type ShotCandidate,
} from "./types.js";

/** 阶段②长调用期间的心跳节奏:必须小于回收器的 5 分钟失联窗口。 */
export const STAGE_HEARTBEAT_INTERVAL_MS = 60_000;

export interface ScriptBreakdownServiceConfig {
  promptVersion?: string;
  now?: () => Date;
  /** 阶段②心跳节奏覆盖:默认 STAGE_HEARTBEAT_INTERVAL_MS,只为测试能毫秒级走完。 */
  stageHeartbeatIntervalMs?: number;
  /** 可选结构化日志(pino 兼容);不传则只走 trace 文件。 */
  logger?: { info(obj: Record<string, unknown>, msg: string): void; error?(obj: Record<string, unknown>, msg: string): void };
  /** 设置后把「一键生成本集」全链路步骤日志与模型提示词全文落盘(本地排障用)。 */
  traceDir?: string;
}

export interface CreateScriptVersionInput {
  title: string | null;
  scriptText: string;
  clientIdempotencyKey: string;
}

export interface CreateRunInput {
  scriptVersionId: string;
  targetDurationSec: number | null;
  clientIdempotencyKey: string;
}

export interface RunDetail {
  run: ScriptBreakdownRunRecord;
  stages: ScriptBreakdownStageRecord[];
  /** 拆解过程的人话事件流,按 sequence 排序。 */
  events: PersistedFillEvent[];
}

/**
 * 一次拆解允许的工具调用次数上限。取的是领域上限之上一点点(60 场 + 180 个
 * 资产 + 300 个镜头 + 梗概 + 收尾),让最大规模的剧本也拆得完,同时挡住跑飞。
 */
const MAX_TOOL_CALLS = 600;

/**
 * 一次拆解允许的模型往返次数上限。这一条不是性能参数,是钱的闸:每一轮
 * 都是一次真实付费调用,也占用调用方当天的 AI 额度一格。真实剧本实测
 * 10-20 轮、悲观 40-60 轮,取 60 既能拆完又有确定的花费上界。
 */
const MAX_TURNS = 60;

/** 执行途中运行被外部放弃或抢占:立刻停手,不再发起付费调用。 */
class RunNoLongerOursError extends Error {
  constructor() {
    super("run no longer owned by this executor");
    this.name = "RunNoLongerOursError";
  }
}

/** trace 文件里每个步骤的固定形状:第几步 / 哪个函数 / 内容。 */
function traceStep(step: number, fn: string, lines: string[]): string {
  return `\n===== [步骤 ${step}] ${fn} =====\n${lines.join("\n")}\n`;
}

/** 提示词全文块:长度 + 分隔线包裹的原文,方便直接拷给模型复现。 */
function tracePromptBlock(label: string, text: string): string[] {
  return [
    `--- ${label}(长度 ${text.length} 字符) ---`,
    text,
    `--- ${label} 结束 ---`,
  ];
}

/**
 * 用例编排。AI 产出只经 executeRun 落草稿区;正式 scenes/shots 只经
 * confirmRun 的人工确认事务。两者之间的边界是本模块的核心红线。
 */
export class ScriptBreakdownService {
  private readonly now: () => Date;
  private readonly promptVersion: string;
  private readonly stageHeartbeatIntervalMs: number;
  private readonly logger?: ScriptBreakdownServiceConfig["logger"];
  private readonly traceDir?: string;

  constructor(
    private readonly repository: ScriptBreakdownRepository,
    private readonly gateway: ScriptBreakdownGateway,
    private readonly access: ScriptBreakdownAccessPort,
    config: ScriptBreakdownServiceConfig = {},
  ) {
    this.now = config.now ?? (() => new Date());
    this.promptVersion = config.promptVersion ?? PROMPT_VERSION;
    this.stageHeartbeatIntervalMs = config.stageHeartbeatIntervalMs ?? STAGE_HEARTBEAT_INTERVAL_MS;
    this.logger = config.logger;
    this.traceDir = config.traceDir;
  }

  /**
   * 「一键生成本集」排障 trace:未配 traceDir 时是空操作。每次 executeRun 一个文件,
   * 文件名带 runId;内容=步骤号+函数名+模型提示词全文。写入失败只降级不抛错。
   */
  private async trace(runId: string, step: number, fn: string, lines: string[]): Promise<void> {
    if (!this.traceDir) return;
    try {
      await mkdir(this.traceDir, { recursive: true });
      const stamp = this.now().toISOString();
      await appendFile(resolve(this.traceDir, `breakdown-trace-${runId}.log`), traceStep(step, fn, [`${stamp}`, ...lines]));
    } catch { /* 排障设施不许把主链路弄挂 */ }
  }

  async createScriptVersion(
    actor: ProjectAccessActor,
    episodeId: string,
    input: CreateScriptVersionInput,
  ): Promise<{ version: ScriptVersionRecord; outcome: "created" | "existing" }> {
    const episode = await this.requireCreativeEpisode(actor, episodeId);
    const scriptText = input.scriptText.trim();
    try {
      assertScriptBounds(scriptText, chunkScriptLines(scriptText));
    } catch (error) {
      if (error instanceof ScriptInputError) throw new BadRequestError("剧本内容不符合要求，请检查后再试。");
      throw error;
    }
    const scriptSha256 = sha256Hex(scriptText);
    return this.repository.createScriptVersion({
      episodeId: episode.id,
      title: input.title,
      scriptText,
      scriptSha256,
      createdByUserId: actor.id,
      clientIdempotencyKey: input.clientIdempotencyKey,
      requestHash: scriptSha256,
      now: this.now(),
    });
  }

  async listScriptVersions(actor: ProjectAccessActor, episodeId: string): Promise<ScriptVersionRecord[]> {
    await this.requireReadableEpisode(actor, episodeId);
    return this.repository.listScriptVersions(episodeId);
  }

  /**
   * 创建一次拆解运行。运行本身不触发任何正式表写入;执行由调用方决定
   * (路由后台执行,测试内联执行)。
   */
  async createRun(
    actor: ProjectAccessActor,
    episodeId: string,
    input: CreateRunInput,
  ): Promise<{ run: ScriptBreakdownRunRecord; outcome: "created" | "existing" }> {
    const episode = await this.requireCreativeEpisode(actor, episodeId);
    const version = await this.repository.getScriptVersion(input.scriptVersionId);
    if (!version || version.episodeId !== episode.id) {
      throw new BadRequestError("剧本版本不存在或不属于该集");
    }
    const activeRun = await this.repository.findActiveRun(episode.id);
    if (activeRun && (
      activeRun.createdByUserId !== actor.id
      || activeRun.clientIdempotencyKey !== input.clientIdempotencyKey
    )) {
      throw new ConflictError("这一集正在解析中，请稍候", "lite_run_in_flight");
    }
    const requestHash = sha256Hex(JSON.stringify({
      episode_id: episode.id,
      script_version_id: version.id,
      target_duration_sec: input.targetDurationSec,
    }));
    const inputSha256 = sha256Hex(`${version.scriptSha256}:${this.promptVersion}`);
    return this.repository.createRun({
      episodeId: episode.id,
      scriptVersionId: version.id,
      createdByUserId: actor.id,
      clientIdempotencyKey: input.clientIdempotencyKey,
      requestHash,
      promptVersion: this.promptVersion,
      inputSha256,
      targetDurationSec: input.targetDurationSec,
      now: this.now(),
    });
  }

  async getRun(actor: ProjectAccessActor, runId: string): Promise<RunDetail> {
    const run = await this.requireRun(actor, runId, "read");
    const [stages, events] = await Promise.all([
      this.repository.listStages(run.id),
      this.repository.listFillEvents(run.id),
    ]);
    return { run, stages, events };
  }

  async listRuns(actor: ProjectAccessActor, episodeId: string): Promise<ScriptBreakdownRunRecord[]> {
    await this.requireReadableEpisode(actor, episodeId);
    return this.repository.listRuns(episodeId);
  }

  /**
   * 断点续跑:放行一次失败的运行,让执行器重新认领。
   *
   * 「已经填好的不重做」不靠这里,靠 run.draft——executeRun 把它交给 agent
   * 当起点。这里只做三件事:状态闸、版本闸,以及 resetStagesForResume 这一次
   * 原子重置(它同时是并发闸:已被新执行认领时返回 false)。
   */
  async resumeRun(actor: ProjectAccessActor, runId: string): Promise<ScriptBreakdownRunRecord> {
    const run = await this.requireRun(actor, runId, "create");
    if (run.status !== "failed" && run.status !== "queued") {
      throw new ConflictError("只有失败或待执行的拆解才能继续", "run_not_resumable");
    }
    if (run.promptVersion !== this.promptVersion) {
      throw new ConflictError(
        "这次拆解使用的整理规则已经更新，请重新开始一次拆解",
        "prompt_version_outdated",
      );
    }
    const reset = await this.repository.resetStagesForResume(run.id, this.now());
    if (!reset) {
      throw new ConflictError("只有失败或待执行的拆解才能继续", "run_not_resumable");
    }
    const resumed = await this.repository.getRun(run.id);
    if (!resumed) throw new NotFoundError("拆解记录不存在");
    return resumed;
  }

  async discardRun(actor: ProjectAccessActor, runId: string): Promise<ScriptBreakdownRunRecord> {
    const run = await this.requireRun(actor, runId, "create");
    const outcome = await this.repository.discardRun({ runId: run.id, actorId: actor.id, now: this.now() });
    if (outcome === "not_found") throw new NotFoundError("拆解记录不存在");
    if (outcome === "not_discardable") {
      throw new ConflictError("已确认或已被替换的拆解不能放弃", "run_not_discardable");
    }
    const fresh = await this.repository.getRun(run.id);
    if (!fresh) throw new NotFoundError("拆解记录不存在");
    return fresh;
  }

  /**
   * 人工确认:把草稿映射进正式 scenes/shots 的唯一入口。重复确认返回
   * 同一结果(already_confirmed),不重复建行。
   */
  async confirmRun(actor: ProjectAccessActor, runId: string): Promise<ConfirmResult> {
    const run = await this.requireRun(actor, runId, "create");
    if (run.status === "confirmed") {
      return this.repository.confirmRun({
        runId: run.id,
        actor,
        mapping: {
          scenes: [],
          shots: [],
          assetCandidates: { characters: [], scenes: [], props: [], costumes: [], audios: [] },
          unmatchedAssets: [],
        },
        now: this.now(),
      });
    }
    if (run.status !== "draft") {
      const message = run.status === "superseded"
        ? "这次拆解已被更新的确认替换"
        : run.status === "discarded"
          ? "这次拆解已放弃,不能确认"
          : "拆解尚未完成,不能确认";
      throw new ConflictError(message, "run_not_confirmable");
    }
    if (run.promptVersion !== this.promptVersion) {
      throw new ConflictError(
        "这次拆解使用的整理规则已经更新，请重新开始一次拆解",
        "prompt_version_outdated",
      );
    }
    const version = await this.repository.getScriptVersion(run.scriptVersionId);
    if (!version) throw new ConflictError("剧本版本不存在,不能确认", "script_version_unavailable");
    const episode = await this.repository.findEpisode(run.episodeId);
    if (!episode || episode.deletedAt || episode.status !== "active") {
      throw new ConflictError("剧集已删除或归档,不能确认旧草稿", "episode_unavailable");
    }
    const sceneDivisions = run.draft.sceneDivisions;
    const assetCandidates = run.draft.assetCandidates;
    const shotCandidates = run.draft.shotCandidates;
    if (!run.draft.storySummary || !sceneDivisions || !assetCandidates || !shotCandidates) {
      throw new ConflictError("草稿内容不完整,不能确认", "draft_incomplete");
    }
    const approvedAssets = await this.repository.listApprovedProjectAssetsByNames(
      episode.projectId,
      referencedAssetNames({ assetCandidates, shotCandidates }),
    );
    const mapping = mapDraftToFormal({
      runId: run.id,
      episodeId: episode.id,
      draft: { sceneDivisions, assetCandidates, shotCandidates },
      scriptLines: chunkScriptLines(version.scriptText),
      approvedAssets,
    });
    const confirmed = await this.repository.confirmRun({ runId: run.id, actor, mapping, now: this.now() });
    this.logger?.info({ step: 11, fn: "ScriptBreakdownService.confirmRun", runId, outcome: confirmed.outcome, scenes: confirmed.sceneCount, shots: confirmed.shotCount }, "lite one-click: 确认事务完成");
    await this.trace(runId, 11, "ScriptBreakdownService.confirmRun", [
      `确认事务完成:outcome=${confirmed.outcome} scenes=${confirmed.sceneCount} shots=${confirmed.shotCount} superseded=${confirmed.supersededRunIds.length} unmatchedAssets=${confirmed.unmatchedAssets.length}`,
    ]);
    return confirmed;
  }

  /**
   * 执行一次拆解:把剧本交给 agent,由它一层层调工具往草稿框架里填。
   *
   * 服务层在这里只做三件模型做不了的事——守住闸(认领、版本、可用性、
   * 围栏)、每填一格就落一次库(它是断点续跑唯一的内容真源)、以及最后
   * 拿未截断的资产清单重算一遍校验。AI 输出只写草稿区表;正式 scenes/shots
   * 只经 confirmRun 落库——options.autoConfirm 是它的自动触发口(Lite 一键
   * 生成本集默认采用),草稿定稿后由本方法续调 confirmRun;确认失败不抛出
   * (草稿已定稿,前端轮询到 draft 后仍有手动/自动确认兜底)。
   */
  async executeRun(runId: string, actorId: string, options: { autoConfirm?: boolean } = {}): Promise<void> {
    const executionToken = await this.repository.claimExecution(runId, this.now());
    if (!executionToken) return;
    const run = await this.repository.getRun(runId);
    if (!run) return;
    this.logger?.info({ step: 3, fn: "ScriptBreakdownService.executeRun", runId, autoConfirm: options.autoConfirm ?? false }, "lite one-click: 后台执行开始");
    await this.trace(runId, 3, "ScriptBreakdownService.executeRun", [
      `拿到执行令牌,进入后台执行:autoConfirm=${options.autoConfirm ? "true" : "false"} promptVersion=${run.promptVersion}`,
    ]);
    if (run.promptVersion !== this.promptVersion) {
      await this.repository.finalizeRunFailed({
        runId,
        executionToken,
        currentStage: null,
        errorCode: "prompt_version_outdated",
        errorMessage: "这次拆解使用的整理规则已经更新，请重新开始一次拆解",
        now: this.now(),
      });
      return;
    }
    const version = await this.repository.getScriptVersion(run.scriptVersionId);
    const episode = await this.repository.findEpisode(run.episodeId);
    if (!version || !episode || episode.deletedAt || episode.status !== "active") {
      await this.repository.finalizeRunFailed({
        runId,
        executionToken,
        currentStage: null,
        errorCode: "episode_unavailable",
        errorMessage: "剧集或剧本版本已不可用,无法继续拆解",
        now: this.now(),
      });
      return;
    }

    const scriptLines = chunkScriptLines(version.scriptText);
    // 给模型看的资产清单是限量摘要。它只影响提示词,不能用来判归属——
    // 唯一性与歧义一律在收尾时用未截断清单重算(见下面的 finalize)。
    const promptAssets = await this.repository.listApprovedProjectAssets(episode.projectId);
    // 预算解析失败(用途没配模型)是配置问题,不是内容问题:如实记进运行,
    // 不用一个兜底数字把「没配好」伪装成「就该这么小」。
    let maxTokens: number;
    try {
      maxTokens = await this.gateway.stageOutputBudgetFor("script_breakdown_enrich");
    } catch (error) {
      const failure = toRunFailure(error);
      await this.repository.finalizeRunFailed({
        runId,
        executionToken,
        currentStage: null,
        errorCode: failure.errorCode,
        errorMessage: failure.message,
        now: this.now(),
      });
      return;
    }

    let usage: RunUsage = run.usage;
    let modelName: string | null = run.modelName;
    const events: PersistedFillEvent[] = await this.repository.listFillEvents(runId);
    let turnError: unknown = null;
    let stageOneTurn = 0;
    await this.trace(runId, 4, "ScriptBreakdownService.executeRun → runBreakdownAgent", [
      `阶段①(场次/资产登记 agent)开始:剧本 ${scriptLines.length} 行、已通过资产 ${promptAssets.length} 条、maxTurns=${MAX_TURNS}、maxToolCalls=${MAX_TOOL_CALLS}`,
      ...tracePromptBlock("阶段① system 提示词(全文)", breakdownSystemPrompt()),
      ...tracePromptBlock("阶段① user 提示词(全文,含编号剧本)", breakdownUserPrompt({ scriptLines, approvedAssets: promptAssets, targetDurationSec: run.targetDurationSec }, run.draft)),
    ]);

    const result = await runBreakdownAgent({
      context: {
        scriptLines,
        approvedAssets: promptAssets,
        targetDurationSec: run.targetDurationSec,
      },
      // 续跑:上一次填到哪,这一次从哪接着填,已经填好的不重做。
      restoredDraft: run.draft,
      maxToolCalls: MAX_TOOL_CALLS,
      maxTurns: MAX_TURNS,
      now: this.now,
      turn: async (input): Promise<BreakdownTurnResult> => {
        try {
          // 每一轮开始前先确认这次运行还归我们:被放弃或被抢占了就当场停手,
          // 不再发下一次付费调用。网关那层的执行围栏是同一件事的第二道保险。
          const current = await this.repository.getRun(runId);
          if (!current || current.status !== "running") throw new RunNoLongerOursError();
          stageOneTurn += 1;
          await this.trace(runId, 5, `executeRun 阶段① turn 闭包(第 ${stageOneTurn} 轮)`, [
            `发起阶段①模型调用 #${stageOneTurn}:purpose=script_breakdown_enrich、messages=${input.messages.length} 条、tools=${input.tools.length} 个`,
          ]);
          const turn = await this.gateway.runToolTurn({
            actorId,
            purpose: "script_breakdown_enrich",
            system: input.system,
            prompt: "",
            messages: input.messages,
            tools: input.tools,
            projectId: episode.projectId,
            relatedObject: { type: "script_breakdown_run", id: run.id },
            executionFence: { type: "script_breakdown_run", runId: run.id, token: executionToken },
            thinking: "disabled",
            maxTokens,
          });
          await this.trace(runId, 6, `executeRun 阶段① turn 闭包(第 ${stageOneTurn} 轮返回)`, [
            `model=${turn.model} inputTokens=${turn.inputTokens ?? "?"} outputTokens=${turn.outputTokens ?? "?"} durationMs=${turn.durationMs ?? "?"}`,
            `toolCalls=${turn.toolCalls.map((call) => call.name).join(",") || "(无)"}`,
          ]);
          modelName = turn.model;
          usage = {
            callCount: usage.callCount + 1,
            totalInputTokens: usage.totalInputTokens + (turn.inputTokens ?? 0),
            totalOutputTokens: usage.totalOutputTokens + (turn.outputTokens ?? 0),
          };
          return {
            text: turn.content,
            toolCalls: turn.toolCalls,
            unreadableToolCalls: turn.unreadableToolCalls,
            model: turn.model,
            inputTokens: turn.inputTokens,
            outputTokens: turn.outputTokens,
            durationMs: turn.durationMs,
          };
        } catch (error) {
          // 循环会把这条异常收成一条空的助手消息,原因就此丢失。先接住,
          // 收尾时用它给出真正的错误码,而不是笼统的「模型没干活」。
          turnError = error;
          throw error;
        }
      },
      onEvent: async (event) => {
        // 序号由这里给,不用 runner 的:runner 每次运行从 1 开始数,续跑之后
        // 界面上就会看到两段各自从 1 起的事件。整条运行只有一条流。
        events.push(toPersistedFillEvent(event, events.length + 1));
        await this.repository.recordFillEvents({ runId, executionToken, events, now: this.now() });
      },
      // 每填进去一格就落一次库。这一步是断点续跑的全部依据:少了它,
      // 进程中途一挂就只能整份重做。
      onFilled: async (draft) => {
        await this.repository.updateRunExecution({
          runId,
          executionToken,
          currentStage: null,
          draft,
          usage,
          ...(modelName ? { modelName } : {}),
          now: this.now(),
        });
      },
    });

    // 被放弃或被抢占:运行已经由别人关账,这里不许再写一笔盖掉它。
    if (turnError instanceof RunNoLongerOursError) return;

    if (!result.completed) {
      const failure = turnError && result.turnFailure
        ? toRunFailure(turnError)
        : {
          errorCode: result.stopReason ? "breakdown_budget_exhausted" : "breakdown_incomplete",
          message: result.unfinishedReason ?? "拆解没有正常收尾,请重试。",
        };
      await this.repository.finalizeRunFailed({
        runId,
        executionToken,
        currentStage: null,
        errorCode: failure.errorCode,
        errorMessage: failure.message,
        usage,
        now: this.now(),
      });
      return;
    }

    // P6 阶段②:skill 单次结构化拆镜。阶段① 只产场次与资产;分镜在这里一次生成。
    // 续跑时草稿里已有镜头(上一次阶段②已成功)就不重拆——已经填好的不重做。
    let draft = result.draft;
    if ((draft.shotCandidates ?? []).length === 0) {
      const storyboard = await this.runStoryboardStage({
        runId,
        executionToken,
        actorId,
        projectId: episode.projectId,
        run,
        draft,
        scriptLines,
        usage,
        setModel: (name) => { modelName = name; },
      });
      if (!storyboard) return; // 阶段②失败已如实关账
      draft = storyboard.draft;
      usage = storyboard.usage;
    }

    await this.finalizeRunDraft({
      runId,
      executionToken,
      run,
      draft,
      usage,
      projectId: episode.projectId,
      scriptLines,
    });

    // 一键生成本集默认采用:草稿定稿即确认,不等人点「采用」。确认失败
    // 不让执行报错——run 停在 draft 就是可见状态,前端与人工确认都能接住。
    if (options.autoConfirm) {
      await this.trace(runId, 10, "ScriptBreakdownService.executeRun(autoConfirm)", [
        "auto_confirm=true:服务端自动确认(一键生成本集默认采用),不等人点「采用」",
      ]);
      try {
        await this.confirmRun({ id: actorId }, runId);
      } catch (error) {
        /* 草稿已定稿;确认失败由 draft 状态兜底,见方法注释。 */
        await this.trace(runId, 10, "ScriptBreakdownService.executeRun(autoConfirm 失败)", [
          `confirmRun 抛错,run 停 draft,前端回落手动确认:${error instanceof Error ? error.message : String(error)}`,
        ]);
      }
    }
  }

  /**
   * P6 阶段②(§2 P6 B):固定 skill 单次结构化拆镜。
   *
   * system = skill 全文 + 输出 schema;user = 编号剧本 + 场次清单 + 资产库清单
   * (五类候选 ∪ 已通过项目资产)+ 默认视频风格 + 生效视频模板。skill 常量被
   * 清空时自动落降级态(通用拆镜,video_prompt 模型直出,storyboard_detail 恒 null)。
   *
   * 失败返回 null(已按现有 finalizeRunFailed 关账);成功返回带全部分镜的草稿。
   * @ 引用只是提示词文本,不写快照——付费生成时参考媒体仍按分镜
   * reference_asset_snapshots 的变体主图解析(§3.4.7)。
   */
  private async runStoryboardStage(input: {
    runId: string;
    executionToken: string;
    actorId: string;
    projectId: string;
    run: ScriptBreakdownRunRecord;
    draft: ScriptBreakdownDraft;
    scriptLines: ScriptLine[];
    usage: RunUsage;
    setModel: (name: string) => void;
  }): Promise<{ draft: ScriptBreakdownDraft; usage: RunUsage } | null> {
    const fail = async (errorCode: string, message: string, usage: RunUsage): Promise<null> => {
      await this.repository.finalizeRunFailed({
        runId: input.runId,
        executionToken: input.executionToken,
        currentStage: null,
        errorCode,
        errorMessage: message,
        usage,
        now: this.now(),
      });
      return null;
    };

    // 付费调用前确认运行仍归我们(与阶段①同一道闸)。
    const current = await this.repository.getRun(input.runId);
    if (!current || current.status !== "running") return null;

    const degraded = STORYBOARD_SKILL_TEXT.trim().length === 0;
    let config;
    let maxTokens;
    try {
      config = await this.repository.resolveStoryboardVideoConfig(input.projectId);
      maxTokens = await this.gateway.stageOutputBudgetFor("script_breakdown_storyboard");
    } catch (error) {
      const failure = toRunFailure(error);
      return fail(failure.errorCode, failure.message, input.usage);
    }

    // 诊断日志:打印取到的阶段②视频配置全文(默认视频风格 + 生效视频模板),用于定位
    // 「分镜提示词没结合项目风格 / 模板」。pino 结构化日志(stdout)随时可见;trace 文件
    // 只在配置了 traceDir 时落盘,与既有「一键生成本集」排障口径一致。
    this.logger?.info({
      step: 7,
      fn: "ScriptBreakdownService.runStoryboardStage",
      runId: input.runId,
      projectId: input.projectId,
      videoStyleDescription: config.styleDescription ?? null,
      videoPromptTemplate: config.promptTemplate,
      shotsPerSegment: config.shotsPerSegment ?? null,
    }, "lite one-click: 取到阶段②视频配置(默认视频风格 + 生效视频模板)");
    await this.trace(input.runId, 7, "ScriptBreakdownService.runStoryboardStage", [
      "阶段②视频配置全文(视频风格 + 生效视频模板):",
      ...tracePromptBlock("默认视频风格(projects.video_style_description)", config.styleDescription ?? "(项目未设置默认视频风格)"),
      ...tracePromptBlock("生效视频模板(项目设置→策略→用户/平台模板→代码常量)", config.promptTemplate),
      `shotsPerSegment(每段分镜 Shot 数):${config.shotsPerSegment ?? "(未设置=自由)"}`,
    ]);

    const scenes = input.draft.sceneDivisions ?? [];
    const candidates: NonNullable<ScriptBreakdownDraft["assetCandidates"]> = input.draft.assetCandidates
      ?? { characters: [], scenes: [], props: [], costumes: [], audios: [] };
    const approvedAssets = await this.repository.listApprovedProjectAssets(input.projectId);
    const knownAssetNames = new Set<string>([
      ...candidates.characters.map((asset) => asset.name),
      ...candidates.scenes.map((asset) => asset.name),
      ...candidates.props.map((asset) => asset.name),
      ...candidates.costumes.map((asset) => asset.name),
      ...candidates.audios.map((asset) => asset.name),
      ...approvedAssets.map((asset) => asset.name),
    ]);

    const system = degraded
      ? `${DEGRADED_STORYBOARD_SYSTEM_PROMPT}\n\n${DEGRADED_STORYBOARD_OUTPUT_SCHEMA_PROMPT}`
      : `${STORYBOARD_SKILL_TEXT}\n\n${storyboardOutputSchemaPrompt(config.shotsPerSegment)}`;
    await this.trace(input.runId, 7, "ScriptBreakdownService.runStoryboardStage", [
      `阶段②(skill 单次结构化拆镜)开始:degraded=${degraded ? "true" : "false"} scenes=${scenes.length} 资产库=${knownAssetNames.size} 条 maxTokens=${maxTokens}`,
      ...tracePromptBlock("阶段② system 提示词(全文:skill 合同 + 输出 schema)", system),
    ]);

    // 阶段②一次调用可放宽到 10 分钟(AI_PURPOSE_TIMEOUT_OVERRIDES),超过
    // 回收器的 5 分钟失联窗口。调用期间每 60 秒用执行令牌 touch 一次
    // updatedAt——心跳即存活证明:令牌失效(被回收/被抢占)时 touch 是
    // 空操作,围栏会在下一次检查拦下执行。
    const heartbeat = setInterval(() => {
      void this.repository.updateRunExecution({
        runId: input.runId,
        executionToken: input.executionToken,
        currentStage: null,
        now: this.now(),
      }).catch(() => { /* 心跳不中断主调用;失联由回收器兜底 */ });
    }, this.stageHeartbeatIntervalMs);
    heartbeat.unref();

    let completion;
    try {
      completion = await this.gateway.complete({
        actorId: input.actorId,
        purpose: "script_breakdown_storyboard",
        system,
        prompt: (() => {
          const userPrompt = storyboardUserPrompt({
            scriptLines: input.scriptLines,
            targetDurationSec: input.run.targetDurationSec,
            scenes,
            assetLibrary: storyboardAssetLibrary(candidates, approvedAssets),
            styleDescription: config.styleDescription,
            promptTemplate: config.promptTemplate,
          });
          void this.trace(input.runId, 7, "ScriptBreakdownService.runStoryboardStage", tracePromptBlock("阶段② user 提示词(全文:编号剧本+场次+资产库+风格+生效模板)", userPrompt));
          return userPrompt;
        })(),
        projectId: input.projectId,
        relatedObject: { type: "script_breakdown_run", id: input.run.id },
        executionFence: { type: "script_breakdown_run", runId: input.run.id, token: input.executionToken },
        thinking: "disabled",
        maxTokens,
      });
    await this.trace(input.runId, 8, "runStoryboardStage → gateway.complete 返回", [
      `model=${completion.model} inputTokens=${completion.inputTokens ?? "?"} outputTokens=${completion.outputTokens ?? "?"}`,
      ...tracePromptBlock("阶段②模型原始输出", completion.content),
    ]);
    } catch (error) {
      // 当场用真实原因关账(超时/网关故障等):异常穿出执行器会让 run
      // 停在 running,五分钟后才被回收器扣上「执行进程失联」,真因被盖掉。
      const failure = toRunFailure(error);
      return fail(failure.errorCode, failure.message, input.usage);
    } finally {
      clearInterval(heartbeat);
    }
    const usage: RunUsage = {
      callCount: input.usage.callCount + 1,
      totalInputTokens: input.usage.totalInputTokens + (completion.inputTokens ?? 0),
      totalOutputTokens: input.usage.totalOutputTokens + (completion.outputTokens ?? 0),
    };
    input.setModel(completion.model);

    const parsed = parseStoryboardOutput({
      content: completion.content,
      lineCount: input.scriptLines.length,
      degraded,
      shotsPerSegment: degraded ? null : config.shotsPerSegment,
      knownAssetNames,
      fallbackDurationSec: 5,
    });
    if (parsed.issues.length > 0) {
      return fail("storyboard_validation_failed", `拆镜结果未通过校验:${parsed.issues[0]}`, usage);
    }

    const shotCandidates = parsed.shots.map((shot, index) => toShotCandidate({
      shot,
      index,
      scenes,
      degraded,
    }));

    const draft: ScriptBreakdownDraft = { ...input.draft, shotCandidates };
    // 阶段②落库一次——与阶段①同口径,它是续跑的内容真源。
    await this.repository.updateRunExecution({
      runId: input.runId,
      executionToken: input.executionToken,
      currentStage: null,
      draft,
      usage,
      modelName: completion.model,
      now: this.now(),
    });
    return { draft, usage };
  }

  /**
   * 收尾:用未截断的资产清单重算一遍。
   *
   * agent 跑的时候手里只有限量摘要,所以它算出的预关联与校验都不能当最终
   * 判据——第 201 条同名资产落在摘要外面时,「唯一同名」会算成真,草稿就
   * 会带着一条不该有的绑定进确认环节。
   */
  private async finalizeRunDraft(input: {
    runId: string;
    executionToken: string;
    run: ScriptBreakdownRunRecord;
    draft: ScriptBreakdownDraft;
    usage: RunUsage;
    projectId: string;
    scriptLines: ReturnType<typeof chunkScriptLines>;
  }): Promise<void> {
    const approvedAssets = await this.repository.listApprovedProjectAssetsByNames(
      input.projectId,
      referencedAssetNames(input.draft),
    );

    const draft = withResolvedPrelinks(input.draft, approvedAssets);
    const runValidation = validateRunDraft({
      draft: {
        sceneDivisions: draft.sceneDivisions ?? [],
        assetCandidates: draft.assetCandidates ?? { characters: [], scenes: [], props: [], costumes: [], audios: [] },
        shotCandidates: draft.shotCandidates ?? [],
      },
      lineCount: input.scriptLines.length,
      approvedAssets,
      targetDurationSec: input.run.targetDurationSec,
    });
    await this.repository.updateRunExecution({
      runId: input.runId,
      executionToken: input.executionToken,
      currentStage: null,
      draft,
      usage: input.usage,
      now: this.now(),
    });
    if (runValidation.hardIssues.length > 0) {
      const first = runValidation.hardIssues[0]!;
      await this.repository.finalizeRunFailed({
        runId: input.runId,
        executionToken: input.executionToken,
        currentStage: null,
        errorCode: "contract_validation_failed",
        errorMessage: `拆解结果未通过完整性校验:${first.message}`,
        validation: {
          status: "failed",
          issues: runValidation.hardIssues,
          unmatchedAssets: runValidation.validation.unmatchedAssets,
          duplicateCoverage: runValidation.validation.duplicateCoverage,
          shotCount: runValidation.validation.shotCount,
          totalDurationSec: runValidation.validation.totalDurationSec,
        },
        usage: input.usage,
        now: this.now(),
      });
      return;
    }
    await this.repository.finalizeRunDraft({
      runId: input.runId,
      executionToken: input.executionToken,
      validation: runValidation.validation,
      usage: input.usage,
      now: this.now(),
    });
    const ac = input.draft.assetCandidates;
    await this.trace(input.runId, 9, "ScriptBreakdownService.finalizeRunDraft", [
      `草稿定稿→draft:scenes=${(input.draft.sceneDivisions ?? []).length} assets=${ac ? ac.characters.length + ac.scenes.length + ac.props.length + ac.costumes.length + ac.audios.length : 0} shots=${(input.draft.shotCandidates ?? []).length}`,
    ]);
  }

  private async requireCreativeEpisode(actor: ProjectAccessActor, episodeId: string) {
    const episode = await this.repository.findEpisode(episodeId);
    if (!episode || episode.deletedAt) throw new NotFoundError("剧集不存在");
    await this.access.require(actor, episode.projectId, "create");
    return episode;
  }

  private async requireReadableEpisode(actor: ProjectAccessActor, episodeId: string) {
    const episode = await this.repository.findEpisode(episodeId);
    if (!episode || episode.deletedAt) throw new NotFoundError("剧集不存在");
    await this.access.require(actor, episode.projectId, "read");
    return episode;
  }

  private async requireRun(actor: ProjectAccessActor, runId: string, action: "read" | "create") {
    const run = await this.repository.getRun(runId);
    if (!run) throw new NotFoundError("拆解记录不存在");
    const episode = await this.repository.findEpisode(run.episodeId);
    if (!episode) throw new NotFoundError("拆解记录不存在");
    await this.access.require(actor, episode.projectId, action);
    return run;
  }
}

function referencedAssetNames(
  draft: Pick<ScriptBreakdownDraft, "assetCandidates" | "shotCandidates">,
): string[] {
  return uniqueNames([
    ...(draft.assetCandidates?.characters?.map((candidate) => candidate.name) ?? []),
    ...(draft.assetCandidates?.scenes?.map((candidate) => candidate.name) ?? []),
    ...(draft.assetCandidates?.props?.map((candidate) => candidate.name) ?? []),
    ...(draft.assetCandidates?.costumes?.map((candidate) => candidate.name) ?? []),
    ...(draft.assetCandidates?.audios?.map((candidate) => candidate.name) ?? []),
    ...(draft.shotCandidates?.flatMap((shot) => [
      ...shot.characterNames,
      ...shot.sceneNames,
      ...shot.propNames,
      ...(shot.costumeNames ?? []),
    ]) ?? []),
  ]);
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

/**
 * 拿未截断的资产清单重算每个角色候选的预关联。
 *
 * agent 侧算过一遍,但它手上是限量摘要。同名资产的第二条落在摘要外面时,
 * 「项目里只有一条同名」会算成真——草稿就会带一条不该有的绑定去确认。
 */
function withResolvedPrelinks(
  draft: ScriptBreakdownDraft,
  approvedAssets: ApprovedAssetSummary[],
): ScriptBreakdownDraft {
  if (!draft.assetCandidates) return draft;
  return {
    ...draft,
    assetCandidates: {
      ...draft.assetCandidates,
      characters: draft.assetCandidates.characters.map((candidate) => ({
        ...candidate,
        prelinkedAsset: prelinkedCharacterAsset(candidate.name, approvedAssets),
      })),
    },
  };
}

/**
 * 事件出库前的白名单投影。
 *
 * 逐字段构造,不用展开:出口对面是数据库和导演端,而事件对象上游还挂着
 * 「入参没读全」时那段可能夹带剧本原文的报文片段。新加的字段默认出不去,
 * 想让它出去必须先改这里,顺带被 review 看见。
 */
function toPersistedFillEvent(event: BreakdownFillEvent, sequence: number): PersistedFillEvent {
  return {
    sequence,
    tool: event.tool,
    status: event.status,
    description: event.description,
    reason: event.reason ?? null,
    occurredAt: event.occurredAt,
  };
}

function toRunFailure(error: unknown): { errorCode: string; message: string } {
  if (error instanceof AppError) return { errorCode: error.code, message: error.message };
  return { errorCode: "internal_error", message: "拆解执行出现内部错误,请稍后重试" };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}


/** 阶段②资产库清单(§2 P6 B):五类候选 ∪ 已通过项目资产,逐条「名称 + 描述」。 */
function storyboardAssetLibrary(
  candidates: NonNullable<ScriptBreakdownDraft["assetCandidates"]>,
  approvedAssets: ApprovedAssetSummary[],
): Array<{ kind: string; name: string; description: string | null }> {
  const items: Array<{ kind: string; name: string; description: string | null }> = [
    ...candidates.characters.map((asset) => ({ kind: "character", name: asset.name, description: asset.description })),
    ...candidates.scenes.map((asset) => ({ kind: "scene", name: asset.name, description: asset.description })),
    ...candidates.props.map((asset) => ({ kind: "prop", name: asset.name, description: asset.description })),
    ...candidates.costumes.map((asset) => ({ kind: "costume", name: asset.name, description: asset.description })),
    ...candidates.audios.map((asset) => ({ kind: "audio", name: asset.name, description: asset.description })),
  ];
  const seen = new Set(items.map((item) => `${item.kind}:${item.name}`));
  for (const asset of approvedAssets) {
    if (seen.has(`${asset.assetKind}:${asset.name}`)) continue;
    seen.add(`${asset.assetKind}:${asset.name}`);
    items.push({ kind: asset.assetKind, name: asset.name, description: asset.description ?? null });
  }
  return items;
}

/** 阶段② user 提示:编号剧本 + 时长 + 场次清单 + 资产库清单 + 默认视频风格 + 生效视频模板。 */
function storyboardUserPrompt(input: {
  scriptLines: ScriptLine[];
  targetDurationSec: number | null;
  scenes: SceneDivision[];
  assetLibrary: Array<{ kind: string; name: string; description: string | null }>;
  styleDescription: string | null;
  promptTemplate: string;
}): string {
  const sceneList = input.scenes.length > 0
    ? input.scenes.map((scene) => `- 第 ${scene.sceneIndex} 场「${scene.name ?? "(无场名)"}」:第 ${scene.startLineIndex} 到 ${scene.endLineIndex} 行`).join("\n")
    : "(这一集还没有场次)";
  const assets = input.assetLibrary.length > 0
    ? input.assetLibrary.map((asset) => `- [${asset.kind}] ${asset.name}${asset.description ? ` | ${asset.description}` : ""}`).join("\n")
    : "(本项目还没有资产)";
  return [
    "剧本按行编号如下(L 后面是行号):",
    "```",
    formatLinesForPrompt(input.scriptLines),
    "```",
    "",
    input.targetDurationSec
      ? `这一集的目标总时长是 ${input.targetDurationSec} 秒。`
      : "这一集没有设定目标总时长。",
    "",
    "场次清单(scene_ref 从这里选序号):",
    sceneList,
    "",
    "资产库清单(分镜只能引用这里的资产,@标签 = @资产名):",
    assets,
    "",
    input.styleDescription ? `默认视频风格:${input.styleDescription}` : "(本项目没有设置默认视频风格)",
    "",
    "生效的视频提示词模板(成文提示词按此格式书写):",
    input.promptTemplate,
  ].join("\n");
}

/** 阶段②解析结果 → 分镜候选。成文提示词由模型按生效模板直出（skill 合同）。 */
function toShotCandidate(input: {
  shot: ParsedStoryboardShot;
  index: number;
  scenes: SceneDivision[];
  degraded: boolean;
}): ShotCandidate {
  const { shot } = input;
  const lineIndices = Array.from({ length: shot.coveredLineRange[1] - shot.coveredLineRange[0] + 1 },
    (_, offset) => shot.coveredLineRange[0] + offset);
  // 归属场:模型给的 scene_ref 在场次清单内才用;对不上按行号回落。
  const scene = input.scenes.find((item) => item.sceneIndex === shot.sceneRef)
    ?? input.scenes.find((item) => shot.coveredLineRange[0] >= item.startLineIndex
      && shot.coveredLineRange[0] <= item.endLineIndex);
  const sceneIndex = scene?.sceneIndex ?? (input.scenes[0]?.sceneIndex ?? 0);

  const referenceNames = {
    character: new Set<string>(),
    scene: new Set<string>(),
    prop: new Set<string>(),
    costume: new Set<string>(),
  };
  for (const asset of shot.assets) {
    if (asset.kind === "character") referenceNames.character.add(asset.name);
    else if (asset.kind === "scene") referenceNames.scene.add(asset.name);
    else if (asset.kind === "prop") referenceNames.prop.add(asset.name);
    else if (asset.kind === "costume") referenceNames.costume.add(asset.name);
    // audio 与三类参考通道只进提示词与 storyboard_detail,不参与分镜四栏引用。
  }

  const firstShot = shot.storyboardDetail?.shots[0] ?? null;
  const videoPrompt = shot.videoPrompt ?? "";
  // v0.9：音频引用名只认 assetDefinitions（parse 已校验 ∈ 资产库）；降级态无 detail 给空。
  const audioNames = [...new Set((shot.storyboardDetail?.assetDefinitions ?? [])
    .filter((asset) => asset.kind === "audio")
    .map((asset) => asset.name))];
  return {
    candidateId: `shot_${String(input.index + 1).padStart(3, "0")}`,
    shotNo: input.index + 1,
    sceneIndex,
    lineIndices,
    elements: {
      subject: firstShot?.subjectAction ?? null,
      action: shot.storyboardDetail?.shots[1]?.subjectAction ?? firstShot?.physicsDetail ?? null,
      visual: firstShot?.physicsDetail ?? null,
      cameraLanguage: firstShot?.cameraLanguage ?? null,
    },
    storyboardDetail: input.degraded ? null : shot.storyboardDetail,
    directorPrompt: null,
    imagePrompt: null,
    videoPrompt,
    durationSec: shot.durationSec,
    characterNames: [...referenceNames.character],
    sceneNames: [...referenceNames.scene],
    propNames: [...referenceNames.prop],
    costumeNames: [...referenceNames.costume],
    audioNames,
  };
}