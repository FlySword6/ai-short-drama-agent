import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chunkScriptLines } from "../lines.js";
import { BreakdownWorkspace } from "./workspace.js";
import { BREAKDOWN_TOOL_NAMES, createBreakdownTools, type BreakdownFillEvent } from "./tools.js";

/**
 * 工具是 agent 与框架之间唯一的接触面。这里钉两件事:
 * 一次调用即一个可展示事件;拒绝以错误结果回到模型,好让它只重这一次。
 */

const SCRIPT = [
  "场景一 客栈门口",
  "林晚提着行李站在门口。",
  "掌柜迎上来:客官打尖还是住店?",
].join("\n");

function setup() {
  const workspace = new BreakdownWorkspace({
    scriptLines: chunkScriptLines(SCRIPT),
    approvedAssets: [],
    targetDurationSec: null,
  });
  const events: Array<Omit<BreakdownFillEvent, "sequence">> = [];
  const tools = createBreakdownTools({
    workspace,
    onEvent: (event) => { events.push(event); },
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { workspace, events, byName };
}

test("工具集覆盖拆解的全部填充动作,名字对外稳定", () => {
  const { byName } = setup();
  assert.deepEqual([...byName.keys()].sort(), [...BREAKDOWN_TOOL_NAMES].sort());
});

test("一次成功的工具调用产生一条带人话描述的事件", async () => {
  const { events, byName, workspace } = setup();

  await byName.get("add_scene")!.execute("call-1", {
    name: "客栈门口",
    summary: "林晚抵达客栈",
    start_line_index: 0,
    end_line_index: 2,
  }, undefined);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.tool, "add_scene");
  assert.equal(events[0]?.status, "accepted");
  assert.match(events[0]?.description ?? "", /客栈门口/);
  assert.equal(workspace.draft.sceneDivisions?.length, 1);
});

test("入参不合法时工具抛出人话原因,由 agent 循环变成这一次调用的错误结果", async () => {
  const { events, byName, workspace } = setup();
  await byName.get("add_scene")!.execute("call-1", {
    name: "客栈门口",
    summary: "林晚抵达客栈",
    start_line_index: 0,
    end_line_index: 1,
  }, undefined);

  await assert.rejects(
    byName.get("add_scene")!.execute("call-2", {
      name: "客房",
      summary: "林晚看山",
      start_line_index: 0,
      end_line_index: 2,
    }, undefined),
    (error: unknown) => error instanceof Error && /第 2 行/.test(error.message),
  );

  assert.equal(events.length, 2);
  assert.equal(events[1]?.status, "rejected");
  assert.match(events[1]?.reason ?? "", /第 2 行/);
  assert.equal(workspace.draft.sceneDivisions?.length, 1, "被拒绝的调用不改动草稿");
});

test("工具入参 schema 就是数据合同:必填缺失由 schema 拦住,不靠提示词祈求", () => {
  const { byName } = setup();
  const addScene = byName.get("add_scene")!;
  const properties = (addScene.parameters as { properties: Record<string, unknown>; required?: string[] });

  assert.deepEqual(
    [...(properties.required ?? [])].sort(),
    ["end_line_index", "start_line_index", "summary"],
  );
  assert.ok(!("scene_no" in properties.properties), "场号由服务端分配,不该出现在模型能填的字段里");
  assert.ok(!("candidate_id" in properties.properties), "候选编号由服务端分配");
});

test("服装登记进草稿并带类型字段(§2 P1)", async () => {
  const { byName, workspace } = setup();
  await byName.get("add_costume")!.execute("call-1", {
    name: "嫁衣",
    description: "红色绣花嫁衣",
    wearer_names: ["林晚"],
    color: "红色",
    occasion: "婚礼",
  }, undefined);
  const costume = workspace.draft.assetCandidates?.costumes[0];
  assert.equal(costume?.candidateId, "costume_001");
  assert.equal(costume?.name, "嫁衣");
  assert.deepEqual(costume?.wearerNames, ["林晚"]);
  assert.equal(costume?.color, "红色");
  assert.equal(costume?.occasion, "婚礼");
});

test("音频登记按五种 audioKind 落库,audio_kind 必填(§2 P1)", async () => {
  const { byName, workspace } = setup();
  await byName.get("add_audio")!.execute("call-1", {
    name: "雨声",
    description: "夜雨打在瓦片上",
    audio_kind: "ambience",
    sound_cue_text: "雨声",
  }, undefined);
  const audio = workspace.draft.assetCandidates?.audios[0];
  assert.equal(audio?.candidateId, "audio_001");
  assert.equal(audio?.audioKind, "ambience");
  assert.equal(audio?.soundCueText, "雨声");
  const properties = (byName.get("add_audio")!.parameters as { required?: string[] });
  assert.ok(properties.required?.includes("audio_kind"), "audio_kind 是必填字段,缺了由 schema 拦");
});

test("阶段①工具集没有拆镜工具:分镜由阶段②一次结构化生成(P6)", () => {
  const { byName } = setup();
  assert.equal(byName.has("add_shot"), false, "P6 起镜头不再由 agent 逐镜填,阶段①只产场次与资产");
  assert.equal(byName.has("add_scene"), true);
  assert.equal(byName.has("add_character"), true);
  assert.equal(byName.has("add_costume"), true);
  assert.equal(byName.has("add_audio"), true);
});

/**
 * 下面两条是从散文提示词那边搬过来的产品口径。口径没变,载体变了:
 * 以前靠一段话请模型照做,现在写进工具的入参 schema——模型只能按这个形状
 * 调用,填不出的字段就是填不出,不是"它没听话"。
 */

test("角色登记锁定补全字段,并写明不许从姓名职业称谓猜", () => {
  const { byName } = setup();
  const parameters = JSON.stringify(byName.get("add_character")!.parameters);

  for (const field of ["gender", "age_value", "age_stage", "appearance", "personality_tags"]) {
    assert.match(parameters, new RegExp(field), `角色入参缺少 ${field}`);
  }
  assert.match(parameters, /不要从名字或称谓猜/, "不猜测规则必须写在入参说明里");
  assert.match(parameters, /只有剧本明说了具体岁数才填/, "年龄只认剧本明说的");
});

/**
 * 反翻译规则不许在换载体时丢掉。
 *
 * 老路上「剧本里用的称呼」这句实测同一集 5 次里 4 次把英文角色名整批译成中文,
 * 机器随后判「正文查无此人」,同一个人跨集裂成两张资产卡;prompts.ts 的 v3/v4
 * 就是修这个。切到 agent 路后约束只剩这一处入参说明,所以在这里钉死——钉的是
 * 模型真收到的那份 schema,不是源码里某个常量长什么样。
 */
function nameFieldDescription(tool: { parameters: unknown }): string {
  const properties = (tool.parameters as {
    properties?: Record<string, { description?: string } | undefined>;
  }).properties;
  return properties?.name?.description ?? "";
}

test("角色与资产的 name:照抄剧本原文,禁止翻译音译", () => {
  const { byName } = setup();

  for (const toolName of ["add_character", "add_location", "add_prop"] as const) {
    const description = nameFieldDescription(byName.get(toolName)!);

    assert.match(description, /照抄/, `${toolName} 的 name 没要求照抄原文`);
    assert.match(description, /保持原文的语言与字符/, `${toolName} 的 name 没钉住原文语言与字符`);
    assert.match(description, /禁止翻译/, `${toolName} 的 name 没禁翻译`);
    assert.match(description, /音译/, `${toolName} 的 name 没禁音译`);
    assert.match(description, /不许换语言/, `${toolName} 的 name 撞名拆分时漏了「不许换语言」`);
  }
});

/**
 * 反翻译规则的配对项:照抄只管 name,其余字段仍然是中文。
 *
 * 老路 v3 是把这两半成对写死的。只搬「name 照抄原文」那半句,模型会把「跟着
 * 剧本的语言走」推广到整条记录——翻译的毛病没了,换来一份英文简介。
 *
 * 第二条断言修的是措辞错位:这条规则会被贴到好几个字段上,而模型读到的只是
 * **自己这个字段**的那一份。原来枚举写的是「description/appearance/personality_tags
 * 等」,贴到 add_scene 的 summary 上时枚举里恰恰没有 summary,模型完全可以读成
 * 「这条不管我」;runner.ts 的系统提示那半句却点名了「场次梗概」。只断
 * `/一律用中文写/` 照不出这种错位,所以补一条:规则要么泛化成「name 之外的字段」,
 * 要么就得把当前这个字段名列进去。
 */
test("name 之外的字段一律中文:照抄规则不许外溢成整份英文产出", () => {
  const { byName } = setup();

  const fieldsByTool: Record<string, string[]> = {
    add_scene: ["summary"],
    add_character: ["description", "appearance", "personality_tags"],
    add_location: ["description"],
    add_prop: ["description"],
  };

  for (const [toolName, fields] of Object.entries(fieldsByTool)) {
    const properties = (byName.get(toolName)!.parameters as {
      properties?: Record<string, { description?: string } | undefined>;
    }).properties;

    for (const field of fields) {
      const description = properties?.[field]?.description ?? "";
      assert.match(
        description,
        /一律用中文写/,
        `${toolName} 的 ${field} 没钉住「不跟着剧本语言走」,反翻译规则会外溢`,
      );
      assert.ok(
        /name 之外的字段/.test(description) || description.includes(field),
        `${toolName} 的 ${field} 读到的规则既没泛化成「name 之外的字段」、也没点名 ${field},`
          + "模型有理由认为这条不管自己这个字段",
      );
    }
  }
});

/**
 * 场次三条:边界照场标、name 照抄整行、null 只是例外。
 *
 * 这三条修的是同一个根因——模型不把场标当作要照抄的东西(#283)。实测
 * `ep-idb-09` 同一份正文连跑 6 次,场数在 1 和 4 之间来回,而正文只有一行场标、
 * 金标 scene-boundary 也只有一条;同一批里 add_scene 的 name 12 次有 8 次给 null。
 * 断的是模型真收到的那份 schema 措辞,不是源码里某个常量长什么样。
 */
test("场次边界照剧本的场标行走:有几行场标就是几场,不许按内容自己再切", () => {
  const { byName } = setup();
  const description = byName.get("add_scene")!.description;

  assert.match(description, /场次边界照剧本里明写的场标行走/, "没说清场次边界的来源是场标行");
  assert.match(description, /有几行场标就拆几场/, "没把「场数 = 场标行数」钉死,模型会自己判断要拆几场");
  assert.match(description, /不许按剧情推进、情绪转折、时间跳跃或人物进出自己再切/, "没禁掉按内容自己再切");
  assert.match(description, /一场戏再长也还是一场/, "缺了这句,长的连续戏还是会被切开");
  for (const marker of ["INT.", "EXT.", "内景", "外景"]) {
    assert.ok(description.includes(marker), `场标行的判别标记里没列 ${marker}`);
  }
});

/**
 * 上面那条只测了「有场标」那一侧,而且第一版把场标写成了封闭枚举
 * (INT. / EXT. / I/E. / 内景 / 外景)——**仓库自己的稿子一份都不在里面**。
 *
 * 用例不是编的:`scripts/breakdown-agent-smoke.mts` 的 SAMPLE_SCRIPT 写
 * 「第一场 客栈门口 黄昏」「第二场 客房 夜」,agent 这四份夹具
 * (tools / workspace / runner / gateway-turn)写「场景一 客栈门口」。
 * 按封闭枚举这些一行都不算场标,再叠上「没有下一行场标就不许自己切」,
 * 模型对这类稿子最可能整集塌成 1 场。
 *
 * 老验收照不到这个盲区:11 份评测语料全部 ≥1 个场标,三条行为验收全落在
 * 「有场标」那一侧。所以这条守卫从仓库现成的稿子反着断——每一行真在用的
 * 中文场标,规则里都得认得出;再断没场标那一侧有出路,不是死胡同。
 */
const REPO_OWN_CN_SCENE_HEADINGS: ReadonlyArray<{ line: string; form: string; where: string }> = [
  { line: "第一场 客栈门口 黄昏", form: "第一场", where: "scripts/breakdown-agent-smoke.mts 的 SAMPLE_SCRIPT" },
  { line: "第二场 客房 夜", form: "第二场", where: "scripts/breakdown-agent-smoke.mts 的 SAMPLE_SCRIPT" },
  { line: "场景一 客栈门口", form: "场景一", where: "tools / workspace / runner / gateway-turn 四份夹具" },
];

const SMOKE_SCRIPT_SOURCE = readFileSync(
  new URL("../../../../scripts/breakdown-agent-smoke.mts", import.meta.url),
  "utf8",
);

test("盲区回归:仓库自己在用的中文场标写法,规则里都认得出", () => {
  const { byName } = setup();
  const description = byName.get("add_scene")!.description;

  // 先证明用例还活着——稿子改了写法而这张表没跟着改,守卫就悄悄变空了。
  for (const { line, where } of REPO_OWN_CN_SCENE_HEADINGS) {
    const stillUsed = SMOKE_SCRIPT_SOURCE.includes(line) || SCRIPT.includes(line);
    assert.ok(stillUsed, `用例过期:${where} 里已经没有「${line}」了,这张表要跟着改,否则守卫是空的`);
  }

  for (const { line, form, where } of REPO_OWN_CN_SCENE_HEADINGS) {
    assert.ok(
      description.includes(form),
      `场标写法里没有「${form}」——${where} 的「${line}」按规则就不算场标,`
        + "模型会同时收到「这份稿子没有场标」和「不许自己切」,整集塌成 1 场",
    );
  }

  // 枚举关不上:写死几个关键词就会漏掉下一种没见过的写法。
  assert.match(description, /写法不止一种/, "场标写法又被写成了封闭枚举");
  assert.match(description, /不是某几个固定关键词/, "缺了这句,模型会把举例当成穷举");
});

/**
 * `SCENE_NAME_NULL_RULE` 的配对项,#283 正文的后半句:「如果原文没写场标,那才是
 * 模型在推断,推断不一致就要靠提示词收敛」。
 *
 * 边界规则堵死「不许自己切」之后,必须同时给出没场标时怎么办,否则那条禁令对
 * 无场标的稿子就是死胡同。收敛判据得是可复现的(地点或时间切换),不能只说
 * 「你自己看着办」——那等于把方差原样留在原地。
 */
test("没场标的稿子有出路:整份剧本一行场标都没有时才自己划分,且按地点或时间切", () => {
  const { byName } = setup();
  const description = byName.get("add_scene")!.description;
  const nameDescription = nameFieldDescription(byName.get("add_scene")!);

  assert.match(
    description,
    /只有整份剧本一行场标都没有时,才轮到你自己划分场次/,
    "没说无场标时怎么办——「不许自己切」对这类稿子就成了死胡同,整集会塌成 1 场",
  );
  assert.match(
    description,
    /按地点或时间的切换切/,
    "无场标时只说「自己划分」不给判据,推断方差原样留着,没做到 #283 说的「靠提示词收敛」",
  );
  // 与 name 那半句成对:两处都必须把「无场标」说成同一种例外情形。
  assert.match(
    nameDescription,
    /只有整份剧本一行场标都没有时才允许给 null/,
    "边界与 name 对「无场标」的口径必须成对,只改一处会让模型两头对不上",
  );
});

test("场次 name 照抄整行场标原文:不许自编节拍标签,null 只是例外", () => {
  const { byName } = setup();
  const description = nameFieldDescription(byName.get("add_scene")!);

  assert.match(description, /照抄那一整行场标原文/, "场次 name 没要求照抄整行场标");
  assert.match(description, /连景别和时间一起抄/, "只抄地点等于把场标改写了");
  assert.match(description, /不许自编节拍标签/, "自编节拍标签正是实测里填上的那几次干的事");
  assert.match(description, /不许只抄地点/, "没禁掉「只抄地点」这种半照抄");
  assert.match(
    description,
    /只有整份剧本一行场标都没有时才允许给 null,这是例外不是常态/,
    "null 必须写成例外——老描述那句「剧本里没写就给 null」正是在暗示场名可选",
  );
  // 不加 ^ 锚:带锚只挡「整条描述退回老写法」,老那句被塞回描述中段照样漏过去。
  // 新描述里不含这个子串,去锚不会误报。
  assert.doesNotMatch(
    description,
    /场名,剧本里没写就给 null/,
    "老描述把场名说成可选项,不许回退",
  );
});

/**
 * 场次 name 此前没拿到反翻译规则。它和角色、资产的 name 一样会被跨集按字符串
 * 比对,漏了这条,英文剧本的场标会被顺手译成中文。
 *
 * (别说成「唯一」:`character_names` / `scene_names` / `prop_names` 同样没有这条,
 * 但那是对的——那几个填的是**已登记过的**名字,写错由 `workspace.firstUnknownName`
 * 当场退回,不需要再贴一遍照抄规则。场次 name 是首次登记,没人兜。)
 */
test("场次 name 同样吃反翻译规则:照抄原文语言与字符", () => {
  const { byName } = setup();
  const description = nameFieldDescription(byName.get("add_scene")!);

  assert.match(description, /保持原文的语言与字符/, "场次 name 没钉住原文语言与字符");
  assert.match(description, /禁止翻译、音译/, "场次 name 没禁翻译音译");
});

/**
 * 照抄规则的配对项。给 name 加了「照抄原文」之后,模型会把「跟着剧本语言走」
 * 推广到同一条记录的其余字段,英文剧本的场次梗概跟着变成英文。
 */
test("场次梗概仍然用中文写:场标照抄不许外溢到梗概", () => {
  const { byName } = setup();
  const properties = (byName.get("add_scene")!.parameters as {
    properties?: Record<string, { description?: string } | undefined>;
  }).properties;

  assert.match(
    properties?.summary?.description ?? "",
    /一律用中文写/,
    "场次梗概没钉住「不跟着剧本语言走」,场标照抄规则会外溢",
  );
});

test("角色 name 只留称呼本身:剧本标记与状态词剔掉,同一个人只出一条", () => {
  const { byName } = setup();
  const description = nameFieldDescription(byName.get("add_character")!);

  for (const marker of ["(V.O.)", "(CONT'D)", "(O.S.)"]) {
    assert.ok(description.includes(marker), `角色 name 说明里没列 ${marker}`);
  }
  assert.match(description, /同一个人只出一条/, "同一个人裂成多条正是资产卡分裂的来源");
});

test("阶段①工具集不让模型填镜头级字段(P6)", () => {
  const { byName } = setup();
  for (const name of BREAKDOWN_TOOL_NAMES) {
    const parameters = JSON.stringify(byName.get(name)!.parameters);
    assert.doesNotMatch(parameters, /scene_index|line_indices|camera_language/, `${name} 不该带镜头级字段`);
  }
});

test("服务端拥有的编号不出现在任何工具的入参里", () => {
  const { byName } = setup();
  for (const name of BREAKDOWN_TOOL_NAMES) {
    const parameters = JSON.stringify(byName.get(name)!.parameters);
    assert.doesNotMatch(parameters, /candidate_id|shot_no|scene_no/, `${name} 不该让模型报服务端编号`);
  }
});
