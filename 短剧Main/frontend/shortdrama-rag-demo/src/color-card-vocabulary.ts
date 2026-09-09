/* ============================================================
   color-card-vocabulary.ts — 色卡内容词表（N3 包，V-17/V-18，R9 创作词表不冻结）

   色卡是**内容词表**（六条导演调色词），不是资产、不是枚举——与 lane-vocabulary
   的栏定义分工：栏定义管「有色卡这一栏」，本文件管「栏里摆哪六套调色」。
   内容源 = DC 2026-07-27 发的「电影调色大全」原图，逐格转写全文见
   docs/design/director-visual-vocabulary.md §3.3（含存疑清单）。

   色值纪律（硬规矩，违反整包打回）：只抄有据的，不许编。
   2026-07-29 抄全：六条的三格色板 HEX 全部照原图抄录，并用色板圆点的像素
   取样与标签文字互证色相；六条全部 active。仍留空的只有三处 gradingRecipe
   （原图该列字号低于可辨阈值，两次独立 OCR 结果互相矛盾）——留空不猜。

   主色/辅助色与格位：原图给两个色名、三格色板，没写谁对谁。六条的「主色名 ↔
   第一格」色相全部吻合，所以 primaryHex 取第一格是有据的；辅助色不然（暖调的
   Green 对应第三格而非第二格），所以**辅助色不做格位推断**，secondaryHex 一律
   记色名原话，三格 HEX 由 palette 原样保留。要生成色卡图的用 palette。

   呈现分工：hex 真值（# 开头）才渲染色块；只记了色名原话的（如暖调辅色
   Green）按文字呈现，不猜色渲染——猜一个具体绿就是编色值。
   纯逻辑、零 DOM，node:test 直接 import。
   ============================================================ */

export interface ColorCardEntry {
  id: string;              // "warm" | "cool" | "low_sat" | "high_sat" | "noir" | "teal_orange"
  name: string;            // 暖调 / 冷调 / 低饱和 / 高饱和 / 暗黑 / 青橙
  /** 原图英文名（WARM TONE / COOL TONE…），提示词编译与英文界面用。 */
  nameEn: string;
  /** 主色名原话（Gold / Blue / Gray…）。 */
  primaryName: string;
  /** 主色 hex = 色板第一格（六条色相全部与主色名吻合，有据）。 */
  primaryHex: string;
  /** 辅色：原图只给色名不给格位，按原话记录（如暖调=Green），界面按文字呈现不猜色。 */
  secondaryHex: string;
  /** 色板三格，按原图从上到下原样保留——生成色卡图用这个，不用上面两个字段。 */
  palette: readonly string[];
  /** 情绪关键词（原图「视觉效果」段，中文）。 */
  mood: readonly string[];
  /** 情绪关键词英文（原图 COLOR ANALYSIS 段）。 */
  moodEn: readonly string[];
  /** 色彩特点（调色手法；原图不可辨的留空数组，不猜）。 */
  gradingRecipe: readonly string[];
  /** 导演用途（原图「导演情绪解析」列）。 */
  directorUse: string;
  /** 词表启停（inactive 不上界面）。 */
  active: boolean;
}

export const COLOR_CARD_ENTRIES: readonly ColorCardEntry[] = [
  {
    id: "warm",
    name: "暖调",
    nameEn: "WARM TONE",
    primaryName: "Gold",
    primaryHex: "#D99B52",
    secondaryHex: "Green", // 原图「辅助色：Green」——不做格位推断，按原话记色名
    palette: ["#D99B52", "#E8C98A", "#6B7B45"],
    mood: ["温暖", "浪漫", "幸福感"],
    moodEn: ["Romance", "Warmth", "Nostalgia"],
    gradingRecipe: [], // 原图「增加：□色 / □色；降低：冷色比例」，前两个色名不可辨——留空
    directorUse: "爱情、回忆、治愈剧情",
    active: true,
  },
  {
    id: "cool",
    name: "冷调",
    nameEn: "COOL TONE",
    primaryName: "Blue",
    primaryHex: "#425A72",
    secondaryHex: "Gray",
    palette: ["#425A72", "#78889A", "#30343A"],
    mood: ["孤独", "距离", "压抑感"],
    moodEn: ["Loneliness", "Distance", "Melancholy"],
    gradingRecipe: ["增加：蓝色", "青色"],
    directorUse: "离别、战争、悬疑",
    active: true,
  },
  {
    id: "low_sat",
    name: "低饱和",
    nameEn: "DESATURATED LOOK",
    primaryName: "Gray",
    primaryHex: "#8C8F94",
    secondaryHex: "Muted Green",
    palette: ["#8C8F94", "#A1A69A", "#4A4D4A"],
    mood: ["真实", "高级", "纪实感"],
    moodEn: ["Realism", "Natural", "Classic"],
    gradingRecipe: ["降低整体颜色", "增加灰度"],
    directorUse: "现实主义、剧情片",
    active: true,
  },
  {
    id: "high_sat",
    name: "高饱和",
    nameEn: "HIGH SATURATION",
    primaryName: "Vibrant Green",
    primaryHex: "#4CAF50",
    secondaryHex: "Sky Blue",
    palette: ["#4CAF50", "#2E86C1", "#FFD24A"],
    mood: ["强烈", "青春", "梦幻"],
    moodEn: ["Youth", "Dreamy", "Energy"],
    gradingRecipe: [], // 原图该列两行完全不可辨——留空
    directorUse: "青春、奇幻、幻想世界",
    active: true,
  },
  {
    id: "noir",
    name: "暗黑",
    nameEn: "DARK CINEMATIC",
    primaryName: "Dark Blue",
    primaryHex: "#1B2636",
    secondaryHex: "Deep Gray",
    /* 第三格存疑：标签读作 #0E0F42，但该圆点像素取样是 #0D0E10（近黑）；
       #0E0F42 会明显偏蓝紫，与渲染不符，字形在 4/9 之间也判不了。
       按原图标签照抄，用它生成色卡图前先跟 DC 核原件
       （docs/design/director-visual-vocabulary.md §二 存疑 4）。 */
    palette: ["#1B2636", "#2C2F36", "#0E0F42"],
    mood: ["危险", "神秘", "紧张"],
    moodEn: ["Danger", "Mystery", "Tension"],
    gradingRecipe: ["降低曝光", "增加阴影", "强化对比"],
    directorUse: "犯罪、复仇、惊悚",
    active: true,
  },
  {
    id: "teal_orange",
    name: "青橙",
    nameEn: "TEAL & ORANGE",
    primaryName: "Teal",
    primaryHex: "#1E6F7A",
    secondaryHex: "Orange",
    palette: ["#1E6F7A", "#F49A44", "#F7C88A"],
    mood: ["突出人物", "增强商业电影感"],
    moodEn: ["Cinematic", "Contrast", "Impact"],
    gradingRecipe: [], // 原图只能读出「……青蓝 / 人物皮肤暖橙」，前两字不可辨——整条留空
    directorUse: "商业大片、动作电影、主角塑造",
    active: true,
  },
];

/** 上界面的色卡（active=true）。 */
export function activeColorCards(): readonly ColorCardEntry[] {
  return COLOR_CARD_ENTRIES.filter((entry) => entry.active);
}

/** 按 id 取词条；未知 id 返回 undefined（调用方判空，不炸 UI）。 */
export function colorCardEntry(id: string): ColorCardEntry | undefined {
  return COLOR_CARD_ENTRIES.find((entry) => entry.id === id);
}
