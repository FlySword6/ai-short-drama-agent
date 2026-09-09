/* ============================================================
   director-visual-vocabulary.ts — 导演视觉词表：构图 / 景别 / 镜头语言
   （R19 四张速查表的后三组，R9 创作词表不冻结）

   内容源 = DC 2026-07-27 发的三张图（电影构图大全 / 电影景别大全 / 镜头语言），
   逐格转写全文与存疑清单见 docs/design/director-visual-vocabulary.md §3.1/3.2/3.4。
   第四组「电影调色大全」不在本文件——它是色卡，已有 color-card-vocabulary.ts。

   分层（照 ontology-blueprint §二）：本文件是 **L2 词表层的内容**，
   lane-vocabulary.ts 是「工作台有哪些栏」，本文件是「栏里摆哪些词条」，两层不混。

   取数口径照 lane-vocabulary.ts（同一套范式，不新造）：
   - 内置词表兜底 → loadDirectorVisualVocabulary({ fetcher }) 可注入远程词表；
   - 快照同步读，读侧助手是组件唯一入口，组件不直读常量；
   - 新增一条词 = 数组加一项（将来 = 表加一行），渲染层按字段走，不认识的不炸 UI。

   抄录纪律：只抄有据的，不许编。原图自身有三处错（近景特写焦段正文 85mm 与
   示意图 50mm 矛盾、远景那格机位说明串了上一条、见设计文档存疑 5/6），
   本词表以正文列为准，矛盾如实记在 sourceNote 里，不擅自「修正」原图。

   纯逻辑、零 DOM，node:test 直接 import（director-visual-vocabulary.test.ts）。
   ============================================================ */

/* ---------- 词表形状 ---------- */

/** 三组的组 id。新增一组 = 加一个 domain 词条，不改类型定义外的任何代码。 */
export type DirectorVisualDomainId = string;

export interface DirectorVisualDomainDef {
  id: DirectorVisualDomainId;
  /** 组标题（构图 / 景别 / 镜头语言）。 */
  label: string;
  /** 组的英文名（原图大标题）。 */
  labelEn: string;
  /** 组的一句话说明（原图副标题）。 */
  subtitle: string;
  /** 组底部 DIRECTOR NOTES 的那句话——界面文案的范本，不是装饰。 */
  directorNote: string;
  sort: number;
}

/** 镜头机位几何：3D 导演台机位预设直接读这一坨；原图没给的字段留 undefined，不猜。 */
export interface CameraGeometry {
  /** 焦段，如 "24mm"；原图未给（环绕镜头）时 undefined。 */
  focalLength?: string;
  /** 机位高度原话，如 "低于脚部（贴地）"。 */
  height?: string;
  /** 角度原话，如 "向上 45 度仰拍"。 */
  angle?: string;
  /** 与人物的距离原话，如 "15 米以上"。 */
  distance?: string;
  /** 运动原话，如 "围绕人物 360 度移动"；静止镜头为 undefined。 */
  movement?: string;
}

export interface DirectorVisualEntry {
  id: string;
  domain: DirectorVisualDomainId;
  /** 展示名（三分法构图 / 大远景 / 低机位仰拍…）。 */
  displayName: string;
  /** 原图英文名（RULE OF THIRDS / EXTREME LONG SHOT…）。 */
  displayNameEn: string;
  /** 组内排序（=原图编号）。 */
  sort: number;
  /** 词表启停（inactive 不上界面、不进提示词编译）。 */
  active: boolean;
  /**
   * 参数段：这条词「怎么拍」的原话。构图=构图原理；景别=摄影距离+画面范围；
   * 镜头语言=摄影机位置与参数。服务端编译提示词时用它，不用 displayName。
   */
  params: readonly string[];
  /** 视觉效果段：这条词「给观众什么感觉」的原话。 */
  effect: readonly string[];
  /** 机位几何（只有镜头语言组有；其余组 undefined）。 */
  geometry?: CameraGeometry;
  /** 原图示意图上的标注原话（景别的「距离中等」、镜头语言的「机位：…」）。 */
  diagramNote?: string;
  /** 原图自身的矛盾/串行如实记录在这里，不擅自修正原图。 */
  sourceNote?: string;
}

export interface DirectorVisualVocabulary {
  /** 词表版本（后端接口就位后由服务端给；内置="builtin-r19"）。 */
  version: string;
  domains: readonly DirectorVisualDomainDef[];
  entries: readonly DirectorVisualEntry[];
}

/* ---------- 内置词表（=R19 三张图逐格转写） ---------- */

export const DIRECTOR_VISUAL_DOMAINS_BUILTIN: readonly DirectorVisualDomainDef[] = [
  {
    id: "composition",
    label: "构图",
    labelEn: "FILM COMPOSITION",
    subtitle: "画框 | 空间 | 视觉叙事",
    directorNote: "构图不是摆放人物，而是在控制观众视线。",
    sort: 1,
  },
  {
    id: "shot_size",
    label: "景别",
    labelEn: "SHOT SIZE",
    subtitle: "距离 | 范围 | 情绪表达",
    directorNote: "景别决定观众距离，也决定故事的情绪与信息传递。选择合适的景别，就是选择让观众如何理解故事。",
    sort: 2,
  },
  {
    id: "camera_language",
    label: "镜头语言",
    labelEn: "CAMERA LANGUAGE",
    subtitle: "景别 | 机位 | 运动",
    directorNote: "镜头不是记录画面，而是在控制观众情绪。",
    sort: 3,
  },
];

const COMPOSITION_ENTRIES: readonly DirectorVisualEntry[] = [
  {
    id: "rule_of_thirds", domain: "composition", displayName: "三分法构图", displayNameEn: "RULE OF THIRDS",
    sort: 1, active: true,
    params: ["画面分为九宫格。", "人物主体位于三分线交汇位置。"],
    effect: ["增强画面平衡。", "突出主体。", "符合自然观看习惯。"],
  },
  {
    id: "center", domain: "composition", displayName: "中心构图", displayNameEn: "CENTER COMPOSITION",
    sort: 2, active: true,
    params: ["人物主体位于画面中央。", "形成强烈视觉集中。"],
    effect: ["突出主角身份。", "制造仪式感。", "增强英雄感。"],
  },
  {
    id: "leading_lines", domain: "composition", displayName: "引导线构图", displayNameEn: "LEADING LINES",
    sort: 3, active: true,
    params: ["利用道路、建筑、光线，引导观众视线。"],
    effect: ["增强空间深度。", "控制观看方向。"],
  },
  {
    id: "frame_within_frame", domain: "composition", displayName: "框架式构图", displayNameEn: "FRAME WITHIN FRAME",
    sort: 4, active: true,
    params: ["利用门框、窗户、建筑形成第二层画框。"],
    effect: ["增强空间层次。", "制造偷窥感。", "突出人物情绪。"],
  },
  {
    id: "foreground_layer", domain: "composition", displayName: "前景遮挡构图", displayNameEn: "FOREGROUND LAYER",
    sort: 5, active: true,
    params: ["利用前景元素遮挡镜头，形成空间层次。"],
    effect: ["增加真实感。", "增强沉浸体验。"],
  },
  {
    id: "negative_space", domain: "composition", displayName: "留白构图", displayNameEn: "NEGATIVE SPACE",
    sort: 6, active: true,
    params: ["主体旁保留大量空白空间。"],
    effect: ["表现孤独。", "等待。", "命运感。"],
  },
];

const SHOT_SIZE_ENTRIES: readonly DirectorVisualEntry[] = [
  {
    id: "extreme_long", domain: "shot_size", displayName: "大远景", displayNameEn: "EXTREME LONG SHOT",
    sort: 1, active: true,
    params: ["摄影距离：摄影机距离人物非常远，人物只占画面极小比例。", "画面范围：展示人物 + 巨大环境。"],
    effect: ["建立世界观。", "表现孤独。", "突出命运感。"],
    diagramNote: "距离非常远",
  },
  {
    id: "long", domain: "shot_size", displayName: "全景", displayNameEn: "LONG SHOT",
    sort: 2, active: true,
    params: ["摄影距离：完整展示人物全身。", "画面范围：人物完整动作，包含周围环境。"],
    effect: ["展示人物行动。", "表现人物与空间关系。"],
    diagramNote: "距离较远",
  },
  {
    id: "medium", domain: "shot_size", displayName: "中景", displayNameEn: "MEDIUM SHOT",
    sort: 3, active: true,
    params: ["摄影距离：拍摄人物腰部以上。", "画面范围：人物动作和表情同时存在。"],
    effect: ["最常用叙事景别。", "适合对白。", "增强人物关系。"],
    diagramNote: "距离中等",
  },
  {
    id: "close", domain: "shot_size", displayName: "近景", displayNameEn: "CLOSE SHOT",
    sort: 4, active: true,
    params: ["摄影距离：胸口以上。", "画面范围：突出人物脸部和情绪。"],
    effect: ["强化心理状态。", "突出角色变化。"],
    diagramNote: "距离中等",
  },
  {
    id: "close_up", domain: "shot_size", displayName: "特写", displayNameEn: "CLOSE UP",
    sort: 5, active: true,
    params: ["摄影距离：极近距离拍摄。", "画面范围：眼睛、嘴唇、手部、关键物品。"],
    effect: ["放大情绪。", "制造戏剧冲击。"],
    diagramNote: "距离很近",
  },
  {
    id: "extreme_close_up", domain: "shot_size", displayName: "大特写", displayNameEn: "EXTREME CLOSE UP",
    sort: 6, active: true,
    params: ["摄影距离：极端靠近。", "画面范围：单个细节。如：眼睛、戒指、剑锋、手指。"],
    effect: ["制造悬念。", "强化关键瞬间。"],
    diagramNote: "距离极近",
  },
];

const CAMERA_LANGUAGE_ENTRIES: readonly DirectorVisualEntry[] = [
  {
    id: "low_angle", domain: "camera_language", displayName: "低机位仰拍", displayNameEn: "LOW ANGLE SHOT",
    sort: 1, active: true,
    params: ["摄影机贴近地面，位于人物脚边以下位置，24mm 广角镜头，向上 45 度仰拍。"],
    effect: ["强化人物存在感。", "提升主角气场。", "制造英雄感。"],
    geometry: { focalLength: "24mm", height: "低于脚部（贴近地面）", angle: "向上 45 度仰拍" },
    diagramNote: "机位：低于脚部，仰角 45°",
  },
  {
    id: "high_angle", domain: "camera_language", displayName: "高机位俯拍", displayNameEn: "HIGH ANGLE SHOT",
    sort: 2, active: true,
    params: ["摄影机位于人物上方，垂直向下俯视，35mm 镜头。"],
    effect: ["表现孤独。", "降低人物力量。", "突出环境。"],
    geometry: { focalLength: "35mm", height: "高于头顶", angle: "垂直向下俯视" },
    diagramNote: "机位：高于头顶，垂直俯拍",
  },
  {
    id: "eye_level", domain: "camera_language", displayName: "平视镜头", displayNameEn: "EYE LEVEL SHOT",
    sort: 3, active: true,
    params: ["摄影机高度与人物眼睛平齐，50mm 电影镜头。"],
    effect: ["真实自然。", "增强观众代入感。"],
    geometry: { focalLength: "50mm", height: "与人物眼睛平齐", angle: "平视" },
    diagramNote: "50mm",
  },
  {
    id: "close_up_shot", domain: "camera_language", displayName: "近景特写", displayNameEn: "CLOSE UP SHOT",
    sort: 4, active: true,
    params: ["85mm 镜头，靠近人物脸部。"],
    effect: ["放大人物情绪。", "捕捉微表情。", "增强内心戏。"],
    geometry: { focalLength: "85mm", distance: "靠近人物脸部" },
    diagramNote: "50mm",
    sourceNote: "原图正文写 85mm、示意图标注 50mm，两者矛盾；以正文为准（设计文档存疑 5）。",
  },
  {
    id: "long_shot", domain: "camera_language", displayName: "远景镜头", displayNameEn: "LONG SHOT",
    sort: 5, active: true,
    params: ["距离人物 15 米以上，24mm 广角镜头。"],
    effect: ["强调空间。", "表现孤独感。", "创造命运感。"],
    geometry: { focalLength: "24mm", distance: "距离人物 15 米以上" },
    diagramNote: "24mm",
    sourceNote: "原图该格另有一行「机位：靠近面部」，内容属上一条近景特写，是原图串行，不采信（设计文档存疑 6）。",
  },
  {
    id: "orbit", domain: "camera_language", displayName: "环绕镜头", displayNameEn: "ORBIT SHOT",
    sort: 6, active: true,
    params: ["摄影机围绕人物 360 度移动。"],
    effect: ["增强沉浸感。", "制造浪漫感。", "提升视觉冲击。"],
    geometry: { movement: "围绕人物 360 度移动" },
    diagramNote: "机位：360° 环绕移动",
  },
];

export const BUILTIN_DIRECTOR_VISUAL_VOCABULARY: DirectorVisualVocabulary = {
  version: "builtin-r19",
  domains: DIRECTOR_VISUAL_DOMAINS_BUILTIN,
  entries: [...COMPOSITION_ENTRIES, ...SHOT_SIZE_ENTRIES, ...CAMERA_LANGUAGE_ENTRIES],
};

/* ---------- 取数口（默认内置兜底；app 显式传接口 fetcher） ---------- */

async function defaultFetcher(): Promise<DirectorVisualVocabulary> {
  return BUILTIN_DIRECTOR_VISUAL_VOCABULARY;
}

let snapshot: DirectorVisualVocabulary = BUILTIN_DIRECTOR_VISUAL_VOCABULARY;

/** 当前词表快照（同步读；未加载过远程时=内置）。 */
export function directorVisualSnapshot(): DirectorVisualVocabulary {
  return snapshot;
}

/**
 * 加载词表并更新快照。fetcher 可注入（测试 mock 远程词表）；
 * 失败回落内置，不炸 UI。返回最终生效的词表。
 */
export async function loadDirectorVisualVocabulary(
  input: { fetcher?: () => Promise<DirectorVisualVocabulary> } = {},
): Promise<DirectorVisualVocabulary> {
  const fetcher = input.fetcher ?? defaultFetcher;
  try {
    snapshot = await fetcher();
  } catch {
    snapshot = BUILTIN_DIRECTOR_VISUAL_VOCABULARY;
  }
  return snapshot;
}

/* ---------- 读侧助手（组件唯一入口，不直读常量） ---------- */

function activeEntries(): readonly DirectorVisualEntry[] {
  return snapshot.entries.filter((entry) => entry.active);
}

/** 某一组的 active 词条（按 sort 排好）。未知 domain 返回空数组，不抛。 */
export function directorVisualEntries(domain: DirectorVisualDomainId): readonly DirectorVisualEntry[] {
  return [...activeEntries()].filter((entry) => entry.domain === domain).sort((a, b) => a.sort - b.sort);
}

/** 三组分区（组标题+组内词条），组无词条时也给空组以便呈现「空」。 */
export function directorVisualDomains(): ReadonlyArray<DirectorVisualDomainDef & { entries: readonly DirectorVisualEntry[] }> {
  return [...snapshot.domains]
    .sort((a, b) => a.sort - b.sort)
    .map((domain) => ({ ...domain, entries: directorVisualEntries(domain.id) }));
}

/** 按 id 取词条；未知 id 返回 undefined（调用方判空，不炸 UI）。 */
export function directorVisualEntry(id: string): DirectorVisualEntry | undefined {
  return activeEntries().find((entry) => entry.id === id);
}

/**
 * 3D 导演台机位预设：镜头语言组里带机位几何的词条。
 * DC 2026-07-27 已定 3D 片场挂 v0.4+，但二维的机位选择器不依赖 3D——
 * 这批预设今天就能用来做选择器，选完由服务端编译进提示词。
 */
export function cameraPresets(): readonly DirectorVisualEntry[] {
  return directorVisualEntries("camera_language").filter((entry) => entry.geometry !== undefined);
}

/* ---------- 演示/测试注入 ---------- */

/** 测试辅助：直接覆盖快照（mock 新词条进词表后验证渲染/编译）。 */
export function injectDirectorVisualVocabularyForTest(next: DirectorVisualVocabulary): void {
  snapshot = next;
}

export function resetDirectorVisualVocabularyForTest(): void {
  snapshot = BUILTIN_DIRECTOR_VISUAL_VOCABULARY;
}
