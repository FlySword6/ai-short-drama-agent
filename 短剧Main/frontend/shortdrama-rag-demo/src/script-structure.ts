/* ============================================================
   script-structure.ts — 分镜叙事自动结构化拆分（纯逻辑，不引 CSS）

   分镜叙事本质是提示词素材：输入即解析，不需要按钮。
   确定性拆分（无 LLM）：
   - 场景行：「日·内 / 夜·外」类场记行（含 日/夜/晨/昏/晓/黎明/傍晚/清晨/深夜/黄昏 × 内/外）；
   - 对白行：「角色：台词」或含「」『』“”引号的话句——对白是声音不是画面，
     生图提示词只取画面部分（scene + visual），对白不入画面提示词；
   - 命中资产：已匹配资产名在文本中出现（≥2 字才参与，防单字误命中）。
   ============================================================ */

export interface ShotScriptStructure {
  /** 场景行（场记格式，取首条命中），无则 null。 */
  scene: string | null;
  /** 画面/动作描述行（剔除场景与对白后的非空行）。 */
  visual: string[];
  /** 对白行。 */
  dialogue: string[];
  /** 文本中命中的资产名（按传入顺序）。 */
  mentioned: string[];
}

/**
 * 场记行：时间词 × 内外景（日·内 / 夜外 / 清晨·内景…）。
 *
 * 同一套中文场记词在服务端也有一份：`src/modules/script-breakdown/agent/tools.ts`
 * 的 `SCENE_HEADING_FORMS_RULE`（发给拆解模型的散文，判整集的场次边界）。
 * 两处刻意没合并——那边还要认「第一场」「场景一」这类整集级的场次编号行，
 * 这里只对单个镜头的分镜叙事挑场记行，认了编号行反而会误判；合并也会把这个
 * 前端纯逻辑模块拖进服务端提示词的依赖里。**改这里的时间词或内外景词表时，
 * 顺手看一眼那条规则**，别让两边的词漂开。
 */
const SCENE_PATTERN = /(?:日|夜|晨|昏|晓|黎明|傍晚|清晨|深夜|黄昏)\s*[·\-—/\s]?\s*(?:内外|内景|外景|内|外)/;

/** 「角色：台词」：开头 1-12 个汉字/字母/数字/间隔号 + 冒号。 */
const SPEAKER_PATTERN = /^(?:旁白|独白|画外音|[\p{Script=Han}A-Za-z0-9·]{1,12})\s*[:：]/u;

/** 含引号话句（「」『』“”"…"）。 */
const QUOTED_PATTERN = /[「『“"][^」』”"]+[」』”"]/;

/** 解析分镜叙事为结构化部分；空文本返回全空结构。 */
export function parseShotScript(text: string, assetNames: readonly string[] = []): ShotScriptStructure {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let scene: string | null = null;
  const visual: string[] = [];
  const dialogue: string[] = [];
  for (const line of lines) {
    if (!scene && SCENE_PATTERN.test(line)) {
      scene = line;
      continue;
    }
    if (SPEAKER_PATTERN.test(line) || QUOTED_PATTERN.test(line)) {
      dialogue.push(line);
      continue;
    }
    visual.push(line);
  }
  const mentioned = assetNames
    .map((name) => name.trim())
    .filter((name) => name.length >= 2 && text.includes(name));
  return { scene, visual, dialogue, mentioned };
}

/** 画面部分（场景 + 画面行）合成提示词素材；空结构返回空串。 */
export function composeVisualText(structure: ShotScriptStructure): string {
  return [structure.scene, ...structure.visual].filter((line): line is string => Boolean(line)).join("\n");
}

/** 命中资产排在前面（稳定，不改未命中的相对序）：提示词「使用资产」行的排序口径。 */
export function orderNamesByMention(names: readonly string[], mentioned: readonly string[]): string[] {
  const hit = new Set(mentioned);
  return [...names.filter((name) => hit.has(name)), ...names.filter((name) => !hit.has(name))];
}

/** 结构摘要行：「场景 1 · 画面 3 · 对白 2」，全空返回空串（调用方不渲染）。 */
export function structureSummaryLine(structure: ShotScriptStructure): string {
  const parts: string[] = [];
  if (structure.scene) parts.push("场景 1");
  if (structure.visual.length > 0) parts.push(`画面 ${structure.visual.length}`);
  if (structure.dialogue.length > 0) parts.push(`对白 ${structure.dialogue.length}`);
  return parts.join(" · ");
}
