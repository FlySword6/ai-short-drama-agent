import assert from "node:assert/strict";
import test from "node:test";
import { chunkScriptLines } from "../lines.js";
import type { ScriptBreakdownDraft } from "../types.js";
import {
  runBreakdownAgent,
  type BreakdownAgentInput,
  type BreakdownTurn,
  type BreakdownTurnInput,
  type BreakdownTurnResult,
} from "./runner.js";
import { SCENE_HEADING_FORMS_RULE, type BreakdownFillEvent } from "./tools.js";

/**
 * 循环本身来自 @earendil-works/pi-agent-core:工具派发、入参校验、把失败
 * 变成这一次调用的错误结果再回给模型,都是库的行为。这里测的是接上去之后
 * 的产品语义:一段剧本走完东西进库;某一次调用失败只重那一次;每次调用
 * 都留下一条能给用户看的事件。
 */

const SCRIPT = [
  "场景一 客栈门口",
  "林晚提着行李站在门口。",
  "掌柜迎上来:客官打尖还是住店?",
].join("\n");

function turnResult(
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>,
  text = "",
  unreadable: Array<{ name: string; argumentsExcerpt: string }> = [],
): BreakdownTurnResult {
  return {
    text,
    toolCalls: toolCalls.map((call, index) => ({
      id: `call-${index}-${Math.random().toString(36).slice(2, 8)}`,
      name: call.name,
      arguments: call.arguments,
    })),
    unreadableToolCalls: unreadable.map((call, index) => ({
      id: `bad-${index}-${Math.random().toString(36).slice(2, 8)}`,
      name: call.name,
      argumentsExcerpt: call.argumentsExcerpt,
    })),
    model: "fake-agent-model",
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 5,
  };
}

function scriptedTurn(script: Array<BreakdownTurnResult | Error>): {
  turn: BreakdownTurn;
  calls: number;
  requests: BreakdownTurnInput[];
} {
  const state = { calls: 0 };
  const requests: BreakdownTurnInput[] = [];
  const turn: BreakdownTurn = async (input) => {
    requests.push(input);
    const next = script[state.calls];
    state.calls += 1;
    if (!next) throw new Error(`turn script exhausted at ${state.calls}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { turn, get calls() { return state.calls; }, requests };
}

const HAPPY_SCRIPT: BreakdownTurnResult[] = [
  turnResult([{ name: "write_story_outline", arguments: { summary: "林晚投宿客栈" } }]),
  turnResult([{
    name: "add_scene",
    arguments: { name: "客栈门口", summary: "林晚抵达客栈", start_line_index: 0, end_line_index: 2 },
  }]),
  turnResult([{ name: "add_character", arguments: { name: "林晚", description: "女主角" } }]),
  turnResult([{ name: "finish_breakdown", arguments: {} }]),
  turnResult([], "拆完了。"),
];

async function run(
  script: Array<BreakdownTurnResult | Error>,
  maxUnreadableRetries?: number,
  overrides: Partial<Pick<BreakdownAgentInput, "maxToolCalls" | "maxTurns">> = {},
) {
  const events: BreakdownFillEvent[] = [];
  const snapshots: ScriptBreakdownDraft[] = [];
  const scripted = scriptedTurn(script);
  const result = await runBreakdownAgent({
    context: {
      scriptLines: chunkScriptLines(SCRIPT),
      approvedAssets: [],
      targetDurationSec: null,
    },
    turn: scripted.turn,
    onEvent: (event) => { events.push(event); },
    onFilled: (draft) => { snapshots.push(draft); },
    maxToolCalls: 50,
    maxTurns: 30,
    ...overrides,
    ...(maxUnreadableRetries === undefined ? {} : { maxUnreadableRetries }),
  });
  return { result, events, snapshots, turnCount: scripted.calls, requests: scripted.requests };
}

test("一段剧本走完:梗概、场、角色都进了草稿;分镜不在阶段①(P6)", async () => {
  const { result } = await run(HAPPY_SCRIPT);

  assert.equal(result.completed, true);
  assert.equal(result.draft.storySummary, "林晚投宿客栈");
  assert.equal(result.draft.sceneDivisions?.length, 1);
  assert.equal(result.draft.assetCandidates?.characters.length, 1);
  assert.equal(result.draft.shotCandidates, undefined, "P6 起镜头由阶段②产出,阶段①草稿里没有分镜");
});

test("每次工具调用都留下一条带人话描述的可展示事件", async () => {
  const { events } = await run(HAPPY_SCRIPT);

  assert.deepEqual(events.map((event) => event.tool), [
    "write_story_outline",
    "add_scene",
    "add_character",
    "finish_breakdown",
  ]);
  for (const event of events) {
    assert.ok(event.description.trim().length > 0, `${event.tool} 没有可展示的描述`);
    assert.doesNotMatch(event.description, /[a-z]_[a-z]/, "描述里不该出现内部字段名");
  }
  assert.match(events[1]?.description ?? "", /客栈门口/);
});

test("中途一次工具调用被拒:只重那一次,已经填好的不重做", async () => {
  const wrongThenRight: BreakdownTurnResult[] = [
    HAPPY_SCRIPT[0]!,
    HAPPY_SCRIPT[1]!,
    HAPPY_SCRIPT[2]!,
    // 模型又想加一场,但剧本已被第一场铺满——工作台当场拒绝
    turnResult([{
      name: "add_scene",
      arguments: { name: "客房", summary: "林晚看山", start_line_index: 0, end_line_index: 1 },
    }]),
    // 收到人话原因后模型收尾
    HAPPY_SCRIPT[3]!,
    HAPPY_SCRIPT[4]!,
  ];

  const { result, events } = await run(wrongThenRight);

  assert.equal(result.completed, true);
  const rejected = events.filter((event) => event.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]?.reason ?? "", /归入场次|第 3 行/);
  assert.equal(result.draft.sceneDivisions?.length, 1, "场没有被重做");
  assert.equal(result.draft.assetCandidates?.characters.length, 1, "角色没有被重做");
});

test("模型活没干完就停下时,把还缺什么告诉它并接着干", async () => {
  const { result, turnCount } = await run([
    HAPPY_SCRIPT[0]!,
    // 场次还没拆就停口
    turnResult([], "先到这里。"),
    // 收到「还没有拆出任何场次」后接着干
    HAPPY_SCRIPT[1]!,
    HAPPY_SCRIPT[2]!,
    HAPPY_SCRIPT[3]!,
    HAPPY_SCRIPT[4]!,
  ]);

  assert.equal(result.completed, true);
  assert.equal(result.draft.sceneDivisions?.length, 1);
  assert.ok(turnCount >= 5, "停口之后应该继续问下去,而不是就此收工");
});

test("一直不干活时不无限催,催到上限就如实报未完成", async () => {
  const { result, turnCount } = await run([
    HAPPY_SCRIPT[0]!,
    ...Array.from({ length: 10 }, () => turnResult([], "我想不出来。")),
  ]);

  assert.equal(result.completed, false);
  assert.match(result.unfinishedReason ?? "", /还没有拆出任何场次/);
  assert.ok(turnCount <= 6, `催问要有上限,实际跑了 ${turnCount} 轮`);
});

/**
 * 下面四条钉的是同一种病:失败被吞成「模型这一轮没干活」。
 * 排查的人会往「提示词不好 / 模型能力差」找,实际是一条读不出的报文。
 */

const BAD_ARGUMENTS_EXCERPT = "{\"name\": \"Grandma\", \"gender\": female, \"age_stage\":";

test("一批六个只有一个读不出:另外五个照填,只有坏的那次被退回", async () => {
  const { result, requests } = await run([
    HAPPY_SCRIPT[0]!,
    HAPPY_SCRIPT[1]!,
    // 一次响应带六个工具调用,第二个的入参是半截 JSON
    turnResult([
      { name: "add_character", arguments: { name: "林晚", description: "女主角" } },
      { name: "add_character", arguments: { name: "掌柜", description: "客栈掌柜" } },
      { name: "add_location", arguments: { name: "客栈门口" } },
      { name: "add_prop", arguments: { name: "行李" } },
      { name: "add_prop", arguments: { name: "灯笼" } },
    ], "", [{ name: "add_character", argumentsExcerpt: BAD_ARGUMENTS_EXCERPT }]),
    // 收到退回后只重发这一次
    turnResult([{ name: "add_character", arguments: { name: "老板娘", description: "客栈老板娘" } }]),
    HAPPY_SCRIPT[3]!,
    HAPPY_SCRIPT[4]!,
  ]);

  assert.equal(result.completed, true);
  assert.equal(result.draft.assetCandidates?.characters.length, 3, "五条合法的照填,重发的那条补上");
  assert.equal(result.draft.assetCandidates?.scenes.length, 1);
  assert.equal(result.draft.assetCandidates?.props.length, 2);
  assert.equal(result.unreadableToolCalls, 1);

  // 退回只针对坏的那一次:下一轮送上去的是「重发这一次」,不是让它整批重做。
  const followUp = requests[3]?.messages.at(-1);
  assert.equal(followUp?.role, "user");
  assert.match(followUp?.content ?? "", /重(新发|发)/);
  assert.doesNotMatch(followUp?.content ?? "", /全部|整批|重头|从头/);
});

test("读不出是一条显式的可展示事件,和「模型主动没调工具」分得开", async () => {
  const unreadable = await run([
    HAPPY_SCRIPT[0]!,
    HAPPY_SCRIPT[1]!,
    turnResult([], "", [{ name: "add_scene", argumentsExcerpt: BAD_ARGUMENTS_EXCERPT }]),
    HAPPY_SCRIPT[2]!,
    HAPPY_SCRIPT[3]!,
    HAPPY_SCRIPT[4]!,
  ]);
  const quiet = await run([
    HAPPY_SCRIPT[0]!,
    HAPPY_SCRIPT[1]!,
    turnResult([], "先到这里。"),
    HAPPY_SCRIPT[2]!,
    HAPPY_SCRIPT[3]!,
    HAPPY_SCRIPT[4]!,
  ]);

  const reported = unreadable.events.filter((event) => event.status === "unreadable");
  assert.equal(reported.length, 1, "读不出必须在事件流里留下一条");
  assert.equal(reported[0]?.tool, "add_scene");
  assert.ok((reported[0]?.description ?? "").trim().length > 0, "界面上要有话说,不能只是进度条不动");
  assert.doesNotMatch(reported[0]?.description ?? "", /[A-Za-z]/, "给用户看的话里不留英文报错");
  assert.doesNotMatch(reported[0]?.description ?? "", /JSON|null/i);

  assert.equal(unreadable.result.unreadableToolCalls, 1);
  assert.equal(quiet.result.unreadableToolCalls, 0, "模型主动不调工具是合法情况,不能算读不出");
  assert.equal(quiet.events.filter((event) => event.status === "unreadable").length, 0);

  // 事件序号是整条流的序号,读不出那条也排在里面,界面按它排序不会乱。
  assert.deepEqual(
    unreadable.events.map((event) => event.sequence),
    unreadable.events.map((_event, index) => index + 1),
  );
});

test("一直读不出时不无限重发,到上限就如实报未完成", async () => {
  const { result, turnCount } = await run([
    HAPPY_SCRIPT[0]!,
    ...Array.from({ length: 10 }, () => turnResult([], "", [
      { name: "add_scene", argumentsExcerpt: BAD_ARGUMENTS_EXCERPT },
    ])),
  ], 2);

  assert.equal(result.completed, false);
  assert.equal(result.unreadableToolCalls, 3, "首次加两次重发,到此为止");
  assert.ok(turnCount <= 5, `重发要有上限,实际跑了 ${turnCount} 轮`);
  assert.match(result.unfinishedReason ?? "", /没读全|没读出/);
});

test("整轮往返失败不再被吞成「模型没干活」,已经填好的保留下来", async () => {
  const { result, events } = await run([
    HAPPY_SCRIPT[0]!,
    HAPPY_SCRIPT[1]!,
    new Error("Ark: chat completion failed with status 500"),
  ]);

  assert.equal(result.completed, false);
  assert.ok(result.turnFailure, "整轮失败必须能被上层看见,而不是当成模型停口");
  assert.doesNotMatch(result.turnFailure ?? "", /[A-Za-z]/, "对外说人话:不带厂商名、状态码、英文报错");
  assert.equal(result.unfinishedReason, result.turnFailure);
  assert.doesNotMatch(result.unfinishedReason ?? "", /还没有拆出任何镜头/);
  assert.equal(result.draft.sceneDivisions?.length, 1, "已经填好的内容不因为一次往返失败被丢掉");
  assert.equal(events.filter((event) => event.status === "unreadable").length, 0);
});

/**
 * 下面两条是服务层能不能接上去的前提:
 * 过程快照决定断点续跑的粒度,轮次硬上限决定这条链路最多能花多少钱。
 */

test("每填进去一格就给一份过程快照,服务层据此增量落库", async () => {
  const { result, snapshots } = await run(HAPPY_SCRIPT);

  assert.equal(snapshots.length, 4, "阶段①四次成功填充(梗概/场/角色/收尾)各给一份快照");
  assert.equal(snapshots[0]?.storySummary, "林晚投宿客栈");
  assert.equal(snapshots[0]?.sceneDivisions, undefined, "第一份快照时还没有场");
  assert.equal(snapshots[1]?.sceneDivisions?.length, 1);
  assert.equal(snapshots[2]?.assetCandidates?.characters.length, 1);
  // 快照是当场拷贝,不是同一个对象的引用——否则落库落到的是最终态,
  // 中途崩溃时数据库里就没有「当时填到哪」这件事。
  assert.notEqual(snapshots[1], snapshots[2]);
  assert.deepEqual(snapshots.at(-1), result.draft);
});

test("被退回和读不出的那几次不给快照:草稿没变就不该重复落库", async () => {
  const { snapshots } = await run([
    HAPPY_SCRIPT[0]!,
    HAPPY_SCRIPT[1]!,
    turnResult([{
      name: "add_scene",
      arguments: { name: "客房", summary: "林晚看山", start_line_index: 0, end_line_index: 1 },
    }], "", [{ name: "add_character", argumentsExcerpt: BAD_ARGUMENTS_EXCERPT }]),
    HAPPY_SCRIPT[2]!,
    HAPPY_SCRIPT[3]!,
    HAPPY_SCRIPT[4]!,
  ]);

  assert.equal(snapshots.length, 4, "退回与读不出不改草稿,不该产生快照");
});

test("轮次用完就停手:不再发起新的付费往返,已经填好的保留下来", async () => {
  const { result, turnCount } = await run(
    [
      HAPPY_SCRIPT[0]!,
      HAPPY_SCRIPT[1]!,
      ...Array.from({ length: 20 }, () => turnResult([
        { name: "add_prop", arguments: { name: `道具${Math.random()}` } },
      ])),
    ],
    undefined,
    { maxTurns: 4 },
  );

  assert.equal(result.completed, false);
  assert.equal(turnCount, 4, "第 5 轮不许再发出去——每一轮都是一次真实付费调用");
  assert.equal(result.turns, 4);
  assert.equal(result.draft.sceneDivisions?.length, 1, "已经填好的内容保留");
  assert.doesNotMatch(result.unfinishedReason ?? "", /[A-Za-z]/);
  assert.equal(result.turnFailure, null, "轮次用完不是「接不上话」,不能报成传输失败");
});

test("工具调用次数用完就收手:不靠模型自己不说话来停,也不再发付费往返", async () => {
  const { result, turnCount } = await run(
    [
      HAPPY_SCRIPT[0]!,
      HAPPY_SCRIPT[1]!,
      ...Array.from({ length: 20 }, () => turnResult([
        { name: "add_prop", arguments: { name: `道具${Math.random()}` } },
      ])),
    ],
    undefined,
    { maxToolCalls: 3, maxTurns: 50 },
  );

  assert.equal(result.completed, false);
  assert.equal(result.toolCalls, 3, "超出上限的调用不许再计入,也不许再执行");
  assert.ok(turnCount <= 4, `用完额度后不该继续转圈,实际跑了 ${turnCount} 轮`);
  assert.doesNotMatch(result.unfinishedReason ?? "", /[A-Za-z]/);
});

/**
 * 名字反翻译的总纲在系统提示里,细则在工具入参说明里,两处都得真发出去。
 *
 * 这条守卫站在传输口上:断言的是这一轮实际交给通道的那份载荷。提示词写了但
 * 没随请求发出、或者工具 schema 在路上被抹掉描述,都算没落地。
 */
test("每一轮发出去的载荷里,系统提示与工具说明都带着「名字照抄原文」", async () => {
  const { requests } = await run(HAPPY_SCRIPT);
  assert.ok(requests.length > 0, "没有发出任何一轮,守卫是空的");

  for (const [index, request] of requests.entries()) {
    assert.match(request.system, /照抄剧本原文的语言与字符/, `第 ${index + 1} 轮的系统提示没带名字总纲`);
    assert.match(request.system, /不许翻译或音译/, `第 ${index + 1} 轮的系统提示没禁翻译音译`);
    // 配对项:照抄只管名字,其余内容仍是中文。少了它,反翻译会外溢成整份英文产出。
    assert.match(
      request.system,
      /除了名字,其余内容一律用中文写/,
      `第 ${index + 1} 轮的系统提示漏了「照抄只管名字」的配对项`,
    );

    for (const toolName of ["add_character", "add_location", "add_prop"]) {
      const tool = request.tools.find((candidate) => candidate.name === toolName);
      assert.ok(tool, `第 ${index + 1} 轮没把 ${toolName} 发给模型`);
      const description = (tool.parameters as {
        properties?: Record<string, { description?: string } | undefined>;
      }).properties?.name?.description ?? "";
      assert.match(description, /禁止翻译、音译/, `第 ${index + 1} 轮 ${toolName} 的 name 说明没带反翻译约束`);
    }
  }
});

/**
 * 场次规则同样得真发出去,而且两处都要有。
 *
 * 总纲在系统提示里(模型是顺着那段中文决定「这一集拆几场」的),细则在 add_scene
 * 的工具描述与 name 入参说明里。#283 实测:`ep-idb-09` 同一份正文连跑 6 次,场数
 * 在 1 和 4 之间来回,而正文只有一行场标;同一批里 name 12 次有 8 次给 null。
 * 规则写在源码里但没随请求发出、或者工具 schema 在路上被抹掉描述,都算没落地。
 */
test("每一轮发出去的载荷里,系统提示与 add_scene 都带着「场次照场标走」", async () => {
  const { requests } = await run(HAPPY_SCRIPT);
  assert.ok(requests.length > 0, "没有发出任何一轮,守卫是空的");

  for (const [index, request] of requests.entries()) {
    assert.match(request.system, /有几场不由你判断/, `第 ${index + 1} 轮的系统提示没带场次总纲`);
    assert.match(
      request.system,
      /剧本里明写了几行场标/,
      `第 ${index + 1} 轮的系统提示没说清场数来自场标行`,
    );
    assert.match(
      request.system,
      /照抄场标行原文当这一场的名字/,
      `第 ${index + 1} 轮的系统提示漏了「场名照抄场标」`,
    );

    const addScene = request.tools.find((candidate) => candidate.name === "add_scene");
    assert.ok(addScene, `第 ${index + 1} 轮没把 add_scene 发给模型`);
    assert.match(
      addScene.description,
      /有几行场标就拆几场/,
      `第 ${index + 1} 轮 add_scene 的工具说明没带场次边界规则`,
    );
    assert.match(
      addScene.description,
      /不许按剧情推进、情绪转折、时间跳跃或人物进出自己再切/,
      `第 ${index + 1} 轮 add_scene 没禁掉按内容自己再切`,
    );

    const properties = (addScene.parameters as {
      properties?: Record<string, { description?: string } | undefined>;
    }).properties;
    const nameDescription = properties?.name?.description ?? "";
    assert.match(
      nameDescription,
      /照抄那一整行场标原文/,
      `第 ${index + 1} 轮 add_scene 的 name 说明没带照抄场标规则`,
    );
    assert.match(
      nameDescription,
      /不许自编节拍标签/,
      `第 ${index + 1} 轮 add_scene 的 name 说明没禁自编节拍标签`,
    );
    assert.match(
      nameDescription,
      /这是例外不是常态/,
      `第 ${index + 1} 轮 add_scene 的 name 说明没把 null 写成例外`,
    );
    // 场次 name 此前没拿到反翻译规则(引用类的 character_names/scene_names/prop_names
    // 也没有,但那几个填的是已登记名字、由 workspace.firstUnknownName 兜),补上之后不许在路上掉。
    assert.match(
      nameDescription,
      /禁止翻译、音译/,
      `第 ${index + 1} 轮 add_scene 的 name 说明没带反翻译约束`,
    );
    assert.match(
      properties?.summary?.description ?? "",
      /一律用中文写/,
      `第 ${index + 1} 轮 add_scene 的场次梗概漏了「不跟着剧本语言走」的配对项`,
    );
  }
});

/**
 * 场标写法两处必须是同一份,而且都要真发出去。
 *
 * 上一条守卫钉的是「规则发出去了」,这一条钉的是「两处没漂」:总纲(系统提示)
 * 与 add_scene 的工具描述原来各写了一份封闭枚举,只改 schema 不改总纲,模型就会
 * 同时收到两套口径。现在两处共用 tools.ts 的 SCENE_HEADING_FORMS_RULE,守卫按
 * 常量原文逐字比对——谁把哪一边改回手写枚举,这里当场红。
 *
 * 本条跑的剧本正文就是模块级的 SCRIPT,首行「场景一 客栈门口」:老封闭枚举不认
 * 它,叠上「不许自己切」正是 #283 说的那种「模型只能塌成 1 场」的稿子。
 */
test("场标写法只有一份:系统提示与 add_scene 逐字带着同一条,且无场标那一侧有出路", async () => {
  const { requests } = await run(HAPPY_SCRIPT);
  assert.ok(requests.length > 0, "没有发出任何一轮,守卫是空的");
  assert.ok(
    SCRIPT.startsWith("场景一"),
    "这条守卫要用「场景一」这种中文场标的稿子才算数,SCRIPT 改了写法就得同步改这里",
  );

  for (const [index, request] of requests.entries()) {
    assert.ok(
      request.system.includes(SCENE_HEADING_FORMS_RULE),
      `第 ${index + 1} 轮的系统提示没带 SCENE_HEADING_FORMS_RULE 原文,两处场标口径已经漂开`,
    );
    assert.match(
      request.system,
      /只有整份剧本一行场标都没有时,才轮到你自己划分场次/,
      `第 ${index + 1} 轮的系统提示漏了无场标时的出路,「不许自己切」成了死胡同`,
    );

    const addScene = request.tools.find((candidate) => candidate.name === "add_scene");
    assert.ok(addScene, `第 ${index + 1} 轮没把 add_scene 发给模型`);
    assert.ok(
      addScene.description.includes(SCENE_HEADING_FORMS_RULE),
      `第 ${index + 1} 轮 add_scene 的工具说明没带 SCENE_HEADING_FORMS_RULE 原文`,
    );

    for (const form of ["第一场", "场景一", "内景", "INT."]) {
      assert.ok(
        request.system.includes(form) && addScene.description.includes(form),
        `第 ${index + 1} 轮有一处不认「${form}」这种场标写法,仓库自己的稿子就用这种`,
      );
    }
  }
});
