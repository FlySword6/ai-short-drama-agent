/* ============================================================
   project-config.ts — 项目级生成配置（卡 #151；产品依据 docs/design/prd-v2/project.md §二/§四）

   口径（2026-08-06 裁决，见 project.md §4.1 注记与 models.md §一「两层」表）：
   - 画幅共用一个字段（aspect_ratio），清晰度图片/视频分开存
     （image_resolution / video_resolution）——图片刻度 1K/2K、视频刻度 720p/1080p，
     不是同一套东西，不许在代码里互相映射；
   - 项目里定的是默认值，单次生成能改，改了只影响那一次，不回写项目默认值；
   - 可选项一律由后端能力矩阵（capability-tiers）渲染：active 档的值可点，
     冻结档的值置灰并带原因；后端加一个档，前端不改代码就多一个选项；
   - 风格 = 一段描述 + 可选参考图，图片/视频各一套；参考图从项目资产或资产中心选，
     不另起一套上传（同一张图不在系统里存两份）；
   - 提示词模板图片/视频各一套，占位符由系统在生成时填入；不填走平台默认模板。

   纯逻辑、零 DOM，node:test 直接 import。
   ============================================================ */

import type { CapabilityTier, ProjectTierPreference } from "./capability-tiers";
import { tierDimensionValue, type GenerationDimensionKey } from "./generation-dimensions";

/* ---------- 类型与 wire ---------- */

/** 一套风格（图片或视频）：描述 + 参考图（媒体 id，来自资产）。 */
export interface ProjectStyleSet {
  description: string;
  referenceMediaIds: string[];
}

export interface ProjectGenerationConfig {
  /** 画幅（图片/视频同义，共用一个默认值）；null = 还没定。 */
  aspectRatio: string | null;
  /** 图片清晰度默认值（刻度 1K/2K）。 */
  imageResolution: string | null;
  /** 视频清晰度默认值（刻度 720p/1080p）。 */
  videoResolution: string | null;
  styleImage: ProjectStyleSet;
  styleVideo: ProjectStyleSet;
  promptTemplateImage: string;
  promptTemplateVideo: string;
}

/** 空配置（新项目/后端还没写过的行）：不是「默认值」，界面据此显示「还没定」。 */
export const EMPTY_PROJECT_CONFIG: ProjectGenerationConfig = {
  aspectRatio: null,
  imageResolution: null,
  videoResolution: null,
  styleImage: { description: "", referenceMediaIds: [] },
  styleVideo: { description: "", referenceMediaIds: [] },
  promptTemplateImage: "",
  promptTemplateVideo: "",
};

/** 产品默认值（project.md §2.1）：画幅竖屏 9:16、图片 1K、视频 720p。
    只在「值域里确实有这个值」时采用——值域由能力矩阵推导，见 pickDefault。 */
export const DEFAULT_ASPECT_RATIO = "9:16";
export const DEFAULT_IMAGE_RESOLUTION = "1K";
export const DEFAULT_VIDEO_RESOLUTION = "720p";

type Raw = Record<string, unknown>;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** 从项目详情行提取生成配置：后端把配置放在 generation_config 键下（嵌套结构）。
    缺字段 = 空配置，不伪造默认。 */
export function projectGenerationConfigFromUnknown(value: unknown): ProjectGenerationConfig {
  const r = (value ?? {}) as Raw;
  const gc = (r.generation_config ?? {}) as Raw;
  const image = (gc.image ?? {}) as Raw;
  const video = (gc.video ?? {}) as Raw;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  /* 平台默认模板后端也会回（带 prompt_template_source 标明），读进表单会被当成
     项目自配再写回去——「不填走平台默认」就被钉死成当时的快照，所以只认 project 自配。 */
  const template = (medium: Raw): string => (medium.prompt_template_source === "project" ? str(medium.prompt_template) : "");
  return {
    aspectRatio: str(gc.default_ratio) || null,
    imageResolution: str(gc.default_image_resolution) || null,
    videoResolution: str(gc.default_video_resolution) || null,
    styleImage: {
      description: str(image.style_description),
      referenceMediaIds: stringList(image.style_reference_media_ids),
    },
    styleVideo: {
      description: str(video.style_description),
      referenceMediaIds: stringList(video.style_reference_media_ids),
    },
    promptTemplateImage: template(image),
    promptTemplateVideo: template(video),
  };
}

/** 配置 → PATCH /projects/:id 的请求段：后端只认 generation_config 键下的嵌套结构
    （src/modules/production/routes.ts generationConfigSchema，strict，多一个字段整体拒绝）。 */
export function projectGenerationConfigToWire(config: ProjectGenerationConfig): Raw {
  /* null（还没定）只能缺键不能写 null——schema 是 enum/min(1) 不收 null；缺键时后端 merge 不动这项。 */
  /* 模板空串写成 null——后端以 null 标记「走平台默认」，写空串会变成项目自配的空模板。 */
  const template = (value: string): string | null => (value.trim() ? value : null);
  return {
    generation_config: {
      ...(config.aspectRatio !== null ? { default_ratio: config.aspectRatio } : {}),
      ...(config.imageResolution !== null ? { default_image_resolution: config.imageResolution } : {}),
      ...(config.videoResolution !== null ? { default_video_resolution: config.videoResolution } : {}),
      image: {
        style_description: config.styleImage.description,
        style_reference_media_ids: config.styleImage.referenceMediaIds,
        prompt_template: template(config.promptTemplateImage),
      },
      video: {
        style_description: config.styleVideo.description,
        style_reference_media_ids: config.styleVideo.referenceMediaIds,
        prompt_template: template(config.promptTemplateVideo),
      },
    },
  };
}

/* ---------- 选项推导（值域 = 能力矩阵实际数据，不写死） ---------- */

export interface ConfigOption {
  value: string;
  /** true = 有 active 档覆盖这个值，可点；false = 只有冻结档，置灰并给原因。 */
  available: boolean;
  /** 置灰原因（冻结档的 availability_reason，后端已给中文人话）。 */
  frozenReason: string | null;
}

/** 某媒介某维度（画幅/清晰度）的可选值：active 档的值可点，冻结档的值置灰带原因。
    同一取值既有 active 又有冻结档时按可点算；多个冻结档取第一条原因。 */
export function listConfigOptions(
  tiers: readonly CapabilityTier[],
  mediaType: "image" | "video",
  key: GenerationDimensionKey,
): ConfigOption[] {
  const byValue = new Map<string, ConfigOption>();
  for (const tier of tiers) {
    if (tier.media_type !== mediaType) continue;
    const raw = tierDimensionValue(tier, key);
    if (typeof raw !== "string" || !raw) continue;
    const active = tier.status === "active" && (tier.availability === undefined || tier.availability === "available");
    const reason = typeof tier.availability_reason === "string" && tier.availability_reason.trim() ? tier.availability_reason.trim() : null;
    const existing = byValue.get(raw);
    if (!existing) {
      byValue.set(raw, { value: raw, available: active, frozenReason: active ? null : reason });
    } else if (active && !existing.available) {
      byValue.set(raw, { value: raw, available: true, frozenReason: null });
    } else if (!existing.available && !existing.frozenReason && reason) {
      byValue.set(raw, { ...existing, frozenReason: reason });
    }
  }
  return [...byValue.values()];
}

/** 画幅的可选值 = 图片与视频两媒介值域的并集（画幅两边同义，裁决口径）。 */
export function listAspectRatioOptions(tiers: readonly CapabilityTier[]): ConfigOption[] {
  const merged = new Map<string, ConfigOption>();
  for (const option of [...listConfigOptions(tiers, "image", "aspect_ratio"), ...listConfigOptions(tiers, "video", "aspect_ratio")]) {
    const existing = merged.get(option.value);
    if (!existing || (option.available && !existing.available)) merged.set(option.value, option);
  }
  return [...merged.values()];
}

/** 默认值选取：产品默认在可选值域里就用它，否则用第一个可点值；全都不可点返回 null。 */
export function pickDefault(options: readonly ConfigOption[], preferred: string): string | null {
  const usable = options.filter((option) => option.available);
  if (usable.some((option) => option.value === preferred)) return preferred;
  return usable[0]?.value ?? null;
}

/** #172：项目设定 → 生成面板默认档偏好。清晰度图片/视频分开存（刻度不同），按媒介各取各的，不互相映射。 */
export function projectTierPreference(config: ProjectGenerationConfig, mediaType: "image" | "video"): ProjectTierPreference {
  return {
    aspectRatio: config.aspectRatio,
    resolution: mediaType === "image" ? config.imageResolution : config.videoResolution,
  };
}

/* ---------- 展示与判定 ---------- */

/** 画幅的人话标签：9:16=竖屏、16:9=横屏、1:1=方形；未知值原样显示（数据真源，不美化）。 */
export function aspectRatioLabel(value: string): string {
  if (value === "9:16") return "竖屏 9:16";
  if (value === "16:9") return "横屏 16:9";
  if (value === "1:1") return "方形 1:1";
  return value;
}

/** 这套风格配了没有：有描述或有参考图即算。 */
export function styleConfigured(set: ProjectStyleSet): boolean {
  return set.description.trim().length > 0 || set.referenceMediaIds.length > 0;
}

/** 项目默认出片摘要，如「竖屏 9:16 · 图片 1K · 视频 720p」；没定的项如实写「还没定」。 */
export function configSummary(config: ProjectGenerationConfig): string {
  const ratio = config.aspectRatio ? `画幅 ${config.aspectRatio}` : "画幅还没定";
  const image = config.imageResolution ? `图片 ${config.imageResolution}` : "图片清晰度还没定";
  const video = config.videoResolution ? `视频 ${config.videoResolution}` : "视频清晰度还没定";
  return `${ratio} · ${image} · ${video}`;
}

/** 生成面板「这次带了项目风格」的摘要：描述截断 + 参考图张数。 */
export function projectStyleSummary(set: ProjectStyleSet): string {
  const parts: string[] = [];
  const description = set.description.trim();
  if (description) parts.push(description.length > 24 ? `${description.slice(0, 24)}…` : description);
  if (set.referenceMediaIds.length > 0) parts.push(`${set.referenceMediaIds.length} 张参考图`);
  return parts.join(" + ");
}

/** 单次生成与项目默认的对照：一致 = 项目默认；不一致 = 这次改过（给痕迹，project.md §4.1）。 */
export function defaultTraceLabel(current: string | null, projectDefault: string | null): string {
  if (!current) return "";
  if (!projectDefault) return `${current} · 项目还没定默认`;
  return current === projectDefault ? `${current} · 项目默认` : `${current} · 这次改过，项目默认是 ${projectDefault}`;
}

/* ---------- 提示词模板 ---------- */

/** 占位符（project.md §4.3 至少四个）：花括号里的内容由系统在生成时填入。 */
export const PROMPT_TEMPLATE_PLACEHOLDERS = ["片段内容", "角色", "场景", "风格描述"] as const;

/** 点一下把占位符插到模板末尾（保持简单：追加，不猜光标）。 */
export function insertPlaceholder(template: string, placeholder: string): string {
  const token = `{${placeholder}}`;
  if (!template) return token;
  return template.endsWith("\n") || template.endsWith(" ") ? `${template}${token}` : `${template} ${token}`;
}
