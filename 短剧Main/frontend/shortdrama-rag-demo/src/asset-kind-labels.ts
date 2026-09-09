/* ============================================================
   asset-kind-labels.ts — 资产类型枚举 → 中文标签（纯逻辑、零 DOM）

   自 ui.tsx 迁出（业务语言化 #18：command-palette 等纯逻辑模块也要用，
   不该为一张标签表 import 整个组件层）。ui.tsx 原样 re-export，
   既有 ../ui 引用方零改动。
   ============================================================ */

/**
 * 资产类型中文标签映射。枚举值与后端同源（src/domain/assets/types.ts 的 assetKind
 * 流通值 + directorManifestImport.ts 的 3D 素模分类），前端只补展示映射、不发明新值。
 * S88：动物展示为「角色·动物」——动物是角色的子类，不与角色并列（DC 判决）；
 * 存量 asset_kind=animal 不改库，仅展示层归类。
 */
const ASSET_KIND_LABELS: Readonly<Record<string, string>> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  costume: "服装",
  audio: "音频",
  lighting: "光线参考",
  camera: "摄影参考",
  video: "视频参考",
  audio: "音频",
  keyword: "关键帧",
  keyframe: "关键帧",
  clothing: "服装",
  animal: "角色·动物",
  reference: "参考",
  other: "参考",
  model_3d: "3D 素模",
  sound: "声音参考",
  music: "配乐参考",
  variant: "变体",
};

/**
 * 资产类型中文标签（S88b 起诚实兜底）：
 * - null/undefined（字段缺省）→「资产」；
 * - 识别值 → 中文标签（大小写/首尾空白归一：后端写入只做 trim、不强制小写，
 *   「Animal」这类值不应在界面上裸显原值）；
 * - 未识别值与空白串 →「未分类」，原始值由 assetKindRawTitle 放进 title 悬浮说明，
 *   不再把未知枚举原样裸显当标签。
 */
export function assetKindLabel(kind?: string | null): string {
  if (kind == null) return "资产";
  return ASSET_KIND_LABELS[kind.trim().toLowerCase()] ?? "未分类";
}

/**
 * 未识别类型的原始值悬浮说明（S88b）：已识别 → undefined（不加 title）；
 * 空白 →「（空白）」；未识别 → 原值（trim 后）。与 assetKindLabel 的「未分类」兜底配套，
 * 用户悬停能看到库里真实存的值，既不裸显也不吞掉。
 */
export function assetKindRawTitle(kind?: string | null): string | undefined {
  if (kind == null) return undefined;
  const trimmed = kind.trim();
  if (!trimmed) return "（空白）";
  return ASSET_KIND_LABELS[trimmed.toLowerCase()] ? undefined : trimmed;
}

/**
 * v0.9：音频五类分类中文标签（与后端 AudioCandidateKind 同源：
 * src/modules/script-breakdown/types.ts；文案与阶段①抽取口径一致）。
 * 未识别/缺省 →「未分类」，不裸显枚举原值。
 */
const AUDIO_KIND_LABELS: Readonly<Record<string, string>> = {
  character_voice: "角色声音",
  narration: "旁白",
  sfx: "音效",
  ambience: "环境声",
  other: "其他",
};

export function audioKindLabel(kind?: string | null): string {
  if (kind == null) return "未分类";
  return AUDIO_KIND_LABELS[kind.trim().toLowerCase()] ?? "未分类";
}
