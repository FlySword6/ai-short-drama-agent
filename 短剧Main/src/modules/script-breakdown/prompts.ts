import type { ApprovedAssetSummary, SceneDivision, ScriptLine, ValidationIssue } from "./types.js";
import { formatLinesForPrompt } from "./lines.js";
import { SCENES_MAX, SHOTS_PER_SCENE_MAX } from "./schemas.js";

/**
 * 版本化提示词合同。任何措辞调整都必须升 PROMPT_VERSION——运行表按版本
 * 记录,提示词漂移即可审计。少样本示例待 M0 合同冻结时由产品批准后补充,
 * 不使用线上用户数据。
 */
export const PROMPT_VERSION = "script-breakdown.v4";

const COMMON_SYSTEM = [
  "你是短剧剧本结构化拆解引擎。只返回符合给定 JSON 结构的 JSON,",
  "不返回 Markdown、解释或额外文本。不得虚构原文没有的剧情事实。",
  "保持原文顺序;无法确定的字段使用 null 或空数组,不得猜测。",
].join("");

export interface StructurePromptInput {
  scriptLines: ScriptLine[];
}

export function buildStructurePrompt(input: StructurePromptInput): { system: string; prompt: string } {
  const system = `${COMMON_SYSTEM}\n本阶段任务:把一集剧本拆成故事摘要与场次划分。`;
  const prompt = [
    `提示词版本:${PROMPT_VERSION}`,
    "",
    "输入是按行号编号的剧本(L 后跟行号,从 0 连续递增):",
    "```",
    formatLinesForPrompt(input.scriptLines),
    "```",
    "",
    "返回 JSON(且只返回这个对象):",
    "{",
    '  "story_summary": string,          // 200 字以内故事摘要',
    '  "scene_divisions": [',
    "    {",
    '      "scene_index": number,        // 从 0 连续递增',
    '      "name": string | null,        // 场名,原文没有就给 null',
    '      "summary": string,            // 该场一句话内容',
    '      "start_line_index": number,   // 该场覆盖的起始行号(含)',
    '      "end_line_index": number      // 该场覆盖的结束行号(含)',
    "    }",
    "  ]",
    "}",
    "",
    "硬性要求:",
    `- 场次不超过 ${SCENES_MAX} 个;`,
    "- 所有行必须被场次完整覆盖:第 0 场从 L0 开始,最后一场以最后一行结束,相邻场不重叠、不留空行;",
    "- 场次的行区间必须按原文顺序推进。",
  ].join("\n");
  return { system, prompt };
}

export interface AssetsPromptInput {
  scriptLines: ScriptLine[];
  sceneDivisions: SceneDivision[];
}

export function buildAssetsPrompt(input: AssetsPromptInput): { system: string; prompt: string } {
  const sceneList = input.sceneDivisions
    .map((scene) => `- 场 ${scene.sceneIndex}:${scene.name ?? "未命名"} — ${scene.summary}`)
    .join("\n");
  const system = `${COMMON_SYSTEM}\n本阶段任务:从剧本中抽取角色、场景、道具、服装、音频候选,并补全角色表单候选。`;
  const prompt = [
    `提示词版本:${PROMPT_VERSION}`,
    "",
    "输入剧本:",
    "```",
    formatLinesForPrompt(input.scriptLines),
    "```",
    "",
    "已划分的场次:",
    sceneList,
    "",
    "返回 JSON(且只返回这个对象):",
    "{",
    '  "characters": [{',
    '    "candidate_id": string,',
    '    "name": string,',
    '    "description": string | null,',
    '    "gender": string | null,',
    '    "age_value": number | null,',
    '    "age_stage": "child" | "teen" | "adult" | "older" | "unknown" | null,',
    '    "appearance": string | null,',
    '    "personality_tags": string[]',
    "  }],",
    '  "scenes":     [{ "candidate_id": string, "name": string, "description": string | null }],',
    '  "props":      [{ "candidate_id": string, "name": string, "description": string | null }],',
    '  "costumes":   [{',
    '    "candidate_id": string,',
    '    "name": string,',
    '    "description": string | null,',
    '    "wearer_names": string[],',
    '    "style": string | null,',
    '    "color": string | null,',
    '    "material": string | null,',
    '    "occasion": string | null',
    "  }],",
    '  "audios":     [{',
    '    "candidate_id": string,',
    '    "name": string,',
    '    "description": string | null,',
    '    "audio_kind": "character_voice" | "narration" | "sfx" | "ambience" | "other",',
    '    "speaker_names": string[],',
    '    "scene_context": string | null,',
    '    "emotion": string | null,',
    '    "duration_hint": string | null,',
    '    "transcript_snippet": string | null,',
    '    "sound_cue_text": string | null,',
    '    "default_audio_prompt_seed": string | null',
    "  }]",
    "}",
    "",
    "硬性要求:",
    '- candidate_id 分别用 "char_001"/"scene_001"/"prop_001"/"costume_001"/"audio_001" 样式从 1 编号,全剧唯一;',
    "- 只抽取原文明确出现的角色、场景、道具、服装、音频线索,不得虚构;",
    "- name 用原文中的称呼,保持唯一且稳定,后续分镜会按 name 引用;",
    "- description 必须是\"资产特点\"的提炼,禁止整段照抄原文,上限 100 字,按类型给口径:",
    '  - 角色:外形/身份/性格概括,如"中年刑警,体格健硕,常穿便装";',
    '  - 场景:空间结构/时间/氛围概括,如"旧式厨房,暖黄灯光,陈设拥挤";',
    '  - 道具:功能/特征概括,如"黑色手枪,警用制式";',
    "  - 服装:款式/颜色/材质/场合概括;",
    "  - 音频:说话角色 + 角色特点 + 剧本说话原文的浓缩(完整对白放 transcript_snippet),如\"任天野,中年刑警,声线低沉;原话:'把门锁上'\";",
    "  - 原文没有可提炼信息就给 null,不要把原文整句搬进 description;",
    "- 角色 gender/age_value/age_stage/appearance/personality_tags 只摘录原文明示信息,不得从姓名、职业或称谓猜测;",
    "- age_value 只有原文明示具体年龄才填整数;只有年龄阶段时填 age_stage;都没有就分别给 null;",
    "- appearance 只写非服装的外貌特征(五官/体型/发型/疤痕等),不混入服装、动作或剧情;服装信息抽到独立 costumes 桶;personality_tags 只给简短性格标签。",
    "- 服装:剧本点名\"穿着/换上/脱下\"且带特征描述即抽(如\"军绿风衣\"\"病号服\");即使日常衣着、只要剧本明确点名穿着也抽,不再要求\"有辨识度\";wearer_names 填穿着该服装的角色名(剧本明确提到的),style/color/material/occasion 原文没有就给 null;",
    "- 音频:剧本有明确音频线索即抽,audio_kind 必填——character_voice(角色对白)/narration(旁白)/sfx(拟声词与动作音)/ambience(环境声);speaker_names 只在 character_voice 时填说话角色名,其余给空数组;transcript_snippet 填对白或旁白原文片段;sound_cue_text 填拟声词或环境声描述;",
  ].join("\n");
  return { system, prompt };
}

export interface ShotsPromptInput {
  scene: SceneDivision;
  sceneLines: ScriptLine[];
  storySummary: string;
  approvedAssets: ApprovedAssetSummary[];
  candidateNames: { characters: string[]; scenes: string[]; props: string[]; costumes: string[] };
  nextShotNo: number;
  targetDurationSec: number | null;
}

export function buildShotsPrompt(input: ShotsPromptInput): { system: string; prompt: string } {
  const approvedList = input.approvedAssets.length > 0
    ? input.approvedAssets.map((asset) => `- [${asset.assetKind}] ${asset.name}`).join("\n")
    : "(本项目暂无已通过资产)";
  const candidateList = [
    `角色:${input.candidateNames.characters.join("、") || "(无)"}`,
    `场景:${input.candidateNames.scenes.join("、") || "(无)"}`,
    `道具:${input.candidateNames.props.join("、") || "(无)"}`,
    `服装:${input.candidateNames.costumes.join("、") || "(无)"}`,
  ].join("\n");
  const system = `${COMMON_SYSTEM}\n本阶段任务:把一个场次的剧本拆成有序分镜草稿。`;
  const prompt = [
    `提示词版本:${PROMPT_VERSION}`,
    "",
    `故事摘要:${input.storySummary}`,
    `当前场次:场 ${input.scene.sceneIndex}${input.scene.name ? `(${input.scene.name})` : ""} — ${input.scene.summary}`,
    input.targetDurationSec ? `本集目标总时长:${input.targetDurationSec} 秒` : "本集未设定目标总时长",
    "",
    "本场剧本行:",
    "```",
    formatLinesForPrompt(input.sceneLines),
    "```",
    "",
    "可引用的资产名称(只能从这里取,不得编造):",
    candidateList,
    "已通过的项目资产(优先引用):",
    approvedList,
    "",
    "返回 JSON(且只返回这个对象):",
    "{",
    '  "shots": [',
    "    {",
    '      "candidate_id": string,     // 建议与 shot_no 对齐为 "shot_001" 样式;服务端会按 shot_no 确定最终 ID',
    `      "shot_no": number,          // 从 ${input.nextShotNo} 开始连续递增`,
    '      "line_indices": number[],   // 本镜头覆盖的剧本行号,只能取本场行号',
    '      "elements": {',
    '        "subject": string | null,          // 主体:本镜头拍谁或拍什么',
    '        "action": string | null,           // 动作:主体正在做什么',
    '        "visual": string | null,           // 画面:构图、空间、光影等可见要素',
    '        "camera_language": string | null   // 镜头语言:景别、角度或运动',
    "      },",
    '      "duration_sec": number,     // 1-60 的整数',
    '      "character_names": string[],',
    '      "scene_names": string[],',
    '      "prop_names": string[],',
    '      "costume_names": string[]',
    "    }",
    "  ]",
    "}",
    "",
    "硬性要求:",
    `- 本场分镜不超过 ${SHOTS_PER_SCENE_MAX} 个;`,
    "- 每场的行按剧情顺序推进,相邻镜头可重复引用同一行,但不得倒退;",
    "- elements 四栏只写短要素,不写成文提示词、渲染指令或生成模型参数;",
    "- 原文没有明确依据的栏给 null,不得为了填满字段而虚构;",
    "- 人物、场景、道具、服装名称必须来自上面给定的集合;镜头没有明确服装的 costume_names 给空数组。",
  ].join("\n");
  return { system, prompt };
}

/**
 * JSON 语法修复:只允许修复原输出的语法,不得重新创作。最多调用一次。
 */
export function buildRepairPrompt(brokenContent: string): { system: string; prompt: string } {
  const excerpt = brokenContent.length > 12_000 ? brokenContent.slice(0, 12_000) : brokenContent;
  return {
    system: "你是 JSON 修复器。只修复 JSON 语法,保持原有字段与取值不变,不新增、不删除、不改写内容。只返回修复后的 JSON。",
    prompt: [
      "以下内容应当是合法 JSON,但目前无法解析。请只做语法修复后原样返回:",
      "```",
      excerpt,
      "```",
    ].join("\n"),
  };
}

/**
 * 结构修复:JSON 已可解析但字段不满足阶段合同。只把受限校验摘要和原输出
 * 交回模型一次，不把原输出或修复结果写入诊断表。
 */
export function buildSchemaRepairPrompt(
  content: string,
  issues: ValidationIssue[],
): { system: string; prompt: string } {
  const excerpt = content.length > 12_000 ? content.slice(0, 12_000) : content;
  const issueLines = issues.slice(0, 12).map((issue) => (
    `- ${issue.path ?? "(root)"}: ${issue.code} ${issue.message}`
  ));
  return {
    system: [
      "你是 JSON 结构修复器。只修复列出的字段类型或缺失字段，",
      "其余字段和值保持不变。不得新增剧情事实，不得输出 Markdown 或解释，只返回修复后的 JSON。",
    ].join(""),
    prompt: [
      "以下 JSON 未通过结构校验:",
      ...issueLines,
      "",
      "请按校验问题修复后只返回 JSON:",
      "```",
      excerpt,
      "```",
    ].join("\n"),
  };
}
