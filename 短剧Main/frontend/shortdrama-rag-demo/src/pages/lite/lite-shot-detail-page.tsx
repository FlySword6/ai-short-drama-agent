/* ============================================================
   lite-shot-detail-page.tsx — Lite 分镜详情工作台（v1.5.1/v1.6/v1.6.8/v1.7）
   ============================================================
   路由：/lite/projects/:id/shots/:shotId（可选 ?ep=，集维度跟随），
   由 app.tsx 以 <LiteShotDetailPage {...runtime} projectId shotId/> 挂载。

   本页（设计真源 docs/design/prd-v2/lite-shots-page.md v1.5/v1.5.1，
   匹配合同真源 docs/design/prd-v2/lite-assets-page.md 问题八 8.8/8.9/八.10）：
   - 顶部条（2026-08-17 页头退役）：‹ 返回项目详情（固定回制作页，2026-08-18
     裁定不走历史返回）上壳单条（lite-shell）；页内只剩同集分镜页签——v1.5 反馈①：
     tab 文案改纯镜号数字（1/2/3…，当前集排序位），悬停显完整场记编码；
     集号由集选择器锚定、场景名保留在列表卡片。「已自动保存」指示 2026-08-18 退役。
   - v1.6（2026-08-18 用户反馈第七轮三问）：① 顶部同集分镜 tab 自适应——横向滚动
     兼容窄屏与多镜，切镜后当前 tab 自动滚进可视区；壳工作页 tab 字体收敛 text-sm；
     lite 用户隐藏「点击到完整版」切换入口（lite-shell；该单向门已被 2026-08-24 全员双向切换裁决取代）；② 已选资产列表固定高度
     （约三行资产卡）内部滚动，来源徽记收敛为「自动匹配」（去掉「一键生成本集」）；
     ③ 生成视频档本镜可选——模型/比例/清晰度三级级联（与资产生图弹窗 v1.4 七.3
     同口径），覆盖配置页默认档；参数行随所选档实时展示。
   - 左右等高工作台（B 视口固定分栏，§3.7）：外层
     flex-1 填满父 flex-col main，左 2 / 右 3。
   - 左栏 = 唯一滚动区：已选资产（reference_asset_snapshots 只读投影：
     缩略占位/名称/类型徽记 + 变体小字；auto 项可移除 → liteRemoveShotAutoRef
     抑制名单；manual 项去素材页删；加资产/换变体/换媒体全在素材页关联分镜
     表单完成——匹配方向单向：资产侧声明 → 分镜，8.8）+ 分镜内容
     （剧本原文可编辑 textarea 失焦保存 script_text + 场景输入框失焦匹配/建场
     后绑 scene_id + 时长）。v1.5 反馈⑤：镜头描述四字段/氛围/结构化对白
     编辑器退役——内容以剧本原文为唯一可编辑文本口径，结构化字段仍由
     「一键生成本集」拆解落库并喂提示词编译，详情不手动编辑。
   - 右栏 = 固定 + 滚动分层（flex flex-col 固定高）：
     播放器（v1.5 反馈⑥：高度有上限，object-contain 居中黑边，不随宽度无限
     放大）→ 视频版本条横向滚动（[vN] 点开版本详情、⋮ 直达版本编辑）
     → 视频提示词竖向滚动（[AI 生成] 草稿 / 锁定 / 参数行 / 生成视频按钮
     固定底部）——版本条与提示词同一视口恒可见。固定「回溯」行退役
     （2026-08-18：每版生成参数在版本详情弹窗内看，右栏不再常驻）。
   - 版本详情弹窗（§4.3.1）：播放器该版本 + 版本/生成/模型元信息 + 版本提示词
     （按 generation_request_id 回溯，〔展开〕）+ 设为当前版/下载/编辑这个版本。
   - 版本编辑弹窗（§4.3.2）：版本名/备注（setVersionLabel）+ 三选一
     ① 整条重新做（4a，复用生成链）② 只改某几秒（「片段编辑即将上线」）
     ③ 删掉这个版本（软删；当前版需先换别的当前版）。
   - 生成视频 = 付费动作：按钮文案「生成视频」（不带任务次数后缀，2026-08-19 裁定），
    一次点击一次任务
     （quote→confirm→create 三段式，supplement_prompt = 生效模板内容 + 本镜
     video_prompt；参考资产由服务端按 shot_id 的 reference_asset_snapshots
     自动解析（resolveControlReferences），前端不再手传 references——8.9），
     轮询跟踪、可离开本页恢复。2026-08-19：未保存配置不再拦生成——未配置按出厂默认
     执行（最便宜非预览 active 档，dev=seedance 2.0/720p/9:16，配置页同口径），
     有可提交档即可点，纯提示词即可（无参考图闸门）。
   - v1.6.8（2026-08-19 用户裁定）：**正式生成只能用 seedance，预览只能用快乐马**——
     视频档池硬切分（lite-generation 共享 formalVideoTiers / previewVideoTiers）：
     正式池 = active 非预览 + provider_label「火山方舟」（ark 视频模型即 seedance）；
     预览池 = active 视频 + params.preview=true（快乐马预览档，DB 标签=快乐马、
     DEMO 标签=阿里云百炼，均非火山方舟，双保险排除）。正式三级级联/默认档反查/
     提交兜底全在正式池内取值（旧策略即使指向快乐马也回落 seedance 兜底）。
     快乐马参考生视频硬约束 1–9 张参考图：无参考图禁用预览提交并给原因
     （撤销 v1.6.7 的「纯提示词即可预览」）。
   - v1.7（2026-08-19 用户裁定 快乐马参数化）：预览弹窗在快乐马能力内开放
     分辨率/画幅/时长三可调项（矩阵后端唯一真源 = v01Contract.ts VIDEO_CAPABILITIES
     快乐马条目，设计文档 §1.1：480p/720p/1080p、9 种画幅、3–15 整数秒；前端
     lite-generation 硬编码同款矩阵并注释指回后端）；时长默认取本镜分镜时长、
     越界收敛 3–15 并给提示；模型锁定快乐马单档（唯一预览模型）。预览提交
     startGeneration(forcedTier, true, overrides) 把覆盖值并入提交参数（preview /
     watermark 身份键保留在档参数 rest 里），后端 requireEffectiveProjectTier /
     requireCurrentTier 已接受快乐马预览档参数覆盖。预览提交不再走正式闸
     （generationGate 约束 seedance 正式档；预览可用性由预览档池 + 参考图闸决定，
     仅快乐马无 seedance 的配置下预览仍可提交，不被正式档缺失误拦）。
   - 版本空态（2026-08-18 收敛）：无视频 → 版本区只留标题与「暂无版本」徽记，
     不占位、不带生成按钮（生成入口在视频提示词区底部，唯一一处）。
     单版本 → 弹窗可开，删版本需先换当前版。
   - 预览视频（v1.7，2026-08-19 预览隔离·快乐马锁定 + 参数化）：正式生成按钮之前的
     次级入口「预览视频」（outline，免费开窗，常驻渲染——有快乐马预览档即可点）；弹窗 =
     预览版本（播放器 + 版本 chip，仅展示本镜预览台账命中的版本）+ 快乐马参数化档位
     （模型锁定只读；比例/清晰度下拉、时长输入 3–15，默认分镜时长收敛；估价按覆盖时长
     × 档单价重算）；播放器只播快乐马预览视频（previewVideos；无预览版给空态，不再回落
     主区正式版）；提示词与右栏当前稿一致、不可编辑；付费点击「生成预览」在
     窗内，走同一 quote→create 链、tier 强制快乐马预览档、任务带 preview 标记。提交后
     弹窗默认不关闭（2026-08-19），出片后新预览自动落入弹窗播放器，用户看完再手动关窗。
     主区 videos/版本条/版本详情排除预览版——预览身份双源：后端 metadata.preview=true
     （快乐马档 params.preview=true 落库，跨刷新/重进稳定；历史快乐马预览同源）∪ 本镜
     sessionStorage 预览台账命中的 generation_request_id（提交→出片窗口期的前端兜底）；
     previewVideos 只在弹窗展示。
   ============================================================ */
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  DotsThree,
  DownloadSimple,
  Eye,
  PencilLine,
  SquaresFour,
  Trash,
  VideoCamera,
} from "@phosphor-icons/react";
import {
  api,
  ApiClientError,
} from "../../api";
import type {
  Episode,
  GenerationDefaultStrategy,
  GenerationTask,
  MediaVersion,
  PromptTemplate,
  Scene,
  Shot,
  ShotAssetSnapshot,
  ShotLiteMetadata,
} from "../../types";
import { Button } from "../../components/ui/button";
import { Badge, EmptyState, ErrorState, Input, Select, Skeleton, Switch, Textarea } from "../../components/ui/primitives";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { LiteShotStoryboardDetailDialog } from "./lite-shot-storyboard-detail-dialog";
import { LiteShotAssetPickerDialog, pickerKey } from "./lite-shot-asset-picker-dialog";
import { useResource } from "../../ui";
import { humanErrorMessage } from "../batch-generate-drawer";
import type { PageRuntimeProps } from "../global-pages";
import { readCurrentEpisodeId, shotCode } from "./lite-shell";
import { DEMO_EPISODES, DEMO_PROJECT, DEMO_SCENES, DEMO_SHOT } from "./lite-demo-fixtures";
import { effectivePromptTemplate } from "../../lite-prompt-templates";
import { newId } from "../../uuid";
import { activeTiers, tierModelLabel, tierPriceLabel, tierSubmitInput, type CapabilityTier } from "../../capability-tiers";
import { mediaDownloadable } from "./lite-media-entries";
import { trackLiteEvent } from "./lite-telemetry";
import {
  ACTIVE_GENERATION_STATUSES,
  HAPPYHORSE_PREVIEW_DEFAULT_DURATION,
  HAPPYHORSE_PREVIEW_MAX_DURATION,
  HAPPYHORSE_PREVIEW_MIN_DURATION,
  HAPPYHORSE_PREVIEW_RATIOS,
  HAPPYHORSE_PREVIEW_RESOLUTIONS,
  LITE_REFERENCE_REJECT_MESSAGE,
  type LiteSubmissionInput,
  type TrackedLiteTask,
  cheapestActiveTier,
  clampPreviewDuration,
  forgetLiteGenMarker,
  formalVideoTiers,
  isLiteReferenceRejection,
  loadLiteKindConfig,
  pickLiteDefaultTier,
  pollDelayMs,
  previewEstimatePoints,
  previewVideoTiers,
  readLiteGenMarkers,
  readLitePreviewRequestIds,
  rememberLiteGenMarker,
  rememberLitePreviewRequest,
  resolveLiteTier,
  tierResolutionOf,
  videoMediaOf,
} from "./lite-generation";

const h = React.createElement;

/* ---------- v2 轮询节奏（计划 §5.2②；pollDelayMs 由 lite-generation 共享） ---------- */
const POLL_BASE_MS = 3000;
const POLL_TOTAL_CAP_MS = 30 * 60 * 1000;
const POLL_FAILURE_NOTICE_THRESHOLD = 5;

/* ============================================================
   纯函数与只读表（导出供 lite-shot-detail-page.test.ts 直接断言）
   ============================================================ */

/** 视频版本的 selection_source 读法：shotMedia wire 未做字段校验映射（normaliseList），
    v1.4 wire 上的 selection_source 能透传但 MediaVersion 类型未含——命名窄化读取，
    缺失时按 is_primary（手动）→ 无定稿则最新默认 回落。 */
export type ShotVideoSelectionSource = "manual" | "latest_default" | null;

/** shotMedia wire 条目上透传的 v1.4 字段（后端 toShotMedia 输出；类型未入 MediaVersion）。 */
interface ShotMediaVersionWire {
  selection_source?: "manual" | "latest_default" | null;
}

export function shotVideoSelectionSource(video: MediaVersion, all: readonly MediaVersion[]): ShotVideoSelectionSource {
  /* 命名窄化：MediaVersion 不含 selection_source，wire 字段经此读（见上注释）。 */
  const wire = video as MediaVersion & ShotMediaVersionWire;
  if (wire.selection_source === "manual" || wire.selection_source === "latest_default") return wire.selection_source;
  if (video.is_primary) return "manual";
  const sorted = [...all].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  const newest = sorted[sorted.length - 1] ?? null;
  return newest && newest.id === video.id ? "latest_default" : null;
}

/** 当前播放版本 = 手选定稿（is_primary）；无定稿则最新一版（latest_default）。 */
export function currentVideoOf(videos: readonly MediaVersion[]): MediaVersion | null {
  const primary = videos.find((video) => video.is_primary);
  if (primary) return primary;
  const sorted = [...videos].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  return sorted[sorted.length - 1] ?? null;
}

/* shotCode/sceneNameShort 随分镜切换 tab 迁入壳顶栏（v1.6 反馈①追加），本页从 lite-shell 复用。 */
export { shotCode };

/** 资产类型标签映射（v1.5 反馈②）：asset_kind → 中文徽记；未登记类型原样展示。
    与制作页「本集资产引用」条同一套映射（lite-workspace-page ASSET_KIND_LABELS），口径统一。 */
export const ASSET_KIND_LABELS: Record<string, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  costume: "服装",
  audio: "音频",
};

/** 快照行有效性过滤（pending/坏行剔除），不去重——弹窗种子与左栏展示共用的基础投影。 */
export function validSnapshots(snapshots: readonly ShotAssetSnapshot[] | null | undefined): ShotAssetSnapshot[] {
  if (!Array.isArray(snapshots)) return [];
  return snapshots.filter((snapshot) => {
    if (!snapshot || typeof snapshot !== "object") return false;
    if (!snapshot.asset_entity_id) return false;
    return snapshot.status !== "pending";
  });
}

/** 已选资产只读投影（v1.5.1，8.8；2026-08-19 用户裁定·三次修正）：**按资产变体 id 去重**——
    同一 (asset, variant) 的 auto/manual 重复引用只出一行（manual 优先）；资产级（variant null）
    与变体级是不同身份，各自成行，靠副行标签区分，绝不把用户没选过的变体顶成行的展示。
    另：同资产一旦有变体级行，**自动匹配的资产级（null）行是粗粒度兜底、冗余**，丢弃不展示
    （manual 资产级是用户显式选择，保留）——消除「同一资产一个自动匹配一个手动关联」两行。
    数组序 = 首见资产变体序。 */
export function displaySnapshots(snapshots: readonly ShotAssetSnapshot[] | null | undefined): ShotAssetSnapshot[] {
  const best = new Map<string, ShotAssetSnapshot>();
  for (const snapshot of validSnapshots(snapshots)) {
    const key = `${snapshot.asset_entity_id}::${snapshot.variant_id ?? "asset"}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, snapshot);
      continue;
    }
    if (snapshotPreference(prev, snapshot) === snapshot) {
      best.set(key, snapshot);
    }
  }
  /* 同资产有变体级行时，自动匹配的资产级行冗余（脚本粗匹配兜底），丢弃；manual 资产级保留。 */
  const hasVariantRow = new Set<string>();
  for (const snapshot of best.values()) {
    if (snapshot.variant_id) hasVariantRow.add(snapshot.asset_entity_id);
  }
  return [...best.values()].filter((snapshot) => {
    const isAutoAssetLevel = !snapshot.variant_id && (snapshot.matched_by ?? "") !== "manual";
    return !(isAutoAssetLevel && hasVariantRow.has(snapshot.asset_entity_id));
  });
}

/** 同 (asset, variant) 两条快照哪个更适合展示：manual（用户确认）优先，次按变体级。 */
function snapshotPreference(left: ShotAssetSnapshot, right: ShotAssetSnapshot): ShotAssetSnapshot {
  return snapshotScore(right) > snapshotScore(left) ? right : left;
}

function snapshotScore(snapshot: ShotAssetSnapshot): number {
  let score = (snapshot.matched_by ?? "") === "manual" ? 100 : 0;
  if (snapshot.variant_id) score += 10;
  return score;
}

/** AI 生成提示词的输入描述（2026-08-18 与拆分镜链同构：内容 = 左栏全部字段）：
    场景名 + 剧本原文 + 对白 + 动作 + 时长；已选资产单独走 selectedAssetIds 水合。
    v1.5 曾只吃剧本原文（唯一可编辑文本），2026-08-18 用户拍板统一内容范围。 */
export function buildPromptDescription(shot: Shot, sceneName: string | null): string {
  const parts: string[] = [];
  if (sceneName) parts.push(`场景：${sceneName}`);
  const scriptText = (shot.script_text ?? "").trim();
  if (scriptText) parts.push(`剧本原文：${scriptText}`);
  const dialogue = liteShotMeta(shot)?.dialogue_note?.trim();
  if (dialogue) parts.push(`对白：${dialogue}`);
  const action = shot.breakdown_elements?.action?.trim();
  if (action) parts.push(`动作：${action}`);
  if (shot.duration_seconds != null) parts.push(`时长：${shot.duration_seconds} 秒`);
  return parts.join("\n");
}

/** 后端 shots.metadata wire 形状（065 migration / production routes.ts）：
    嵌套命名空间 { lite: { shot: { atmosphere?, dialogue?, prompt_locked? } } }。 */
interface ShotMetadataWire {
  lite?: { shot?: ShotLiteMetadata | null } | null;
}

/** 读取分镜 metadata.lite.shot（v1.4 固定命名空间）。前端 Shot.metadata 类型为平铺投影，
    wire 是嵌套命名空间——按嵌套优先、平铺兜底读取，避免真栈 wire 上的字段被类型挡住。 */
export function liteShotMeta(shot: Shot | null | undefined): ShotLiteMetadata | undefined {
  const meta = shot?.metadata;
  if (!meta) return undefined;
  /* 命名窄化：meta 是平铺类型；wire 实为嵌套（见 ShotMetadataWire）。 */
  const wire = meta as unknown as ShotMetadataWire;
  const nested = wire.lite?.shot;
  if (nested && typeof nested === "object") return nested;
  return meta as ShotLiteMetadata;
}

/** PATCH shots.metadata 的 v1.4 长尾字段——按后端 zod 形状（routes.ts:98-110）构造
    { metadata: { lite: { shot: { … } } } }，再与 api.updateShot 的平铺类型做一次性窄断言
    （后端合并式 PATCH 只覆盖请求里出现的 lite.shot 键，保留其它命名空间）。 */
export function liteShotMetadataPatch(patch: ShotLiteMetadata): { metadata: ShotLiteMetadata } {
  /* 命名窄化：后端 zod 要求嵌套 lite.shot；前端类型平铺，调用点一次性断言。 */
  const wireBody: unknown = { metadata: { lite: { shot: patch } } };
  return wireBody as { metadata: ShotLiteMetadata };
}

/* ============================================================
   demo fixture（离线模式使用；不发起任何真实请求）
   项目/集/场景/分镜与壳顶栏共用 lite-demo-fixtures 同一份（v1.6 反馈①追加）；
   媒体/生成配置仅本页使用，留在此处。
   ============================================================ */

const DEMO_MEDIA: { items: MediaVersion[]; count: number } = {
  items: [
    {
      id: "demo-lite-video-1",
      media_kind: "video",
      version_no: 1,
      version_label: null,
      is_primary: false,
      storage_url: "https://storage.example/demo-video-1.mp4",
      duration_seconds: 4,
      created_at: "2026-08-10T08:30:00.000Z",
      persistence_status: "persisted",
    },
    {
      id: "demo-lite-video-2",
      media_kind: "video",
      version_no: 2,
      version_label: "雨夜版",
      is_primary: true,
      storage_url: "https://storage.example/demo-video-2.mp4",
      duration_seconds: 4,
      created_at: "2026-08-10T09:00:00.000Z",
      persistence_status: "persisted",
      generation_request_id: "demo-req-2",
    },
    {
      id: "demo-lite-video-3",
      media_kind: "video",
      version_no: 3,
      version_label: null,
      preview: true,
      is_primary: false,
      storage_url: "https://storage.example/demo-video-3-preview.mp4",
      duration_seconds: 5,
      created_at: "2026-08-10T10:00:00.000Z",
      persistence_status: "persisted",
      generation_request_id: "demo-req-3",
    },
  ],
  count: 3,
};

const DEMO_GEN_CONFIG: { tiers: CapabilityTier[]; strategy: GenerationDefaultStrategy; library: PromptTemplate[] } = {
  tiers: [
    {
      tier_id: "vid-seedance20fast-916-720p-4s",
      media_type: "video",
      display_name: "Seedance 2.0 Fast",
      provider_label: "火山方舟",
      model_label: "Seedance 2.0 Fast",
      is_default: true,
      availability: "available",
      params: { aspect_ratio: "9:16", resolution: "720p", duration_seconds: 4 },
      price: { unit: "per_second", points: 80 },
      status: "active",
    },
    {
      tier_id: "vid-happyhorse-preview-480p-5s",
      media_type: "video",
      display_name: "快乐马 · 预览",
      provider_label: "阿里云百炼",
      model_label: "HappyHorse 1.1",
      availability: "available",
      params: { aspect_ratio: "9:16", resolution: "480p", duration_seconds: 5, watermark: false, preview: true },
      price: { unit: "per_second", points: 8 },
      status: "active",
    },
  ],
  strategy: {
    id: "demo-lite-video-default",
    project_id: "demo-lite-project",
    media_kind: "video",
    mode: "material_to_prompt",
    model_key: "vid-seedance20fast-916-720p-4s",
    parameters: { resolution: "720p", ratio: "9:16", duration_seconds: 4, prompt_template_id: null },
    version: 1,
  },
  library: [
    {
      id: "tpl-video-1",
      project_id: "demo-lite-project",
      media_kind: "video",
      name: "默认视频模板",
      content: "示例视频提示词模板正文",
      created_by_user_id: "demo-user",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    },
  ],
};

const EMPTY_SCENES: { items: Scene[]; count: number } = { items: [], count: 0 };

/** 回溯：mediaId → 任务（loading/error 用哨兵值；undefined = 未拉取/不可回溯）。 */
type TracebackState = Record<string, GenerationTask | "loading" | "error" | undefined>;

/** 版本编辑弹窗的三选一：整条重新做 / 只改某几秒 / 删掉这个版本。 */
type VersionEditMode = "redo" | "trim" | "delete";

function formatDuration(seconds: number | null | undefined): string {
  return seconds == null ? "—" : `${seconds}s`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

/* ============================================================
   页面组件
   ============================================================ */

export function LiteShotDetailPage({
  demoMode,
  notify,
  projectId,
  shotId,
}: PageRuntimeProps & { projectId: string; shotId: string }): React.JSX.Element {
  /* ---------- 数据：项目/集 → 分镜 → 媒体/场景/生成配置（各自独立加载）。
     v1.5.1：已选资产不再单独拉 shot_asset_refs——随 shot 的
     reference_asset_snapshots 原样下发（toShot 透传），本页只读投影。 ---------- */
  const projectState = useResource(() => api.project(projectId), DEMO_PROJECT, demoMode, [projectId]);
  const episodeId = readCurrentEpisodeId() ?? projectState.data?.lite_episode_id ?? null;

  const episodeState = useResource(
    () => (episodeId ? api.episodes(projectId) : Promise.resolve({ items: [] as Episode[], count: 0 })),
    { items: DEMO_EPISODES, count: DEMO_EPISODES.length },
    demoMode,
    [projectId],
  );
  const episode = (episodeState.data?.items ?? []).find((item) => item.id === episodeId) ?? null;

  const shotState = useResource(() => api.shot(shotId), DEMO_SHOT, demoMode, [shotId]);
  const shot = shotState.data;

  const mediaState = useResource(() => api.shotMedia(shotId), DEMO_MEDIA, demoMode, [shotId]);
  const scenesState = useResource(
    () => (episodeId ? api.episodeScenes(episodeId) : Promise.resolve(EMPTY_SCENES)),
    { items: DEMO_SCENES, count: DEMO_SCENES.length },
    demoMode,
    [episodeId],
  );
  const genConfigState = useResource(() => loadLiteKindConfig(projectId, "video"), DEMO_GEN_CONFIG, demoMode, [projectId]);
  /* v1.6 反馈③：生视频档本镜可选——tierOverrideId = 用户级联选中的档 id（null = 跟配置页默认档）。 */
  const [tierOverrideId, setTierOverrideId] = useState<string | null>(null);

  const scene = (scenesState.data?.items ?? []).find((item) => item.id === shot?.scene_id) ?? null;
  /* 已选资产 = 快照只读投影（8.8 方向修正：匹配写入在资产侧，本页只读）。
     2026-08-19 用户裁定（二次修正）：按资产变体 id 去重——同 (asset, variant) 只出一行，
     资产级与变体级各自成行（副行标签区分）。 */
  const refs = useMemo(() => displaySnapshots(shot?.reference_asset_snapshots), [shot]);
  /* 弹窗种子必须用**全部**有效引用（不去重）：每个 (asset, variant) 独立勾选状态。
     不能复用 refs——资产级 + 变体级两条真实引用在展示层合并成一行，种子若跟着合并，
     弹窗里第二条引用会显示成未关联。 */
  const pickerRefs = useMemo(() => validSnapshots(shot?.reference_asset_snapshots), [shot]);
  /* 已关联本镜的 (asset, variant) 键集 → 弹窗内默认勾选（取消勾选 = 移除关联）。
     autoRefAssetKeys 为 exact_name 子集：取消走 liteRemoveShotAutoRef（快照删除 +
     抑制名单），其余 manual 项走资产侧 liteRemoveShotUsage。 */
  const linkedAssetKeys = useMemo(
    () => new Set(pickerRefs.map((r) => pickerKey(r.asset_entity_id, r.variant_id ?? null))),
    [pickerRefs],
  );
  const autoRefAssetKeys = useMemo(
    () => new Set(
      pickerRefs.filter((r) => (r.matched_by ?? null) !== "manual").map((r) => pickerKey(r.asset_entity_id, r.variant_id ?? null)),
    ),
    [pickerRefs],
  );
  /* 行内「移除」只给「该资产恰好一条 auto 引用且无 manual」的行——合并行（多条引用）
     删除语义有歧义，改走弹窗/素材页；manual 与无变体审计行维持原有提示。 */
  const autoRemovable = useMemo(() => {
    const groups = new Map<string, ShotAssetSnapshot[]>();
    for (const ref of validSnapshots(shot?.reference_asset_snapshots)) {
      const group = groups.get(ref.asset_entity_id) ?? [];
      group.push(ref);
      groups.set(ref.asset_entity_id, group);
    }
    const out = new Map<string, ShotAssetSnapshot>();
    for (const [assetId, group] of groups) {
      const hasManual = group.some((ref) => (ref.matched_by ?? "") === "manual");
      const autos = group.filter((ref) => (ref.matched_by ?? "") !== "manual");
      if (!hasManual && autos.length === 1 && autos[0]?.variant_id) {
        out.set(assetId, autos[0]!);
      }
    }
    return out;
  }, [shot]);

  /* 视频版本：全量按 created_at 升序；预览身份（backend metadata.preview=true 的历史快乐马
     预览，或本镜 sessionStorage 预览台账命中的 generation_request_id）从主区排除——
     videos/currentVideo/版本条只含正式版，previewVideos 只在预览弹窗展示（2026-08-19）。 */
  const allVideos = useMemo(
    () => [...videoMediaOf(mediaState.data ?? undefined)].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")),
    [mediaState.data],
  );
  const [previewRequestIds, setPreviewRequestIds] = useState<ReadonlySet<string>>(
    () => readLitePreviewRequestIds(window.sessionStorage, shotId),
  );
  useEffect(() => {
    setPreviewRequestIds(readLitePreviewRequestIds(window.sessionStorage, shotId));
  }, [shotId]);
  const videos = useMemo(
    () => allVideos.filter((video) => video.preview !== true && (!video.generation_request_id || !previewRequestIds.has(video.generation_request_id))),
    [allVideos, previewRequestIds],
  );
  const previewVideos = useMemo(
    () => allVideos.filter((video) => video.preview === true || (video.generation_request_id != null && previewRequestIds.has(video.generation_request_id))),
    [allVideos, previewRequestIds],
  );
  const currentVideo = useMemo(() => currentVideoOf(videos), [videos]);

  /* ---------- 稳定句柄（useResource 返回新对象，抽底层稳定函数进回调依赖） ---------- */
  const retryShot = shotState.retry;
  const setMediaData = mediaState.setData;

  /* ---------- 本地编辑草稿（仅按 shot.id 变化初始化，保存后不覆盖用户输入） ---------- */
  const [scriptTextDraft, setScriptTextDraft] = useState("");
  const [durationDraft, setDurationDraft] = useState("");
  const [dialogueDraft, setDialogueDraft] = useState("");
  const [actionDraft, setActionDraft] = useState("");
  const [videoPromptDraft, setVideoPromptDraft] = useState("");
  const [promptLocked, setPromptLocked] = useState(false);
  const [initializedShotId, setInitializedShotId] = useState<string | null>(null);
  /* P6 storyboard_detail 高级查看（§3.4.6 E）：skill 单次结构化拆镜全量；
     storyboard_detail 为 null（降级态/旧分镜）时入口隐藏。 */
  const [storyboardDetailOpen, setStoryboardDetailOpen] = useState(false);
  /** 匹配+选择资产弹窗（2026-08-18 弹窗优于跳转）。 */
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);

  useEffect(() => {
    if (!shot || initializedShotId === shot.id) return;
    setInitializedShotId(shot.id);
    setScriptTextDraft(shot.script_text ?? "");
    setDurationDraft(shot.duration_seconds != null ? String(shot.duration_seconds) : "");
    setDialogueDraft(liteShotMeta(shot)?.dialogue_note ?? "");
    setActionDraft(shot.breakdown_elements?.action ?? "");
    setVideoPromptDraft(shot.video_prompt ?? "");
    setPromptLocked(liteShotMeta(shot)?.prompt_locked === true);
  }, [shot, initializedShotId]);

  /* 播放器选择：默认跟随当前版；媒体刷新后若原选择已消失则回退到当前版。 */
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  useEffect(() => {
    if (!currentVideo) return;
    setSelectedVideoId((previous) => (previous && videos.some((video) => video.id === previous) ? previous : currentVideo.id));
  }, [currentVideo, videos]);
  const selectedVideo = videos.find((video) => video.id === selectedVideoId) ?? currentVideo ?? null;

  /* ---------- 生成任务与轮询 ---------- */
  const [videoTask, setVideoTask] = useState<TrackedLiteTask | null>(null);
  const [pollKick, setPollKick] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const videoTaskRef = useRef(videoTask);
  useEffect(() => { videoTaskRef.current = videoTask; }, [videoTask]);


  const refreshShotMedia = useCallback(async (): Promise<void> => {
    if (demoMode) return;
    try {
      const list = await api.shotMedia(shotId);
      setMediaData({ items: list.items, count: list.count });
    } catch (reason) {
      notify(humanErrorMessage(reason, "读取视频版本失败"), "error");
    }
  }, [demoMode, shotId, setMediaData, notify]);

  const settleVideoTask = useCallback((tracked: TrackedLiteTask, next: GenerationTask): void => {
    forgetLiteGenMarker(window.sessionStorage, shotId, "video");
    if (next.status === "succeeded") {
      notify(tracked.preview ? "预览视频已生成，在预览弹窗查看" : "视频已生成，可在上方播放器查看", "success");
      void refreshShotMedia();
    } else if (next.status === "failed") {
      /* 失败：展示人话原因；用户可重试（完整重走 estimate→submit、新幂等键）。 */
      notify(next.display_reason ?? "视频生成失败，请重试", "error");
    }
  }, [shotId, notify, refreshShotMedia]);

  const handleTaskGone = useCallback((): void => {
    forgetLiteGenMarker(window.sessionStorage, shotId, "video");
    setVideoTask(null);
  }, [shotId]);

  const isPollingTarget = useCallback((tracked: TrackedLiteTask): boolean => {
    return ACTIVE_GENERATION_STATUSES.includes(tracked.task.status) && !tracked.timedOut;
  }, []);

  /* 轮询 effect：3s 起始、指数退避（pollDelayMs 共享）、30 分钟总上限、标签页隐藏暂停、
     卸载清理；kick（新任务/手动刷新）变化时重新布防。 */
  useEffect(() => {
    if (demoMode) return;
    let active = true;
    let timer = 0;
    const schedule = (ms: number): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(), Math.max(250, ms));
    };
    const tick = async (): Promise<void> => {
      if (!active) return;
      const tracked = videoTaskRef.current;
      if (!tracked || !isPollingTarget(tracked)) return;
      if (document.hidden) {
        schedule(POLL_BASE_MS);
        return;
      }
      if (Date.now() - tracked.firstPollAt > POLL_TOTAL_CAP_MS) {
        setVideoTask((previous) => (previous ? { ...previous, timedOut: true } : previous));
        return;
      }
      try {
        const next = await api.generation(tracked.requestId);
        if (!active) return;
        const terminal = !ACTIVE_GENERATION_STATUSES.includes(next.status);
        setVideoTask((previous) => {
          if (!previous) return previous;
          if (terminal) return null;
          return {
            ...previous,
            task: next,
            pollCount: previous.pollCount + 1,
            pollFailures: 0,
            nextPollAt: Date.now() + pollDelayMs(previous.pollCount + 1),
          };
        });
        if (terminal) settleVideoTask(tracked, next);
      } catch (reason) {
        if (!active) return;
        if (reason instanceof ApiClientError && (reason.status === 403 || reason.status === 404)) {
          handleTaskGone();
          return;
        }
        setVideoTask((previous) => (previous
          ? { ...previous, pollFailures: previous.pollFailures + 1, nextPollAt: Date.now() + pollDelayMs(previous.pollCount + 1) }
          : previous));
      }
      const remaining = videoTaskRef.current;
      if (active && remaining && isPollingTarget(remaining)) {
        schedule(Math.max(0, remaining.nextPollAt - Date.now()));
      }
    };
    const onVisibility = (): void => {
      const tracked = videoTaskRef.current;
      if (!document.hidden && tracked && isPollingTarget(tracked)) schedule(0);
    };
    if (videoTaskRef.current && isPollingTarget(videoTaskRef.current)) schedule(0);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, pollKick, shotId, isPollingTarget, settleVideoTask, handleTaskGone]);

  /* 挂载恢复：sessionStorage 台账里本镜的视频任务若仍在进行中则恢复轮询。 */
  useEffect(() => {
    if (demoMode) return;
    let cancelled = false;
    void (async () => {
      const marker = readLiteGenMarkers(window.sessionStorage).find((entry) => entry.shotId === shotId && entry.kind === "video");
      if (!marker?.marker.requestId) return;
      try {
        const task = await api.generation(marker.marker.requestId);
        if (cancelled) return;
        if (ACTIVE_GENERATION_STATUSES.includes(task.status)) {
          const now = Date.now();
          setVideoTask({
            requestId: task.generation_request_id,
            shotId,
            kind: "video",
            task,
            firstPollAt: now,
            pollCount: 0,
            pollFailures: 0,
            nextPollAt: now + POLL_BASE_MS,
            timedOut: false,
          });
          setPollKick((value) => value + 1);
        } else {
          forgetLiteGenMarker(window.sessionStorage, shotId, "video");
        }
      } catch (reason) {
        if (reason instanceof ApiClientError && (reason.status === 403 || reason.status === 404)) {
          forgetLiteGenMarker(window.sessionStorage, shotId, "video");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [demoMode, shotId]);

  /* ---------- 分镜内容保存（updateShot → 本地刷新，不整页 reload） ---------- */
  const patchShot = useCallback(async (patch: Parameters<typeof api.updateShot>[1]): Promise<void> => {
    if (demoMode) {
      notify("离线演示不会写入", "info");
      return;
    }
    await api.updateShot(shotId, patch);
    if (episodeId) {
      trackLiteEvent({ event: "lite_shot_mutated", projectId, episodeId, shotId, action: "updated" });
    }
    retryShot();
  }, [demoMode, episodeId, projectId, shotId, retryShot, notify]);

  /* 剧本原文可编辑（v1.5 反馈③）：失焦保存 script_text，与 video_prompt 同一条路径。 */
  const saveScriptText = useCallback((): void => {
    const trimmed = scriptTextDraft.trim();
    if (trimmed === ((shot?.script_text ?? "")).trim()) return;
    void patchShot({ script_text: trimmed || null }).catch((reason) => {
      notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
    });
  }, [scriptTextDraft, shot, patchShot, notify]);

  const saveDuration = useCallback((): void => {
    const trimmed = durationDraft.trim();
    let next: number | null = null;
    if (trimmed) {
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 600) {
        notify("时长需为 1-600 秒的整数", "error");
        return;
      }
      next = parsed;
    }
    if (next === shot?.duration_seconds) return;
    void patchShot({ duration_seconds: next }).catch((reason) => {
      notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
    });
  }, [durationDraft, shot, patchShot, notify]);

  /* 对白/动作（2026-08-18 v1.7 反馈：与场景/时长同组的两个输入框）：
     对白 → metadata.lite.shot.dialogue_note（jsonb 命名空间，065 合同）；
     动作 → breakdown_elements.action（列已有、编译器已消费；PATCH 整对象
     回写，spread 保留 subject/visual/camera_language 不被清空）。 */
  const saveDialogue = useCallback((): void => {
    const trimmed = dialogueDraft.trim();
    if (trimmed === ((liteShotMeta(shot)?.dialogue_note ?? "")).trim()) return;
    void patchShot(liteShotMetadataPatch({ dialogue_note: trimmed || null })).catch((reason) => {
      notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
    });
  }, [dialogueDraft, shot, patchShot, notify]);

  const saveAction = useCallback((): void => {
    const trimmed = actionDraft.trim();
    if (trimmed === ((shot?.breakdown_elements?.action ?? "")).trim()) return;
    void patchShot({ breakdown_elements: { ...(shot?.breakdown_elements ?? { subject: null, action: null, visual: null, camera_language: null }), action: trimmed || null } }).catch((reason) => {
      notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
    });
  }, [actionDraft, shot, patchShot, notify]);

  /* 场景输入框（v1.5 反馈④）：失焦保存——空 → scene_id=null；与当前场景同名 → 不动；
     否则本集场景按名精确匹配命中绑 scene_id，未命中 POST /episodes/:eid/scenes
     建一场（scene_no = 本集现有场数+1）再绑。仍走 scene_id FK，不另造字段。 */
  const saveSceneInput = useCallback((rawName: string): void => {
    if (demoMode) {
      notify("离线演示不会写入", "info");
      return;
    }
    const name = rawName.trim();
    const currentName = (scene?.name ?? "").trim();
    if (!name) {
      if (shot?.scene_id == null) return;
      void patchShot({ scene_id: null }).catch((reason) => {
        notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
      });
      return;
    }
    if (name === currentName) return;
    const scenes = scenesState.data?.items ?? [];
    const matched = scenes.find((item) => item.name.trim() === name);
    if (matched) {
      if (matched.id === shot?.scene_id) return;
      void patchShot({ scene_id: matched.id }).catch((reason) => {
        notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
      });
      return;
    }
    if (!episodeId) {
      notify("当前集未知，无法保存场景", "error");
      return;
    }
    const nextSceneNo = scenes.length + 1;
    void (async () => {
      try {
        const created = await api.createScene(episodeId, { scene_no: nextSceneNo, name });
        await api.updateShot(shotId, { scene_id: created.id });
        notify(`已新建场景「${name}」并绑定`, "success");
        retryShot();
      } catch (reason) {
        notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
      }
    })();
  }, [demoMode, scene, shot, scenesState.data, episodeId, shotId, patchShot, retryShot, notify]);

  const saveVideoPrompt = useCallback((): void => {
    const trimmed = videoPromptDraft.trim();
    if (trimmed === (shot?.video_prompt ?? "")) return;
    void patchShot({ video_prompt: trimmed || null }).catch((reason) => {
      notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
    });
  }, [videoPromptDraft, shot, patchShot, notify]);

  const togglePromptLocked = useCallback((): void => {
    const next = !promptLocked;
    setPromptLocked(next);
    void patchShot(liteShotMetadataPatch({ prompt_locked: next })).catch((reason) => {
      setPromptLocked(!next);
      notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
    });
  }, [promptLocked, patchShot, notify]);

  /* ---------- 已选资产：只读投影 + 两个轻量出口（v1.5.1，决策 4） ----------
     移除 auto（exact_name）项 = liteRemoveShotAutoRef（快照删除 + removedAutoRefs
     抑制名单，backfill 重跑不复活）；manual 项须去素材页删（删除对称，8.8 规则 5）；
     加资产/换变体/换媒体在素材页关联分镜表单完成——写入权在资产侧。 */
  const removeSnapshot = useCallback((snapshot: ShotAssetSnapshot): void => {
    if (snapshot.matched_by === "manual") {
      notify("手动关联请在素材页删除（资产侧声明的删除对称）", "info");
      return;
    }
    if (!snapshot.variant_id) {
      notify("这条是拆解审计快照（无变体），不影响生成，无需移除", "info");
      return;
    }
    if (demoMode) {
      notify("离线演示不会写入", "info");
      return;
    }
    const variantId = snapshot.variant_id;
    void (async () => {
      try {
        await api.liteRemoveShotAutoRef(projectId, shotId, snapshot.asset_entity_id, variantId);
        retryShot();
        notify(`已移除「${snapshot.name || "未命名资产"}」，重新一键生成不会再加回`, "success");
      } catch (reason) {
        notify(humanErrorMessage(reason, "移除失败，请重试"), "error");
      }
    })();
  }, [demoMode, projectId, shotId, retryShot, notify]);

  /* ---------- 视频版本动作 ---------- */
  const setCurrentVideo = useCallback((video: MediaVersion): void => {
    if (demoMode) {
      notify("离线演示不会写入", "info");
      return;
    }
    void (async () => {
      try {
        await api.setShotPrimary(shotId, video.id);
        if (episodeId) {
          trackLiteEvent({
            event: "lite_media_selected",
            projectId,
            episodeId,
            shotId,
            mediaId: video.id,
            mediaKind: "video",
            approvedInAction: false,
          });
        }
        void refreshShotMedia();
        notify(`已把 v${video.version_no ?? ""} 设为当前版`, "success");
      } catch (reason) {
        notify(humanErrorMessage(reason, "设置失败，请重试"), "error");
      }
    })();
  }, [demoMode, episodeId, projectId, shotId, refreshShotMedia, notify]);

  const downloadVideo = useCallback((video: MediaVersion): void => {
    if (demoMode) {
      notify("离线演示不会写入", "info");
      return;
    }
    void api.downloadMedia(video.id).catch((reason) => {
      notify(humanErrorMessage(reason, "下载失败，请重试"), "error");
    });
  }, [demoMode, notify]);

  /* 版本详情/编辑弹窗（§4.3.1/§4.3.2）：版本 = 可点开的实体。 */
  const [detailVideoId, setDetailVideoId] = useState<string | null>(null);
  const [detailTracebackExpanded, setDetailTracebackExpanded] = useState(false);
  const [editVideoId, setEditVideoId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<VersionEditMode>("redo");
  const [labelDraft, setLabelDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [trimComingSoon, setTrimComingSoon] = useState(false);
  const [deleteGuardTarget, setDeleteGuardTarget] = useState("");
  const [savingLabelNote, setSavingLabelNote] = useState(false);
  const [deletingVersion, setDeletingVersion] = useState(false);

  const detailVideo = videos.find((video) => video.id === detailVideoId) ?? null;
  const editVideo = videos.find((video) => video.id === editVideoId) ?? null;

  const openVersionDetail = useCallback((video: MediaVersion): void => {
    setDetailVideoId(video.id);
    setDetailTracebackExpanded(false);
  }, []);

  const openVersionEdit = useCallback((video: MediaVersion): void => {
    setDetailVideoId(null);
    setEditVideoId(video.id);
    setLabelDraft(video.version_label ?? "");
    setNoteDraft(video.version_note ?? "");
    setEditMode("redo");
    setTrimComingSoon(false);
    setDeleteGuardTarget("");
  }, []);

  /* 回溯：按 generation_request_id 拉任务，展示 prompt/时间（模型/参数取自档位配置）。 */
  const [tracebackMap, setTracebackMap] = useState<TracebackState>({});
  useEffect(() => {
    if (!detailVideoId) return;
    const video = videos.find((item) => item.id === detailVideoId);
    if (!video || !video.generation_request_id) return;
    let cancelled = false;
    if (demoMode) {
      /* 离线 fixture：不发起真实请求，版本提示词区就地说明。 */
      setTracebackMap((previous) => ({ ...previous, [video.id]: undefined }));
      return;
    }
    setTracebackMap((previous) => ({ ...previous, [video.id]: "loading" }));
    void api.generation(video.generation_request_id).then((task) => {
      if (!cancelled) setTracebackMap((previous) => ({ ...previous, [video.id]: task }));
    }).catch(() => {
      if (!cancelled) setTracebackMap((previous) => ({ ...previous, [video.id]: "error" }));
    });
    return () => { cancelled = true; };
  }, [detailVideoId, demoMode, videos]);

  /* 版本名/备注保存（setVersionLabel 一次写 label + note）。 */
  const saveVersionLabelNote = useCallback((video: MediaVersion): void => {
    if (demoMode) {
      notify("离线演示不会写入", "info");
      return;
    }
    const label = labelDraft.trim() || null;
    const note = noteDraft.trim() || null;
    if (label === (video.version_label ?? null) && note === (video.version_note ?? null)) return;
    setSavingLabelNote(true);
    void api.setVersionLabel(shotId, video.id, label, note).then(() => {
      void refreshShotMedia();
      notify("已保存版本名称/备注", "success");
    }).catch((reason) => {
      notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
    }).finally(() => {
      setSavingLabelNote(false);
    });
  }, [demoMode, shotId, labelDraft, noteDraft, refreshShotMedia, notify]);

  /* 删掉这个版本：软删（deleteShotMedia），本地列表随媒体刷新移除；当前版先换。 */
  const deleteVersion = useCallback((video: MediaVersion): void => {
    if (demoMode) {
      notify("离线演示不会写入", "info");
      return;
    }
    if (currentVideo?.id === video.id) {
      notify("当前版需先换成别的版本才能删除", "error");
      return;
    }
    setDeletingVersion(true);
    void (async () => {
      try {
        await api.deleteShotMedia(shotId, video.id);
        setEditVideoId(null);
        setDetailVideoId(null);
        void refreshShotMedia();
        notify(`已删除 v${video.version_no ?? ""}`, "success");
      } catch (reason) {
        notify(humanErrorMessage(reason, "删除失败，请重试"), "error");
      } finally {
        setDeletingVersion(false);
      }
    })();
  }, [demoMode, shotId, currentVideo, refreshShotMedia, notify]);

  /* 删当前版前的换版：选另一个版本设为当前版，媒体刷新后该版不再当前。 */
  const guardTargetVideo = videos.find((video) => video.id === deleteGuardTarget) ?? null;
  const swapCurrentForDelete = useCallback((): void => {
    if (!guardTargetVideo) return;
    if (demoMode) {
      notify("离线演示不会写入", "info");
      return;
    }
    setCurrentVideo(guardTargetVideo);
    setDeleteGuardTarget("");
  }, [guardTargetVideo, demoMode, setCurrentVideo]);

  /* ---------- 返回项目详情：2026-08-17 起按钮上壳单条（lite-shell shellDetailBack，
     2026-08-18 起分镜详情固定回制作页，不走历史返回），本页不再自带返回控件 ---------- */

  /* ---------- 视频提示词 AI 草稿（一次点击只生成一次；草稿不自动保存） ----------
     2026-08-18 与拆分镜链同构：内容 = 左栏全字段（buildPromptDescription），
     技能 = P6 §八 成文规范（服务端 video system prompt）；资产上下文带快照
     实体 id（prompt-draft 侧水合真实资产档案）。 */
  const [draftingPrompt, setDraftingPrompt] = useState(false);
  const generatePromptDraft = useCallback((): void => {
    if (draftingPrompt) return;
    if (demoMode) {
      notify("离线演示不会发起真实生成", "info");
      return;
    }
    if (!shot) return;
    setDraftingPrompt(true);
    const description = buildPromptDescription(shot, scene?.name ?? null);
    const selectedAssetIds = [...new Set(refs.map((snapshot) => snapshot.asset_entity_id))].slice(0, 12);
    void api.draftPrompt({ mediaKind: "video", description, selectedAssetIds, projectId }).then((draft) => {
      setVideoPromptDraft(draft.promptText);
      notify("草稿已生成，可继续编辑后保存", "success");
    }).catch((reason) => {
      notify(humanErrorMessage(reason, "提示词生成失败，请重试"), "error");
    }).finally(() => {
      setDraftingPrompt(false);
    });
  }, [draftingPrompt, demoMode, shot, scene, refs, projectId, notify]);

  /* ---------- 生成视频（quote→confirm→create 三段式，一次点击一次提交） ----------
     v1.5.1：参考资产不再手传——服务端按 shot_id 读 reference_asset_snapshots
     自动解析各变体主图并入参考清单（resolveControlReferences，合同 8.9）。 */
  /* 弹窗内预览版本选择（2026-08-19：预览版只在弹窗展示）；提交新预览时复位 → 出片默认看最新版。
     声明在 startGeneration 之前：其 deps 数组引用 setSelectedPreviewVideoId（TDZ 守卫）。 */
  const [selectedPreviewVideoId, setSelectedPreviewVideoId] = useState<string | null>(null);
  const generationGate = useCallback((): string => {
    const config = genConfigState.data;
    if (!config) return genConfigState.loading ? "视频生成配置读取中，请稍候" : "视频生成配置读取失败，请稍后重试";
    /* 2026-08-19：不再要求已保存策略——未配置按出厂默认执行（最便宜非预览 active 档，
       dev=seedance 2.0/720p/9:16，配置页同口径），只要存在可提交档即可点，纯提示词即可。
       v1.6.8：正式生成只用 seedance——视频档池=火山方舟非预览档，快乐马预览档不进闸。 */
    const videoTiers = formalVideoTiers(config.tiers);
    if (!pickLiteDefaultTier(videoTiers, config.strategy ?? null)) {
      return "当前没有可用的视频生成档位，请联系管理员配置";
    }
    if (videoTask && isPollingTarget(videoTask)) return "本镜有视频生成任务进行中，完成后再发新任务";
    return "";
  }, [genConfigState, videoTask, isPollingTarget]);

  const startGeneration = useCallback((forcedTier: CapabilityTier | null = null, preview = false, overrides: { resolution?: string; ratio?: string; durationSeconds?: number } = {}): void => {
    if (demoMode) {
      notify("离线演示不会发起真实生成", "info");
      return;
    }
    if (submitting || !shot) return;
    /* v1.7：预览提交不走正式闸（generationGate 约束 seedance 正式档）——预览可用性由
       预览档池 + 参考图闸决定（renderPreviewDialog 已给原因并禁用），仅快乐马无
       seedance 的配置下预览仍可提交，不被正式档缺失误拦。 */
    if (!preview) {
      const gate = generationGate();
      if (gate !== "") {
        notify(gate, "error");
        return;
      }
    }
    const config = genConfigState.data;
    const strategy = config?.strategy ?? null;
    if (!config) return;
    /* v1.6 反馈③：提交档 = 用户覆盖档 → 配置页默认档反查 → 最便宜 active 档兜底；
       2026-08-19：未配置（strategy null）直接回落最便宜非预览 active 档（出厂默认）。
       v1.6.8：三段解析全部约束在正式池（formalVideoTiers）内——旧策略若指向快乐马预览档
       也被排斥，回落 seedance 兜底，正式生成绝不落到非 seedance 档。 */
    const videoTiers = formalVideoTiers(config.tiers);
    const override = videoTiers.find((tier) => tier.tier_id === tierOverrideId);
    /* 预览弹窗提交强制所选档（快乐马预览档），不吃本镜覆盖/默认反查。 */
    const byStrategy = strategy ? resolveLiteTier(config.tiers, "video", strategy) : null;
    const resolved = byStrategy && videoTiers.some((tier) => tier.tier_id === byStrategy.tier_id) ? byStrategy : null;
    const tier = forcedTier ?? override ?? resolved ?? cheapestActiveTier(videoTiers);
    if (!tier) return;
    const templateContent = effectivePromptTemplate(strategy, config.library, "video").content;
    const shotPrompt = (shot.video_prompt ?? "").trim();
    const supplement = [templateContent, shotPrompt].filter(Boolean).join("\n");
    const { parameters, quantity } = tierSubmitInput(tier);
    /* v1.7 预览参数化：覆盖值并入提交参数（preview/watermark 身份键保留在档参数 rest 里，
       后端 requireEffectiveProjectTier / requireCurrentTier 已接受快乐马预览档参数覆盖）。 */
    const mergedParameters = preview && (overrides.resolution !== undefined || overrides.ratio !== undefined || overrides.durationSeconds !== undefined)
      ? {
          ...parameters,
          ...(overrides.resolution !== undefined ? { resolution: overrides.resolution } : {}),
          ...(overrides.ratio !== undefined ? { ratio: overrides.ratio } : {}),
          ...(overrides.durationSeconds !== undefined ? { duration_seconds: overrides.durationSeconds } : {}),
        }
      : parameters;
    const key = newId();
    const input: LiteSubmissionInput = {
      media_kind: "video",
      tier_id: tier.tier_id,
      project_id: projectId,
      shot_id: shot.id,
      parameters: mergedParameters,
      quantity,
      client_idempotency_key: key,
      ...(supplement ? { supplement_prompt: supplement } : {}),
    };
    /* 幂等键提交前落 sessionStorage（计划 §5.2③）；按钮点击即禁用至 submit 返回。
       LiteSubmissionInput 是两段式子集；quote/create 只做 JSON 透传，调用点一次性窄断言
       （与 lite-shots-page 同口径，见 LiteSubmissionInput 注释）。 */
    const submitBody = input as unknown as Parameters<typeof api.quoteGeneration>[0];
    rememberLiteGenMarker(window.sessionStorage, shot.id, "video", { key });
    setSubmitting(true);
    void (async () => {
      try {
        const quote = await api.quoteGeneration(submitBody);
        // v1.9 十.7:Lite 自动确认并入 submit,不再单独调 confirm
        const task = await api.createGeneration(submitBody, quote.generation_quote_id, true);
        if (episodeId) {
          trackLiteEvent({
            event: "lite_generation_submitted",
            projectId,
            episodeId,
            shotId: shot.id,
            requestId: task.generation_request_id,
            mediaKind: "video",
            preview,
          });
        }
        rememberLiteGenMarker(window.sessionStorage, shot.id, "video", { key, requestId: task.generation_request_id });
        /* 2026-08-19：预览提交 → 请求 id 入本镜预览台账（sessionStorage）并复位弹窗选择，
           新预览出片后自动落入弹窗播放器（主区 videos 排除预览版）。 */
        if (preview) {
          rememberLitePreviewRequest(window.sessionStorage, shot.id, task.generation_request_id);
          setPreviewRequestIds((previous) => (previous.has(task.generation_request_id) ? previous : new Set([...previous, task.generation_request_id])));
          setSelectedPreviewVideoId(null);
        }
        const now = Date.now();
        setVideoTask({
          requestId: task.generation_request_id,
          shotId: shot.id,
          kind: "video",
          preview: preview || undefined,
          task,
          firstPollAt: now,
          pollCount: 0,
          pollFailures: 0,
          nextPollAt: now + POLL_BASE_MS,
          timedOut: false,
        });
        setPollKick((value) => value + 1);
        notify(preview ? "预览视频任务已提交" : "视频生成任务已提交", "success");
      } catch (reason) {
        forgetLiteGenMarker(window.sessionStorage, shot.id, "video");
        notify(isLiteReferenceRejection(reason) ? LITE_REFERENCE_REJECT_MESSAGE : humanErrorMessage(reason, "提交失败，请重试"), "error");
      } finally {
        setSubmitting(false);
      }
    })();
  }, [submitting, shot, generationGate, genConfigState, tierOverrideId, projectId, episodeId, notify, setPreviewRequestIds, setSelectedPreviewVideoId]);

  /* ---------- 生成档三级级联（v1.6 反馈③：模型 → 比例 → 清晰度；与资产生图弹窗
     v1.4 七.3 决策 2 同口径——维度取值全部从 active 档推导，不硬编码） ---------- */
  const [previewOpen, setPreviewOpen] = useState(false);
  /* 预览参数化（v1.7，2026-08-19 裁定）：弹窗内 画幅/清晰度/时长 三可调项（快乐马能力内）。
     时长默认取本镜分镜时长（越界收敛 3–15 并提示），分镜无时长回落到快乐马缺省 5s。 */
  const [previewRatio, setPreviewRatio] = useState<string>("");
  const [previewResolution, setPreviewResolution] = useState<string>("");
  const [previewDuration, setPreviewDuration] = useState<number>(HAPPYHORSE_PREVIEW_DEFAULT_DURATION);
  /* 正式生视频档池（v1.6.8，2026-08-19 裁定）：仅 seedance（active 非预览火山方舟视频档），
     快乐马预览档不进正式级联——正式生成只能用 seedance。 */
  const availableVideoTiers = useMemo(() => formalVideoTiers(genConfigState.data?.tiers ?? []), [genConfigState.data]);
  /* 预览档池（快乐马，params.preview=true）：预览弹窗锁定快乐马，预览只能用它。 */
  const previewTiers = useMemo(() => previewVideoTiers(genConfigState.data?.tiers ?? []), [genConfigState.data]);
  /** 开窗时初始化预览参数：以快乐马预览档注册值打底，时长默认分镜时长收敛
      （定义在 previewTiers 之后，useCallback 工厂渲染期即执行，避免 TDZ）。 */
  const openPreviewDialog = useCallback(() => {
    const tier = previewTiers[0];
    if (tier) {
      setPreviewRatio(typeof tier.params.aspect_ratio === "string" ? tier.params.aspect_ratio : "9:16");
      setPreviewResolution(tierResolutionOf(tier) ?? "480p");
    }
    setPreviewDuration(clampPreviewDuration(shot?.duration_seconds));
    setPreviewOpen(true);
  }, [previewTiers, shot?.duration_seconds]);
  /* 本镜生效档（v1.6 反馈③）：用户覆盖档 → 配置页默认档反查 → 最便宜 active 档兜底。
     参数行/回溯行随之实时展示；GenerationTask 不含模型/参数，展示取自档位配置。
     v1.6.8：默认档反查只在正式池内生效——旧策略即使指向快乐马也回落 seedance 兜底。 */
  const selectedTier = (() => {
    const config = genConfigState.data;
    if (!config) return null;
    if (tierOverrideId) return activeTiers(config.tiers).find((tier) => tier.tier_id === tierOverrideId) ?? null;
    const byStrategy = config.strategy ? resolveLiteTier(config.tiers, "video", config.strategy) : null;
    if (byStrategy && availableVideoTiers.some((tier) => tier.tier_id === byStrategy.tier_id)) return byStrategy;
    return cheapestActiveTier(availableVideoTiers) ?? null;
  })();
  const selectedModel = selectedTier ? tierModelLabel(selectedTier) : "";
  const selectedRatio = typeof selectedTier?.params.aspect_ratio === "string" ? selectedTier.params.aspect_ratio : "";
  const selectedResolution = selectedTier ? (tierResolutionOf(selectedTier) ?? "") : "";
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tier of availableVideoTiers) {
      const label = tierModelLabel(tier);
      if (!seen.has(label)) { seen.add(label); out.push(label); }
    }
    return out;
  }, [availableVideoTiers]);
  const ratioOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tier of availableVideoTiers) {
      if (tierModelLabel(tier) !== selectedModel) continue;
      const ratio = typeof tier.params.aspect_ratio === "string" ? tier.params.aspect_ratio : "";
      if (ratio && !seen.has(ratio)) { seen.add(ratio); out.push(ratio); }
    }
    return out;
  }, [availableVideoTiers, selectedModel]);
  const resolutionOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tier of availableVideoTiers) {
      if (tierModelLabel(tier) !== selectedModel) continue;
      if (typeof tier.params.aspect_ratio === "string" && tier.params.aspect_ratio !== selectedRatio) continue;
      const resolution = tierResolutionOf(tier) ?? "";
      if (resolution && !seen.has(resolution)) { seen.add(resolution); out.push(resolution); }
    }
    return out;
  }, [availableVideoTiers, selectedModel, selectedRatio]);
  /** 切模型 → 该模型下按配置页策略反查默认档（比例/清晰度随之收敛，七.3 决策 1 同款口径）。 */
  const handleTierModelChange = useCallback((model: string): void => {
    const tier = pickLiteDefaultTier(availableVideoTiers.filter((item) => tierModelLabel(item) === model), genConfigState.data?.strategy ?? null);
    if (tier) setTierOverrideId(tier.tier_id);
  }, [availableVideoTiers, genConfigState.data]);
  /** 切比例 → 当前模型内匹配档；清晰度收敛到最便宜，可再经第三级改（七.3）。 */
  const handleTierRatioChange = useCallback((ratio: string): void => {
    const tier = cheapestActiveTier(availableVideoTiers.filter((item) => tierModelLabel(item) === selectedModel && item.params.aspect_ratio === ratio));
    if (tier) setTierOverrideId(tier.tier_id);
  }, [availableVideoTiers, selectedModel]);
  /** 切清晰度 → 精确定位档（同模型同比例下取最便宜 active 档）。 */
  const handleTierResolutionChange = useCallback((resolution: string): void => {
    const tier = cheapestActiveTier(availableVideoTiers.filter((item) => {
      if (tierModelLabel(item) !== selectedModel) return false;
      if (typeof item.params.aspect_ratio === "string" && item.params.aspect_ratio !== selectedRatio) return false;
      return (tierResolutionOf(item) ?? "") === resolution;
    }));
    if (tier) setTierOverrideId(tier.tier_id);
  }, [availableVideoTiers, selectedModel, selectedRatio]);

  /* 整条重新做 = 复用整条生成链（4a）：以当前分镜状态重新生成一整条新版本。 */
  const submitRedo = useCallback((): void => {
    if (demoMode) {
      notify("离线演示不会发起真实生成", "info");
      return;
    }
    setEditVideoId(null);
    startGeneration();
  }, [demoMode, startGeneration]);

  /* 失败/超时后的手动刷新：查一次真态；仍在进行中则重开一轮轮询窗口。 */
  const refreshTaskNow = useCallback((): void => {
    const tracked = videoTask;
    if (!tracked || demoMode || refreshingId !== null) return;
    setRefreshingId(tracked.requestId);
    void api.generation(tracked.requestId).then((next) => {
      if (!ACTIVE_GENERATION_STATUSES.includes(next.status)) {
        settleVideoTask(tracked, next);
        setVideoTask(null);
        return;
      }
      const now = Date.now();
      setVideoTask({
        ...tracked,
        task: next,
        firstPollAt: now,
        pollCount: 0,
        pollFailures: 0,
        nextPollAt: now + POLL_BASE_MS,
        timedOut: false,
      });
      setPollKick((value) => value + 1);
    }).catch((reason) => {
      if (reason instanceof ApiClientError && (reason.status === 403 || reason.status === 404)) {
        handleTaskGone();
        return;
      }
      notify(humanErrorMessage(reason, "刷新失败，请稍后再试"), "error");
    }).finally(() => {
      setRefreshingId(null);
    });
  }, [videoTask, demoMode, refreshingId, settleVideoTask, handleTaskGone, notify]);

  /* ============================================================
     渲染
     ============================================================ */

  if (shotState.loading && !shot) {
    return h("div", { className: "mx-auto w-full max-w-[1440px] 2xl:max-w-[1920px] px-4 py-3" },
      h("div", { className: "mb-4" }, h(Skeleton, { className: "h-4 w-40" })),
      h("div", { className: "flex h-96 gap-4" },
        h("div", { className: "w-2/5 space-y-4" }, h(Skeleton, { className: "h-64 w-full" }), h(Skeleton, { className: "h-72 w-full" })),
        h("div", { className: "w-3/5 space-y-4" }, h(Skeleton, { className: "h-64 w-full" }), h(Skeleton, { className: "h-64 w-full" })),
      ),
    );
  }
  if (shotState.error && !shot) {
    return h(ErrorState, { message: shotState.error, onRetry: retryShot });
  }
  if (!shot) {
    return h(EmptyState, { title: "未找到该分镜", description: "分镜可能已被删除，或链接有误。" });
  }

  const currentCode = shotCode(shot, episode, scene);
  const gateReason = generationGate();
  const paramModel = selectedTier ? tierModelLabel(selectedTier) : "";

  /* ---------- v1.6 反馈①追加：分镜切换 tab 上壳顶栏（lite-shell，「已自动保存」
     2026-08-18 退役），页内不再渲染页首条；返回/镜名/切镜全在壳单条。 ---------- */
  return h("div", { className: "mx-auto flex min-h-0 w-full max-w-[1440px] 2xl:max-w-[1920px] flex-1 flex-col gap-4 overflow-y-auto px-4 py-3 lg:overflow-y-visible" },

    /* ---------- 左右等高工作台（左 2 / 右 3；2026-08-18 小屏优化：窄屏(<1024px)
       堆叠为单列、正文滚动，避免定高视口装不下） ---------- */
    h("div", { className: "flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-5" },
      /* ============ 左栏（v1.6 反馈②：已选资产列表内部滚动；分镜内容自然增长；
         2026-08-18 分镜详情修好?：桌面端与右栏等高独立滚动,内容不被 h-dvh 视口裁掉） ============ */
      h("div", { className: "flex w-full min-w-0 flex-col gap-4 lg:min-h-0 lg:w-2/5 lg:overflow-y-auto lg:pr-2" },

        /* ① 已选资产（v1.5.1：快照只读投影；写入在素材页。v1.6 反馈②：列表区固定
           高度（约三行资产卡）超出内部滚动——seedance 2.5 参考资产上限放开到 60 张时
           左栏不再被撑爆；计数徽记提示总量）。 */
        h("section", { className: "flex shrink-0 flex-col rounded-xl border border-border-1 bg-surface-1" },
          h("header", { className: "flex items-center justify-between gap-2 px-4 pt-4" },
            h("div", { className: "flex items-center gap-2" },
              h(SquaresFour, { className: "size-4 text-ink-2" }),
              h("h2", { className: "text-section-title text-ink-1" }, "已选资产"),
              refs.length > 0 ? h(Badge, { tone: "neutral" }, `${refs.length} 个`) : null,
            ),
            h(Button, {
              variant: "outline",
              size: "sm",
              onClick: () => setAssetPickerOpen(true),
            }, "匹配+选择"),
          ),
          h("div", { className: "max-h-48 space-y-2 overflow-y-auto px-4 py-3 lg:max-h-80" },
            refs.length === 0
              ? h(EmptyState, { title: "还没有参考资产", description: "去素材页把资产关联到本镜（集 · 分镜号 · 场景名），保存后自动出现在这里。" })
              : refs.map((snapshot) => renderSnapshotRow(snapshot)),
          ),
        ),

        /* ② 分镜内容（v1.5：剧本原文可编辑 + 场景输入框 + 时长；2026-08-18 v1.7
           反馈追加「对白 + 动作」同组；字段直接平铺在卡片内，一层）。 */
        h("section", { className: "shrink-0 rounded-xl border border-border-1 bg-surface-1" },
          h("header", { className: "px-4 pt-4" },
            h("h2", { className: "text-section-title text-ink-1" }, "分镜内容"),
          ),
          h("div", { className: "space-y-4 px-4 py-3" },
            /* 剧本原文（可编辑，失焦保存 script_text）+ 编码 */
            h("label", { className: "block" },
              h("span", { className: "mb-2 block text-xs font-medium text-ink-3" }, "剧本原文"),
              h(Textarea, {
                rows: 5,
                value: scriptTextDraft,
                placeholder: "填写本镜的剧本原文（台词/旁白/动作描述）。",
                onBlur: saveScriptText,
                onChange: (event) => setScriptTextDraft((event.target as HTMLTextAreaElement).value),
              }),
              h("span", { className: "mt-2 block text-aux text-ink-3" }, `分镜编码：${currentCode} · 失焦自动保存`),
            ),
            /* 场景（v1.5 反馈④：文案改名「场景」，输入框；失焦匹配/建场后绑 scene_id） */
            h("label", { className: "block" },
              h("span", { className: "mb-2 block text-xs font-medium text-ink-3" }, "场景"),
              h(Input, {
                key: `${shot.id}:${scene?.id ?? ""}`,
                defaultValue: scene?.name ?? "",
                disabled: scenesState.loading && !scenesState.data,
                placeholder: "输入场景名；不存在时失焦自动新建",
                onBlur: (event) => saveSceneInput((event.target as HTMLInputElement).value),
              }),
              h("span", { className: "mt-2 block text-aux text-ink-3" }, "输新名字 = 在本集新建一个场景并绑定"),
            ),
            /* 对白 / 动作（2026-08-18 v1.7 反馈：与场景/时长同组，失焦保存；
               对白=dialogue_note，动作=breakdown_elements.action） */
            h("label", { className: "block" },
              h("span", { className: "mb-2 block text-xs font-medium text-ink-3" }, "对白"),
              h(Textarea, {
                rows: 3,
                value: dialogueDraft,
                placeholder: "本镜的对白/台词",
                onBlur: saveDialogue,
                onChange: (event) => setDialogueDraft((event.target as HTMLTextAreaElement).value),
              }),
            ),
            h("label", { className: "block" },
              h("span", { className: "mb-2 block text-xs font-medium text-ink-3" }, "动作"),
              h(Input, {
                value: actionDraft,
                placeholder: "本镜的动作描述",
                onBlur: saveAction,
                onChange: (event) => setActionDraft((event.target as HTMLInputElement).value),
              }),
            ),
            /* 时长 */
            h("label", { className: "block" },
              h("span", { className: "mb-2 block text-xs font-medium text-ink-3" }, "时长（秒）"),
              h(Input, {
                type: "number",
                min: 1,
                max: 600,
                value: durationDraft,
                placeholder: "如 4",
                onBlur: saveDuration,
                onChange: (event) => setDurationDraft((event.target as HTMLInputElement).value),
              }),
            ),
          ),
        ),
      ),

      /* ============ 右栏 = 固定 + 滚动分层 ============ */
      h("div", { className: "flex w-full min-w-0 flex-col gap-4 lg:w-3/5" },
        /* ① 播放器（v1.5 反馈⑥：高度有上限，object-contain 居中；2026-08-18 小屏
           收敛 h-40，给版本条与提示词留空间） */
        h("div", { className: "shrink-0 rounded-xl border border-border-1 bg-surface-1 p-3" },
          h("div", { className: "flex h-40 items-center justify-center overflow-hidden rounded-lg bg-black lg:h-56" },
            h("video", {
              key: selectedVideo?.id ?? "none",
              controls: true,
              className: "max-h-full max-w-full",
              src: selectedVideo?.storage_url ?? undefined,
              preload: "metadata",
            }),
          ),
          h("div", { className: "mt-2 flex items-center justify-between gap-2 px-2 text-aux text-ink-3" },
            h("span", {},
              selectedVideo
                ? `v${selectedVideo.version_no ?? ""}${selectedVideo.version_label ? ` · ${selectedVideo.version_label}` : ""}${selectedVideo.preview ? " · 预览" : ""}${currentVideo?.id === selectedVideo.id ? " · 当前版" : ""}`
                : "无视频",
            ),
            h("span", {}, selectedVideo ? `时长 ${formatDuration(selectedVideo.duration_seconds)}` : ""),
          ),
        ),

        /* ② 视频版本（版本条横向滚动；无视频不占位、不带生成按钮——2026-08-18） */
        h("section", { className: "shrink-0" },
          h("div", { className: "flex items-center gap-2 px-2" },
            h(VideoCamera, { className: "size-4 text-ink-2" }),
            h("h2", { className: "text-section-title text-ink-1" }, "视频版本"),
            h(Badge, { tone: "accent" }, currentVideo ? `当前版 v${currentVideo.version_no ?? ""}` : "暂无版本"),
          ),
          h("div", { className: "mt-2" },
            mediaState.loading && videos.length === 0 ? h(Skeleton, { className: "h-9 w-full" })
              : mediaState.error && videos.length === 0 ? h(ErrorState, { message: mediaState.error, onRetry: mediaState.retry })
              : videos.length === 0 ? null
              : h("div", { className: "flex items-center gap-1" },
                  h("div", { className: "flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5" },
                    videos.map((video) => renderVersionChip(video)),
                  ),
                  h("button", {
                    type: "button",
                    disabled: !(selectedVideo ?? currentVideo),
                    title: selectedVideo ?? currentVideo ? `编辑 v${(selectedVideo ?? currentVideo)?.version_no ?? ""}` : "没有可编辑的版本",
                    onClick: () => { const target = selectedVideo ?? currentVideo; if (target) openVersionEdit(target); },
                    className: "flex size-8 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-surface-1 hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-40",
                  }, h(DotsThree, { className: "size-4" })),
                ),
          ),
        ),


        /* ④ 视频提示词（标题/AI 生成固定，内容竖滚，参数行 + 生成按钮固定底部） */
        h("section", { className: "flex min-h-0 flex-1 flex-col rounded-xl border border-border-1 bg-surface-1" },
          h("header", { className: "flex shrink-0 items-center justify-between gap-2 px-4 pt-4" },
            h("div", { className: "flex items-center gap-2" },
              h(PencilLine, { className: "size-4 text-ink-2" }),
              h("h2", { className: "text-section-title text-ink-1" }, "视频提示词"),
            ),
            h("div", { className: "flex items-center gap-3" },
              h("span", { className: "text-aux text-ink-3" }, "锁定（防自动编译覆盖，不防重新生成本集）"),
              h(Switch, { checked: promptLocked, label: "锁定视频提示词", onChange: togglePromptLocked }),
              shot?.storyboard_detail ? h(Button, { variant: "ghost", size: "sm", onClick: () => setStoryboardDetailOpen(true) }, "拆镜详情") : null,
              h(Button, { variant: "secondary", size: "sm", icon: h(PencilLine, { className: "size-4" }), loading: draftingPrompt, onClick: generatePromptDraft }, "AI 生成"),
            ),
          ),
          h("div", { className: "min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" },
            promptLocked ? h("p", { className: "text-xs text-warning" }, "已锁定：自动编译会保留当前提示词；重新生成本集会重建分镜，并清除此锁定和提示词。") : null,
            h(Textarea, {
              rows: 8,
              className: "resize-y",
              value: videoPromptDraft,
              placeholder: "填写本镜的视频提示词；可用「AI 生成」产出草稿后编辑。",
              onBlur: saveVideoPrompt,
              onChange: (event) => setVideoPromptDraft((event.target as HTMLTextAreaElement).value),
            }),
            h("p", { className: "text-aux text-ink-3" }, "AI 生成只产出草稿，不会自动保存；确认后点失焦或手动保存。"),
            videoTask ? renderTaskCard(videoTask) : null,
          ),
          /* 参数选择 + 生成按钮（固定底部；v1.6 反馈③：模型/比例/清晰度本镜三级级联可选，
             取值全部从 active 档推导；档价如实展示，不虚构。2026-08-18 小屏优化：生成
             按钮全页仅一个、与参数同行，窄屏 flex-wrap 换行）。 */
          h("div", { className: "shrink-0 border-t border-border-1 px-4 py-3" },
            h("div", { className: "flex flex-wrap items-end gap-3" },
              renderTierSelects(),
              selectedTier ? h("span", { className: "shrink-0 pb-2 text-aux text-ink-3" }, tierPriceLabel(selectedTier)) : null,
              /* 生成按钮与模型/比例/清晰度同行（2026-08-18：全页唯一生成入口；
                 窄屏 flex-wrap 自动换行，不挤压选择框） */
              /* v1.6.8：预览入口在正式生成之前（outline 次级；开窗免费，付费点击在弹窗内），
                 常驻渲染——预览可用性由预览档池决定（快乐马预览档；无预览档则禁用）。 */
              h(Button, {
                variant: "outline",
                className: "shrink-0",
                icon: h(Eye, { className: "size-4" }),
                disabled: submitting || previewTiers.length === 0,
                title: previewTiers.length === 0 ? "当前没有可用的预览档（快乐马），请联系管理员配置" : "打开预览弹窗（开窗不付费）",
                onClick: openPreviewDialog,
              }, "预览视频"),
              h(Button, {
                variant: "accent",
                className: "shrink-0",
                icon: h(VideoCamera, { className: "size-4" }),
                loading: submitting,
                disabled: gateReason !== "" || submitting,
                title: gateReason || undefined,
                onClick: () => startGeneration(),
              }, "生成视频"),
            ),
            gateReason ? h("p", { className: "mt-2 text-xs text-warning" }, gateReason) : null,
          ),
        ),
      ),
    ),

    /* ---------- 版本详情 / 版本编辑弹窗 ---------- */
    renderVersionDetailDialog(),
    renderVersionEditDialog(),
    renderPreviewDialog(),
    h(LiteShotStoryboardDetailDialog, { detail: shot?.storyboard_detail, open: storyboardDetailOpen, onOpenChange: setStoryboardDetailOpen }),
    assetPickerOpen
      ? h(LiteShotAssetPickerDialog, {
        projectId,
        shotId: shot.id,
        demoMode,
        linkedKeys: linkedAssetKeys,
        autoRefKeys: autoRefAssetKeys,
        notify,
        onClose: () => setAssetPickerOpen(false),
        onLinked: retryShot,
      })
      : null,
  );

  /* ---------- 局部渲染函数（闭包：依赖上面 state/handlers） ---------- */

  /* 已选资产行（v1.5 反馈②：名称 + 类型徽记；v1.5.1：auto 项可移除，manual 去素材页删；
     2026-08-19：按 (asset, variant) 去重成行，副行显示引用层级（变体名/资产级）——
     资产级与变体级是不同身份，各自一行、标签区分，绝不顶替用户没选过的变体）。 */
  function renderSnapshotRow(snapshot: ShotAssetSnapshot): React.ReactNode {
    const kindLabel = snapshot.asset_kind ? (ASSET_KIND_LABELS[snapshot.asset_kind] ?? snapshot.asset_kind) : "素材";
    const isAuto = snapshot.matched_by !== "manual";
    const scopeLabel = snapshot.variant_id
      ? (snapshot.variant_name ? `变体「${snapshot.variant_name}」` : "变体")
      : "资产级";
    const removable = autoRemovable.get(snapshot.asset_entity_id);
    return h("div", { key: `${snapshot.asset_entity_id}::${snapshot.variant_id ?? "asset"}`, className: "rounded-lg border border-border-1 bg-surface-0 p-2" },
      h("div", { className: "flex items-start gap-2" },
        snapshot.image_url
          ? h("img", { src: snapshot.image_url, alt: snapshot.name || "资产缩略图", className: "size-9 shrink-0 rounded-md border border-border-1 object-cover" })
          : h("div", { className: "flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-xs text-ink-3" }, kindLabel),
        h("div", { className: "min-w-0 flex-1" },
          h("div", { className: "flex items-center gap-2" },
            h("span", { className: "truncate text-sm font-medium text-ink-1" }, snapshot.name || "未命名资产"),
            h(Badge, { tone: "neutral" }, kindLabel),
          ),
          h("p", { className: "mt-2 truncate text-xs text-ink-3" },
            `${isAuto ? "自动匹配" : "手动关联"} · ${scopeLabel}`,
          ),
        ),
        removable ? h(Button, {
          variant: "ghost",
          size: "sm",
          icon: h(Trash, { className: "size-4" }),
          title: "移除后重新一键生成不会再加回",
          onClick: () => removeSnapshot(removable),
        }, "移除") : null,
      ),
    );
  }


  function renderVersionChip(video: MediaVersion): React.ReactNode {
    const isCurrent = currentVideo?.id === video.id;
    const rejected = video.review_status === "rejected";
    return h("button", {
      key: video.id,
      type: "button",
      onClick: () => openVersionDetail(video),
      title: `v${video.version_no ?? ""}${video.version_label ? ` · ${video.version_label}` : ""}${isCurrent ? " · 当前版" : ""} — 点开版本详情`,
      className: `flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
        isCurrent ? "border-accent/50 bg-accent/5 text-accent-text" : "border-border-1 bg-surface-1 text-ink-2 hover:border-border-2 hover:text-ink-1"
      }`,
    },
      h("span", { className: "font-medium" }, `v${video.version_no ?? "?"}`),
      video.version_label ? h("span", {}, `· ${video.version_label}`) : null,
      isCurrent ? h("span", { "aria-label": "当前版" }, "✓") : null,
      rejected ? h("span", { className: "text-danger" }, "· 未过") : null,
    );
  }

  /* 弹窗内预览版本 chip（2026-08-19）：只展示本镜预览台账命中的版本（含历史
     metadata.preview=true 的快乐马预览，带「· 预览」徽记），点击在弹窗内切换
     播放器（不进版本详情——预览版不进主区版本列表）。 */
  function renderPreviewChip(video: MediaVersion, active: boolean): React.ReactNode {
    return h("button", {
      key: video.id,
      type: "button",
      onClick: () => setSelectedPreviewVideoId(video.id),
      title: `v${video.version_no ?? ""}${video.version_label ? ` · ${video.version_label}` : ""} — 弹窗内切换预览版`,
      className: `flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
        active ? "border-accent/50 bg-accent/5 text-accent-text" : "border-border-1 bg-surface-1 text-ink-2 hover:border-border-2 hover:text-ink-1"
      }`,
    },
      h("span", { className: "font-medium" }, `v${video.version_no ?? "?"}`),
      video.version_label ? h("span", {}, `· ${video.version_label}`) : null,
      video.preview ? h("span", { className: "text-warning" }, "· 预览") : null,
    );
  }

  /* 生成档三级级联选择器（v1.6 反馈③ + v1.6.5 预览弹窗复用）：主区参数行与预览弹窗
     共用同一组 state（selectedModel/selectedRatio/selectedResolution + tierOverrideId）与
     处理器——改弹窗里的档 = 改主区档（无第二份数据，预览弹窗同源原则）。 */
  function renderTierSelects(): React.ReactNode {
    return h("div", { className: "flex flex-wrap items-end gap-3" },
      h("label", { className: "block min-w-0 flex-1" },
        h("span", { className: "mb-2 block text-xs font-medium text-ink-3" }, "模型"),
        h(Select, {
          "aria-label": "视频模型",
          className: "h-9 w-full",
          value: selectedModel,
          disabled: availableVideoTiers.length === 0,
          onChange: (event) => handleTierModelChange((event.target as HTMLSelectElement).value),
        },
          availableVideoTiers.length === 0 ? h("option", { value: "" }, "暂无可用模型") : modelOptions.map((option) => h("option", { key: option, value: option }, option)),
        ),
      ),
      h("label", { className: "block w-24 shrink-0" },
        h("span", { className: "mb-2 block text-xs font-medium text-ink-3" }, "比例"),
        h(Select, {
          "aria-label": "画面比例",
          className: "h-9 w-full",
          value: selectedRatio,
          disabled: ratioOptions.length === 0,
          onChange: (event) => handleTierRatioChange((event.target as HTMLSelectElement).value),
        },
          ratioOptions.length === 0 ? h("option", { value: "" }, "—") : ratioOptions.map((option) => h("option", { key: option, value: option }, option)),
        ),
      ),
      h("label", { className: "block w-28 shrink-0" },
        h("span", { className: "mb-2 block text-xs font-medium text-ink-3" }, "清晰度"),
        h(Select, {
          "aria-label": "清晰度",
          className: "h-9 w-full",
          value: selectedResolution,
          disabled: resolutionOptions.length === 0,
          onChange: (event) => handleTierResolutionChange((event.target as HTMLSelectElement).value),
        },
          resolutionOptions.length === 0 ? h("option", { value: "" }, "—") : resolutionOptions.map((option) => h("option", { key: option, value: option }, option)),
        ),
      ),
    );
  }

  /* ---------- 预览视频弹窗（v1.7，2026-08-19 预览隔离·快乐马锁定 + 参数化）：预览只能使用
     快乐马——弹窗锁定预览档池（previewVideoTiers，params.preview=true），模型锁定只读，
     比例/清晰度/时长在快乐马能力内可调（矩阵 = lite-generation HAPPYHORSE_* 常量，指回后端
     v01Contract.ts VIDEO_CAPABILITIES / 设计文档 §1.1），时长默认取本镜分镜时长并收敛 3–15
     （越界给提示）。快乐马参考生视频硬约束 1–9 张参考图：无参考图禁用提交并给原因
     （撤销 v1.6.7 的「纯提示词即可预览」）。预览版只在弹窗展示——弹窗播放器/版本 chip 走
     previewVideos（本镜 sessionStorage 预览台账命中），主区 videos 排除预览版。播放器目标 =
     所选预览版 → 最新预览版；无预览版给空态，不再回落主区正式版（seedance 与预览分离后
     回落会把正式版混进预览弹窗）。提示词同源不可编辑；付费点击「生成预览」在
     窗内，带覆盖参数提交；提交后弹窗默认不关闭——生成中在窗内提示，出片后新预览自动落入
     弹窗播放器（提交时已复位选择 → 默认看最新），用户看完再手动关窗。 ---------- */
  function renderPreviewDialog(): React.ReactNode {
    if (previewTiers.length === 0) return null;
    const previewTier = previewTiers[0]!;
    const refsOk = refs.length >= 1 && refs.length <= 9;
    const previewReason = refs.length === 0
      ? "快乐马预览需至少 1 张参考图（1–9 张），请先在左侧选中参考资产"
      : refs.length > 9
        ? `快乐马预览参考图最多 9 张，当前 ${refs.length} 张`
        : "";
    const target = previewVideos.find((video) => video.id === selectedPreviewVideoId) ?? previewVideos[previewVideos.length - 1] ?? null;
    /* 分镜时长越界提示：本镜 duration_seconds 在快乐马能力外（3–15）时，提示收敛后的取值。 */
    const shotDuration = typeof shot?.duration_seconds === "number" ? shot.duration_seconds : null;
    const durationNotice = shotDuration !== null && (shotDuration < HAPPYHORSE_PREVIEW_MIN_DURATION || shotDuration > HAPPYHORSE_PREVIEW_MAX_DURATION)
      ? `本镜时长 ${shotDuration} 秒超出快乐马预览能力（${HAPPYHORSE_PREVIEW_MIN_DURATION}–${HAPPYHORSE_PREVIEW_MAX_DURATION} 秒），已收敛为 ${previewDuration} 秒`
      : "";
    const estimate = previewEstimatePoints(previewTier, previewDuration);
    return h(Dialog, { open: previewOpen, onOpenChange: setPreviewOpen },
      h(DialogContent, { size: "large" },
        h(DialogHeader, {},
          h(DialogTitle, {}, "预览视频"),
          h(DialogDescription, {}, "预览仅支持快乐马（HappyHorse 1.1）参考生视频，需 1–9 张参考图；正式生成仅支持 Seedance。预览版只显示在弹窗，不进版本列表。"),
        ),
        h(DialogBody, { className: "space-y-4" },
          h("div", { className: "overflow-hidden rounded-lg border border-border-1 bg-black/5" },
            h("video", {
              key: target?.id ?? "none",
              controls: true,
              className: "max-h-72 w-full",
              src: target?.storage_url ?? undefined,
              preload: "metadata",
            }),
          ),
          videoTask && isPollingTarget(videoTask)
            ? h("p", { className: "text-xs text-warning" }, "视频生成中…出片后自动出现在上方播放器，弹窗保持打开。")
            : null,
          previewVideos.length > 0
            ? h("div", { className: "flex items-center gap-1 overflow-x-auto py-0.5" }, previewVideos.map((video) => renderPreviewChip(video, video.id === target?.id)))
            : h("p", { className: "text-xs text-ink-3" }, "暂无预览版本，点「生成预览」出一版"),
          h("div", { className: "space-y-2 rounded-lg border border-border-1 bg-surface-0 p-3 text-xs text-ink-2" },
            h("p", {}, h("span", { className: "font-medium text-ink-1" }, "提示词："), "与右栏当前视频提示词一致（此处不可编辑）"),
            h("div", { className: "space-y-1.5" },
              h("p", { className: "text-xs font-medium text-ink-3" }, "生成档位（预览锁定快乐马，正式生成锁定 Seedance；比例/清晰度/时长可在快乐马能力内调整）"),
              h("div", { className: "flex flex-wrap items-end gap-3" },
                h("label", { className: "block w-28 shrink-0" },
                  h("span", { className: "mb-2 block text-xs text-ink-3" }, "模型"),
                  h("div", { className: "flex h-9 items-center rounded-md border border-border-1 bg-surface-1 px-3 text-ink-1" }, tierModelLabel(previewTier)),
                ),
                h("label", { className: "block w-28 shrink-0" },
                  h("span", { className: "mb-2 block text-xs text-ink-3" }, "比例"),
                  h(Select, {
                    "aria-label": "预览画幅",
                    className: "h-9 w-full",
                    value: previewRatio,
                    onChange: (event) => setPreviewRatio((event.target as HTMLSelectElement).value),
                  }, HAPPYHORSE_PREVIEW_RATIOS.map((option) => h("option", { key: option, value: option }, option))),
                ),
                h("label", { className: "block w-28 shrink-0" },
                  h("span", { className: "mb-2 block text-xs text-ink-3" }, "清晰度"),
                  h(Select, {
                    "aria-label": "预览清晰度",
                    className: "h-9 w-full",
                    value: previewResolution,
                    onChange: (event) => setPreviewResolution((event.target as HTMLSelectElement).value),
                  }, HAPPYHORSE_PREVIEW_RESOLUTIONS.map((option) => h("option", { key: option, value: option }, option))),
                ),
                h("label", { className: "block w-28 shrink-0" },
                  h("span", { className: "mb-2 block text-xs text-ink-3" }, "时长（秒）"),
                  h(Input, {
                    type: "number",
                    min: HAPPYHORSE_PREVIEW_MIN_DURATION,
                    max: HAPPYHORSE_PREVIEW_MAX_DURATION,
                    step: 1,
                    value: previewDuration,
                    onChange: (event) => setPreviewDuration(clampPreviewDuration(Number((event.target as HTMLInputElement).value), previewDuration)),
                    className: "h-9 w-full",
                  }),
                ),
              ),
              durationNotice ? h("p", { className: "text-xs text-warning" }, durationNotice) : null,
            ),
            h("p", {}, h("span", { className: "font-medium text-ink-1" }, "参考资产："), `${refs.length} 个（快乐马需 1–9 张参考图，服务端同口径解析）`),
            h("p", {}, h("span", { className: "font-medium text-ink-1" }, "预计："), `${tierPriceLabel(previewTier)} · 约 ${estimate} 积分`),
          ),
        ),
        h(DialogFooter, {},
          h(Button, {
            variant: "accent",
            loading: submitting,
            disabled: !refsOk || submitting,
            title: previewReason || undefined,
            onClick: () => {
              /* 2026-08-19：提交后弹窗保持打开、不自动关闭；预览版只进弹窗（快乐马档 params
                 自带 preview=true → 后端 metadata.preview），出片后自动落入上方弹窗播放器
                 （keyed by video.id），用户看完再手动关窗。
                 v1.7：携带弹窗覆盖参数（比例/清晰度/时长），身份键 preview/watermark 在档
                 参数 rest 里，后端已接受快乐马预览档参数覆盖。 */
              startGeneration(previewTier, true, { resolution: previewResolution, ratio: previewRatio, durationSeconds: previewDuration });
            },
          }, "生成预览"),
        ),
        previewReason ? h("p", { className: "px-4 pb-4 text-xs text-warning" }, previewReason) : null,
      ),
    );
  }

  /* ---------- 版本详情弹窗（§4.3.1）：查看具体版本，不改当前版 ---------- */
  function renderVersionDetailDialog(): React.ReactNode {
    const video = detailVideo;
    if (!video) return null;
    const isCurrent = currentVideo?.id === video.id;
    const rejected = video.review_status === "rejected";
    const source = shotVideoSelectionSource(video, videos);
    const downloadable = mediaDownloadable(video);
    const referenceCount = refs.length;
    const traceback = tracebackMap[video.id];
    const resolutionLabel = typeof selectedTier?.params.resolution === "string" ? selectedTier.params.resolution : "";
    return h(Dialog, {
      open: detailVideo !== null,
      onOpenChange: (open) => { if (!open) setDetailVideoId(null); },
    },
      h(DialogContent, { size: "large" },
        h(DialogHeader, {},
          h(DialogTitle, {}, `版本详情 · ${currentCode}-v${video.version_no ?? ""}`),
          h(DialogDescription, {}, "查看该版本，不会改变当前版。"),
        ),
        h(DialogBody, { className: "space-y-4" },
          h("div", { className: "overflow-hidden rounded-lg border border-border-1 bg-black/5" },
            h("video", {
              key: video.id,
              controls: true,
              className: "aspect-video w-full",
              src: video.storage_url ?? undefined,
              preload: "metadata",
            }),
          ),
          h("div", { className: "space-y-1 text-body text-ink-2" },
            h("p", {},
              h("span", { className: "font-medium text-ink-1" }, "版本："),
              video.version_label || `v${video.version_no ?? "?"}`,
              source === "manual" ? " · 手动" : source === "latest_default" ? " · 默认(最新)" : "",
              isCurrent ? " · 当前版 ✓" : "",
              rejected ? " · 审核未过" : "",
              video.preview ? " · 预览" : "",
            ),
            h("p", {},
              h("span", { className: "font-medium text-ink-1" }, "生成："),
              formatDateTime(video.created_at),
              ` · 时长 ${formatDuration(video.duration_seconds)}`,
              resolutionLabel ? ` · ${resolutionLabel}` : "",
            ),
            h("p", {},
              h("span", { className: "font-medium text-ink-1" }, "模型："),
              paramModel || "—",
              ` · 参考资产 ${referenceCount} 张`,
            ),
          ),
          /* 版本提示词（生成时用的）：按 generation_request_id 回溯 */
          h("div", { className: "rounded-lg border border-border-1 bg-surface-0 p-3" },
            h("div", { className: "mb-2 flex items-center justify-between gap-2" },
              h("span", { className: "text-xs font-medium text-ink-3" }, "版本提示词（生成时用的）"),
              traceback && traceback !== "loading" && traceback !== "error" && traceback.prompt
                ? h("button", { type: "button", className: "text-xs text-accent-text hover:underline", onClick: () => setDetailTracebackExpanded((value) => !value) }, detailTracebackExpanded ? "收起" : "展开")
                : null,
            ),
            traceback === "loading" ? h(Skeleton, { className: "h-12 w-full" })
              : traceback === "error" ? h("p", { className: "text-xs text-danger" }, "读取生成任务失败")
              : traceback === undefined
                ? h("p", { className: "text-xs text-ink-3" }, demoMode && video.generation_request_id ? "离线演示不包含真实生成任务信息" : "该版本没有生成任务记录。")
                : traceback.prompt
                  ? (detailTracebackExpanded
                      ? h("pre", { className: "whitespace-pre-wrap text-xs text-ink-2" }, traceback.prompt)
                      : h("p", { className: "line-clamp-2 text-xs text-ink-2" }, traceback.prompt))
                  : h("p", { className: "text-xs text-ink-3" }, "（无提示词记录）"),
          ),
        ),
        h(DialogFooter, { className: "flex-wrap" },
          isCurrent
            ? h(Button, { variant: "outline", size: "sm", disabled: true }, "当前版")
            : h(Button, {
                variant: "outline",
                size: "sm",
                icon: h(CheckSquare, { className: "size-4" }),
                disabled: rejected,
                title: rejected ? "审核未过，不能设为当前版" : undefined,
                onClick: () => setCurrentVideo(video),
              }, "设为当前版"),
          h(Button, {
            variant: "outline",
            size: "sm",
            icon: h(DownloadSimple, { className: "size-4" }),
            disabled: !downloadable,
            title: downloadable ? undefined : "文件归档中，暂不可下载",
            onClick: () => downloadVideo(video),
          }, "下载"),
          h(Button, { variant: "secondary", size: "sm", onClick: () => openVersionEdit(video) }, "编辑这个版本"),
        ),
      ),
    );
  }

  /* ---------- 版本编辑弹窗（§4.3.2）：改视频的唯一入口 ---------- */
  function renderVersionEditDialog(): React.ReactNode {
    const video = editVideo;
    if (!video) return null;
    const isCurrent = currentVideo?.id === video.id;
    const nextVersionNo = (video.version_no ?? 0) + 1;
    return h(Dialog, {
      open: editVideo !== null,
      onOpenChange: (open) => { if (!open) setEditVideoId(null); },
    },
      h(DialogContent, { size: "medium" },
        h(DialogHeader, {},
          h(DialogTitle, {}, `编辑这个版本 · ${currentCode}-v${video.version_no ?? ""}`),
          h(DialogDescription, {}, `现在：${isCurrent ? "当前版 ✓" : "非当前版"} · ${formatDateTime(video.created_at)} 生成`),
        ),
        h(DialogBody, { className: "space-y-4" },
          /* 版本名 + 备注（保存走 setVersionLabel：label + note 一次写） */
          h("label", { className: "block" },
            h("span", { className: "mb-2 block text-xs font-medium text-ink-3" }, "版本名"),
            h(Input, {
              value: labelDraft,
              placeholder: `不填就叫 v${video.version_no ?? ""}，如「雨夜版」`,
              onChange: (event) => setLabelDraft((event.target as HTMLInputElement).value),
            }),
          ),
          h("label", { className: "block" },
            h("span", { className: "mb-2 block text-xs font-medium text-ink-3" }, "备注"),
            h(Textarea, {
              rows: 3,
              value: noteDraft,
              placeholder: "如：上次试的，人物偏暗，先留着",
              onChange: (event) => setNoteDraft((event.target as HTMLTextAreaElement).value),
            }),
          ),
          /* 三选一 */
          h("div", { className: "rounded-lg border border-border-1 bg-surface-0 p-3" },
            h("p", { className: "mb-2 text-xs font-medium text-ink-3" }, "这个视频怎么改？"),
            h("div", { className: "space-y-1" },
              renderEditOption("redo", "整条重新做", `照同样要求重新生成一整条，得到新版本 v${nextVersionNo}（不覆盖这个版本）。`),
              renderEditOption("trim", "只改某几秒", "切成几段，只重做不满意的那段，其他段原样保留。"),
              renderEditOption("delete", "删掉这个版本", "历史版本不要了（当前版需先换）。"),
            ),
            editMode === "trim" && trimComingSoon
              ? h("p", { className: "mt-2 rounded-md bg-surface-2/60 p-2 text-xs text-ink-2" }, "片段编辑即将上线。")
              : null,
            editMode === "delete" && isCurrent ? renderDeleteCurrentGuard(video) : null,
          ),
        ),
        h(DialogFooter, { className: "flex-wrap" },
          h(Button, { variant: "outline", size: "sm", loading: savingLabelNote, onClick: () => saveVersionLabelNote(video) }, "保存名称/备注"),
          editMode === "redo"
            ? h(Button, {
                variant: "accent",
                size: "sm",
                icon: h(VideoCamera, { className: "size-4" }),
                loading: submitting,
                disabled: gateReason !== "" || submitting,
                title: gateReason || undefined,
                onClick: submitRedo,
              }, "整条重新做（1 次任务）")
            : editMode === "trim"
              ? h(Button, { variant: "secondary", size: "sm", onClick: () => setTrimComingSoon(true) }, "下一步：开始改")
              : h(Button, {
                  variant: "danger",
                  size: "sm",
                  icon: h(Trash, { className: "size-4" }),
                  disabled: isCurrent || deletingVersion,
                  loading: deletingVersion,
                  title: isCurrent ? "当前版需先换成别的版本" : undefined,
                  onClick: () => deleteVersion(video),
                }, "删掉这个版本"),
        ),
      ),
    );
  }

  function renderEditOption(value: VersionEditMode, title: string, desc: string): React.ReactNode {
    return h("label", { key: value, className: "flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-surface-2" },
      h("input", {
        type: "radio",
        name: "shot-video-edit-mode",
        className: "mt-2 accent-accent",
        checked: editMode === value,
        onChange: () => setEditMode(value),
      }),
      h("span", { className: "min-w-0" },
        h("span", { className: "block text-sm font-medium text-ink-1" }, title),
        h("span", { className: "block text-xs text-ink-3" }, desc),
      ),
    );
  }

  /* 删当前版前的换版引导（E4：当前版不能删，先换别的当前版）。 */
  function renderDeleteCurrentGuard(video: MediaVersion): React.ReactNode {
    const others = videos.filter((item) => item.id !== video.id);
    return h("div", { className: "mt-2 rounded-md bg-surface-2/60 p-2 text-xs text-ink-2" },
      h("p", {}, "当前版不能直接删。先把另一个版本设为当前版："),
      others.length === 0
        ? h("p", { className: "mt-2 text-aux text-ink-3" }, "没有其他版本可设当前版。")
        : h("div", { className: "mt-2 flex items-center gap-2" },
            h(Select, {
              className: "h-8 w-44",
              value: deleteGuardTarget,
              onChange: (event) => setDeleteGuardTarget((event.target as HTMLSelectElement).value),
            },
              h("option", { value: "" }, "选择版本"),
              others.map((item) => h("option", { key: item.id, value: item.id }, `v${item.version_no ?? ""}${item.version_label ? ` · ${item.version_label}` : ""}`)),
            ),
            h(Button, { variant: "outline", size: "sm", disabled: !guardTargetVideo, onClick: swapCurrentForDelete }, "设为当前版"),
          ),
    );
  }

  function renderTaskCard(tracked: TrackedLiteTask): React.ReactNode {
    const active = isPollingTarget(tracked);
    return h("div", { className: "rounded-lg border border-border-1 bg-surface-0 p-3" },
      h("div", { className: "flex items-center justify-between gap-2" },
        h("div", {},
          h("p", { className: "text-sm font-medium text-ink-1" }, active ? "视频生成中…" : `状态：${tracked.task.status}`),
          h("p", { className: "mt-2 text-xs text-ink-3" }, `任务 ${tracked.requestId.slice(0, 8)}… · 可离开本页，回来后进度自动恢复`),
          tracked.timedOut ? h("p", { className: "mt-2 text-xs text-warning" }, "任务仍在处理，请稍后回到本页查看。") : null,
          tracked.pollFailures >= POLL_FAILURE_NOTICE_THRESHOLD ? h("p", { className: "mt-2 text-xs text-warning" }, "进度刷新连续失败，显示的状态可能偏旧。") : null,
          tracked.task.status === "failed" && tracked.task.display_reason ? h("p", { className: "mt-2 text-xs text-danger" }, tracked.task.display_reason) : null,
        ),
        tracked.pollFailures >= POLL_FAILURE_NOTICE_THRESHOLD || tracked.timedOut
          ? h(Button, { variant: "outline", size: "sm", loading: refreshingId === tracked.requestId, onClick: refreshTaskNow }, "立即刷新")
          : null,
      ),
    );
  }
}
