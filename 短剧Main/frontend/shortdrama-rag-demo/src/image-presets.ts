/* ============================================================
   image-presets.ts — W6-1 生图工作台预设模板库（LibTV 参考）
   14 个定稿模板，两组：分镜叙事 storyboard（9）+ 设定图 design（5）。
   模板文案为控制材料生产语义定稿（Dario 校对），不得擅自改写。
   纯数据 + 纯函数：不 import css / react / api，node:test 可直接断言
   （src/w6-presets.test.ts）。
   ============================================================ */
import type { JsonRecord, Shot } from "./types";

export type ImagePresetGroup = "storyboard" | "design";

export interface ImagePreset {
  id: string;
  group: ImagePresetGroup;
  name: string;
  /** 含 {content} 占位符的模板文案，选中后替换为当前分镜内容预填。 */
  prompt: string;
  parameters: { ratio: string; size: string };
}

/** 模板文案中的内容占位符。 */
export const PRESET_CONTENT_TOKEN = "{content}";

/** 分镜无剧本文本也无标题时的可手填引导语。 */
export const PRESET_CONTENT_HINT = "（在这里补充素材内容：剧本文本或画面描述）";

/** 未选模板时的图片参数兜底（与 V0.1.1 固定参数一致）。 */
export const IMAGE_FALLBACK_RATIO = "16:9";
export const IMAGE_FALLBACK_SIZE = "2K";

export const IMAGE_PRESETS: readonly ImagePreset[] = [
  /* ---------- 分镜叙事组 ---------- */
  {
    id: "storyboard-blocking",
    group: "storyboard",
    name: "调度故事板",
    prompt: "专业导演调度故事板：{content}。以电影分镜表形式呈现关键调度节点，标注镜头运动与人物走位，画面连贯、光影写实，按叙事顺序从左到右、从上到下排列。",
    parameters: { ratio: "16:9", size: "2K" },
  },
  {
    id: "storyboard",
    group: "storyboard",
    name: "故事板",
    prompt: "电影级故事板：{content}。标准分镜连环画形式，每格一个关键镜头，标注景别与镜头角度，写实光影，人物服装与场景保持一致，阅读顺序从左到右、从上到下。",
    parameters: { ratio: "16:9", size: "2K" },
  },
  {
    id: "grid-9",
    group: "storyboard",
    name: "九宫格分镜",
    prompt: "严格 3x3 九宫格分镜草图（nine-panel storyboard contact sheet）：{content}。整图均匀切分为 9 格，每格 2.39:1 电影画幅，格间距均匀，每格一个递进镜头，人物与场景保持全片一致，阅读顺序从左到右、从上到下。",
    parameters: { ratio: "1:1", size: "2K" },
  },
  {
    id: "grid-25",
    group: "storyboard",
    name: "25宫格连贯分镜",
    prompt: "严格 5x5 二十五宫格连贯分镜：{content}。整图均匀切分为 25 格，每格 2.39:1 画幅，格与格剧情连续推进，像漫画一样逐格阅读，从左到右、从上到下，人物、服装、光线全片统一。",
    parameters: { ratio: "1:1", size: "2K" },
  },
  {
    id: "grid-4-plot",
    group: "storyboard",
    name: "剧情推演四宫格",
    prompt: "严格 2x2 四宫格剧情推演：{content}。整图切分为 4 格，分别呈现起因、发展、转折、结果四个关键时刻，每格 16:9，写实电影光影，人物一致，阅读顺序从左到右、从上到下。",
    parameters: { ratio: "1:1", size: "2K" },
  },
  {
    id: "plus-3s",
    group: "storyboard",
    name: "画面推演-3秒后",
    prompt: "同一镜头的画面推演：呈现{content}发生 3 秒后的画面。保持完全相同的机位、构图、光线与人物服装，只推进人物动作与场面状态，电影级写实。",
    parameters: { ratio: "16:9", size: "2K" },
  },
  {
    id: "minus-5s",
    group: "storyboard",
    name: "画面推演-5秒前",
    prompt: "同一镜头的画面推演：呈现{content}发生 5 秒前的画面。保持完全相同的机位、构图、光线与人物服装，回溯人物动作与场面状态，电影级写实。",
    parameters: { ratio: "16:9", size: "2K" },
  },
  {
    id: "multi-camera-9",
    group: "storyboard",
    name: "多机位九宫格",
    prompt: "严格 3x3 九宫格多机位分镜：{content}。同一场戏的 9 个不同机位（远景、全景、中景、近景、特写、俯拍、仰拍、过肩、主观），整图均匀 9 格，每格标注机位语义，人物与场景一致，从左到右、从上到下。",
    parameters: { ratio: "1:1", size: "2K" },
  },
  {
    id: "pano-720",
    group: "storyboard",
    name: "720全景",
    prompt: "720° 全景场景图（equirectangular 等距柱状投影）：{content}。水平 360° 连续无缝、垂直 180° 全覆盖，地平线保持水平，无接缝畸变，电影级写实光影。",
    parameters: { ratio: "21:9", size: "2K" },
  },
  /* ---------- 设定图组 ---------- */
  {
    id: "face-three-view",
    group: "design",
    name: "角色脸部三视图",
    prompt: "角色脸部设定三视图：{content}。同一角色的正面、3/4 侧面、正侧面三张脸部特写并排，五官、发型、肤色完全一致，白底或浅灰底，标准角色设定集风格。",
    parameters: { ratio: "16:9", size: "2K" },
  },
  {
    id: "character-sheet",
    group: "design",
    name: "角色设定图",
    prompt: "角色全身设定图：{content}。同一角色正面全身立绘，服装、发型、配饰细节清晰，中性站姿，纯色背景，标注级角色设定风格，写实电影质感。",
    parameters: { ratio: "16:9", size: "2K" },
  },
  {
    id: "character-three-view",
    group: "design",
    name: "角色三视图",
    prompt: "角色三视图设定：{content}。同一角色的正面、侧面、背面三个全身视图并排，16:9 构图，身高比例一致，服装细节三视图对应，纯色背景，标准设定集规范。",
    parameters: { ratio: "16:9", size: "2K" },
  },
  {
    id: "scene-sheet",
    group: "design",
    name: "场景设定图",
    prompt: "场景设定图：{content}。宽画幅环境概念图，呈现场景全貌、光照氛围与材质细节，符合影视美术场景设定规范，写实电影光影。",
    parameters: { ratio: "16:9", size: "2K" },
  },
  {
    id: "product-sheet",
    group: "design",
    name: "产品设定图",
    prompt: "道具/产品设定图：{content}。主体居中，材质与结构细节清晰，标准产品三视或单视展示，纯色背景，影视美术道具设定风格。",
    parameters: { ratio: "16:9", size: "2K" },
  },
];

/** 两组分组展示顺序与组名。 */
export const IMAGE_PRESET_GROUPS: ReadonlyArray<{ key: ImagePresetGroup; label: string }> = [
  { key: "storyboard", label: "分镜叙事" },
  { key: "design", label: "设定图" },
];

/** 按组取模板（保持 IMAGE_PRESETS 内定义顺序）。 */
export function presetsInGroup(group: ImagePresetGroup): ImagePreset[] {
  return IMAGE_PRESETS.filter((preset) => preset.group === group);
}

export function findImagePreset(id: string | null | undefined): ImagePreset | null {
  if (!id) return null;
  return IMAGE_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * {content} 替换内容：分镜剧本文本优先，其次分镜标题，
 * 两者皆空时给可手填的引导语（不留空串让人对着空白猜）。
 */
export function resolvePresetContent(shot: Pick<Shot, "script_text" | "title"> | null | undefined): string {
  const script = shot?.script_text?.trim();
  if (script) return script;
  const title = shot?.title?.trim();
  if (title) return title;
  return PRESET_CONTENT_HINT;
}

/** 模板文案预填：替换全部 {content} 占位符。 */
export function applyPresetPrompt(
  preset: ImagePreset,
  shot: Pick<Shot, "script_text" | "title"> | null | undefined,
): string {
  return preset.prompt.split(PRESET_CONTENT_TOKEN).join(resolvePresetContent(shot));
}

/** 选中-取消切换：点同一枚模板取消选中（返回 null），点另一枚改选。 */
export function togglePresetSelection(currentId: string | null, presetId: string): string | null {
  return currentId === presetId ? null : presetId;
}

/**
 * 提交参数合并：选中模板的 ratio/size 覆盖默认；
 * watermark:false 与 sequential_image_generation:"disabled" 恒定保留。
 */
export function imageGenerationParameters(preset: ImagePreset | null | undefined): JsonRecord {
  return {
    ratio: preset?.parameters.ratio ?? IMAGE_FALLBACK_RATIO,
    size: preset?.parameters.size ?? IMAGE_FALLBACK_SIZE,
    watermark: false,
    sequential_image_generation: "disabled",
  };
}

/**
 * S59 + G06/G07 回归吸收：档是原子的（提交参数=tierSubmitInput(档)，模板 ratio 不参与提交），
 * 而宫格/全景类模板按特定画幅设计。选中模板的设计画幅与当前档画幅不一致时必须明示，
 * 不能静默按档画幅出图让宫格变形。彻底解决（档=可选范围、模板参数重新参与提交）
 * 属合同变更，归后续包；在此之前先诚实告知。
 */
export function presetRatioNote(preset: ImagePreset | null | undefined, tierRatio: string | null | undefined): string | null {
  if (!preset || !tierRatio || preset.parameters.ratio === tierRatio) return null;
  return `「${preset.name}」按 ${preset.parameters.ratio} 画幅设计，当前档只出 ${tierRatio}，出图会变形`;
}

/**
 * 模板卡副标（S73,V-07 口径随 S66 行为更新）：预填提示词恒发生；
 * 设计画幅在 active 档值域内时选中还会按维度反查切档——副标必须把「切档」说上,
 * 只写「预填提示词」等于把 V-07 修好的切档又说漏了;
 * 无档（如 21:9 全景）不切,副标如实写「无 N:N 档」,选中后模板区另有变形警示。
 * 值域未就绪（档位读取中/失败）时保持中性,不说不知道的事。
 */
export function presetBadgeLabel(preset: ImagePreset, allowedRatios: ReadonlySet<string> | null): string {
  if (!allowedRatios) return "预填提示词";
  return allowedRatios.has(preset.parameters.ratio)
    ? `预填提示词 · 按 ${preset.parameters.ratio} 切档`
    : `预填提示词 · 无 ${preset.parameters.ratio} 档`;
}
