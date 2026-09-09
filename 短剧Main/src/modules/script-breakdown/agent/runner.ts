import { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { formatLinesForPrompt } from "../lines.js";
import type { ScriptBreakdownDraft } from "../types.js";
import { BreakdownWorkspace, type WorkspaceContext } from "./workspace.js";
import {
  BREAKDOWN_TOOL_NAMES,
  createBreakdownTools,
  isBreakdownToolName,
  SCENE_HEADING_FORMS_RULE,
  type BreakdownFillEvent,
} from "./tools.js";

/**
 * 拆解的 agent 循环。
 *
 * 循环、工具派发、入参校验、把一次失败变成「这一次调用」的错误结果再交回
 * 模型——全部来自 @earendil-works/pi-agent-core,这里不重写。本文件只做四件
 * 事:把剧本讲给模型听、把库的事件翻成产品事件、把失败如实报出去、把填充
 * 结果交回服务层。
 *
 * 第三件是有来历的:库在 streamFn 抛错时会合成一条空的助手消息把这一轮收掉,
 * 于是一条传输层异常在上层长得和「模型这一轮没说话」一模一样。排查的人会去
 * 改提示词、换模型,而真因要抓原始报文才看得见。所以这里对两种失败都留了
 * 明确的出口:turnFailure(整轮没跑成)与 unreadableToolCalls(入参没读出)。
 */

export interface BreakdownTurnToolSpec {
  name: string;
  description: string;
  parameters: unknown;
}

export interface BreakdownTurnMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export interface BreakdownTurnInput {
  system: string;
  messages: BreakdownTurnMessage[];
  tools: BreakdownTurnToolSpec[];
}

export interface BreakdownTurnResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** 模型发起了调用但入参没读出来的那些。空数组是常态。 */
  unreadableToolCalls: Array<{ id: string; name: string; argumentsExcerpt: string }>;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

/** 一次模型往返。真实实现走统一 AI 网关(审计、限额、执行围栏都在那一层)。 */
export type BreakdownTurn = (input: BreakdownTurnInput) => Promise<BreakdownTurnResult>;

/**
 * 收手的原因。两条都不是错误,是预算用完:内容还在,可以续跑。
 * 与 turnFailure(接不上话)分开,因为界面上该说的话和该给的按钮不一样。
 */
export type BreakdownStopReason = "turn_budget" | "tool_budget";

export interface BreakdownAgentInput {
  context: WorkspaceContext;
  turn: BreakdownTurn;
  onEvent: (event: BreakdownFillEvent) => void | Promise<void>;
  /**
   * 每次成功填充之后的过程快照。服务层靠它做增量落库——它是断点续跑
   * 唯一的内容真源。没有它,进程中途一挂就得整份重做。
   */
  onFilled?: (draft: ScriptBreakdownDraft) => void | Promise<void>;
  /** 断点续跑:把上次已经填好的内容接着往下填,不从头重做。 */
  restoredDraft?: ScriptBreakdownDraft;
  /** 一次运行允许的工具调用总数上限,防跑飞。 */
  maxToolCalls: number;
  /**
   * 一次运行允许的模型往返次数上限。每一轮都是一次真实付费调用,所以这道闸
   * 必须在发出去之前拦住,而不是靠模型自己不说话来停。
   */
  maxTurns: number;
  /** 模型停口时最多催问几次。默认 3 次:够救回偶发停口,又不至于无限烧钱。 */
  maxNudges?: number;
  /** 入参读不出时最多请模型重发几次。同样是一道花钱的闸,默认 3 次。 */
  maxUnreadableRetries?: number;
  now?: () => Date;
}

export interface BreakdownAgentResult {
  completed: boolean;
  unfinishedReason?: string;
  /** 预算用完而收手时的类别;null 表示不是因为预算停的。 */
  stopReason: BreakdownStopReason | null;
  /**
   * 入参没读出来的调用次数。>0 说明这一次踩到的是报文问题,
   * 与「模型主动选择不调工具」是两回事,上层据此分流。
   */
  unreadableToolCalls: number;
  /** 整轮往返没跑成时的人话原因;null 表示没发生过。 */
  turnFailure: string | null;
  draft: ScriptBreakdownDraft;
  validation: ReturnType<BreakdownWorkspace["validate"]>;
  turns: number;
  toolCalls: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}

/** 对外只说人话:厂商名、状态码、英文报错留在服务端日志里。 */
const TURN_FAILURE_MESSAGE = "拆解中途没能和模型接上话,已经拆好的内容都保留着,请重试。";

const STOP_MESSAGE: Record<BreakdownStopReason, string> = {
  turn_budget: "这一次拆解的往返次数已经用完,已经拆好的内容都保留着,可以接着拆。",
  tool_budget: "这一次拆解的操作步数已经用完,已经拆好的内容都保留着,可以接着拆。",
};

/**
 * 只用来把库的循环从内部掐断。它永远不会流到用户面前:库把它收成一条空的
 * 助手消息,上层读的是 stopReason 和 unfinishedReason。
 */
class BreakdownBudgetExhausted extends Error {}

const AGENT_MODEL: Model<"openai-completions"> = {
  id: "script-breakdown-agent",
  name: "剧本拆解",
  api: "openai-completions",
  provider: "script-breakdown",
  baseUrl: "https://script-breakdown.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 32_768,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
    maxTokensField: "max_tokens",
  },
};

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const allowedTools = new Set<string>(BREAKDOWN_TOOL_NAMES);

export async function runBreakdownAgent(input: BreakdownAgentInput): Promise<BreakdownAgentResult> {
  const workspace = new BreakdownWorkspace(input.context, input.restoredDraft);
  const now = input.now ?? (() => new Date());
  const maxNudges = input.maxNudges ?? 3;
  const maxUnreadableRetries = input.maxUnreadableRetries ?? 3;
  let finished = false;
  let toolCalls = 0;
  let turns = 0;
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let sequence = 0;
  let unreadableToolCalls = 0;
  let unreadableRetries = 0;
  let unreadableInThisTurn = false;
  let turnFailure: string | null = null;
  let stopReason: BreakdownStopReason | null = null;

  // 工具事件和「读不出」事件走同一个号:界面拿到的是一条能排序的流。
  const emit = async (event: Omit<BreakdownFillEvent, "sequence">) => {
    sequence += 1;
    await input.onEvent({ ...event, sequence });
  };

  const tools = createBreakdownTools({
    workspace,
    now: input.now,
    onEvent: async (event) => {
      if (event.tool === "finish_breakdown" && event.status === "accepted") finished = true;
      await emit(event);
      // 只有真填进去了才发快照:被退回和读不出都没改草稿,再落一次库是白写。
      if (event.status === "accepted") await input.onFilled?.(workspace.draft);
    },
  });
  const toolLabels = new Map(tools.map((tool) => [tool.name, tool.label]));

  /**
   * 模型确实发起了这几次调用,只是内容没完整传回来。
   * 报成事件让界面有话说,再把「只重发这几次」交回模型——同一批里读得出的
   * 那些已经填进去了,不该陪着重做。
   */
  const reportUnreadable = async (calls: BreakdownTurnResult["unreadableToolCalls"]) => {
    unreadableToolCalls += calls.length;
    for (const call of calls) {
      const label = toolLabels.get(call.name);
      await emit({
        tool: isBreakdownToolName(call.name) ? call.name : null,
        status: "unreadable",
        description: label
          ? `${label}:这一步的内容没读全,正在请它重来。`
          : "有一步的内容没读全,正在请它重来。",
        reason: "这一次的内容没有完整传回来,已经请模型只把这一次重发一遍,前面拆好的都还在。",
        occurredAt: now(),
      });
    }
    if (unreadableRetries >= maxUnreadableRetries) return;
    unreadableRetries += 1;
    agent.steer({
      role: "user",
      content: [{ type: "text", text: unreadableRetryPrompt(calls, toolLabels) }],
      timestamp: Date.now(),
    });
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: breakdownSystemPrompt(),
      model: AGENT_MODEL,
      tools,
      messages: [],
      thinkingLevel: "off",
    },
    toolExecution: "sequential",
    streamFn: async (_model, context) => {
      // 预算闸在发出去之前:一轮往返就是一次真实付费调用,过了这行就已经花钱了。
      // 库的循环条件是「还有工具调用就继续」,被拦下的调用不经过 afterToolCall,
      // 所以不在这里硬停,配额用完之后模型每多说一句话都还在扣费。
      if (stopReason) throw new BreakdownBudgetExhausted();
      if (turns >= input.maxTurns) {
        stopReason = "turn_budget";
        agent.abort();
        throw new BreakdownBudgetExhausted();
      }
      turns += 1;
      let result: BreakdownTurnResult;
      try {
        result = await input.turn({
          system: context.systemPrompt ?? "",
          messages: context.messages.map(toTurnMessage),
          tools: (context.tools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        });
      } catch (error) {
        // 库会把这条异常合成一条空的助手消息,于是它在上层长得像「模型没说话」。
        // 先在这里记下真话:日志留内部原文,结果里留一句人话。抛回去交给库收场。
        turnFailure = TURN_FAILURE_MESSAGE;
        console.error("[script-breakdown] 模型往返失败", {
          turn: turns,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      model = result.model;
      inputTokens += result.inputTokens ?? 0;
      outputTokens += result.outputTokens ?? 0;
      unreadableInThisTurn = result.unreadableToolCalls.length > 0;
      if (unreadableInThisTurn) await reportUnreadable(result.unreadableToolCalls);
      return assistantStream(result);
    },
    beforeToolCall: async ({ toolCall }) => {
      if (!allowedTools.has(toolCall.name)) return { block: true, reason: "这个动作不在拆解工具里。" };
      if (toolCalls >= input.maxToolCalls) {
        stopReason = "tool_budget";
        agent.abort();
        return { block: true, reason: "这一次拆解的操作次数已经用完。" };
      }
      toolCalls += 1;
      return undefined;
    },
    // 收尾成功就停:再多跑一轮只会多花钱,不会多出内容。
    afterToolCall: async () => finished ? { terminate: true } : undefined,
  });

  // 模型有时候活没干完就停口(实测 20 次里出现 1 次:拆完场次就不说话了)。
  // 这不是解析问题,也不该整轮判死——把还缺什么告诉它,让它接着干。
  // 催问有上限:一直不动就如实报未完成,不无限烧钱。
  let nudges = 0;
  agent.subscribe((event) => {
    if (event.type !== "turn_end" || finished || stopReason) return;
    // 这两种不是「停口」,催问只会掩盖真因:整轮没跑成、以及这一轮的内容没读全
    // (那一条已经在请它重发了)。
    if (turnFailure || unreadableInThisTurn) return;
    if (event.message.role === "assistant"
      && event.message.content.some((item) => item.type === "toolCall")) return;
    if (nudges >= maxNudges) return;
    nudges += 1;
    const missing = workspace.finish();
    if (missing.status !== "rejected") return;
    agent.followUp({
      role: "user",
      content: [{ type: "text", text: `${missing.reason}请接着用工具把它补完,补完后调用完成拆解。` }],
      timestamp: Date.now(),
    });
  });

  await agent.prompt(breakdownUserPrompt(input.context, workspace.draft));
  await agent.waitForIdle();

  const validation = workspace.validate();
  return {
    completed: finished,
    ...(finished
      ? {}
      : { unfinishedReason: unfinishedReason(workspace, turnFailure, unreadableToolCalls, stopReason) }),
    stopReason,
    unreadableToolCalls,
    turnFailure,
    draft: workspace.draft,
    validation,
    turns,
    toolCalls,
    model,
    inputTokens,
    outputTokens,
  };
}

function unfinishedReason(
  workspace: BreakdownWorkspace,
  turnFailure: string | null,
  unreadableToolCalls: number,
  stopReason: BreakdownStopReason | null,
): string {
  if (stopReason) return STOP_MESSAGE[stopReason];
  if (turnFailure) return turnFailure;
  const attempt = workspace.finish();
  const gap = attempt.status === "rejected" ? attempt.reason : "拆解没有正常收尾,请重试。";
  return unreadableToolCalls > 0
    ? `有 ${unreadableToolCalls} 步的内容没读全,请模型重发之后仍然没能拆完。${gap}`
    : gap;
}

function unreadableRetryPrompt(
  calls: BreakdownTurnResult["unreadableToolCalls"],
  labels: Map<string, string>,
): string {
  const named = calls.map((call) => labels.get(call.name) ?? call.name).join("、");
  return [
    `刚才有 ${calls.length} 次调用(${named})的参数没有完整传过来,这几次都没有生效。`,
    `请只把这 ${calls.length} 次重新发一遍,参数要是完整合法的 JSON;同一批里其他调用已经生效,不用再发。`,
  ].join("");
}

function toTurnMessage(message: Context["messages"][number]): BreakdownTurnMessage {
  if (message.role === "toolResult") {
    return {
      role: "tool",
      content: textOf(message.content),
      toolCallId: message.toolCallId,
    };
  }
  if (message.role === "assistant") {
    const calls = message.content.flatMap((item) => item.type === "toolCall"
      ? [{ id: item.id, name: item.name, arguments: item.arguments as Record<string, unknown> }]
      : []);
    return {
      role: "assistant",
      content: textOf(message.content),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    };
  }
  return { role: "user", content: textOf(message.content) };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item && typeof item === "object" && "type" in item && item.type === "text"
      ? String((item as { text?: unknown }).text ?? "")
      : ""))
    .join("");
}

function assistantStream(result: BreakdownTurnResult) {
  const toolCalls: ToolCall[] = result.toolCalls.map((call) => ({
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: call.arguments,
  }));
  const message: AssistantMessage = {
    role: "assistant",
    content: [
      ...(result.text ? [{ type: "text" as const, text: result.text }] : []),
      ...toolCalls,
    ],
    api: "openai-completions",
    provider: "script-breakdown",
    model: result.model,
    usage: {
      ...EMPTY_USAGE,
      input: result.inputTokens ?? 0,
      output: result.outputTokens ?? 0,
      totalTokens: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
    },
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  let contentIndex = 0;
  for (const item of message.content) {
    if (item.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial: message });
      stream.push({ type: "text_delta", contentIndex, delta: item.text, partial: message });
      stream.push({ type: "text_end", contentIndex, content: item.text, partial: message });
    } else if (item.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex, partial: message });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: item, partial: message });
    }
    contentIndex += 1;
  }
  stream.push({ type: "done", reason: toolCalls.length > 0 ? "toolUse" : "stop", message });
  return stream;
}

export function breakdownSystemPrompt(): string {
  return [
    "你是短剧拆解助手。你的工作是读一集剧本,用给你的工具把它一层层拆开填进制作框架。",
    "只能通过工具改内容,不要在回复里写拆解结果——写在回复里的内容不会被保存。",
    "按这个顺序做:先写故事梗概,再按剧本顺序一场一场地拆,",
    "把出现的角色、场景、道具、服装、音频登记进来,最后调用完成拆解。",
    "分镜不用你拆:场次与资产齐了就可以收尾,拆解系统会自行拆镜。",
    "场次要把剧本从头到尾铺满:每一场紧接上一场结束的下一行,不重叠也不留空。",
    // 总纲,逐字段细则在 tools.ts 的 SCENE_HEADING_BOUNDARY_RULE / SCENE_NAME_VERBATIM_RULE。
    // 与名字那两条同一个道理:模型是顺着这段中文决定「这一集要拆几场」的。上面那句
    // 只说了「铺满、不重叠」,没说「几场由谁定」,于是模型把场数当成自己的判断题——
    // 实测同一集连跑 6 次在 1 场和 4 场之间来回,而正文只有一行场标(#283)。
    "有几场不由你判断:剧本里明写了几行场标就是几场,",
    "照抄场标行原文当这一场的名字,不要按剧情自己再切、也不要自编场名。",
    // 「场标行怎么认」在这里与 add_scene 的工具描述用的是同一个常量:总纲这一句
    // 原来自己写了一份封闭枚举(只列 INT./EXT./内景/外景),跟 schema 那份各写各的。
    // 仓库自己的稿子(冒烟脚本的「第一场」、四份夹具的「场景一」)两份都不认,
    // 于是模型被同时告知「没有场标」和「不许自己切」——最可能整集塌成 1 场。
    `场标行怎么认:${SCENE_HEADING_FORMS_RULE}`,
    // 与 tools.ts 的 SCENE_NAME_NULL_RULE 成对:堵死上一句之后必须给出没场标时的出路,
    // 否则「不许自己切」就成了死胡同。#283 正文的后半句说的就是这种稿子要靠提示词收敛。
    "只有整份剧本一行场标都没有时,才轮到你自己划分场次:按地点或时间的切换切,那种稿子场名给 null。",
    "登记资产与场次时:镜头会用到的角色、场景、道具、服装名称必须先登记过;剧本明写或可直接推出的音频(角色声音/旁白/音效/环境声)也要登记。",
    // 总纲。逐个字段的细则在工具入参描述里(tools.ts 的 NAME_VERBATIM_RULE),
    // 但模型是顺着这段中文说话的,不在这里先把语言钉死,它会整批把英文名译成中文。
    "名字一律照抄剧本原文的语言与字符:英文剧本里的名字就写英文原文,不许翻译或音译成中文。",
    "名字是后面唯一按字符串比对的东西,同一个人跨集必须始终是同一个字符串,改一个字就成了另一个人。",
    // 上一句的配对项。只说「名字跟着剧本走」,模型会把这条推广到整条记录,
    // 英文剧本拆出来的简介与外貌也跟着变成英文——翻译的毛病没了,换来一份
    // 导演读不懂的产出。照抄只管名字,别的字段一律中文。
    "除了名字,其余内容一律用中文写:简介、外貌、性格标签、场次梗概都不跟着剧本的语言走。",
    "只写剧本里真有的内容。剧本没写的信息就留空,不要靠名字、职业或称谓推测。",
    // P5(九.1):「定位要点」的旧口径把模型引向剧情定位句(实测 AARIC 的描述成了
    // 「救下坠崖的Elara后…」)。实体描述规则写进总纲,与 tools.ts 各参数细则同口径;
    // workspace.checkAssetInput 另有「描述照抄剧本原行」的硬校验兜底。
    "登记资产时,description 要写成这个资产的实体描述,不要照抄剧本原句,也不要写剧情动作:",
    "角色写外貌/着装/身份特征,场景写地点/陈设/氛围,道具写外形/功能特征,",
    "服装写款式/颜色/材质,音频写音色/情绪/用途。剧本没写的信息不要编,宁可给 null。",
    "某一次调用被退回时,只要按退回说明改这一次重来,已经填好的不用重做。",
  ].join("\n");
}

export function breakdownUserPrompt(context: WorkspaceContext, restored: ScriptBreakdownDraft): string {
  const approved = context.approvedAssets.length > 0
    ? context.approvedAssets.map((asset) => `- [${asset.assetKind}] ${asset.name}`).join("\n")
    : "(这个项目还没有已通过的资产)";
  const resumed = restored.sceneDivisions?.length || restored.shotCandidates?.length
    ? [
      "",
      "这一次是接着上次继续拆,已经填好的部分不要重做:",
      `- 已拆出 ${restored.sceneDivisions?.length ?? 0} 场、${restored.shotCandidates?.length ?? 0} 个镜头;`,
      `- 下一场要从第 ${(restored.sceneDivisions?.at(-1)?.endLineIndex ?? -1) + 1} 行开始。`,
    ]
    : [];
  return [
    "剧本按行编号如下(L 后面是行号):",
    "```",
    formatLinesForPrompt(context.scriptLines),
    "```",
    "",
    context.targetDurationSec
      ? `这一集的目标总时长是 ${context.targetDurationSec} 秒。`
      : "这一集没有设定目标总时长。",
    "",
    "这个项目已通过的资产(镜头里可以直接引用):",
    approved,
    ...resumed,
  ].join("\n");
}
