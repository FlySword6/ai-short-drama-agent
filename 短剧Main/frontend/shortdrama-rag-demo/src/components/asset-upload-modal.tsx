import { CloudArrowUp, UploadSimple } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { formatFileSize } from "../asset-media";
import { isRecord } from "../generation-quotes";
import type { Asset, JsonRecord, MediaVersion } from "../types";
import { assetKindLabel } from "../ui";
import { businessErrorMessage } from "../error-copy";
import { ASSET_ROLES } from "../control-assets";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Field, Input, Switch } from "./ui/primitives";

/* ============================================================
   P2 资产域（板12 资产详情与弹窗群 / 板13 项目资产）
   纯函数集中在本文件，方便 src/p1-assets.test.ts 不经 CSS 直接覆盖
   （tsx --test 无法加载 .css，与 P1 batch-generate-drawer.tsx 先例一致）；
   组件部分只有上传弹窗，视图层 = Tailwind v4 + components/ui 原语（无 CSS 依赖）。
   ============================================================ */

/* ---------- 审核四态（板02 图例 → 板12 头部 pill / 板13 卡片 pill） ---------- */

export type AssetReviewStatus = "approved" | "pending" | "auto" | "rejected";

/**
 * 资产本体审核四态。后端 asset.status 写入口径为 pending_review / approved
 * （见 src/repositories/assetEntityRepository.ts），demo 与早期数据另有 ready/pending。
 * 未知值并入"待审核"，不虚构其他态（与资产审核域的统一映射同原则）。
 */
export function assetReviewStatus(status?: string | null): AssetReviewStatus {
  const value = (status ?? "").trim().toLowerCase();
  if (value === "approved" || value === "ready" || value === "passed") return "approved";
  if (value === "rejected" || value === "failed") return "rejected";
  if (value === "auto" || value === "auto_approved") return "auto";
  return "pending";
}

export function assetReviewLabel(status: AssetReviewStatus): string {
  if (status === "approved") return "已通过";
  if (status === "rejected") return "已拒绝";
  if (status === "auto") return "自动通过";
  return "待审核";
}

/** 板12 头部类型行：「角色 · 男主参考」= 类型 + metadata.category / 首个风格标签。 */
export function assetTypeLine(asset: Asset): string {
  const kind = assetKindLabel(asset.asset_kind);
  const meta = asset.metadata;
  const category = isRecord(meta) && typeof meta.category === "string" ? meta.category.trim() : "";
  const tag = category || asset.style_tags?.[0]?.trim() || "";
  return tag ? `${kind} · ${tag}` : kind;
}

/* ---------- 变体分组（板12 变体 chips + 视图网格） ---------- */

export interface AssetVariantGroup {
  /** 变体标识：asset_variant_id；空串 = 实体级媒体（默认造型）。 */
  id: string;
  name: string;
  versions: MediaVersion[];
  primary: MediaVersion | null;
}

export const DEFAULT_VARIANT_NAME = "默认造型";

/**
 * 版本列表 → 变体 chips。后端暂无 variants 列表端点（asset_variants 表无读取路由，
 * 缺口见交接），前端按 media.asset_variant_id 分组；变体名取组内 media metadata.variant_name，
 * 缺失回退「变体 N」，不虚构命名。实体级组固定「默认造型」排最前。
 */
export function groupAssetVersions(versions: MediaVersion[]): AssetVariantGroup[] {
  const groups: AssetVariantGroup[] = [];
  const byId = new Map<string, AssetVariantGroup>();
  for (const version of versions) {
    const key = version.asset_variant_id ?? "";
    let group = byId.get(key);
    if (!group) {
      group = { id: key, name: "", versions: [], primary: null };
      byId.set(key, group);
      groups.push(group);
    }
    group.versions.push(version);
  }
  let fallbackIndex = 0;
  for (const group of groups) {
    group.primary = group.versions.find((version) => version.is_primary) ?? group.versions[0] ?? null;
    if (!group.id) {
      group.name = DEFAULT_VARIANT_NAME;
      continue;
    }
    fallbackIndex += 1;
    group.name = group.versions.map(variantNameOf).find((name) => name) ?? `变体 ${fallbackIndex}`;
  }
  groups.sort((a, b) => (a.id === "" ? -1 : b.id === "" ? 1 : 0));
  return groups;
}

function variantNameOf(version: MediaVersion): string {
  const meta = version.metadata;
  if (!isRecord(meta)) return "";
  const value = meta.variant_name ?? meta.variantName;
  return typeof value === "string" ? value.trim() : "";
}

/** 视图标签（板12 视图网格）：metadata.view_angle > title > 视图 N。 */
export function viewLabelForVersion(version: MediaVersion, index: number): string {
  const meta = version.metadata;
  if (isRecord(meta)) {
    const value = meta.view_angle ?? meta.viewAngle;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return version.title?.trim() || `视图 ${index + 1}`;
}

/* ---------- 上传校验（板12 上传弹窗：.jpg/.png/.webp · 单张 ≤ 10MB） ---------- */

/** S11-5：与后端真口径统一（ASSET_MEDIA_MAX_FILE_BYTES=10MB，仓根 src/modules/assets/routes.ts:34）——
 *  原 20MB 口径会被后端实际拒收，「说了但做不到」；三处统一为 10MB。 */
export const ASSET_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const ASSET_UPLOAD_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";

const uploadExtensions = new Set(["jpg", "jpeg", "png", "webp"]);
const uploadContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

/** 只收 JPG/PNG/WebP 且 ≤ 10MB（与后端 ASSET_MEDIA_MAX_FILE_BYTES 真口径统一，S11-5）。 */
export function assetUploadValidationError(file: Pick<File, "name" | "size" | "type">): string {
  if (file.size <= 0) return "图片文件不能为空";
  if (file.size > ASSET_UPLOAD_MAX_BYTES) return "图片不能超过 10 MB";
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!uploadContentTypes.has(file.type.toLowerCase()) && !uploadExtensions.has(extension)) {
    return "只支持 JPG、PNG 或 WebP 图片";
  }
  return "";
}

/* ---------- 上传后审核说明（S17-A3：后端上传即 approved，假「待审」档已摘除） ---------- */

export type AssetUploadReview = "auto" | "pending";

/**
 * 上传后审核口径：后端上传即 approved: true（src/modules/assets/mediaUpload.ts:183），
 * 上传时选「待审」没有落库路径——S17 起 UI 不再提供该假档位（原为假选项+缺口文案，
 * 两头不真）。项目级「默认待审」策略（新建项目/项目设置的审核策略）不受影响。
 */
export function assetUploadReviewNote(): string {
  return "上传后即自动通过；项目级审核策略在项目设置里管。";
}

/* ---------- 引入-移出状态机（板13：引入 = project_reference，移出 = DELETE reference） ---------- */

export interface ProjectAssetListData {
  items: Asset[];
  count: number;
}

/** 引入：幂等追加；已在项目内的资产不重复添加（状态机：已引入 → 引入 = 无操作）。 */
export function projectAssetAddReducer(
  current: ProjectAssetListData | null,
  asset: Asset,
  input: { projectId: string; referenceId?: string; mediaId?: string },
): ProjectAssetListData {
  const items = current?.items ?? [];
  if (items.some((item) => item.id === asset.id)) return { items, count: current?.count ?? items.length };
  const next: Asset = { ...asset, scope: "project", project_id: input.projectId };
  if (input.referenceId) next.project_reference_id = input.referenceId;
  if (input.mediaId) next.selected_media_id = input.mediaId;
  return { items: [...items, next], count: (current?.count ?? items.length) + 1 };
}

/** 移出：只解除引用，不动资产本体；列表里不存在的项保持原样。 */
export function projectAssetRemoveReducer(
  current: ProjectAssetListData | null,
  assetId: string,
): ProjectAssetListData | null {
  if (!current) return current;
  if (!current.items.some((item) => item.id === assetId)) return current;
  return {
    items: current.items.filter((item) => item.id !== assetId),
    count: Math.max(0, current.count - 1),
  };
}

export interface IntroduceAction {
  introduced: boolean;
  busy: boolean;
  label: string;
  disabled: boolean;
}

/** 引入抽屉结果行的按钮态：引入 / 已引入 / 处理中。 */
export function introduceAction(assetId: string, introducedIds: Set<string>, busyId: string): IntroduceAction {
  const introduced = introducedIds.has(assetId);
  const busy = busyId === assetId;
  return {
    introduced,
    busy,
    label: busy ? "处理中" : introduced ? "已引入" : "引入",
    disabled: introduced || Boolean(busyId),
  };
}

/* ---------- 引用信息推导（板12 引用情况卡 / 板13 卡片引用行） ---------- */

export interface AssetReferenceBinding {
  projectId?: string;
  projectName: string;
  episodeNos: number[];
  /** null = 绑定于集但未读到分镜计数（板13「绑定于集」）。 */
  shotCount?: number | null;
}

/**
 * 引用约定：后端暂无"资产 → 项目/集/分镜"的引用统计端点（缺口见交接）。
 * 先读 metadata.reference_bindings: [{ project_id, project_name, episode_nos, shot_count }]`；
 * 读不到时卡片与明细卡如实显示"暂未引用/暂未读到引用记录"——不虚构引用数。
 * （use_count 展示已按 S10 裁决摘除：该字段数据死、后端无自增链路；
 *   自增链路排期由 Fable 另排，接通前一律不显示次数。）
 */
export function referenceBindingsFromMetadata(asset?: Asset | null): AssetReferenceBinding[] {
  const meta = asset?.metadata;
  if (!isRecord(meta)) return [];
  const raw = meta.reference_bindings ?? meta.referenceBindings;
  if (!Array.isArray(raw)) return [];
  const bindings: AssetReferenceBinding[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const projectName = typeof item.project_name === "string" ? item.project_name
      : typeof item.projectName === "string" ? item.projectName : "";
    if (!projectName) continue;
    const nosRaw = item.episode_nos ?? item.episodeNos;
    const episodeNos = Array.isArray(nosRaw)
      ? nosRaw.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      : [];
    const shotCountRaw = item.shot_count ?? item.shotCount;
    const projectId = typeof item.project_id === "string" ? item.project_id
      : typeof item.projectId === "string" ? item.projectId : undefined;
    bindings.push({
      projectId,
      projectName,
      episodeNos,
      shotCount: typeof shotCountRaw === "number" && Number.isFinite(shotCountRaw) ? shotCountRaw : null,
    });
  }
  return bindings;
}

export function formatEpisodeNos(nos: number[]): string {
  return nos.join("、");
}

/** 板13 卡片引用行：「第 1、2 集 · 6 镜引用」/「第 1 集 · 绑定于集」/「暂未引用」。 */
export function projectAssetReferenceLine(asset: Asset, projectId?: string): string {
  const bindings = referenceBindingsFromMetadata(asset);
  const scoped = projectId ? bindings.filter((binding) => !binding.projectId || binding.projectId === projectId) : bindings;
  const binding = scoped.find((item) => item.episodeNos.length > 0);
  if (binding) {
    const base = `第 ${formatEpisodeNos(binding.episodeNos)} 集`;
    return binding.shotCount != null ? `${base} · ${binding.shotCount} 镜引用` : `${base} · 绑定于集`;
  }
  // 裁决 1:use_count 数据死(无自增链路),「累计被引用 N 次」兜底摘除——无绑定即「暂未引用」
  return "暂未引用";
}

/** 板12 引用情况卡：逐项目一行；无分镜绑定的项目显示「未引用」。 */
export function assetReferenceLines(asset: Asset): Array<{ text: string; active: boolean }> {
  const bindings = referenceBindingsFromMetadata(asset);
  if (bindings.length === 0) {
    return [{ text: "暂未读到引用记录", active: false }];
  }
  return bindings.map((binding) => {
    if (binding.episodeNos.length === 0) return { text: `${binding.projectName}未引用`, active: false };
    const detail = binding.shotCount != null ? ` · ${binding.shotCount} 个分镜引用` : " · 绑定于集";
    return { text: `${binding.projectName}第 ${formatEpisodeNos(binding.episodeNos)} 集${detail}`, active: true };
  });
}

/* ---------- 描述 / image_prompt 读写约定（板12 三卡） ---------- */

/** image_prompt（生图用）：后端资产表无一等字段，按任务约定存 metadata.image_prompt。 */
export function assetImagePrompt(asset?: Asset | null): string {
  const meta = asset?.metadata;
  if (isRecord(meta) && typeof meta.image_prompt === "string") return meta.image_prompt;
  return asset?.visual_prompt ?? "";
}

/**
 * 组装 PATCH metadata：剥除 GET 序列化时合并进来的 primaryImage（非持久化字段，
 * 见后端 toAssetData），写入 image_prompt；空串表示清除。
 */
export function assetMetadataWithImagePrompt(metadata: JsonRecord | undefined, prompt: string): JsonRecord {
  const next: JsonRecord = {};
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (key === "primaryImage" || key === "primary_image" || key === "image_prompt") continue;
      next[key] = value;
    }
  }
  const trimmed = prompt.trim();
  if (trimmed) next.image_prompt = trimmed;
  return next;
}

/** 标签规整：去空白、去重、上限 50（与后端 updateAssetSchema 对齐）。 */
export function normalizeStyleTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const value = tag.trim();
    if (value && !seen.has(value)) seen.add(value);
    if (seen.size >= 50) break;
  }
  return [...seen];
}

/* ---------- 上传弹窗（板12：拖入或选择文件 / 设为该变体主图 / 上传后审核两档） ---------- */

export interface AssetUploadInput {
  file: File;
  title: string;
  setPrimary: boolean;
  review: AssetUploadReview;
  /** 控制职责六类单选（G1 强制；入库写入资产 role 字段）。 */
  role: string;
}

export function AssetUploadModal({ variantName, defaultPrimary, initialRole = "", demoMode, busy, onClose, onSubmit }: {
  variantName: string;
  defaultPrimary: boolean;
  /** 资产已有 role 时预填（变体补图沿用资产职责；G1）。 */
  initialRole?: string;
  demoMode: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: AssetUploadInput) => Promise<void>;
}): React.JSX.Element {
  const [role, setRole] = useState(initialRole);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [setPrimary, setSetPrimary] = useState(defaultPrimary);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function pickFile(next: File | null): void {
    setFile(next);
    if (!next) {
      setError("请选择一张图片");
      return;
    }
    setError(assetUploadValidationError(next));
    if (!title.trim()) setTitle(next.name.replace(/\.[^.]+$/, "").slice(0, 128));
  }

  async function submit(): Promise<void> {
    if (!role) {
      setError("请先选择资产职责（六类单选，入库必填）");
      return;
    }
    if (!file) {
      setError("请选择一张图片");
      return;
    }
    const fileError = assetUploadValidationError(file);
    if (fileError) {
      setError(fileError);
      return;
    }
    try {
      await onSubmit({ file, title: title.trim(), setPrimary, review: "auto", role });
    } catch (reason) {
      setError(businessErrorMessage(reason, "上传图片失败"));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent size="medium">
        <DialogHeader>
          <DialogTitle>{`上传图片 → 变体「${variantName}」`}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <button
            className={cn(
              "flex min-h-[132px] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center text-ink-2 transition-colors duration-150 ease-out-quart",
              dragOver ? "border-accent text-accent-text" : "border-border-2 hover:border-accent hover:text-accent-text",
            )}
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => { event.preventDefault(); setDragOver(false); pickFile(event.dataTransfer.files?.[0] ?? null); }}
          >
            <CloudArrowUp className="size-7" aria-hidden="true" />
            <strong className="text-sm text-ink-1">{file?.name || "拖入或选择文件"}</strong>
            <span className="text-xs">{file ? formatFileSize(file.size) : ".jpg / .png / .webp · 单张 ≤ 10MB"}</span>
          </button>
          <input
            className="sr-only"
            ref={inputRef}
            type="file"
            accept={ASSET_UPLOAD_ACCEPT}
            onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
          />
          <div className="flex flex-col gap-3">
            <Field label="图片名称（可选）">
              <Input value={title} maxLength={128} onChange={(event) => setTitle(event.target.value)} placeholder="例如：铠甲染血 · 特写" />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-xs font-medium text-ink-2">资产职责（六类单选，入库必填）</legend>
              <div className="grid grid-cols-2 gap-2">
                {ASSET_ROLES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={role === item.value}
                    className={cn(
                      "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors duration-150 ease-out-quart",
                      role === item.value
                        ? "border-accent bg-accent-subtle text-ink-1"
                        : "border-border-1 text-ink-2 hover:border-border-2 hover:text-ink-1",
                    )}
                    onClick={() => setRole(item.value)}
                  >
                    <strong className="text-sm">{item.label}</strong>
                    <span className="text-xs text-ink-4">{item.mediaHint}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="flex items-center justify-between gap-3 text-sm text-ink-2">
              <span>设为该变体主图</span>
              <Switch
                checked={setPrimary}
                label="设为该变体主图"
                onChange={() => setSetPrimary((current) => !current)}
              />
            </div>
            <p className="text-xs text-ink-3">{assetUploadReviewNote()}</p>
            {demoMode ? <div className="rounded-sm border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2">离线演示可以查看界面，但不会上传文件。</div> : null}
            {error ? <div className="rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</div> : null}
            <p className="text-xs text-ink-3">制片事后抽查，不挡任何人。</p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            icon={<UploadSimple />}
            loading={busy}
            disabled={!file || !role || Boolean(error) || demoMode}
            title={demoMode ? "离线演示不会上传文件" : undefined}
            onClick={() => void submit()}
          >上传 · 传完即可用</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
