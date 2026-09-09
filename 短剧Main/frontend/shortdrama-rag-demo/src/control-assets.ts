/**
 * 控制资产类型化（G 组 · 控制包提案第二节的前端面）
 * role 六类单选强制、usage_mode 三值校验分区；后端字段就位前先在前端类型与
 * demo fixture 上落地，接口形状对齐 docs/proposals/control-package-model.md。
 */

/** 控制职责六类（单一职责，上传/生成入库强制单选）。 */
export const ASSET_ROLES = [
  { value: "character_identity", label: "角色身份", mediaHint: "图片为主", tone: "accent" },
  { value: "scene", label: "场景", mediaHint: "图片为主", tone: "success" },
  { value: "prop", label: "道具", mediaHint: "图片为主", tone: "warning" },
  { value: "motion", label: "动作参考", mediaHint: "视频为主", tone: "agent" },
  { value: "camera_storyboard", label: "镜头故事板", mediaHint: "视频为主", tone: "danger" },
  { value: "style_env", label: "风格环境", mediaHint: "图片为主", tone: "neutral" },
] as const;

export type AssetRole = (typeof ASSET_ROLES)[number]["value"];

const ROLE_BY_VALUE = new Map<string, (typeof ASSET_ROLES)[number]>(ASSET_ROLES.map((role) => [role.value, role]));

export function assetRoleMeta(role: string | null | undefined): { readonly value: string; readonly label: string; readonly mediaHint: string; readonly tone: string } | null {
  return role ? ROLE_BY_VALUE.get(role) ?? null : null;
}

/** 使用方式三值：生成管线按此校验（控制输入不得误当起止帧）。 */
export const USAGE_MODES = [
  { value: "reference", label: "参考素材" },
  { value: "first_frame", label: "首帧" },
  { value: "last_frame", label: "尾帧" },
] as const;

export type UsageMode = (typeof USAGE_MODES)[number]["value"];

/** 生成分区（G2）：媒介 × usage_mode 四区，各区只收对应媒体类型。 */
export interface ReferenceZone {
  key: "reference_image" | "reference_video" | "first_frame" | "last_frame";
  label: string;
  /** 该区接受的媒体类型 */
  accepts: "image" | "video";
  hint: string;
}

export const REFERENCE_ZONES: readonly ReferenceZone[] = [
  { key: "reference_image", label: "参考图", accepts: "image", hint: "画面风格/构图/角色参考" },
  { key: "reference_video", label: "参考视频", accepts: "video", hint: "动作节奏/运镜参考（只收视频资产）" },
  { key: "first_frame", label: "首帧", accepts: "image", hint: "视频生成的起始画面" },
  { key: "last_frame", label: "尾帧", accepts: "image", hint: "视频生成的收束画面" },
] as const;

/** 媒体版本按 zone 过滤的纯判定（usage_mode 缺省视为 reference）。 */
export function mediaMatchesZone(media: { media_kind?: string; format?: string | null; usage_mode?: string | null } | null | undefined, zone: ReferenceZone): boolean {
  if (!media) return false;
  const kind = (media.media_kind ?? "").toLowerCase();
  const format = (media.format ?? "").toLowerCase();
  const isVideo = kind.includes("video") || ["mp4", "mov", "webm"].includes(format);
  if (zone.accepts === "video") return isVideo;
  if (isVideo) return false;
  const usage = media.usage_mode ?? "reference";
  if (zone.key === "first_frame") return usage === "first_frame";
  if (zone.key === "last_frame") return usage === "last_frame";
  return usage === "reference";
}
