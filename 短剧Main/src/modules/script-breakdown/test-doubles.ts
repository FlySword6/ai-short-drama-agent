import { ConflictError } from "../../shared/errors.js";
import type {
  AiCompletionRequest,
  AiConversationMessage,
  AiProviderCompletion,
  AiProviderToolTurn,
  AiToolSpec,
} from "../ai/types.js";
import type { ProjectAccessActor, ProjectAccessAction } from "../project-access/types.js";
import { DEFAULT_VIDEO_PROMPT_TEMPLATE } from "../generation/promptCompiler.js";
import {
  FILL_EVENTS_STAGE_KEY,
  type ApprovedAssetSummary,
  type ConfirmMapping,
  type ConfirmResult,
  type CreateOutcome,
  type EpisodeContext,
  type PersistedFillEvent,
  type RunUsage,
  type ScriptBreakdownAccessPort,
  type ScriptBreakdownDraft,
  type ScriptBreakdownGateway,
  type ScriptBreakdownRepository,
  type ScriptBreakdownRunRecord,
  type ScriptBreakdownRunStatus,
  type ScriptBreakdownStageRecord,
  type ScriptVersionRecord,
  type StoryboardVideoConfig,
} from "./types.js";

/**
 * 模块测试替身:内存版 repository 忠实模拟状态机与幂等语义,剧本化
 * gateway 按队列返回工具调用轮次或抛错。只服务于 *.test.ts,不进任何
 * 运行时路径。
 */

export const TEST_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_EPISODE_ID = "22222222-2222-4222-8222-222222222222";
export const TEST_ACTOR: ProjectAccessActor = { id: "33333333-3333-4333-8333-333333333333", role: "member" };

export const TEST_SCRIPT_TEXT = [
  "夜,旧仓库,林雪独白。",
  "林雪:我不会再等。",
  "日,天台,林雪与周行对峙。",
  "周行:你终于来了。",
].join("\n");

/**
 * 一次拆解走完的工具调用剧本:梗概 → 两场 → 五个资产 → 两个镜头 → 收尾。
 * 五轮往返,和真实模型一样会在一轮里带回好几次调用。
 */
export function happyPathToolTurns(): ToolTurnStep[] {
  return [
    { toolCalls: [{ name: "write_story_outline", arguments: { summary: "林雪与周行在天台对峙。" } }] },
    {
      toolCalls: [
        {
          name: "add_scene",
          arguments: { name: "旧仓库", summary: "林雪独白", start_line_index: 0, end_line_index: 1 },
        },
        {
          name: "add_scene",
          arguments: { name: "天台", summary: "两人对峙", start_line_index: 2, end_line_index: 3 },
        },
      ],
    },
    {
      toolCalls: [
        {
          name: "add_character",
          arguments: {
            name: "林雪",
            description: "女主角",
            gender: "女",
            age_value: 26,
            age_stage: "adult",
            appearance: "短发，眼神坚定",
            personality_tags: ["克制", "坚定"],
          },
        },
        { name: "add_character", arguments: { name: "周行", gender: "男", age_stage: "adult" } },
        { name: "add_location", arguments: { name: "旧仓库" } },
        { name: "add_location", arguments: { name: "天台" } },
        { name: "add_prop", arguments: { name: "怀表", description: "周行随身携带的旧怀表" } },
        { name: "add_costume", arguments: { name: "风衣", description: "林雪的军绿风衣", wearer_names: ["林雪"] } },
        { name: "add_audio", arguments: { name: "雨声", description: "夜雨环境声", audio_kind: "ambience", sound_cue_text: "雨声" } },
      ],
    },
    { toolCalls: [{ name: "finish_breakdown", arguments: {} }] },
  ];
}

/**
 * P6 阶段②假返回:两个 segment 覆盖测试剧本全部 4 行(旧仓库 0-1 / 天台 2-3),
 * 每段 5 Shot 四模块——与 happyPathToolTurns 的场次配套。Shot 数不再受后端
 * 校验约束(数量由内容自定),固定 5 只是这个假返回自身的形状。
 */
export function storyboardCompletionJson(): string {
  const shots = (camera: string) => Array.from({ length: 5 }, (_, index) => ({
    subject_action: `第 ${index + 1} 个镜头的主体动作`,
    physics_detail: `第 ${index + 1} 个镜头的物理细节`,
    camera_language: camera,
    lighting: "冷光",
  }));
  return JSON.stringify({
    segments: [
      {
        segment_title: "旧仓库独白",
        scene_ref: 0,
        covered_line_range: [0, 1],
        assets: [
          { kind: "character", name: "林雪" },
          { kind: "scene", name: "旧仓库" },
          { kind: "prop", name: "怀表" },
          { kind: "costume", name: "风衣" },
          { kind: "audio", name: "雨声" },
        ],
        audio: {
          sfx_layers: ["风声"],
          dialogue: [{ speaker: "林雪", text: "我不会再等。", lip_sync: true }],
        },
        style: { art_style: "写实", color_tone: "冷蓝", camera_strategy: "缓慢推近" },
        video_prompt: "【旧仓库独白】@林雪 独白,缓慢推近;音效:风声;对白:林雪:我不会再等。(对口型) 风格:冷蓝 严禁任何字幕,严禁背景音乐",
        shots: shots("缓慢推近"),
      },
      {
        segment_title: "天台对峙",
        scene_ref: 1,
        covered_line_range: [2, 3],
        duration_sec: 8,
        assets: [
          { kind: "character", name: "林雪" },
          { kind: "character", name: "周行" },
          { kind: "scene", name: "天台" },
        ],
        audio: {
          sfx_layers: [],
          dialogue: [{ speaker: "周行", text: "你终于来了。", lip_sync: true }],
        },
        style: { art_style: "写实", color_tone: "橙红", camera_strategy: "正反打" },
        video_prompt: "【天台对峙】@林雪 与 @周行 正反打对峙;对白:周行:你终于来了。(对口型) 风格:橙红 严禁任何字幕,严禁背景音乐",
        shots: shots("正反打"),
      },
    ],
    self_check: { segment_count: 2, covered_lines: [0, 3] },
  });
}

/** 剧本化的一轮:要么给回一批工具调用,要么整轮抛错。 */
export interface ToolTurnStep {
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  text?: string;
  unreadable?: Array<{ name: string; argumentsExcerpt: string }>;
  error?: Error;
  model?: string;
}

export type ScriptedToolTurnRequest = AiCompletionRequest & {
  messages: AiConversationMessage[];
  tools: AiToolSpec[];
};

export const FAKE_BREAKDOWN_MODEL = "fake-breakdown-model";

export class ScriptedToolTurnGateway implements ScriptBreakdownGateway {
  readonly requests: ScriptedToolTurnRequest[] = [];
  /** P6 阶段②的单次文本往返记录。 */
  readonly storyboardRequests: AiCompletionRequest[] = [];
  private index = 0;

  constructor(
    private readonly steps: ToolTurnStep[],
    /** 网关按用途解析出的输出预算。拆解侧只会照用,不会自己另算一个数。 */
    readonly stageBudget = 32_768,
  ) {}

  async stageOutputBudgetFor(): Promise<number> {
    return this.stageBudget;
  }

  /** 阶段②假返回:默认给出覆盖测试剧本全 4 行的合法拆镜 JSON。 */
  async complete(input: AiCompletionRequest): Promise<AiProviderCompletion> {
    this.storyboardRequests.push(input);
    return {
      content: storyboardCompletionJson(),
      model: FAKE_BREAKDOWN_MODEL,
      inputTokens: 120,
      outputTokens: 60,
      durationMs: 7,
    };
  }

  async runToolTurn(input: ScriptedToolTurnRequest): Promise<AiProviderToolTurn> {
    this.requests.push(input);
    // 剧本跑完之后模型就不说话了:这是合法情况(runner 会催问),
    // 不能变成异常——异常会被上层读成「接不上话」。
    const step = this.steps[this.index] ?? { text: "没有更多要补的了。" };
    this.index += 1;
    if (step.error) throw step.error;
    const calls = step.toolCalls ?? [];
    return {
      content: step.text ?? "",
      toolCalls: calls.map((call, position) => ({
        id: `call-${this.index}-${position}`,
        name: call.name,
        arguments: call.arguments,
      })),
      unreadableToolCalls: (step.unreadable ?? []).map((call, position) => ({
        id: `bad-${this.index}-${position}`,
        name: call.name,
        argumentsExcerpt: call.argumentsExcerpt,
      })),
      model: step.model ?? FAKE_BREAKDOWN_MODEL,
      inputTokens: 120,
      outputTokens: 60,
      durationMs: 7,
    };
  }
}

export class AllowAllAccess implements ScriptBreakdownAccessPort {
  readonly calls: Array<{ actorId: string; projectId: string; action: ProjectAccessAction }> = [];

  constructor(private readonly deny?: (action: ProjectAccessAction) => Error | null) {}

  async require(actor: ProjectAccessActor, projectId: string, action: ProjectAccessAction): Promise<unknown> {
    this.calls.push({ actorId: actor.id, projectId, action });
    const error = this.deny?.(action);
    if (error) throw error;
    return { projectId, actorId: actor.id };
  }
}

export class InMemoryScriptBreakdownRepository implements ScriptBreakdownRepository {
  readonly episodes = new Map<string, EpisodeContext>();
  readonly versions = new Map<string, ScriptVersionRecord>();
  readonly runs = new Map<string, ScriptBreakdownRunRecord>();
  readonly stagesByRun = new Map<string, ScriptBreakdownStageRecord[]>();
  approvedAssets: ApprovedAssetSummary[] = [];
  /** 正式表写路径调用记录:草稿区边界测试的核心证据。 */
  readonly confirmCalls: Array<{ runId: string; mapping: ConfirmMapping }> = [];

  /** P6 阶段②配置:内存版给平台默认口径,与素材页配置同形状;测试可按需改。 */
  storyboardVideoConfig: StoryboardVideoConfig = {
    styleDescription: null,
    promptTemplate: DEFAULT_VIDEO_PROMPT_TEMPLATE,
    shotsPerSegment: null,
  };

  /** P6 阶段②配置:内存版给平台默认口径,与素材页配置同形状。 */
  async resolveStoryboardVideoConfig(): Promise<StoryboardVideoConfig> {
    return this.storyboardVideoConfig;
  }

  constructor() {
    this.episodes.set(TEST_EPISODE_ID, {
      id: TEST_EPISODE_ID,
      projectId: TEST_PROJECT_ID,
      status: "active",
      deletedAt: null,
    });
  }

  async findEpisode(episodeId: string): Promise<EpisodeContext | null> {
    return this.episodes.get(episodeId) ?? null;
  }

  async createScriptVersion(input: {
    episodeId: string;
    title: string | null;
    scriptText: string;
    scriptSha256: string;
    createdByUserId: string;
    clientIdempotencyKey: string;
    requestHash: string;
    now: Date;
  }): Promise<{ version: ScriptVersionRecord; outcome: CreateOutcome }> {
    const existingEntry = [...this.versionIdempotencyKeys.entries()]
      .find(([id, key]) => key === input.clientIdempotencyKey
        && this.versions.get(id)?.createdByUserId === input.createdByUserId);
    if (existingEntry) {
      const existing = this.versions.get(existingEntry[0])!;
      if (existing.scriptSha256 !== input.scriptSha256) {
        throw new ConflictError("同一幂等键提交了不同内容,请更换幂等键", "idempotency_conflict");
      }
      return { version: existing, outcome: "existing" };
    }
    const version: ScriptVersionRecord = {
      id: crypto.randomUUID(),
      episodeId: input.episodeId,
      versionNo: [...this.versions.values()].filter((item) => item.episodeId === input.episodeId).length + 1,
      title: input.title,
      scriptText: input.scriptText,
      scriptSha256: input.scriptSha256,
      source: "manual",
      createdByUserId: input.createdByUserId,
      createdAt: input.now,
    };
    this.versions.set(version.id, version);
    this.versionIdempotencyKeys.set(version.id, input.clientIdempotencyKey);
    return { version, outcome: "created" };
  }

  private readonly versionIdempotencyKeys = new Map<string, string>();

  async listScriptVersions(episodeId: string): Promise<ScriptVersionRecord[]> {
    return [...this.versions.values()].filter((version) => version.episodeId === episodeId);
  }

  async getScriptVersion(id: string): Promise<ScriptVersionRecord | null> {
    return this.versions.get(id) ?? null;
  }

  private readonly runIdempotencyKeys = new Map<string, string>();
  private readonly runRequestHashes = new Map<string, string>();
  private readonly runExecutionTokens = new Map<string, string>();

  async createRun(input: {
    episodeId: string;
    scriptVersionId: string;
    createdByUserId: string;
    clientIdempotencyKey: string;
    requestHash: string;
    promptVersion: string;
    inputSha256: string;
    targetDurationSec: number | null;
    now: Date;
  }): Promise<{ run: ScriptBreakdownRunRecord; outcome: CreateOutcome }> {
    const existingEntry = [...this.runIdempotencyKeys.entries()]
      .find(([id, key]) => key === input.clientIdempotencyKey && this.runs.get(id)?.createdByUserId === input.createdByUserId);
    if (existingEntry) {
      const existing = this.runs.get(existingEntry[0])!;
      if (this.runRequestHashes.get(existing.id) !== input.requestHash) {
        throw new ConflictError("同一幂等键提交了不同内容,请更换幂等键", "idempotency_conflict");
      }
      return { run: existing, outcome: "existing" };
    }
    const run: ScriptBreakdownRunRecord = {
      id: crypto.randomUUID(),
      episodeId: input.episodeId,
      scriptVersionId: input.scriptVersionId,
      createdByUserId: input.createdByUserId,
      modelName: null,
      promptVersion: input.promptVersion,
      status: "queued",
      currentStage: null,
      targetDurationSec: input.targetDurationSec,
      inputSha256: input.inputSha256,
      draft: {},
      validation: emptyValidation(),
      usage: { callCount: 0, totalInputTokens: 0, totalOutputTokens: 0 },
      errorCode: null,
      errorMessage: null,
      confirmedByUserId: null,
      confirmedAt: null,
      discardedByUserId: null,
      discardedAt: null,
      supersededByRunId: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.runs.set(run.id, run);
    this.runIdempotencyKeys.set(run.id, input.clientIdempotencyKey);
    this.runRequestHashes.set(run.id, input.requestHash);
    this.stagesByRun.set(run.id, []);
    return { run, outcome: "created" };
  }
  async findActiveRun(episodeId: string): Promise<{
    createdByUserId: string;
    clientIdempotencyKey: string;
  } | null> {
    const active = [...this.runs.entries()].find(([, run]) => (
      run.episodeId === episodeId && ["queued", "running", "draft"].includes(run.status)
    ));
    if (!active) return null;
    return {
      createdByUserId: active[1].createdByUserId,
      clientIdempotencyKey: this.runIdempotencyKeys.get(active[0])!,
    };
  }

  async getRun(runId: string): Promise<ScriptBreakdownRunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async listRuns(episodeId: string): Promise<ScriptBreakdownRunRecord[]> {
    return [...this.runs.values()].filter((run) => run.episodeId === episodeId);
  }

  async listStages(runId: string): Promise<ScriptBreakdownStageRecord[]> {
    return [...(this.stagesByRun.get(runId) ?? [])]
      .filter((stage) => stage.stageKey !== FILL_EVENTS_STAGE_KEY)
      .sort((a, b) => a.stageOrder - b.stageOrder);
  }

  /** 与 Drizzle 实现同形:整条运行一行,带围栏的整体覆盖写。 */
  async recordFillEvents(input: {
    runId: string;
    executionToken: string;
    events: PersistedFillEvent[];
    now: Date;
  }): Promise<void> {
    if (!this.ownsExecution(input.runId, input.executionToken)) return;
    const stages = this.stagesByRun.get(input.runId)!;
    const payload = { events: input.events.map((event) => ({ ...event })) };
    const existing = stages.find((stage) => stage.stageKey === FILL_EVENTS_STAGE_KEY);
    this.eventWrites += 1;
    if (existing) {
      existing.output = payload;
      existing.completedAt = input.now;
      return;
    }
    stages.push({
      id: crypto.randomUUID(),
      runId: input.runId,
      stageKey: FILL_EVENTS_STAGE_KEY,
      stageOrder: 0,
      // 固定终态:回收 worker 只碰 running 行,续跑重置只碰 running/failed 行,
      // 事件行都不该被它们改写。
      status: "succeeded",
      attemptCount: 1,
      output: payload,
      validation: { issues: [] },
      usage: { calls: [] },
      errorCode: null,
      errorMessage: null,
      startedAt: input.now,
      completedAt: input.now,
    });
  }

  eventWrites = 0;

  async listFillEvents(runId: string): Promise<PersistedFillEvent[]> {
    const row = (this.stagesByRun.get(runId) ?? [])
      .find((stage) => stage.stageKey === FILL_EVENTS_STAGE_KEY);
    const events = (row?.output as { events?: PersistedFillEvent[] } | null)?.events ?? [];
    return events.map((event) => ({ ...event, occurredAt: new Date(event.occurredAt) }));
  }

  async claimExecution(runId: string, now: Date): Promise<string | null> {
    const run = this.runs.get(runId);
    if (!run || (run.status !== "queued" && run.status !== "failed")) return null;
    if ([...this.runs.values()].some((candidate) =>
      candidate.id !== run.id
      && candidate.episodeId === run.episodeId
      && (candidate.status === "queued" || candidate.status === "running" || candidate.status === "draft")
    )) {
      throw new ConflictError("这一集正在解析中，请稍候", "lite_run_in_flight");
    }
    const executionToken = crypto.randomUUID();
    run.status = "running";
    run.updatedAt = now;
    this.runExecutionTokens.set(runId, executionToken);
    return executionToken;
  }

  async reclaimStaleRuns(input: { cutoff: Date; now: Date }): Promise<number> {
    let reclaimed = 0;
    for (const run of this.runs.values()) {
      if (run.status !== "running" || run.updatedAt >= input.cutoff) continue;
      run.status = "failed";
      run.errorCode = "worker_timeout";
      run.errorMessage = "拆解执行进程失联，已安全回收，请继续执行。";
      run.updatedAt = input.now;
      this.runExecutionTokens.delete(run.id);
      for (const stage of this.stagesByRun.get(run.id) ?? []) {
        if (stage.status !== "running") continue;
        stage.status = "failed";
        stage.errorCode = "worker_timeout";
        stage.errorMessage = "拆解执行进程失联，已安全回收，请继续执行。";
        stage.completedAt = input.now;
      }
      reclaimed += 1;
    }
    return reclaimed;
  }

  /**
   * 每一次真正落库的草稿快照,按发生顺序。
   *
   * 「已填的不重跑」只能靠这条流水证明:终态正确说明不了问题——从头重放一遍,
   * 终态照样是对的。要看的是过程中的写入次数与写入内容有没有倒退。
   */
  readonly draftWrites: ScriptBreakdownDraft[] = [];

  async updateRunExecution(input: {
    runId: string;
    executionToken: string;
    currentStage: string | null;
    draft?: ScriptBreakdownDraft;
    usage?: RunUsage;
    modelName?: string;
    now: Date;
  }): Promise<void> {
    const run = this.runs.get(input.runId)!;
    if (!this.ownsExecution(input.runId, input.executionToken)) return;
    run.currentStage = input.currentStage;
    if (input.draft !== undefined) {
      this.draftWrites.push(structuredClone(input.draft));
      run.draft = input.draft;
    }
    if (input.usage !== undefined) run.usage = input.usage;
    if (input.modelName !== undefined) run.modelName = input.modelName;
    run.updatedAt = input.now;
  }

  async finalizeRunDraft(input: {
    runId: string;
    executionToken: string;
    validation: ScriptBreakdownRunRecord["validation"];
    usage: RunUsage;
    now: Date;
  }): Promise<void> {
    const run = this.runs.get(input.runId)!;
    if (!this.ownsExecution(input.runId, input.executionToken)) return;
    run.status = "draft";
    this.runExecutionTokens.delete(input.runId);
    run.currentStage = null;
    run.validation = input.validation;
    run.usage = input.usage;
    run.errorCode = null;
    run.errorMessage = null;
    run.updatedAt = input.now;
  }

  async finalizeRunFailed(input: {
    runId: string;
    executionToken: string;
    currentStage: string | null;
    errorCode: string;
    errorMessage: string;
    validation?: ScriptBreakdownRunRecord["validation"];
    usage?: RunUsage;
    now: Date;
  }): Promise<void> {
    const run = this.runs.get(input.runId)!;
    if (!this.ownsExecution(input.runId, input.executionToken)) return;
    run.status = "failed";
    this.runExecutionTokens.delete(input.runId);
    run.currentStage = input.currentStage;
    run.errorCode = input.errorCode;
    run.errorMessage = input.errorMessage;
    if (input.validation !== undefined) run.validation = input.validation;
    if (input.usage !== undefined) run.usage = input.usage;
    run.updatedAt = input.now;
  }

  async resetStagesForResume(runId: string, now: Date): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || (run.status !== "queued" && run.status !== "failed") || this.runExecutionTokens.has(runId)) {
      return false;
    }
    if ([...this.runs.values()].some((candidate) =>
      candidate.id !== run.id
      && candidate.episodeId === run.episodeId
      && (candidate.status === "queued" || candidate.status === "running" || candidate.status === "draft")
    )) {
      throw new ConflictError("这一集正在解析中，请稍候", "lite_run_in_flight");
    }
    for (const stage of this.stagesByRun.get(runId) ?? []) {
      if (stage.status === "running" || stage.status === "failed") {
        /* 与 Drizzle 实现同形:清错误与时间戳,回到可重跑的 pending。 */
        stage.status = "pending";
        stage.errorCode = null;
        stage.errorMessage = null;
        stage.startedAt = null;
        stage.completedAt = null;
      }
    }
    run.status = "queued";
    run.errorCode = null;
    run.errorMessage = null;
    run.updatedAt = now;
    return true;
  }

  async listApprovedProjectAssets(): Promise<ApprovedAssetSummary[]> {
    return this.approvedAssets.slice(0, 200);
  }

  async listApprovedProjectAssetsByNames(
    _projectId: string,
    names: string[],
  ): Promise<ApprovedAssetSummary[]> {
    const wanted = new Set(names);
    return this.approvedAssets.filter((asset) => wanted.has(asset.name));
  }

  /** 唯一模拟正式表写入的方法;边界测试靠 confirmCalls 与 confirmedCounts 取证。 */
  readonly confirmedCounts = new Map<string, { sceneCount: number; shotCount: number }>();

  async confirmRun(input: {
    runId: string;
    actor: ProjectAccessActor;
    mapping: ConfirmMapping;
    now: Date;
  }): Promise<ConfirmResult> {
    const run = this.runs.get(input.runId);
    if (!run) throw new ConflictError("拆解记录不存在", "run_not_found");
    if (run.status === "confirmed") {
      this.confirmCalls.push({ runId: input.runId, mapping: input.mapping });
      const counts = this.confirmedCounts.get(run.id) ?? { sceneCount: 0, shotCount: 0 };
      return { runId: run.id, outcome: "already_confirmed", ...counts, supersededRunIds: [], unmatchedAssets: input.mapping.unmatchedAssets };
    }
    if (run.status !== "draft") {
      throw new ConflictError("拆解尚未完成,不能确认", "run_not_ready");
    }
    const materialized = materializeInMemoryAssets(this.approvedAssets, input.mapping);
    this.approvedAssets = materialized.assets;
    this.confirmCalls.push({ runId: input.runId, mapping: materialized.mapping });
    run.status = "confirmed";
    run.confirmedByUserId = input.actor.id;
    run.confirmedAt = input.now;
    run.updatedAt = input.now;
    this.confirmedCounts.set(run.id, { sceneCount: input.mapping.scenes.length, shotCount: input.mapping.shots.length });
    return {
      runId: run.id,
      outcome: "confirmed",
      sceneCount: input.mapping.scenes.length,
      shotCount: input.mapping.shots.length,
      supersededRunIds: [],
      unmatchedAssets: input.mapping.unmatchedAssets,
    };
  }

  async discardRun(input: { runId: string; actorId: string; now: Date }): Promise<"discarded" | "not_discardable" | "not_found"> {
    const run = this.runs.get(input.runId);
    if (!run) return "not_found";
    const discardable: ScriptBreakdownRunStatus[] = ["queued", "running", "failed", "draft"];
    if (!discardable.includes(run.status)) return "not_discardable";
    run.status = "discarded";
    run.discardedByUserId = input.actorId;
    run.discardedAt = input.now;
    run.updatedAt = input.now;
    this.runExecutionTokens.delete(input.runId);
    for (const stage of this.stagesByRun.get(input.runId) ?? []) {
      if (stage.status !== "running") continue;
      stage.status = "failed";
      stage.errorCode = "run_discarded";
      stage.errorMessage = "拆解已被用户放弃。";
      stage.completedAt = input.now;
    }
    return "discarded";
  }

  private ownsExecution(runId: string, executionToken: string): boolean {
    return this.runs.get(runId)?.status === "running"
      && this.runExecutionTokens.get(runId) === executionToken;
  }
}

function materializeInMemoryAssets(
  approvedAssets: ApprovedAssetSummary[],
  mapping: ConfirmMapping,
): { assets: ApprovedAssetSummary[]; mapping: ConfirmMapping } {
  const assets = [...approvedAssets];
  const groups = [
    ["character", mapping.assetCandidates.characters],
    ["scene", mapping.assetCandidates.scenes],
    ["prop", mapping.assetCandidates.props],
    ["costume", mapping.assetCandidates.costumes],
    ["audio", mapping.assetCandidates.audios],
  ] as const;
  for (const [kind, candidates] of groups) {
    for (const candidate of candidates) {
      const matches = assets.filter((asset) => asset.assetKind === kind && asset.name === candidate.name);
      if (matches.length > 1) {
        throw new ConflictError(
          `项目资产库里有多条同名资产“${candidate.name}”`,
          "script_asset_name_ambiguous",
        );
      }
      if (matches.length === 0) {
        assets.push({
          assetEntityId: `script-asset-${candidate.candidateId}`,
          name: candidate.name,
          assetKind: kind,
        });
      }
    }
  }
  const materializedByKey = new Map(
    assets.map((asset) => [`${asset.assetKind}:${asset.name}`, asset]),
  );
  return {
    assets,
    mapping: {
      ...mapping,
      shots: mapping.shots.map((shot) => {
        const snapshots: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        const references = [
          ["character", shot.referenceAssetNames.characters],
          ["scene", shot.referenceAssetNames.scenes],
          ["prop", shot.referenceAssetNames.props],
        ] as const;
        for (const [kind, names] of references) {
          for (const name of names) {
            const asset = materializedByKey.get(`${kind}:${name}`);
            if (!asset || seen.has(asset.assetEntityId)) continue;
            seen.add(asset.assetEntityId);
            snapshots.push({
              asset_entity_id: asset.assetEntityId,
              name: asset.name,
              asset_kind: asset.assetKind,
              matched_by: "exact_name",
            });
          }
        }
        return { ...shot, referenceAssetSnapshots: snapshots };
      }),
    },
  };
}

function emptyValidation() {
  return {
    status: "pass" as const,
    issues: [],
    unmatchedAssets: [],
    duplicateCoverage: [],
    shotCount: 0,
    totalDurationSec: 0,
  };
}
