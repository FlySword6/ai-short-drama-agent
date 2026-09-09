import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { characterAgeStages } from "../types.js";
import {
  ASSETS_PER_KIND_MAX,
  SCENES_MAX,
} from "../schemas.js";
import type { BreakdownWorkspace, FillOutcome } from "./workspace.js";

/**
 * 拆解工具集。
 *
 * 工具的入参 schema 就是拆解的数据合同——模型只能按这个形状调用,不存在
 * 「模型吐一段文本、我们再想办法解析」这一步。每个工具都是一次可独立校验、
 * 可独立重试、可独立展示的填充动作。
 *
 * 服务端拥有的字段(场号、镜号、候选编号)不出现在入参里:让模型报编号
 * 只会多出一整类它自己也修不好的失败。
 */

export const BREAKDOWN_TOOL_NAMES = [
  "write_story_outline",
  "add_scene",
  "add_character",
  "add_location",
  "add_prop",
  "add_costume",
  "add_audio",
  // P6:镜头不在阶段①产出——拆镜由阶段②(skill 单次结构化输出)一次生成。
  "finish_breakdown",
] as const;

export type BreakdownToolName = typeof BREAKDOWN_TOOL_NAMES[number];

export function isBreakdownToolName(value: string): value is BreakdownToolName {
  return (BREAKDOWN_TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * 一次填充动作产生的可展示事件。description 与 reason 都是给用户看的话。
 *
 * 三种状态说的是三件不同的事,界面上也该说三种话:
 * - accepted:填进去了;
 * - rejected:内容不合规矩,工作台说明了怎么改,模型会重来这一次;
 * - unreadable:模型发起了这次调用,但内容没完整传回来,我们连它想填什么都没读出。
 *   这一条是失败,不是「模型没干活」——把它折叠进 rejected 会让排查的人去改提示词。
 *
 * sequence 由运行时统一分配:工具产生的事件和读不出的事件在同一条流上排队,
 * 界面按它排序才不会乱。
 */
export interface BreakdownFillEvent {
  sequence: number;
  /** 读不出时供应商给的名字未必是我们认识的工具,这时为 null。 */
  tool: BreakdownToolName | null;
  status: "accepted" | "rejected" | "unreadable";
  description: string;
  reason?: string;
  occurredAt: Date;
}

export interface BreakdownToolsInput {
  workspace: BreakdownWorkspace;
  onEvent: (event: Omit<BreakdownFillEvent, "sequence">) => void | Promise<void>;
  now?: () => Date;
}

const storyOutlineParameters = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2_000, description: "这一集讲了什么,一段话说清" }),
}, { additionalProperties: false });

/**
 * name 是这条路上唯一按字符串比对的字段:镜头按 name 引用已登记的资产,跨集
 * 资产也靠 name 精确匹配。工具描述和系统提示都是中文,剧本可能是英文,模型会
 * 顺着中文把名字译过去(英文名整批变成中文),于是同一个人在两集里成了两张
 * 资产卡,机器再判「正文查无此人」。老路 prompts.ts 的 v3/v4 就是修这个病;
 * 这条 agent 路的约束在同一处,所以规则跟着搬过来,写死在入参描述里,不留给
 * 模型判断。
 *
 * 换例纪律(v4 立的):这里的示例词一律不得取自评测语料或线上剧本——示例逐字
 * 撞上语料,评测涨幅就分不清「学会规则」还是「被告知答案」。换例前先对评测
 * 语料逐词 grep(大小写不敏感、含子串)确认零命中再落笔。现用这批
 * (ROSALIND / GODMOTHER / BUTLER'S UMBRELLA / UMBRELLA IN CELLAR /
 * GWENDOLYN / PHANTOM)沿用 dev 上 v4 已过 grep 的示例,本次改动前又核过一遍。
 */
const NAME_VERBATIM_RULE = "从剧本原文照抄那个称呼,保持原文的语言与字符:英文剧本给英文名,中文剧本给中文名;"
  + "禁止翻译、音译或改写成另一种语言(不得把 ROSALIND 写成「罗莎琳德」、GODMOTHER 写成「教母」)。";

/**
 * 唯一性是硬校验(workspace 同名即退回)。只说「照抄」会让原文里三个不同的
 * umbrella 都被抄成 umbrella 而撞名,所以撞名怎么拆也要一起说清。
 */
const NAME_COLLISION_RULE = "两个不同的东西不许共用一个 name:原文用同一个词指代好几样东西时,"
  + "用原文里的所属或位置区分开(BUTLER'S UMBRELLA / UMBRELLA IN CELLAR),但仍然不许换语言。";

const CHARACTER_NAME_MARKERS_RULE = "只保留称呼本身:剔除 (V.O.)/(CONT'D)/(O.S.) 这类剧本标记和 PHANTOM 之类的状态词,"
  + "同一个人只出一条(GWENDOLYN'S PHANTOM 与 GWENDOLYN 都写 GWENDOLYN)。";

/**
 * 上面那三条的配对项,少了它反翻译修复会反噬。
 *
 * 老路 prompts.ts 的 v3 是把「name 照抄原文」和「其余字段照旧用中文」成对写死的:
 * 只说前半句,模型会把「跟着剧本的语言走」推广到整条记录,英文剧本拆出来的
 * description/appearance/personality_tags 跟着变成英文——翻译的毛病没了,换来
 * 一份导演读不懂的产出。这半句必须跟着搬,不能只搬 name 那半句。
 *
 * 主语写「name 之外的字段」而不是列几个字段名,是因为这条会被贴到好几个字段的
 * 描述上,模型读到的是**自己这个字段**的那一份。原来枚举写的是
 * 「description/appearance/personality_tags 等」,贴到 add_scene 的 summary 上时,
 * 枚举里恰恰没有 summary——模型完全可以读成「这条不管我」。runner.ts 的系统提示
 * 那半句是点名了「场次梗概」的,两处口径不该差这一格。枚举保留只当举例,
 * 并且必须覆盖每一个真的贴了这条规则的字段。
 */
const NON_NAME_FIELDS_CHINESE_RULE = "name 之外的字段一律用中文写,不要跟着剧本的语言走"
  + "(summary、description、appearance、personality_tags 都算)。";

/**
 * P5(九.1):description 的口径是「资产实体描述」,不是剧情定位句。实测旧口径
 * 「定位或用途要点」把模型引向剧情句(角色描述成了「救下她后充满怀疑」这类
 * 动作),素材检索与出片拿不到可用描述。细则分类型写进各参数描述,总纲
 * (runner.ts breakdownSystemPrompt)同步同一句;workspace.checkAssetInput 另有
 * 「描述照抄剧本原行 → 退回」硬校验兜底。示例为虚构通用句,不取自任何剧本。
 */
const ENTITY_DESCRIPTION_RULE = "description 写这个资产的实体描述:不要照抄剧本原句,"
  + "不要写剧情动作(「他救下她后充满怀疑」是剧情,不是描述);剧本没写的信息不要编,宁可给 null。";

/* ---- 场次四条:场标写法 / 边界 / name 照抄 / null 例外 ---- */

/**
 * 场次不是模型的判断题,是剧本里明写的东西。下面这几条(场标写法 / 边界 /
 * name / null 例外)都在修同一个根因:模型不把场标当作「要照抄的东西」。
 *
 * 实测来历(#283):`ep-idb-09` 同一份正文连跑 6 次,场数在 1 和 4 之间来回
 * (1,4,4,1,1,1,变异系数 77.5%),而同一批里角色数 6 次一个不差。正文只有
 * 一行场标,金标 scene-boundary 也只有一条(置信 certain,确定性抽取器 + 三个
 * 独立标注源一致),所以 4 场那两次是模型自己按剧情把一场连续戏切开了。
 * 凡是场标明写的其余剧本(1 个场标的 `ep-idb-13`、4 个场标的 `ep-bdlw-09`、
 * 4 个场标的中文 `ep-cn-adhoc-01`)模型全对得上——规律干净得没有例外。
 *
 * 这不只是数字难看:切成 4 场时模型往返从 5 次涨到 8~13 次,失败率 0/4 → 2/4,
 * 轮次翻倍直接把超时(#282)的触发概率抬上去。对用户则是同一集拆两次给出两种
 * 结果,后面的镜头归属、资产复用、按场备戏全跟着变。
 *
 * 同根的第二个表现在 name 上:12 次里 8 次给 null,而两个剧本的场标都写明了;
 * 填上的几次还自编节拍标签而不是抄场标。老描述写的是「场名,剧本里没写就给
 * null」——这句话本身在暗示场名是可选的,于是模型把「抄场标」读成了「有空再填」。
 * 所以 null 那半句不能只是留着,必须反过来写成例外。
 *
 * 换例纪律同上:示例词不得取自评测语料。本批示例
 * (FUNICULAR / TERMINUS / DUSK / 缆车 / 诀别)落笔前已对 `episodes/` 十份与
 * `episodes-cn-adhoc/` 一份逐词 `grep -icoF`,合计命中均为 0;同批核过的 DAY(22)、
 * NIGHT(11) 命中非零,已弃用。INT./EXT./I/E./内景/外景 是规则要指的剧本标记本身
 * (通用剧本约定,不是示例名),不受这条约束;同理,补场标写法这一轮加进来的
 * 「第一场」「第二场」「场景一」「1.」「一、」与 日/夜/清晨/黄昏 × 内/外 也是剧本
 * 标记本身。即便如此仍然复核过:这批词加上 序号 / 内外景 / 台词 / 地点 / 切换
 * 对同样 11 份语料逐词 `grep -icoF` 合计命中全 0,对照组 DAY(22) / NIGHT(11) /
 * 祠堂(5) / MORGUE(3) 命中非零,说明方法没失灵。
 */

/**
 * 场标行长什么样。单拎成一条并且 export,是因为总纲(runner.ts 的
 * breakdownSystemPrompt)和 add_scene 的工具描述必须认同一套写法:分头各写一份,
 * 改了一边忘了另一边,模型就会同时收到两份打架的口径。
 *
 * 这里原本是封闭枚举——只认 INT. / EXT. / I/E. / 「内景」/「外景」。而仓库自己的
 * 稿子用的是别的写法:`scripts/breakdown-agent-smoke.mts` 的 SAMPLE_SCRIPT 写
 * 「第一场 客栈门口 黄昏」「第二场 客房 夜」,agent 这四份测试夹具
 * (tools/workspace/runner/gateway-turn)写「场景一 客栈门口」。按老枚举这些一行
 * 都不算场标,再叠上下面「没有下一行场标就不许自己切」那句,模型对这类中文稿
 * 最可能整集塌成 1 场。盲区不是推演出来的,是仓库里现成的用例。
 *
 * 时间词 × 内外景这套中文场记词,与前端
 * `frontend/shortdrama-rag-demo/src/script-structure.ts` 的 SCENE_PATTERN 是同一套,
 * 那边留了反向指针。两处**没有**合并成一个常量,理由是粒度和消费方都不同:那条
 * 正则跑在浏览器里、对单个镜头的分镜叙事挑出「日·内」这样的场记行;这条是发给
 * 模型的散文、判的是整集的场次边界,而且要认「第一场」这类那边根本不该认的编号行。
 * 合并等于把一个前端纯逻辑模块拖进服务端提示词的依赖里,换来的只有词表一致。
 * 所以改成互相引用:谁动词表,顺着注释能找到另一边。
 */
export const SCENE_HEADING_FORMS_RULE = "场标行是单独占一行、只交代这一场在哪儿什么时候的行,写法不止一种:"
  + "英文剧本多是 INT. / EXT. / I/E. 打头;"
  + "中文剧本可能是「内景」「外景」打头,可能是「第一场」「第二场」「场景一」这样的场次序号行,"
  + "可能是「1.」「一、」这类序号打头后面缀地点、时间与内外景,"
  + "也可能只有地点加时间加内外景(日/夜/清晨/黄昏 配 内/外)。"
  + "判据是「这一行在交代场次、地点、时间、内外景,而不是台词或动作」,不是某几个固定关键词。";

const SCENE_HEADING_BOUNDARY_RULE = "场次边界照剧本里明写的场标行走。"
  + SCENE_HEADING_FORMS_RULE
  + "有几行场标就拆几场,一行一场,顺序照原文。"
  + "剧本写了场标时,不许按剧情推进、情绪转折、时间跳跃或人物进出自己再切——"
  + "只要没有下一行场标,一场戏再长也还是一场。"
  + "只有整份剧本一行场标都没有时,才轮到你自己划分场次:按地点或时间的切换切,"
  + "同一地点同一时间的连续戏合成一场,不要按情绪或节拍切得更碎。";

const SCENE_NAME_VERBATIM_RULE = "照抄那一整行场标原文,连景别和时间一起抄"
  + "(场标行写 INT. FUNICULAR TERMINUS - DUSK,name 就写 INT. FUNICULAR TERMINUS - DUSK)。"
  + "不许自编节拍标签(不得写成「缆车诀别」),不许只抄地点,不许改写或缩写。";

/**
 * null 只对「整份剧本一行场标都没有」那种稿子成立。写成例外而不是选项,
 * 是因为老描述里那句「剧本里没写就给 null」被模型读成了「可填可不填」。
 */
const SCENE_NAME_NULL_RULE = "只有整份剧本一行场标都没有时才允许给 null,这是例外不是常态:"
  + "场标写了就必须抄,不许因为嫌长、嫌重复或者觉得可省而留空。";

const sceneParameters = Type.Object({
  name: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: 120 }),
    Type.Null(),
  ], {
    description: `这一场的场标。${SCENE_NAME_VERBATIM_RULE}${NAME_VERBATIM_RULE}${SCENE_NAME_NULL_RULE}`,
  })),
  summary: Type.String({
    minLength: 1,
    maxLength: 500,
    description: `这一场发生了什么。${NON_NAME_FIELDS_CHINESE_RULE}`,
  }),
  start_line_index: Type.Integer({ minimum: 0, description: "这一场覆盖的起始行号(含),必须紧接上一场结束行" }),
  end_line_index: Type.Integer({ minimum: 0, description: "这一场覆盖的结束行号(含)" }),
}, { additionalProperties: false });

const assetParameters = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: 80,
    description: `剧本里用的称呼,后面镜头按这个名字引用。${NAME_VERBATIM_RULE}${NAME_COLLISION_RULE}`,
  }),
  description: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: 500 }),
    Type.Null(),
  ], { description: `资产实体描述(场景:地点/陈设/氛围;道具:外形/功能特征)。${ENTITY_DESCRIPTION_RULE}${NON_NAME_FIELDS_CHINESE_RULE}` })),
}, { additionalProperties: false });

const costumeParameters = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: 80,
    description: `剧本里对这件服装的称呼。${NAME_VERBATIM_RULE}${NAME_COLLISION_RULE}`,
  }),
  description: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()], {
    description: `资产实体描述:款式/颜色/材质。${ENTITY_DESCRIPTION_RULE}${NON_NAME_FIELDS_CHINESE_RULE}`,
  })),
  wearer_names: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
    maxItems: 10,
    description: "穿着该服装的角色名,只填剧本明确提到的,不要猜。",
  })),
  style: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()], {
    description: "款式要点,剧本没写就给 null",
  })),
  color: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 60 }), Type.Null()], {
    description: "颜色,剧本没写就给 null",
  })),
  material: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()], {
    description: "材质,剧本没写就给 null",
  })),
  occasion: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()], {
    description: "穿着场合(如战场、宴会、日常),剧本没写就给 null",
  })),
}, { additionalProperties: false });

const audioKindValues = ["character_voice", "narration", "sfx", "ambience", "other"] as const;

const audioParameters = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: 80,
    description: `这条音频的称呼,照剧本原文里的说法。${NAME_VERBATIM_RULE}${NAME_COLLISION_RULE}`,
  }),
  description: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()], {
    description: `资产实体描述:音色/情绪/用途。${ENTITY_DESCRIPTION_RULE}${NON_NAME_FIELDS_CHINESE_RULE}`,
  })),
  audio_kind: Type.Union([...audioKindValues.map((kind) => Type.Literal(kind))], {
    description: "character_voice=角色声音,narration=旁白,sfx=音效,ambience=环境声,other=其他",
  }),
  speaker_names: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
    maxItems: 10,
    description: "说话的角色名,只填剧本明确提到的;旁白/音效/环境声可留空。",
  })),
  scene_context: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()], {
    description: "出现在什么场景,剧本没写就给 null",
  })),
  emotion: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 60 }), Type.Null()], {
    description: "情绪基调,剧本没写就给 null",
  })),
  duration_hint: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 60 }), Type.Null()], {
    description: "时长提示(如约3秒),只在剧本有明确线索时填,否则 null",
  })),
  transcript_snippet: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()], {
    description: "对白/旁白文本片段,照抄原文;没有就给 null",
  })),
  sound_cue_text: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()], {
    description: "拟声词/环境声提示文本(如雨声、脚步声),没有就给 null",
  })),
}, { additionalProperties: false });

const characterParameters = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: 80,
    description: `剧本里用的称呼。${NAME_VERBATIM_RULE}${CHARACTER_NAME_MARKERS_RULE}${NAME_COLLISION_RULE}`,
  }),
  description: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()], {
    description: `资产实体描述:身份/外貌/着装特征。${ENTITY_DESCRIPTION_RULE}${NON_NAME_FIELDS_CHINESE_RULE}`,
  })),
  gender: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()], {
    description: "只填剧本明说的,不要从名字或称谓猜",
  })),
  age_value: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 150 }), Type.Null()], {
    description: "只有剧本明说了具体岁数才填",
  })),
  age_stage: Type.Optional(Type.Union([
    ...characterAgeStages.map((stage) => Type.Literal(stage)),
    Type.Null(),
  ], { description: "剧本只说了年龄段时填这个" })),
  appearance: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 1_000 }), Type.Null()], {
    description: `只写外貌辨识特征,不混服装、动作与剧情。${NON_NAME_FIELDS_CHINESE_RULE}`,
  })),
  personality_tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
    maxItems: 12,
    description: `简短性格标签。${NON_NAME_FIELDS_CHINESE_RULE}`,
  })),
}, { additionalProperties: false });


const finishParameters = Type.Object({}, { additionalProperties: false });

export function createBreakdownTools(input: BreakdownToolsInput): AgentTool[] {
  const now = input.now ?? (() => new Date());

  const record = async (tool: BreakdownToolName, outcome: FillOutcome) => {
    await input.onEvent({
      tool,
      status: outcome.status,
      description: outcome.description,
      ...(outcome.status === "rejected" ? { reason: outcome.reason } : {}),
      occurredAt: now(),
    });
    if (outcome.status === "rejected") {
      // 抛出去,由 agent 循环变成「这一次调用」的错误结果回给模型。
      // 已经填好的内容不受影响,模型只需要把这一次改对重来。
      throw new Error(outcome.reason);
    }
    return {
      content: [{ type: "text" as const, text: outcome.description }],
      details: outcome.progress,
    };
  };

  const writeStoryOutline: AgentTool<typeof storyOutlineParameters, unknown> = {
    name: "write_story_outline",
    label: "整理故事梗概",
    description: "写下这一集的故事梗概。整集拆解从这里开始。",
    parameters: storyOutlineParameters,
    executionMode: "sequential",
    execute: async (_id, params) => record("write_story_outline", input.workspace.setStoryOutline({
      summary: params.summary,
    })),
  };

  const addScene: AgentTool<typeof sceneParameters, unknown> = {
    name: "add_scene",
    label: "拆出一场",
    description: "按剧本顺序拆出下一场,场次要把剧本从头到尾铺满、不重叠不留空。"
      + `${SCENE_HEADING_BOUNDARY_RULE}一集最多 ${SCENES_MAX} 场。`,
    parameters: sceneParameters,
    executionMode: "sequential",
    execute: async (_id, params) => record("add_scene", input.workspace.addScene({
      name: params.name ?? null,
      summary: params.summary,
      startLineIndex: params.start_line_index,
      endLineIndex: params.end_line_index,
    })),
  };

  const addCharacter: AgentTool<typeof characterParameters, unknown> = {
    name: "add_character",
    label: "登记角色",
    description: `登记剧本里出现的一个角色。只登记原文真有的,最多 ${ASSETS_PER_KIND_MAX} 个。`,
    parameters: characterParameters,
    executionMode: "sequential",
    execute: async (_id, params) => record("add_character", input.workspace.addCharacter({
      name: params.name,
      description: params.description ?? null,
      gender: params.gender ?? null,
      ageValue: params.age_value ?? null,
      ageStage: params.age_stage ?? null,
      appearance: params.appearance ?? null,
      personalityTags: params.personality_tags ?? [],
    })),
  };

  const addLocation: AgentTool<typeof assetParameters, unknown> = {
    name: "add_location",
    label: "登记场景",
    description: "登记剧本里出现的一处场景(实景或环境)。",
    parameters: assetParameters,
    executionMode: "sequential",
    execute: async (_id, params) => record("add_location", input.workspace.addLocation({
      name: params.name,
      description: params.description ?? null,
    })),
  };

  const addProp: AgentTool<typeof assetParameters, unknown> = {
    name: "add_prop",
    label: "登记道具",
    description: "登记剧本里出现的一件道具。",
    parameters: assetParameters,
    executionMode: "sequential",
    execute: async (_id, params) => record("add_prop", input.workspace.addProp({
      name: params.name,
      description: params.description ?? null,
    })),
  };

  const addCostume: AgentTool<typeof costumeParameters, unknown> = {
    name: "add_costume",
    label: "登记服装",
    description: "登记剧本里出现的一件服装:角色点名「穿着/换上/脱下」的衣着就登记,"
      + "含日常衣着,不要求该穿着有辨识意义。",
    parameters: costumeParameters,
    executionMode: "sequential",
    execute: async (_id, params) => record("add_costume", input.workspace.addCostume({
      name: params.name,
      description: params.description ?? null,
      wearerNames: params.wearer_names ?? [],
      style: params.style ?? null,
      color: params.color ?? null,
      material: params.material ?? null,
      occasion: params.occasion ?? null,
    })),
  };

  const addAudio: AgentTool<typeof audioParameters, unknown> = {
    name: "add_audio",
    label: "登记音频",
    description: "登记剧本里的一条音频:角色声音、旁白、音效、环境声"
      + "(audio_kind: character_voice=角色声音,narration=旁白,sfx=音效,ambience=环境声,other=其他)。"
      + "剧本有对白、旁白、拟声词或环境声线索就登记,audio_kind 必填。",
    parameters: audioParameters,
    executionMode: "sequential",
    execute: async (_id, params) => record("add_audio", input.workspace.addAudio({
      name: params.name,
      description: params.description ?? null,
      audioKind: params.audio_kind,
      speakerNames: params.speaker_names ?? [],
      sceneContext: params.scene_context ?? null,
      emotion: params.emotion ?? null,
      durationHint: params.duration_hint ?? null,
      transcriptSnippet: params.transcript_snippet ?? null,
      soundCueText: params.sound_cue_text ?? null,
    })),
  };


  const finishBreakdown: AgentTool<typeof finishParameters, unknown> = {
    name: "finish_breakdown",
    label: "完成拆解",
    description: "场次与五类资产都登记完后调用一次。还有没拆完的地方会被退回并说明缺什么。分镜不用你拆——拆解系统会在你收尾后自行拆镜。",
    parameters: finishParameters,
    executionMode: "sequential",
    execute: async () => record("finish_breakdown", input.workspace.finish()),
  };

  return [
    writeStoryOutline,
    addScene,
    addCharacter,
    addLocation,
    addProp,
    addCostume,
    addAudio,
    finishBreakdown,
  ];
}
