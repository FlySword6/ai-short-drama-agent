/**
 * 两段式提示词编译器 v2(合同 docs/contracts/v0.2.0/rough-cut-generation-mapping.md
 * 第二节「两段式提示词编译」):提示词 = 固定自动填充段(服务端编译,只读)
 * + 人工补充段(默认空),拼接后提交。
 *
 * 自动段从结构化真源编译:剧集/场次背景、出场角色描述、场景描述、镜头意图、
 * 参考控制包各栏资产登记描述(按栏组织)。编译模板/栏序/负面词表服务端版本化
 * (R7):改模板、栏序或词表必须升 PROMPT_TEMPLATE_VERSION。中文 ≤500 字预算内
 * 按确定性优先级裁剪(字数过多致信息分散)。对话台词包双引号(优化
 * generate_audio 音频效果)。
 *
 * 本模块是纯函数,零依赖;结构化真源的查询在 repository 层完成。
 */
export const PROMPT_TEMPLATE_VERSION = "v3";
export const LOCKED_PROMPT_VERSION = "locked-manual-v1";
export const AUTO_PROMPT_BUDGET_CHARS = 500;
export const REFERENCE_DESCRIPTION_BUDGET_CHARS = 30;
export const SCENE_DESCRIPTION_BUDGET_CHARS = 60;
export const SEGMENT_PROMPT_DEFAULTS_VERSION = "segment-defaults-v1";
export const SEGMENT_NO_BGM_CONSTRAINT = "音频约束:只使用音效，不使用背景音乐(BGM)";
export const DEFAULT_IMAGE_PROMPT_TEMPLATE =
  "片段内容：{{segment_content}}\n角色：{{characters}}\n场景：{{scene}}\n图片风格：{{style_description}}";
export const DEFAULT_VIDEO_PROMPT_TEMPLATE =
  "片段内容：{{segment_content}}\n角色：{{characters}}\n场景：{{scene}}\n视频风格：{{style_description}}";

const TIMECODE_SOURCE = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;
const TIMECODE_RANGE_SOURCE = String.raw`${TIMECODE_SOURCE}(?:\s*(?:-->|[-–—~～]|至)\s*${TIMECODE_SOURCE})?`;
const BRACKETED_TIMECODE = new RegExp(
  String.raw`[\[【(（]\s*${TIMECODE_RANGE_SOURCE}\s*[\]】)）]`,
  "giu",
);
const LEADING_TIMECODE = new RegExp(
  String.raw`^\s*${TIMECODE_RANGE_SOURCE}\s*(?:[|｜:：\-–—]\s*)?`,
  "iu",
);
const SHOT_TIMECODE = new RegExp(
  String.raw`^(\s*(?:镜头|shot)\s*[#№]?\s*[\p{L}\p{N}_-]+\s+)${TIMECODE_RANGE_SOURCE}\s*(?:[|｜:：\-–—]\s*)?`,
  "iu",
);

/** 负面词表 v1。 */
export const NEGATIVE_PROMPT_V1 = "避免:低分辨率、画面模糊、人物变形、多余手指、水印、字幕";

/** 参考控制包各栏(assetEntities.role)的中文标签;未登记的栏按原字符串展示。 */
const LANE_LABELS: Record<string, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  camera_motion: "运镜",
  reference: "参考",
  reference_video: "参考视频",
  audio: "音频",
};

const PROJECT_PROMPT_TEMPLATE_PLACEHOLDERS = new Set([
  "segment_content",
  "characters",
  "scene",
  "style_description",
  "episode_background",
  "shot_intent",
  "props",
  "references",
  "negative_prompt",
]);
const PROJECT_PROMPT_TEMPLATE_PLACEHOLDER = new RegExp(
  String.raw`\{\{\s*([^{}]+?)\s*\}\}`,
  "gu",
);

export interface PromptReferenceEntry {
  lane: string;
  name: string;
  description?: string;
}

/** 编译输入:结构化真源的快照,全部由服务端查询装配,客户端不可直改。 */
export interface PromptCompilationContext {
  /** 剧集背景(episodes.name)。 */
  episodeBackground?: string;
  /** 场景描述(scenes.description)。 */
  sceneDescription?: string;
  /** 镜头意图(shots.directorPrompt)。 */
  shotIntent?: string;
  /** 台词(shots.scriptText),自动段内包双引号。 */
  scriptText?: string;
  /** 参考控制包各栏资产登记描述,顺序 = 请求参考清单顺序。 */
  references?: PromptReferenceEntry[];
  /** 项目级风格描述，按图片/视频分别配置。 */
  styleDescription?: string;
  /** 项目级提示词模板；存在时替换平台默认组织方式。 */
  promptTemplate?: string;
  /** 当前生成媒介，供调用方传递项目的图片/视频模板选择结果。 */
  mediaKind?: "image" | "video";
  /** 分镜手写视频提示词；仅在 promptLocked=true 时替代自动段。 */
  manualPrompt?: string;
  /** 锁定后自动编译不得覆盖 manualPrompt。 */
  promptLocked?: boolean;
}

export interface CompiledAutoPrompt {
  version: string;
  autoPrompt: string;
  /** 锁定分镜的人工提示词；存在时调用方必须跳过自动段与请求补充段。 */
  lockedPrompt?: string;
}

function charLength(text: string): number {
  return [...text].length;
}

function truncateChars(text: string, budget: number): string {
  const chars = [...text];
  return chars.length <= budget ? text : chars.slice(0, budget).join("");
}

/** 拒绝未知的项目模板占位符，避免配置看似成功但在生成时被静默忽略。 */
export function validateProjectPromptTemplate(template: string): void {
  for (const match of template.matchAll(PROJECT_PROMPT_TEMPLATE_PLACEHOLDER)) {
    const placeholder = (match[1] ?? "").trim();
    if (!PROJECT_PROMPT_TEMPLATE_PLACEHOLDERS.has(placeholder)) {
      throw new Error(`未知提示词模板占位符: {{${placeholder}}}`);
    }
  }
}

/**
 * R144 keeps timeline information in the UI but out of provider prompts.
 * Only bracketed markers, line-leading markers, and markers immediately
 * following a shot label are removed; natural-language times such as
 * "晚上 20:30 集合" remain untouched.
 */
export function stripPromptTimecodes(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line
      .replace(BRACKETED_TIMECODE, " ")
      .replace(SHOT_TIMECODE, "$1")
      .replace(LEADING_TIMECODE, "")
      .replace(/[ \t]{2,}/g, " ")
      .trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function applySegmentPromptDefaults(prompt: string): {
  version: typeof SEGMENT_PROMPT_DEFAULTS_VERSION;
  prompt: string;
  supplementPrompt: string;
} {
  const supplementPrompt = stripPromptTimecodes(prompt);
  return {
    version: SEGMENT_PROMPT_DEFAULTS_VERSION,
    prompt: joinPromptSegments(SEGMENT_NO_BGM_CONSTRAINT, supplementPrompt),
    supplementPrompt,
  };
}

interface TrimOptions {
  truncateReferences: boolean;
  dropEpisodeBackground: boolean;
  truncateSceneDescription: boolean;
}

function renderSegments(
  context: PromptCompilationContext,
  references: PromptReferenceEntry[],
  options: TrimOptions,
): string[] {
  const segments: string[] = [];
  const episodeBackground = context.episodeBackground?.trim();
  if (!options.dropEpisodeBackground && episodeBackground) {
    segments.push(`剧集背景:${episodeBackground}`);
  }
  const sceneDescription = context.sceneDescription?.trim();
  if (sceneDescription) {
    segments.push(`场景:${options.truncateSceneDescription
      ? truncateChars(sceneDescription, SCENE_DESCRIPTION_BUDGET_CHARS)
      : sceneDescription}`);
  }
  const shotIntent = stripPromptTimecodes(context.shotIntent ?? "");
  if (shotIntent) segments.push(`镜头意图:${shotIntent}`);
  const scriptText = stripPromptTimecodes(context.scriptText ?? "");
  if (scriptText) segments.push(`台词:“${scriptText}”`);

  const lanes = new Map<string, string[]>();
  for (const reference of references) {
    const description = reference.description?.trim();
    const rendered = description
      ? `${reference.name}(${options.truncateReferences
        ? truncateChars(description, REFERENCE_DESCRIPTION_BUDGET_CHARS)
        : description})`
      : reference.name;
    const items = lanes.get(reference.lane) ?? [];
    items.push(rendered);
    lanes.set(reference.lane, items);
  }
  for (const [lane, items] of lanes) {
    segments.push(`${LANE_LABELS[lane] ?? lane}:${items.join("、")}`);
  }
  return segments;
}

function renderReferenceLanes(
  references: PromptReferenceEntry[],
  lanes: string[],
): string {
  const grouped = new Map<string, string[]>();
  for (const reference of references) {
    if (!lanes.includes(reference.lane)) continue;
    const description = reference.description?.trim();
    const items = grouped.get(reference.lane) ?? [];
    items.push(description ? `${reference.name}(${description})` : reference.name);
    grouped.set(reference.lane, items);
  }
  return lanes
    .flatMap((lane) => {
      const items = grouped.get(lane);
      return items?.length ? [`${LANE_LABELS[lane] ?? lane}:${items.join("、")}`] : [];
    })
    .join("。 ");
}

export function renderProjectPromptTemplate(
  template: string,
  context: PromptCompilationContext,
  references: PromptReferenceEntry[],
): { prompt: string; includesStyleDescription: boolean } {
  validateProjectPromptTemplate(template);
  const shotIntent = stripPromptTimecodes(context.shotIntent ?? "");
  const scriptText = stripPromptTimecodes(context.scriptText ?? "");
  const values: Record<string, string> = {
    segment_content: [shotIntent, scriptText].filter(Boolean).join("。"),
    characters: renderReferenceLanes(references, ["character"]),
    scene: context.sceneDescription?.trim() ?? "",
    style_description: context.styleDescription?.trim() ?? "",
    episode_background: context.episodeBackground?.trim() ?? "",
    shot_intent: shotIntent,
    props: renderReferenceLanes(references, ["prop"]),
    references: renderReferenceLanes(references, ["reference", "reference_video"]),
    negative_prompt: NEGATIVE_PROMPT_V1,
  };
  const includesStyleDescription = [...template.matchAll(PROJECT_PROMPT_TEMPLATE_PLACEHOLDER)]
    .some((match) => (match[1] ?? "").trim() === "style_description");
  const prompt = template
    .split(/\r?\n/u)
    .map((line) => {
      const placeholders = [...line.matchAll(PROJECT_PROMPT_TEMPLATE_PLACEHOLDER)]
        .map((match) => (match[1] ?? "").trim());
      if (placeholders.length > 0 && placeholders.every((placeholder) => !values[placeholder])) {
        return "";
      }
      return line.replace(
        PROJECT_PROMPT_TEMPLATE_PLACEHOLDER,
        (_match, placeholder: string) => values[placeholder.trim()] ?? "",
      );
    })
    .map((line) => line.replace(/[ \t]{2,}/gu, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return { prompt, includesStyleDescription };
}

/**
 * 编译自动段。输出是输入的纯函数:同一份结构化真源两次编译 byte 级一致。
 * 无任何结构化真源时返回空串(负面词表不单独成段),由调用方判空兜底。
 */
export function compileAutoPrompt(context: PromptCompilationContext): CompiledAutoPrompt {
  const lockedPrompt = context.manualPrompt?.trim() ?? "";
  if (context.mediaKind === "video" && context.promptLocked && lockedPrompt) {
    return {
      version: LOCKED_PROMPT_VERSION,
      autoPrompt: "",
      lockedPrompt,
    };
  }
  const references = (context.references ?? [])
    .filter((reference) => reference.name?.trim())
    .map((reference) => ({ ...reference, name: reference.name.trim() }));
  const styleDescription = context.styleDescription?.trim();
  if (context.promptTemplate) {
    const rendered = renderProjectPromptTemplate(context.promptTemplate, context, references);
    let autoPrompt = rendered.prompt;
    if (styleDescription && !rendered.includesStyleDescription) {
      autoPrompt = joinPromptSegments(autoPrompt, `风格:${styleDescription}`);
    }
    if (autoPrompt && !autoPrompt.includes(NEGATIVE_PROMPT_V1)) {
      autoPrompt = joinPromptSegments(autoPrompt, NEGATIVE_PROMPT_V1);
    }
    return {
      version: PROMPT_TEMPLATE_VERSION,
      autoPrompt: truncateChars(autoPrompt, AUTO_PROMPT_BUDGET_CHARS),
    };
  }
  const assemble = (options: TrimOptions): string => {
    const segments = renderSegments(context, references, options);
    if (styleDescription) segments.push(`风格:${styleDescription}`);
    return segments.length === 0 ? "" : [...segments, NEGATIVE_PROMPT_V1].join("。");
  };
  let autoPrompt = assemble({
    truncateReferences: false,
    dropEpisodeBackground: false,
    truncateSceneDescription: false,
  });
  if (charLength(autoPrompt) > AUTO_PROMPT_BUDGET_CHARS) {
    // ①各参考登记描述截 30 字(保资产名)
    autoPrompt = assemble({
      truncateReferences: true,
      dropEpisodeBackground: false,
      truncateSceneDescription: false,
    });
  }
  if (charLength(autoPrompt) > AUTO_PROMPT_BUDGET_CHARS) {
    // ②删剧集背景
    autoPrompt = assemble({
      truncateReferences: true,
      dropEpisodeBackground: true,
      truncateSceneDescription: false,
    });
  }
  if (charLength(autoPrompt) > AUTO_PROMPT_BUDGET_CHARS) {
    // ③场景描述截 60 字
    autoPrompt = assemble({
      truncateReferences: true,
      dropEpisodeBackground: true,
      truncateSceneDescription: true,
    });
  }
  if (charLength(autoPrompt) > AUTO_PROMPT_BUDGET_CHARS) {
    // ④整体硬截(镜头意图/台词保到本步)
    autoPrompt = truncateChars(autoPrompt, AUTO_PROMPT_BUDGET_CHARS);
  }
  return { version: PROMPT_TEMPLATE_VERSION, autoPrompt };
}

/** 服务端拼接 = 自动段 + 人工补充段(默认空)。 */
export function joinPromptSegments(autoPrompt: string, supplementPrompt?: string): string {
  return [autoPrompt.trim(), supplementPrompt?.trim() ?? ""].filter(Boolean).join("\n");
}

