/* ============================================================
   ir-compiler.ts — 结构化 IR → Seedance prose 编译器（纯函数，不引 CSS）

   规格来源：outputs/workbench-w9/audit-v3-fable5.md §2.2（EBNF）/§2.3（schema）、
   audit-v3-gpt56sol.md（@槽位三层模型 / prose 可回源）、audit-v3b-fable5.md（EDIT 骨架）。
   核心约定：
   - IR 是唯一真相，prose 只是编译产物；@图像N/@视频N 槽位号编译时才分配
     （图片、视频分开编号，按 IR 数组顺序），IR 层永远用稳定 asset_id 引用；
     正文内联引用写 {{asset_id}} 占位、refs 数组存 asset_id，@N 一律由编译器
     生成，绝不手存、不回写 IR；
   - 正向约束收尾（GENERATE）与锁定枚举句 /「唯一新增的内容是：…」白名单句 /
     镜头继承句 / 技术规格继承句（EDIT）全部由编译器从 IR 字段自动推导，
     IR 没有"约束尾自由文本"字段，禁止手写；
   - 每个 prose 段携带 provenance 回源路径（如 shots[2].camera），供 UI 点击回跳；
   - 数值伪精度（60:30:10、24–35mm…）按普通字符串透传，不解析、不承诺数值级
     可控；SpecClaim 对象形态可标 verified，供 UI 区分「已验证可控 / 官方推荐未验证」；
   - 编译器零副作用：不发网络请求、不读环境、同 IR 必同输出。
   ============================================================ */

import {
  composeVisualText,
  orderNamesByMention,
  parseShotScript,
  type ShotScriptStructure,
} from "./script-structure";

/* ---------------- 共用：资产与槽位（结构层 asset_id + role） ---------------- */

/** 资产媒介：图像绑定身份/外观/场景结构；视频绑定构图/运镜/动态/节奏（语义不同，一等公民）。 */
export type AssetMedia = "image" | "video";

/** 资产角色（§2.3 schema 草案）。 */
export type AssetRole =
  | "character"
  | "scene"
  | "prop"
  | "composition"
  | "motion"
  | "pacing"
  | "endcard";

/**
 * 数值/风格声明：普通字符串透传；对象形态可标注 verified（true=已验证可控，
 * false/缺省=官方推荐但未验证），编译器只取 text，不消费 verified。
 */
export type SpecClaim = string | { readonly text: string; readonly verified?: boolean };

/** 身份锁定强度（§2.2 LockStrength）。 */
export type AssetLock =
  /** 全锁：100% 匹配参考图。 */
  | { readonly mode: "full" }
  /** 部分继承：参考 X（继承 inherit）但 override 字段完全不同。 */
  | { readonly mode: "partial"; readonly inherit?: readonly string[]; readonly override: readonly string[] }
  /** 单维绑定：参考 X 的构图/运镜/动态/冲击感/运动/节奏（BindDim）。 */
  | { readonly mode: "dimension"; readonly dimension: string };

/** 资产生效作用域：全局贯穿 or 指定分镜（如 { shots: ["S3"] }）。 */
export type AssetScope = "global" | { readonly shots: readonly string[] };

/** 控制资产：稳定 asset_id 为主键；label/alias 是显示层语义名，不是身份主键。 */
export interface PromptAsset {
  readonly id: string;
  readonly media: AssetMedia;
  readonly role: AssetRole;
  /** UI 语义名（如 "任天野 · 主角身份"）：仅显示层与分镜叙事命中用，不进 prose。 */
  readonly label?: string;
  /** 别名（如 her/him）→ 编译为 @her，可复用变量。 */
  readonly alias?: string;
  /** 身份/外观描述（身份锁定段正文），可含 {{asset_id}} 内联引用。 */
  readonly description?: string;
  /** 锁定声明；缺省 = 仅声明槽位与描述，不输出锁定句。 */
  readonly lock?: AssetLock;
  readonly scope: AssetScope;
}

/* ---------------- GENERATE IR（spec：从空白全量描述） ---------------- */

/** 头部元信息（Header）：【标题 — 节拍… | 类型 | 时长】+ 一句话梗概。 */
export interface PromptMeta {
  readonly title: string;
  /** 节拍摘要；同时驱动约束尾"叙事闭环"复述（唯一数据源）。 */
  readonly beats: readonly string[];
  readonly genre: string;
  readonly duration_s: number;
  readonly logline?: string;
}

/** 全局风格（GlobalStyle := 媒介 质感 (配色比 "60:30:10")? ExclusionList?）。 */
export interface GlobalStyle {
  /** 媒介（如 "真实实拍质感，物理电影镜头，真实材质"）。 */
  readonly medium: string;
  /** 整体画面基调（场景/时代/光线…）。 */
  readonly scene?: string;
  /** 质感/细节（如 "超高细节——汗衫布料抖动…"）。 */
  readonly texture?: string;
  /** 60:30:10 配色比：字符串原样透传，不做数值解析（伪精度不特殊处理）。 */
  readonly palette_603010?: SpecClaim;
  /** 风格排除项（"3D 渲染/游戏引擎/动漫感"），同时喂给约束尾排除清单。 */
  readonly exclusions?: readonly string[];
}

/** 全局镜头&变速（GlobalCamera）。 */
export interface GlobalCamera {
  /** 镜头系统（"混合手持与摇臂/无人机，按分镜切换视角与景别…"）。 */
  readonly system?: string;
  /** 焦段/快门等（"24–35mm,180° 快门…"）：字符串透传。 */
  readonly lens?: SpecClaim;
  /** 变速策略（"大部分为实时；仅 S5/S6 各一次短暂慢动作"）。 */
  readonly ramp?: string;
}

/** 全局物理（GlobalPhysics）。 */
export interface GlobalPhysics {
  /** 强度标签（如 "极致真实"）。 */
  readonly label?: string;
  readonly text: string;
}

/** 全局声音设计（GlobalAudio）。 */
export interface GlobalAudio {
  /** 声音设计策略（如 "按分镜在巨响与完全无声之间反复硬切"）。 */
  readonly strategy: string;
  /** 基底（如 "仅现场同期声"），同时喂给约束尾。 */
  readonly base?: string;
  /** 环境声垫底。 */
  readonly bed?: string;
  /** 对白策略（如 "无对白（除本能的惊呼）"）。 */
  readonly vo_policy?: string;
  /** 声音排除项（"音乐/字幕"），同时喂给约束尾排除清单。 */
  readonly exclusions?: readonly string[];
}

/**
 * 时间轴分镜（Shot）。资产引用一律 asset_id：refs 数组直接存 id，
 * action 等正文内联引用写 {{asset_id}} 占位，编译器统一替换为 @N。
 */
export interface PromptShot {
  readonly id: string;
  readonly start_s: number;
  readonly end_s: number;
  /** 分镜主题（如 "开幕：咀嚼大特写(有声)"）。 */
  readonly theme?: string;
  /** 景别/视角（CameraSpec := 景别 ("，" 视角)?）。 */
  readonly camera?: { readonly framing?: string; readonly angle?: string };
  /** 机位/位置（实例 2："机身背面"）。 */
  readonly position?: string;
  /** 画面/动作主体文本，可含 {{asset_id}} 内联引用。 */
  readonly action?: string;
  /** 原始分镜叙事：经 parseShotScript 确定性拆分为画面行（补 action）与对白行。 */
  readonly script?: string;
  readonly performance?: string;
  /** 本镜引用资产（asset_id 列表）→ 编译为"参考@图像1、@视频2"。 */
  readonly refs?: readonly string[];
  /** 音效/可听见（如 "听得见咀嚼声…"），原样成句。 */
  readonly sfx?: string;
  /** 旁白 → 编译为 旁白："…"。 */
  readonly vo?: string;
  /** 变速（SpeedRamp）："实时" 原样成句；其余编译为 变速：…。 */
  readonly speed_ramp?: string;
  /** 验收标准（Acceptance := "要求：" Text，实例 2 字段）。 */
  readonly acceptance?: string;
}

/** 品牌文字块（BrandBlock）：依叙事位置出现，位于时间轴之后、约束尾之前。 */
export interface BrandBlock {
  /** 品牌字样 / slogan。 */
  readonly text: string;
  /** 出现时机（如 "结尾黑屏" / "20-23秒白屏段"）。 */
  readonly timing?: string;
  /** 旁白念出全文。 */
  readonly voiceover?: string;
  readonly note?: string;
}

/**
 * GENERATE IR。骨架：头部元信息 → 全局风格 → 资产声明+身份锁定 → 全局镜头 →
 * 全局物理 → 全局声音 → 时间轴分镜体 → 品牌文字块 → 正向约束收尾（自动推导）。
 */
export interface GenerateIR {
  readonly kind: "generate";
  readonly meta: PromptMeta;
  readonly assets: readonly PromptAsset[];
  readonly global: {
    readonly style: GlobalStyle;
    readonly camera?: GlobalCamera;
    readonly physics?: GlobalPhysics;
    readonly audio?: GlobalAudio;
  };
  readonly shots: readonly PromptShot[];
  readonly brand?: BrandBlock;
}

/* ---------------- EDIT IR（diff/patch：默认全锁，只声明增量） ---------------- */

/** EDIT 可锁定维度（三态字段的固定枚举集合，锁定枚举句的用词来源）。 */
export type EditDimension =
  | "duration"
  | "composition"
  | "camera_motion"
  | "subject_trajectory"
  | "scene"
  | "lighting"
  | "grading"
  | "aspect"
  | "audio"
  | "imperfections";

/** 维度 → 锁定枚举句用词（顺序即枚举句顺序）。 */
export const EDIT_DIMENSIONS: ReadonlyArray<readonly [EditDimension, string]> = [
  ["duration", "时长与节奏"],
  ["composition", "构图"],
  ["camera_motion", "镜头运动"],
  ["subject_trajectory", "主体运动轨迹"],
  ["scene", "场景与物体"],
  ["lighting", "光线"],
  ["grading", "色调与调色"],
  ["aspect", "画幅与镜头特性"],
  ["audio", "原音频"],
  ["imperfections", "自然瑕疵感"],
];

/** 字段三态（v3b 字段状态机）：🔒lock（默认）/ ✏️override / ➕add。 */
export type EditField =
  | { readonly mode: "lock" }
  | { readonly mode: "override"; readonly value: string }
  | { readonly mode: "add"; readonly value: string };

/** 核心新增块：一个命名的增量规则（转色规则 / 银幕破裂锁定…），四要素齐全。 */
export interface CoreAddition {
  readonly name: string;
  /** 白名单句条目（"唯一新增的内容是：…"中的语义项）。 */
  readonly summary: string;
  /** 规则详述，可含 {{asset_id}} 内联引用。 */
  readonly description?: string;
  /** 触发条件（事件锚点，如 "火车车头真正突破银幕的那一瞬间"）。 */
  readonly trigger: string;
  /** 空间锚点（如 "以火车冲出点为中心向全画面扩散"）。 */
  readonly spatial_anchor: string;
  /** 时间同步要求（如 "与破幕的爆发瞬间精确同步"）。 */
  readonly time_sync: string;
  /** 物理约束（如 "撕扯方向与火车冲出的力量和方向一致"）。 */
  readonly physics: string;
}

/** 音频继承 + 增量。 */
export interface EditAudio {
  /** 继承内容（如 "放映厅环境音（放映机哒哒声、观众轻微骚动）"）。 */
  readonly inherit?: string;
  /** 新增音效清单。 */
  readonly add?: readonly string[];
  /** 声音排除项（如 ["音乐"] → 不要音乐）。 */
  readonly exclusions?: readonly string[];
}

/**
 * EDIT IR。骨架：编辑目标 → 风格约束 → 原视频锁定块（枚举锁定项 + 白名单）→
 * 核心新增块×N → 覆写字段声明 → 增量主体 → 镜头继承声明 → 音频继承+增量 →
 * 技术规格尾块（与 @视频N 完全一致，继承句强制自动生成）。
 */
export interface EditIR {
  readonly kind: "edit";
  /** 编辑目标一句话（L1 轻指令也是它，只是字段更少）。 */
  readonly intent: string;
  /** 基础视频 asset_id：必须存在于 assets 且 media 为 video。 */
  readonly base: string;
  readonly assets: readonly PromptAsset[];
  /** 风格约束（正向基调 + 负向清单），可选。 */
  readonly style?: { readonly positive?: string; readonly negative?: readonly string[] };
  /** 字段三态表：未声明 override/add 的字段自动进锁定枚举句。 */
  readonly fields?: Readonly<Partial<Record<EditDimension, EditField>>>;
  readonly additions?: readonly CoreAddition[];
  /** 增量主体（仅描述 Δ 实体：主体/场景/动作），可含 {{asset_id}}。 */
  readonly subject?: string;
  /** 镜头继承声明；缺省自动生成"完全继承@视频N原本的镜头运动…"。 */
  readonly camera_inheritance?: string;
  readonly audio?: EditAudio;
  /** 复述性输出规格（"16:9","1080p"…）；时长/规格继承句由编译器强制追加。 */
  readonly output_notes?: readonly string[];
}

/** 双语法 IR：GENERATE（spec）与 EDIT（diff）共用底层资产/时间轴结构。 */
export type PromptIR = GenerateIR | EditIR;

/* ---------------- 编译产物 ---------------- */

/** 槽位绑定（显示层 @N / 别名）：编译时分配，只存在于产物，不回写 IR。 */
export interface SlotBinding {
  readonly asset_id: string;
  /** 显示层 token：@图像1 / @视频1（图片、视频分开编号，按 IR 数组顺序）。 */
  readonly token: string;
  /** 别名 token：@her。 */
  readonly alias?: string;
  readonly media: AssetMedia;
  readonly role: AssetRole;
}

/** prose 段级回源映射（prose 可回源：UI 点击段 → 定位 IR 字段）。 */
export interface ProvenanceEntry {
  /** 段标识：header / global_style / asset:xxx / shot:S3 / constraint_tail / edit_lock … */
  readonly segment: string;
  /** 来源 IR 路径（如 "meta"、"assets[0].lock"、"shots[2].camera"），必有至少一条且均可解析。 */
  readonly source: readonly string[];
  /** 该段编译产物（prose = 全部段 text 以 "\n" 连接，顺序即 provenance 顺序）。 */
  readonly text: string;
}

export interface CompileResult {
  readonly prose: string;
  readonly provenance: readonly ProvenanceEntry[];
  readonly slots: readonly SlotBinding[];
}

/* ---------------- 内部：槽位分配与引用替换 ---------------- */

/** 槽位编译时分配：图片、视频分开编号，均按 IR 数组顺序从 1 递增。 */
function allocateSlots(assets: readonly PromptAsset[]): SlotBinding[] {
  let images = 0;
  let videos = 0;
  return assets.map((asset) => {
    const token = asset.media === "image" ? `@图像${(images += 1)}` : `@视频${(videos += 1)}`;
    return {
      asset_id: asset.id,
      token,
      ...(asset.alias ? { alias: `@${asset.alias}` } : {}),
      media: asset.media,
      role: asset.role,
    };
  });
}

function slotMap(slots: readonly SlotBinding[]): ReadonlyMap<string, SlotBinding> {
  return new Map(slots.map((slot) => [slot.asset_id, slot]));
}

/** asset_id → 显示层 token；IR 引用未知资产属于编译期错误（未绑定槽位）。 */
function refToken(byId: ReadonlyMap<string, SlotBinding>, assetId: string): string {
  const slot = byId.get(assetId);
  if (!slot) throw new Error(`ir-compiler: 未知资产引用 "${assetId}"（IR 只允许 asset_id 引用已注册资产）`);
  return slot.token;
}

/** 正文内联占位 {{asset_id}} → 编译期槽位 token；@N 由此进入 prose，绝不手存。 */
function substitute(text: string, byId: ReadonlyMap<string, SlotBinding>): string {
  return text.replace(/\{\{([^{}]+)\}\}/g, (_match, rawId: string) => refToken(byId, rawId.trim()));
}

/* ---------------- 内部：句子装配 ---------------- */

/** 句尾归一：剥掉字段自带的句末句号/空白，句号由编译器统一补。 */
function clause(text: string): string {
  return text.replace(/[。\s]+$/u, "");
}

/** 子句装配：以 "。" 连接并补句末句号；空表返回空串。 */
function joinClauses(parts: readonly string[]): string {
  const cleaned = parts.map(clause).filter((part) => part.length > 0);
  if (cleaned.length === 0) return "";
  const joined = cleaned.join("。");
  // 末尾已是句末标点（！？。）不再补句号，避免"！。"叠用
  return /[。！？!?]$/u.test(joined) ? joined : `${joined}。`;
}

/** SpecClaim 取文本（verified 仅供 UI 打标，编译不消费）。 */
function claimText(claim: SpecClaim): string {
  return typeof claim === "string" ? claim : claim.text;
}

/** 资产显示层语义名表（parseShotScript 命中匹配用；label 缺省不参与）。 */
function assetLabels(assets: readonly PromptAsset[]): string[] {
  return assets.map((asset) => asset.label?.trim() ?? "").filter((label) => label.length > 0);
}

/** refs 按分镜叙事命中排序（命中在前，未命中相对序不变）；无 script 时原序。 */
function orderShotRefs(
  refIds: readonly string[],
  parsed: ShotScriptStructure | null,
  assets: readonly PromptAsset[],
): readonly string[] {
  if (!parsed || refIds.length < 2) return refIds;
  const keyById = new Map(assets.map((asset) => [asset.id, asset.label?.trim() || asset.id]));
  const pairs = refIds.map((id) => ({ id, key: keyById.get(id) ?? id }));
  const idByKey = new Map(pairs.map((pair) => [pair.key, pair.id]));
  return orderNamesByMention(
    pairs.map((pair) => pair.key),
    parsed.mentioned,
  ).map((key) => idByKey.get(key) ?? key);
}

/* ---------------- GENERATE：各块编译 ---------------- */

function compileHeader(meta: PromptMeta): string {
  const beats = meta.beats.length > 0 ? ` — ${meta.beats.join(" — ")}` : "";
  const header = `【${meta.title}${beats} | ${meta.genre} | 约 ${meta.duration_s} 秒】`;
  return meta.logline ? `${header}【一句话梗概】${clause(meta.logline)}` : header;
}

function compileGlobalStyle(style: GlobalStyle): string {
  const parts: string[] = [];
  if (style.scene) parts.push(`整体画面 —— ${style.scene}`);
  if (style.palette_603010) parts.push(`60:30:10 配色 —— ${claimText(style.palette_603010)}`);
  const exclusions = style.exclusions?.length ? `，无 ${style.exclusions.join("/")}` : "";
  parts.push(`${style.medium}${exclusions}`);
  if (style.texture) parts.push(style.texture);
  return joinClauses(parts);
}

/** 资产声明 + 身份锁定（AssetBlock := AssetRef IdentityLock? LockStrength?）。 */
function compileAssetBlock(
  asset: PromptAsset,
  slot: SlotBinding,
  byId: ReadonlyMap<string, SlotBinding>,
): string {
  const clauses: string[] = [];
  const lock = asset.lock;
  if (!lock || lock.mode === "full") {
    const head = slot.alias
      ? `参考${slot.token}：${slot.alias}`
      : `${asset.media === "image" ? "参考图" : "参考视频"}${slot.token}`;
    const desc = asset.description ? `——${substitute(asset.description, byId)}` : "";
    clauses.push(`${head}${desc}`);
    if (lock?.mode === "full") {
      clauses.push(asset.media === "image" ? "100% 匹配参考图" : "100% 匹配参考视频");
    }
  } else if (lock.mode === "partial") {
    const inherit = lock.inherit?.length ? `，继承其${lock.inherit.join("、")}` : "";
    clauses.push(`参考${slot.token}${inherit}，但${lock.override.join("、")}完全不同`);
  } else {
    clauses.push(`参考${slot.token}的${lock.dimension}`);
  }
  if (asset.scope !== "global") clauses.push(`仅 ${asset.scope.shots.join("、")} 生效`);
  return joinClauses(clauses);
}

function compileGlobalCamera(camera: GlobalCamera): string {
  const parts: string[] = [];
  if (camera.system) parts.push(camera.system);
  if (camera.lens) parts.push(claimText(camera.lens));
  const ramp = camera.ramp ? `变速：${clause(camera.ramp)}。` : "";
  return `镜头&变速 —— ${joinClauses(parts)}${ramp}`;
}

function compileGlobalPhysics(physics: GlobalPhysics): string {
  return `物理${physics.label ? `(${physics.label})` : ""} —— ${joinClauses([physics.text])}`;
}

function compileGlobalAudio(audio: GlobalAudio): string {
  const parts: string[] = [audio.strategy];
  if (audio.base) parts.push(audio.base);
  if (audio.bed) parts.push(`背景垫${audio.bed}`);
  if (audio.vo_policy) parts.push(audio.vo_policy);
  if (audio.exclusions?.length) parts.push(`无${audio.exclusions.join("/")}`);
  return `声音设计 —— ${joinClauses(parts)}`;
}

/** 时间轴分镜：S?(起–止秒)・主题 —— 参考@N / 镜头 / 位置 / 动作 / 表演 / 对白 / 要求 / 旁白 / 音效 / 变速。 */
function compileShot(
  shot: PromptShot,
  assets: readonly PromptAsset[],
  byId: ReadonlyMap<string, SlotBinding>,
): string {
  const parsed: ShotScriptStructure | null = shot.script
    ? parseShotScript(shot.script, assetLabels(assets))
    : null;
  const clauses: string[] = [];
  const refIds = orderShotRefs(shot.refs ?? [], parsed, assets);
  if (refIds.length > 0) {
    clauses.push(`参考${refIds.map((id) => refToken(byId, id)).join("、")}`);
  }
  if (shot.camera) {
    const spec = [shot.camera.framing, shot.camera.angle].filter((v): v is string => Boolean(v)).join("，");
    if (spec) clauses.push(`镜头：${spec}`);
  }
  if (shot.position) clauses.push(`位置：${substitute(shot.position, byId)}`);
  const action = shot.action ?? (parsed ? composeVisualText(parsed).split("\n").join("；") : "");
  if (action) clauses.push(substitute(action, byId));
  if (shot.performance) clauses.push(`表演：${substitute(shot.performance, byId)}`);
  if (parsed) clauses.push(...parsed.dialogue);
  if (shot.acceptance) clauses.push(`要求：${substitute(shot.acceptance, byId)}`);
  if (shot.vo) clauses.push(`旁白：“${substitute(shot.vo, byId)}”`);
  if (shot.sfx) clauses.push(substitute(shot.sfx, byId));
  if (shot.speed_ramp) {
    clauses.push(shot.speed_ramp === "实时" ? "实时" : `变速：${substitute(shot.speed_ramp, byId)}`);
  }
  const head = `${shot.id}(${shot.start_s}–${shot.end_s}秒)`;
  const body = joinClauses(clauses);
  if (!body) return head;
  return `${head}${shot.theme ? `・${substitute(shot.theme, byId)} —— ` : " —— "}${body}`;
}

function compileBrand(brand: BrandBlock): string {
  const parts: string[] = [];
  parts.push(`${brand.timing ? `${brand.timing}：` : ""}画面出现“${brand.text}”字样`);
  if (brand.voiceover) parts.push(`旁白念出：“${brand.voiceover}”`);
  if (brand.note) parts.push(brand.note);
  return `品牌文字 —— ${joinClauses(parts)}`;
}

/**
 * 正向约束收尾（ConstraintTail := 时长复述 角色数量 一致性声明 叙事闭环复述
 * ExclusionList）：全部由 IR 字段自动推导，IR 没有约束尾自由文本字段。
 */
function compileConstraintTail(ir: GenerateIR, byId: ReadonlyMap<string, SlotBinding>): string {
  const sentences: string[] = [];
  // 时长复述 + 类型 + 分镜一致性声明
  sentences.push(`约 ${ir.meta.duration_s} 秒，${ir.meta.genre}，严格遵循上述分镜的景别切换与声音切换`);
  // 角色数量 + 身份一致性声明（有局部角色时不做"只有一个角色"的全局断言）
  const characters = ir.assets.filter((asset) => asset.role === "character");
  const hasScoped = characters.some((asset) => asset.scope !== "global");
  const [only] = characters;
  if (characters.length === 1 && !hasScoped && only) {
    const desc = only.description ? `：${clause(substitute(only.description, byId))}` : "";
    sentences.push(`全片只有一个角色${desc}，无其他人物，身份/长相/体型/着装 100% 匹配参考图，全程一致不漂移`);
  } else if (characters.length > 0) {
    sentences.push(`全片共 ${characters.length} 个角色，各自身份 100% 匹配参考图，全程一致不漂移`);
  }
  // 叙事闭环复述（与头部节拍同源）
  if (ir.meta.beats.length > 0) sentences.push(`故事闭环：${ir.meta.beats.join("→")}`);
  // 排除项：风格排除 + 声音排除（复述媒介/基底以增强权重）
  const styleExclusions = ir.global.style.exclusions ?? [];
  if (styleExclusions.length > 0) {
    sentences.push(`${ir.global.style.medium}，无 ${styleExclusions.join("/")}`);
  }
  const audio = ir.global.audio;
  if (audio) {
    const audioExclusions = audio.exclusions ?? [];
    if (audio.base && audioExclusions.length > 0) sentences.push(`${audio.base}，无${audioExclusions.join("/")}`);
    else if (audioExclusions.length > 0) sentences.push(`无${audioExclusions.join("/")}`);
    else if (audio.base) sentences.push(audio.base);
  }
  return `正向约束 —— ${joinClauses(sentences)}`;
}

/* ---------------- 装配 ---------------- */

function assemble(segments: readonly ProvenanceEntry[], slots: readonly SlotBinding[]): CompileResult {
  return {
    prose: segments.map((segment) => segment.text).join("\n"),
    provenance: segments,
    slots,
  };
}

/* ---------------- 导出：GENERATE 编译 ---------------- */

export function compileGeneratePrompt(ir: GenerateIR): CompileResult {
  const slots = allocateSlots(ir.assets);
  const byId = slotMap(slots);
  const segments: ProvenanceEntry[] = [];

  // 1) 头部元信息
  segments.push({ segment: "header", source: ["meta"], text: compileHeader(ir.meta) });
  // 2) 全局风格
  segments.push({ segment: "global_style", source: ["global.style"], text: compileGlobalStyle(ir.global.style) });
  // 3) 资产声明 + 身份锁定
  ir.assets.forEach((asset, index) => {
    const source = [`assets[${index}]`];
    if (asset.lock) source.push(`assets[${index}].lock`);
    segments.push({
      segment: `asset:${asset.id}`,
      source,
      text: compileAssetBlock(asset, byId.get(asset.id) ?? slotMustExist(asset.id), byId),
    });
  });
  // 4) 全局镜头&变速
  if (ir.global.camera) {
    segments.push({ segment: "global_camera", source: ["global.camera"], text: compileGlobalCamera(ir.global.camera) });
  }
  // 5) 全局物理
  if (ir.global.physics) {
    segments.push({ segment: "global_physics", source: ["global.physics"], text: compileGlobalPhysics(ir.global.physics) });
  }
  // 6) 全局声音
  if (ir.global.audio) {
    segments.push({ segment: "global_audio", source: ["global.audio"], text: compileGlobalAudio(ir.global.audio) });
  }
  // 7) 时间轴分镜体
  segments.push({
    segment: "timeline",
    source: ["meta.duration_s", "shots"],
    text: `分镜(约 ${ir.meta.duration_s} 秒 —— 严格按此节奏与声音切换)`,
  });
  ir.shots.forEach((shot, index) => {
    const source = [`shots[${index}]`];
    if (shot.camera) source.push(`shots[${index}].camera`);
    if (shot.action) source.push(`shots[${index}].action`);
    if (shot.script) source.push(`shots[${index}].script`);
    if (shot.refs?.length) source.push(`shots[${index}].refs`);
    segments.push({ segment: `shot:${shot.id}`, source, text: compileShot(shot, ir.assets, byId) });
  });
  // 8) 品牌文字块
  if (ir.brand) {
    segments.push({ segment: "brand", source: ["brand"], text: compileBrand(ir.brand) });
  }
  // 9) 正向约束收尾（自动推导，禁止手写）
  const tailSource = ["meta.duration_s", "meta.genre", "meta.beats", "assets", "global.style"];
  if (ir.global.audio) tailSource.push("global.audio");
  segments.push({ segment: "constraint_tail", source: tailSource, text: compileConstraintTail(ir, byId) });

  return assemble(segments, slots);
}

/** 槽位表与资产数组同源分配，取不到即 IR 内部不一致（防御分支）。 */
function slotMustExist(assetId: string): never {
  throw new Error(`ir-compiler: 资产 "${assetId}" 槽位分配缺失`);
}

/* ---------------- 导出：EDIT 编译 ---------------- */

export function compileEditPrompt(ir: EditIR): CompileResult {
  const slots = allocateSlots(ir.assets);
  const byId = slotMap(slots);
  const baseSlot = byId.get(ir.base);
  if (!baseSlot) throw new Error(`ir-compiler: EDIT 基础视频 "${ir.base}" 未在资产注册表中声明`);
  if (baseSlot.media !== "video") {
    throw new Error(`ir-compiler: EDIT 基础资产 "${ir.base}" 必须是 video 媒介（实际 ${baseSlot.media}）`);
  }
  const baseToken = baseSlot.token;

  // 字段三态：未声明 override/add 的字段自动进锁定枚举句
  const fields = ir.fields ?? {};
  const locked: string[] = [];
  const addValues: string[] = [];
  const overrideItems: string[] = [];
  const overrideDecls: string[] = [];
  for (const [dimension, label] of EDIT_DIMENSIONS) {
    const field = fields[dimension];
    if (!field || field.mode === "lock") {
      locked.push(label);
    } else if (field.mode === "add") {
      addValues.push(field.value);
    } else {
      overrideItems.push(`${label}：${field.value}`);
      overrideDecls.push(`${label}改为：${field.value}`);
    }
  }

  const additions = ir.additions ?? [];
  const segments: ProvenanceEntry[] = [];

  // 0) 编辑目标
  segments.push({
    segment: "edit_intent",
    source: ["intent", "base"],
    text: `编辑目标：对${baseToken}进行编辑 —— ${clause(substitute(ir.intent, byId))}。`,
  });
  // 1) 风格约束（正向 + 负向）
  if (ir.style) {
    const parts: string[] = [];
    if (ir.style.positive) parts.push(`风格：${ir.style.positive}`);
    if (ir.style.negative?.length) parts.push(ir.style.negative.map((item) => `不要 ${item}`).join("，"));
    segments.push({ segment: "edit_style", source: ["style"], text: joinClauses(parts) });
  }
  // 2) 原视频锁定块 = 枚举锁定项 +「唯一新增的内容是：…」白名单
  const whitelist = [...additions.map((addition) => addition.summary), ...addValues, ...overrideItems];
  const lockParts = [
    `原视频锁定：将${baseToken}完整保留为基础画面`,
    `${locked.join("、")}都保持不变，不要修改`,
  ];
  if (whitelist.length > 0) lockParts.push(`唯一新增的内容是：${whitelist.join("、")}`);
  const lockSource = ["base"];
  if (ir.fields) lockSource.push("fields");
  if (additions.length > 0) lockSource.push("additions");
  segments.push({ segment: "edit_lock", source: lockSource, text: joinClauses(lockParts) });
  // 3) 核心新增块×N（触发条件 + 空间锚点 + 时间同步 + 物理约束）
  additions.forEach((addition, index) => {
    const parts = [`${addition.name}(核心新增)`];
    if (addition.description) parts.push(substitute(addition.description, byId));
    parts.push(
      `触发条件：${addition.trigger}`,
      `空间锚点：${addition.spatial_anchor}`,
      `时间同步：${addition.time_sync}`,
      `物理约束：${addition.physics}`,
    );
    segments.push({ segment: `addition:${addition.name}`, source: [`additions[${index}]`], text: joinClauses(parts) });
  });
  // 3b) 覆写字段声明（✏️ 编译进增量声明）
  if (overrideDecls.length > 0) {
    segments.push({ segment: "edit_delta_fields", source: ["fields"], text: joinClauses(overrideDecls) });
  }
  // 4) 增量主体（仅描述 Δ 实体）
  if (ir.subject) {
    segments.push({
      segment: "edit_subject",
      source: ["subject"],
      text: `主体：${clause(substitute(ir.subject, byId))}。`,
    });
  }
  // 5) 镜头继承声明（缺省自动生成）
  const cameraText = ir.camera_inheritance
    ? substitute(ir.camera_inheritance, byId)
    : `完全继承${baseToken}原本的镜头运动。不要平滑，不要重定时，不要重新构图`;
  segments.push({
    segment: "edit_camera",
    source: ir.camera_inheritance ? ["camera_inheritance"] : ["base"],
    text: `镜头要求：${clause(cameraText)}。`,
  });
  // 6) 音频继承 + 增量
  if (ir.audio) {
    const parts: string[] = [];
    if (ir.audio.exclusions?.length) parts.push(ir.audio.exclusions.map((item) => `不要${item}`).join("，"));
    const inherit = `继承${baseToken}原本的${ir.audio.inherit ?? "环境音"}`;
    parts.push(ir.audio.add?.length ? `${inherit}，并新增${ir.audio.add.join("、")}` : inherit);
    segments.push({ segment: "edit_audio", source: ["audio"], text: `声音：${joinClauses(parts)}` });
  }
  // 7) 技术规格尾块：继承句强制自动生成（总时长与@视频N完全一致 + 零改动重申）
  const notes = (ir.output_notes ?? []).map(clause).filter((note) => note.length > 0);
  const specLine = [...notes, `总时长与${baseToken}完全一致`].join("，");
  segments.push({
    segment: "edit_techspec",
    source: ir.output_notes ? ["output_notes", "base"] : ["base"],
    text: `限制条件：${specLine}。除上述增量与声明的变化外，不新增、不修改任何其他内容，未提及的一切保持原样。`,
  });

  return assemble(segments, slots);
}
