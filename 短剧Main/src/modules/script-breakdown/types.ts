import type {
  AiCompletionRequest,
  AiConversationMessage,
  AiProviderCompletion,
  AiProviderToolTurn,
  AiPurpose,
  AiToolSpec,
} from "../ai/types.js";
import type { ProjectAccessActor, ProjectAccessAction } from "../project-access/types.js";

/**
 * 整理规则的版本号。它标定的是「这份草稿按哪一套规则产生」:比对不上的
 * 运行不许续跑、不许确认(见 ScriptBreakdownService 的三处闸)。
 *
 * 合同没变,只是载体变了:以前规则写在 prompts.ts 的散文提示词里,现在写在
 * 系统提示与工具入参说明里(agent/runner.ts、agent/tools.ts)。这些措辞改一个字
 * 就是换了一套规则,必须升号——运行表按版本记录,提示词漂移才审计得出来。
 *
 * 号从 v2 直接跳到 v5:v3/v4 已经被 dev 上老路的两次反翻译修复用掉了,那是另一
 * 套规则,号不能重用——同一个号必须只对应一套规则,否则版本闸判出来的东西不算数。
 *
 * v5:名字反翻译规则搬进 agent 路(照抄原文语言与字符、禁止翻译音译)。
 * 这一版不与 v2 兼容,而且恰恰在续跑上不兼容:name 是镜头引用资产、跨集资产
 * 匹配唯一按字符串比对的字段。老规则下登记的译名留在草稿里,新规则续填时同
 * 一个人会以原文名再登记一次——两个字符串不同,查重查不出,同一份草稿里同
 * 一个人落成两张卡;镜头引用到还没登记的那个则直接被退回。所以老运行只能重
 * 开一次,不能拿新规则接着跑。
 *
 * v6:agent 工具层补齐 add_costume / add_audio(一键生成本集 P1),系统提示与
 * 工具描述从三类资产扩到五类。规则变化,续跑沿用同样判据:老 run 重开。
 *
 * v7:拆镜改为两阶段——阶段① agent 循环只产资产+场次(去掉 add_shot 与
 * 「必须有 shot」校验);阶段② 固定 skill《跨模型统一影视分镜生成约束规范》
 * 单次结构化输出全部分镜(storyboard-skill.ts),每镜成文提示词落 video_prompt,
 * skill 全维度落 storyboard_detail(迁移 067)。规则变化,老 run 重开。
 *
 * v8:阶段②成文分镜提示词改由模型按生效模板成文(skill 合同加 video_prompt
 * 必填)——服务端不再把模板当填空题渲染(模板是创作规范,不是占位符表);
 * 确认事务把服装/音频候选一并物化为正式项目资产。输出合同变化,老 run 重开。
 *
 * v9:阶段②固定 skill 换成附件《通用动态模板配套标准化Skill · 跨模型统一约束
 * 完整版》全文(storyboard-skill.ts)——统一 4 类切割边界、单 Shot 四模块固定
 * 顺序、Segment 模块排版、摄影基准与后台自检;Shot 数默认固定 5,项目配置了
 * 几段式 N 则按 N。提示词合同变化,老 run 重开。
 *
 * v10:推翻「默认 5、配置可覆盖」的固定几段式约束——每 Segment 内 Shot 数由
 * 剧情内容自然决定(不设固定数量,至少 1 个),shots_per_segment 配置字段随之
 * 废弃、后端不再读取。规则变化,老 run 重开。
 *
 * v11:推翻 v10——每 Segment 内 Shot 数改由「模板面板・分镜 Shot 数」正式配置
 * 决定(generation_default_strategies.parameters.shots_per_segment,1..12 生效):
 * 配置了 N 则每段恰好 N 个,未配置(缺省)则回落 v10 的自由态(剧情内容自然
 * 决定,≥1)。Skill 规则 1 与阶段② schema 同步两态,parse 校验「恰好 N / ≥1」。
 * 规则变化,老 run 重开。
 */
export const PROMPT_VERSION = "script-breakdown.v11";

/**
 * 剧本拆解草稿区领域类型。AI 产出一律先落草稿区(script_breakdown_runs +
 * script_breakdown_run_stages),只有人工确认才把草稿映射进正式 scenes/shots。
 *
 * ScriptBreakdownStageRecord 与 StageUsage 现在只用于读回上一版留下的阶段行:
 * 新路把过程记成事件(PersistedFillEvent),不再产生新的阶段行。
 */
/**
 * P6 skill 单次结构化拆镜输出全量（迁移 067，shots.storyboard_detail）。
 * 分镜（shots 一行）= 一个 Segment（独立剧情单元）；Segment 内若干 Shot 四模块
 * （数量 = 模板面板「分镜 Shot 数」配置，恰好 N；未配置由剧情内容自然决定，≥1）
 * 作为该分镜的内部结构化内容。形状定义在模块内——boundary.test.ts 禁止拆解模块
 * import db/schema，数据库列以结构兼容消费。
 */
export interface ShotStoryboardDetail {
  segmentTitle: string | null;
  shots: Array<{
    subjectAction: string | null;
    physicsDetail: string | null;
    cameraLanguage: string | null;
    lighting: string | null;
  }>;
  lighting: string | null;
  sfxLayers: string[];
  dialogue: Array<{ speaker: string | null; text: string; lipSync: boolean }>;
  assetDefinitions: Array<{ kind: string; name: string }>;
  style: { artStyle: string | null; colorTone: string | null; cameraStrategy: string | null };
}

export const scriptBreakdownRunStatuses = [
  "queued",
  "running",
  "draft",
  "failed",
  "confirmed",
  "discarded",
  "superseded",
] as const;
export type ScriptBreakdownRunStatus = typeof scriptBreakdownRunStatuses[number];

export type ScriptBreakdownStageStatus = "pending" | "running" | "succeeded" | "failed";

export type AssetCandidateKind = "character" | "scene" | "prop" | "costume" | "audio";

/** 服务端确定性切分的一行剧本(不依赖模型重打原文)。 */
export interface ScriptLine {
  lineIndex: number;
  text: string;
}

export interface SceneDivision {
  sceneIndex: number;
  name: string | null;
  summary: string;
  startLineIndex: number;
  endLineIndex: number;
}

export interface AssetCandidate {
  candidateId: string;
  name: string;
  description: string | null;
}

export const characterAgeStages = ["child", "teen", "adult", "older", "unknown"] as const;
export type CharacterAgeStage = typeof characterAgeStages[number];

export interface PrelinkedCharacterAsset {
  assetEntityId: string;
  name: string;
  matchedBy: "exact_name";
}

export interface CharacterAssetCandidate extends AssetCandidate {
  gender: string | null;
  /** 只有剧本明确给出具体年龄时才填写，禁止模型估算。 */
  ageValue: number | null;
  ageStage: CharacterAgeStage | null;
  appearance: string | null;
  personalityTags: string[];
  /** 服务端依据已通过项目资产计算，模型不能写。 */
  prelinkedAsset: PrelinkedCharacterAsset | null;
}

export interface CostumeAssetCandidate extends AssetCandidate {
  /** 穿着该服装的角色名（剧本明确提到的，不猜测）。 */
  wearerNames: string[];
  style: string | null;
  color: string | null;
  material: string | null;
  /** 适用场合，如"战场""宴会""日常"。 */
  occasion: string | null;
}

/** 音频候选类型：角色声音 / 旁白 / 音效 / 环境声 / 其他音频。 */
export type AudioCandidateKind = "character_voice" | "narration" | "sfx" | "ambience" | "other";

export interface AudioAssetCandidate extends AssetCandidate {
  audioKind: AudioCandidateKind;
  /** 角色声音时填说话角色名；旁白/音效/环境声可为空。 */
  speakerNames: string[];
  sceneContext: string | null;
  emotion: string | null;
  /** 时长提示，如"约3秒"；模型不估，只在剧本有明确线索时填。 */
  durationHint: string | null;
  /** 对白/旁白文本片段。 */
  transcriptSnippet: string | null;
  /** 拟声词/环境声拟声文本，如"雨声""脚步声"。 */
  soundCueText: string | null;
  /** 默认音频生成提示词种子，用于无图资产时的文本引用。 */
  defaultAudioPromptSeed: string | null;
}

export interface AssetCandidates {
  characters: CharacterAssetCandidate[];
  scenes: AssetCandidate[];
  props: AssetCandidate[];
  costumes: CostumeAssetCandidate[];
  audios: AudioAssetCandidate[];
}

export interface ShotStructuredElements {
  subject: string | null;
  action: string | null;
  visual: string | null;
  cameraLanguage: string | null;
}

export interface ShotCandidate {
  candidateId: string;
  shotNo: number;
  sceneIndex: number;
  lineIndices: number[];
  /** v2 结构化真源；只存要素，不存成文提示词。 */
  elements: ShotStructuredElements | null;
  /** v7 P6：skill 单次结构化拆镜全量；降级路径写 null；旧草稿缺省按 null。 */
  storyboardDetail?: ShotStoryboardDetail | null;
  /** v1 草稿兼容字段；新运行固定为 null。 */
  directorPrompt: string | null;
  imagePrompt: string | null;
  videoPrompt: string | null;
  durationSec: number;
  characterNames: string[];
  sceneNames: string[];
  propNames: string[];
  costumeNames: string[];
  /** v0.9：阶段② assetDefinitions 中 kind=audio 的引用名（parse 已校验 ∈ 资产库）；
   *  Lite materialize 据此写音频出现记录，不进分镜四栏引用。旧草稿缺省按空数组。 */
  audioNames?: string[];
}

/**
 * 草稿区内容。由 agent 一格一格填出来,每填一格服务层落一次库——这份
 * 草稿就是断点续跑的内容真源。剧本文行不重复存进草稿:它们可以从绑定的
 * 剧本版本确定性重建。
 */
export interface ScriptBreakdownDraft {
  storySummary?: string;
  sceneDivisions?: SceneDivision[];
  assetCandidates?: AssetCandidates;
  shotCandidates?: ShotCandidate[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface UnmatchedAsset {
  kind: AssetCandidateKind;
  name: string;
  shotCandidateIds: string[];
}

export interface DuplicateCoverage {
  lineIndex: number;
  shotCandidateIds: string[];
}

export interface DraftValidation {
  /** failed:运行级结构完整性校验未通过,草稿不可用。 */
  status: "pass" | "pass_with_warnings" | "failed";
  issues: ValidationIssue[];
  unmatchedAssets: UnmatchedAsset[];
  duplicateCoverage: DuplicateCoverage[];
  shotCount: number;
  totalDurationSec: number;
}

/** 阶段级诊断:只存结构与校验信息,绝不存 provider 原始响应。 */
export interface StageValidation {
  issues: ValidationIssue[];
}

/**
 * 历史阶段行的用量形态。切到 agent 路之后没有代码再写它——留着只为把
 * 上一版写下的行读回来,所以 kind 的取值也就停在历史那两种。
 */
export interface StageUsage {
  calls: Array<{
    kind: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number;
  }>;
}

export interface RunUsage {
  /**
   * 模型往返次数,不是工具调用次数——一次往返可以带回好几次工具调用。
   * 口径按 ai_calls 的行数定:一轮一条审计行、一条计入当天额度,账单和
   * 额度读的都是这个数。两种口径能差三倍,所以这里只认这一种。
   */
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

/**
 * 拆解过程事件的落库与外发形态。
 *
 * 这是一张**白名单**:只有下面这几个字段能出这道门。理由是出口对面就是
 * 数据库和导演端,而模型侧能拿到的东西里有两类绝不能过去——一次拆解会
 * 产生 600 多条带真实推理内容的思考事件,以及「入参没读全」时那段可能
 * 夹着剧本原文的报文片段。用白名单而不是黑名单:新加字段默认出不去。
 */
export interface PersistedFillEvent {
  sequence: number;
  tool: string | null;
  status: "accepted" | "rejected" | "unreadable";
  description: string;
  reason: string | null;
  occurredAt: Date;
}

/**
 * 过程事件在 script_breakdown_run_stages 里占的那一行的键。
 *
 * 为什么整条运行只占一行而不是一条事件一行:一次拆解 40-60 条事件,
 * 逐条建行就是 40-60 次串行的行锁事务;而且事件行会混进阶段列表被当成
 * 「失败步骤」显示,还会被回收 worker 判成超时。
 */
export const FILL_EVENTS_STAGE_KEY = "fill_events";

export interface ScriptVersionRecord {
  id: string;
  episodeId: string;
  versionNo: number;
  title: string | null;
  scriptText: string;
  scriptSha256: string;
  source: string;
  createdByUserId: string;
  createdAt: Date;
}

export interface ScriptBreakdownRunRecord {
  id: string;
  episodeId: string;
  scriptVersionId: string;
  createdByUserId: string;
  modelName: string | null;
  promptVersion: string;
  status: ScriptBreakdownRunStatus;
  currentStage: string | null;
  targetDurationSec: number | null;
  inputSha256: string;
  draft: ScriptBreakdownDraft;
  validation: DraftValidation;
  usage: RunUsage;
  errorCode: string | null;
  errorMessage: string | null;
  confirmedByUserId: string | null;
  confirmedAt: Date | null;
  discardedByUserId: string | null;
  discardedAt: Date | null;
  supersededByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScriptBreakdownStageRecord {
  id: string;
  runId: string;
  stageKey: string;
  stageOrder: number;
  status: ScriptBreakdownStageStatus;
  attemptCount: number;
  output: unknown | null;
  validation: StageValidation;
  usage: StageUsage;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface ApprovedAssetSummary {
  assetEntityId: string;
  name: string;
  assetKind: string;
  /** 实体描述。阶段②资产库清单逐条「名称+描述」用;归属判断仍只按 name。 */
  description?: string | null;
}

export interface EpisodeContext {
  id: string;
  projectId: string;
  status: string;
  deletedAt: Date | null;
}

/** 统一 AI 网关的窄口:业务只经它发调用,审计/限额/开关由网关负责。 */
export interface ScriptBreakdownGateway {
  /**
   * 带工具表的一轮对话。拆解的每一轮都从这里出去:审计、每日额度、执行
   * 围栏都在网关那一层,业务侧不复制这些规则。
   */
  runToolTurn(input: AiCompletionRequest & {
    messages: AiConversationMessage[];
    tools: AiToolSpec[];
  }): Promise<AiProviderToolTurn>;
  /**
   * P6 阶段②:单次结构化文本往返(不带工具表)。与工具轮次同一套审计、
   * 每日额度与执行围栏;模型由网关按用途(script_breakdown_storyboard)解析。
   * AiGatewayService.complete 结构性满足。
   */
  complete(input: AiCompletionRequest): Promise<AiProviderCompletion>;
  /**
   * 本次拆解每一轮能要多少输出 token。由网关按用途解析出实际模型、再按
   * model_capabilities 表算出并留余量——拆解侧不该自己知道用的是哪个模型,
   * 更不该自己写死一个数字。解析不出模型时网关报错,拆解侧不猜。
   */
  stageOutputBudgetFor(purpose: AiPurpose): Promise<number>;
}

export interface ScriptBreakdownAccessPort {
  require(actor: ProjectAccessActor, projectId: string, action: ProjectAccessAction): Promise<unknown>;
}

/**
 * P6 阶段②只读配置（§2 P6 C）：默认视频风格（projects.video_style_description）、
 * 生效视频模板（真源 1 projects.video_prompt_template → 真源 2
 * generation_default_strategies.parameters.prompt_template_id →
 * prompt_templates / prompt_default_templates 兜底，再落代码常量）、
 * 每段 Shot 数（generation_default_strategies.parameters.shots_per_segment，
 * 1..MAX 生效，null=自由）。
 * 真源顺序与分镜详情「AI 生成」getProjectVideoTemplate / 生成期
 * resolveProjectGenerationConfig 同口径。拆镜阶段只读，不新增配置。
 */
export interface StoryboardVideoConfig {
  styleDescription: string | null;
  promptTemplate: string;
  /** 每段恰好拆几个 Shot；null = 不固定，由剧情内容自然决定（≥1）。 */
  shotsPerSegment: number | null;
}

export interface StoryboardConfigPort {
  resolveVideoConfig(projectId: string): Promise<StoryboardVideoConfig>;
}

export interface MappedScene {
  candidateId: string;
  episodeId: string;
  sceneNo: number;
  name: string | null;
  description: string | null;
  sortOrder: number;
  sourceBreakdownRunId: string;
  sourceCandidateId: string;
}

export interface MappedShot {
  candidateId: string;
  sceneCandidateId: string;
  episodeId: string;
  shotCode: string;
  title: string | null;
  scriptText: string | null;
  breakdownElements: ShotStructuredElements | null;
  directorPrompt: string | null;
  /** v7 P6：skill 单次结构化拆镜全量；降级路径写 null（迁移 067）。 */
  storyboardDetail: ShotStoryboardDetail | null;
  imagePrompt: string | null;
  videoPrompt: string | null;
  durationSeconds: number;
  sortOrder: number;
  referenceAssetNames: {
    characters: string[];
    scenes: string[];
    props: string[];
    costumes: string[];
  };
  referenceAssetSnapshots: Array<Record<string, unknown>>;
  sourceBreakdownRunId: string;
  sourceCandidateId: string;
}

export interface ConfirmResult {
  runId: string;
  outcome: "confirmed" | "already_confirmed";
  sceneCount: number;
  shotCount: number;
  supersededRunIds: string[];
  unmatchedAssets: UnmatchedAsset[];
}

export interface ConfirmMapping {
  scenes: MappedScene[];
  shots: MappedShot[];
  assetCandidates: AssetCandidates;
  unmatchedAssets: UnmatchedAsset[];
}

export type CreateOutcome = "created" | "existing";

export interface ScriptBreakdownRepository {
  findEpisode(episodeId: string): Promise<EpisodeContext | null>;
  createScriptVersion(input: {
    episodeId: string;
    title: string | null;
    scriptText: string;
    scriptSha256: string;
    createdByUserId: string;
    clientIdempotencyKey: string;
    requestHash: string;
    now: Date;
  }): Promise<{ version: ScriptVersionRecord; outcome: CreateOutcome }>;
  listScriptVersions(episodeId: string): Promise<ScriptVersionRecord[]>;
  getScriptVersion(id: string): Promise<ScriptVersionRecord | null>;
  createRun(input: {
    episodeId: string;
    scriptVersionId: string;
    createdByUserId: string;
    clientIdempotencyKey: string;
    requestHash: string;
    promptVersion: string;
    inputSha256: string;
    targetDurationSec: number | null;
    now: Date;
  }): Promise<{ run: ScriptBreakdownRunRecord; outcome: CreateOutcome }>;
  findActiveRun(episodeId: string): Promise<{
    createdByUserId: string;
    clientIdempotencyKey: string;
  } | null>;
  getRun(runId: string): Promise<ScriptBreakdownRunRecord | null>;
  listRuns(episodeId: string): Promise<ScriptBreakdownRunRecord[]>;
  /** 只返回真正的执行阶段;过程事件那一行不在其中。 */
  listStages(runId: string): Promise<ScriptBreakdownStageRecord[]>;
  /**
   * 整条运行的过程事件整体覆盖写一次,带执行围栏。
   * 之所以是「整体覆盖」而不是「追加一条」:一条一行会把阶段表撑成事件表,
   * 而且每条都要一次带行锁的事务。代价是重写整个数组,一次拆解累计几百 KB。
   */
  recordFillEvents(input: {
    runId: string;
    executionToken: string;
    events: PersistedFillEvent[];
    now: Date;
  }): Promise<void>;
  listFillEvents(runId: string): Promise<PersistedFillEvent[]>;
  /** 原子认领执行权并生成隔离 token；null 表示运行已被其他执行器认领。 */
  claimExecution(runId: string, now: Date): Promise<string | null>;
  /**
   * P6 阶段②只读配置(§2 P6 C):默认视频风格 + 生效视频模板。
   * 拆镜阶段只读不写;解析链与素材页配置同口径,不另立第二套。
   */
  resolveStoryboardVideoConfig(projectId: string): Promise<StoryboardVideoConfig>;
  /**
   * 回收超过 provider 超时窗口仍无进展的 running。运行、当前阶段与对应
   * AI 审计必须在同一事务结束，之后可走既有 resume 检查点。
   */
  reclaimStaleRuns(input: { cutoff: Date; now: Date }): Promise<number>;
  updateRunExecution(input: {
    runId: string;
    executionToken: string;
    currentStage: string | null;
    draft?: ScriptBreakdownDraft;
    usage?: RunUsage;
    modelName?: string;
    now: Date;
  }): Promise<void>;
  finalizeRunDraft(input: {
    runId: string;
    executionToken: string;
    validation: DraftValidation;
    usage: RunUsage;
    now: Date;
  }): Promise<void>;
  finalizeRunFailed(input: {
    runId: string;
    executionToken: string;
    currentStage: string | null;
    errorCode: string;
    errorMessage: string;
    validation?: DraftValidation;
    usage?: RunUsage;
    now: Date;
  }): Promise<void>;
  /** 只在 run 仍可续跑且未被新执行认领时，原子重置失败阶段并将 run 置 queued 占住本集活跃位。 */
  resetStagesForResume(runId: string, now: Date): Promise<boolean>;
  /** 模型提示词摘要可限量；不得用于资产绑定正确性判断。 */
  listApprovedProjectAssets(projectId: string): Promise<ApprovedAssetSummary[]>;
  /** 按候选名称读取完整集合，用于唯一性/歧义判断，不得截断。 */
  listApprovedProjectAssetsByNames(projectId: string, names: string[]): Promise<ApprovedAssetSummary[]>;
  /**
   * 确认事务:锁运行 + 锁集,校验状态与越权,软删上一次确认产生的正式行,
   * 写入本次 scenes/shots,标记被替换运行为 superseded。重复确认返回
   * already_confirmed,不重复建行。
   */
  confirmRun(input: {
    runId: string;
    actor: ProjectAccessActor;
    mapping: ConfirmMapping;
    now: Date;
  }): Promise<ConfirmResult>;
  discardRun(input: { runId: string; actorId: string; now: Date }): Promise<"discarded" | "not_discardable" | "not_found">;
}

export function emptyRunUsage(): RunUsage {
  return { callCount: 0, totalInputTokens: 0, totalOutputTokens: 0 };
}
