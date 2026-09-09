/* ============================================================
   lite-asset-detail-page.tsx — Lite 素材详情页(Phase 2,左右分栏工作台)

   口径(第四版,按 lite-ui-rework §4.4.2 重设计,用户裁定 2026-08-13):
   - 独立路由页面 /lite/projects/:id/assets/:assetEntityId
   - 模式 B 视口固定分栏(§3.7):外层 `h-[calc(100dvh-3.5rem-2rem)] max-w-7xl`,
     左右两栏等高、各自独立纵向滚动(与制作页工作台同高度模型)
   - 左栏 = 变体卡片两列网格(v1.4:sticky 主图大卡退役,看图统一走 lightbox)
     (网格区头常驻计数 `共 N 个变体`;每卡上图下名、选中 accent 描边、⭐ 主图角标;
     尾部「＋ 新建变体」与卡同规格虚线引导卡 → 弹窗 B new_variant 模式)
   - 右栏 = 选中变体信息面板(顶部小封面缩略图,点击进 lightbox)+ 版本图素材轨:
     信息面板纵向区块条件渲染
     (基础信息恒显 / AI 生成信息仅当前展示图 `source === "ai"` / 出现记录恒显),
     不设「身份信息」区块(Lite 身份字段恒 null,描述并入简介)
   - 变体语义(v1.3):默认选中第一个变体;主图/版本轨/出现记录按选中变体过滤;
     删变体后回落第一个剩余变体
   - 页顶动作位(v1.9 十.1/十.2):顶部主动作「新建资产」退役;仅留「删除资产」
     (软删带确认,成功后回素材列表);变体删除入口常驻左栏网格头(选中变体时)
   ============================================================ */
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bank,
  Camera,
  CheckCircle,
  Cube,
  Diamond,
  ImageSquare,
  Images,
  Mountains,
  MusicNote,
  PawPrint,
  Plus,
  Sparkle,
  SpeakerHigh,
  SpinnerGap,
  Star,
  Sun,
  TShirt,
  UploadSimple,
  User,
  VideoCamera,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  api,
  type LiteAddUsageItem,
  type LiteAssetDetail,
  type LiteAssetUsageEntry,
  type LiteAssetVariant,
  type LiteAssetVersionTrackItem,
  type LiteMatchSuggestItem,
} from "../../api";
import { navigate } from "../../routing";
import { audioKindLabel } from "../../asset-kind-labels";
import { Button } from "../../components/ui/button";
import { Badge, ErrorState, Input, Skeleton, Textarea } from "../../components/ui/primitives";
import { EmptyState, useResource } from "../../ui";
import { cn } from "../../components/ui/cn";
import { humanErrorMessage } from "../batch-generate-drawer";
import type { PageRuntimeProps } from "../global-pages";
import { liteProjectPath } from "./lite-shell";
import { LiteAssetAddImageDialog } from "./lite-asset-add-image-dialog";
import { useLiteRegistrations, type LiteRegistrationEndpoints } from "./lite-registration";
import { newId } from "../../uuid";
import { LiteConfirmDialog, type LiteConfirmState } from "./lite-confirm-dialog";

export interface LiteAssetDetailPageProps extends PageRuntimeProps {
  projectId: string;
  assetEntityId: string;
}

// ---- 纯逻辑辅助(导出供测试) ----

/** lightbox 索引导航:边界 clamp(不循环),空列表或 null 返回 null。 */
export function navigateLightbox(length: number, index: number | null, delta: number): number | null {
  if (length === 0 || index === null) return null;
  const next = index + delta;
  return next >= 0 && next < length ? next : index;
}

/** 变体默认选中:契约 v1.3 默认选第一个变体(非「全部」),空列表返回 null。 */
export function pickDefaultVariant<T extends { is_primary: boolean; variant_id: string }>(variants: T[]): string | null {
  return variants[0]?.variant_id ?? null;
}

/** 「设主图」按钮显示条件:非主图 + 有可用 ID。上传图走 asset_media_id,生成图走 media_result_id,均可翻转。 */
export function canSetAsPrimary(item: { is_primary: boolean; asset_media_id: string | null; media_result_id: string | null }): boolean {
  return !item.is_primary && (item.asset_media_id !== null || item.media_result_id !== null);
}

/** 信息字段的展示值:null/空 → 短横占位(与渲染口径一致)。 */
export function identityDisplay(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

/** 构建详情页路由路径(列表页卡片点击导航用)。 */
export function liteAssetDetailPath(projectId: string, assetEntityId: string): string {
  return `/lite/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetEntityId)}`;
}

/** 关联分镜多条目表单的一行:episode_no/shot_no 为字符串草稿,保存时才转数字校验。
    v1.8(lite-assets 九.4b):变体下拉退役——新记录恒挂当前选中变体(回落第一个变体)。 */
interface UsageDraftRow {
  id: string;
  episodeNo: string;
  shotNo: string;
  sceneName: string;
}

// ---- 本地辅助(不导出) ----

/** 资产类型 → 占位图标(与 asset-widgets 的 KIND_ICONS 同口径;只作占位,不逐处新造图标)。 */
const KIND_ICONS: Record<string, typeof User> = {
  character: User,
  scene: Mountains,
  prop: Diamond,
  costume: TShirt,
  clothing: TShirt,
  lighting: Sun,
  camera: Camera,
  video: VideoCamera,
  sound: SpeakerHigh,
  music: MusicNote,
  animal: PawPrint,
  keyword: Images,
  keyframe: Images,
  reference: Bank,
  other: Bank,
  model_3d: Cube,
};

function AssetKindIcon({ kind, className }: { kind: string | null | undefined; className?: string }): React.JSX.Element {
  const Icon = KIND_ICONS[(kind ?? "").trim().toLowerCase()] ?? ImageSquare;
  return <Icon className={className} aria-hidden="true" />;
}

/** 版本轨 created_at → MM-DD(与 wireframe 时间回显口径一致);非法/空返回空串。 */
function formatDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

/** 返回素材列表:优先历史返回,深链直达(无历史)时回落资产列表路由。 */
function goBack(projectId: string): void {
  if (window.history.length > 1) window.history.back();
  else navigate(liteProjectPath(projectId, "assets"));
}

export function LiteAssetDetailPage({
  projectId,
  assetEntityId,
  demoMode,
  notify,
}: LiteAssetDetailPageProps): React.JSX.Element {
  // --- 资产详情 ---
  const detailResource = useResource(
    () => api.liteGetAsset(projectId, assetEntityId),
    DEMO_DETAIL,
    demoMode,
    [projectId, assetEntityId],
  );

  // --- 变体列表 ---
  const [variants, setVariants] = useState<LiteAssetVariant[]>([]);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const loadVariants = useCallback(async () => {
    if (demoMode) return;
    try {
      const items = await api.liteListAssetVariants(projectId, assetEntityId);
      setVariants(items);
    } catch { /* 静默,详情加载已有提示 */ }
  }, [projectId, assetEntityId, demoMode]);
  useEffect(() => { void loadVariants(); }, [loadVariants]);

  // --- 变体默认选中(契约 v1.3)---
  // 首次加载到变体时自动选中第一个(非「全部」);之后选中变体若被删,回落到第一个剩余变体
  // (变体全删则回落 null,网格只剩「＋ 新建变体」引导卡)。
  const variantInitialized = useRef(false);
  useEffect(() => {
    if (variants.length === 0) {
      if (selectedVariantId !== null) setSelectedVariantId(null);
      return;
    }
    if (!variantInitialized.current) {
      variantInitialized.current = true;
      setSelectedVariantId(pickDefaultVariant(variants));
      return;
    }
    if (selectedVariantId !== null && !variants.some((v) => v.variant_id === selectedVariantId)) {
      setSelectedVariantId(pickDefaultVariant(variants));
    }
  }, [variants, selectedVariantId]);

  // --- 版本图轨 ---
  const [versionTrack, setVersionTrack] = useState<LiteAssetVersionTrackItem[]>([]);
  const [trackLoading, setTrackLoading] = useState(true);
  const loadVersionTrack = useCallback(async () => {
    setTrackLoading(true);
    try {
      if (!demoMode) {
        const items = await api.liteListVersionTrack(projectId, assetEntityId);
        setVersionTrack(items);
      }
    } catch { /* 静默 */ } finally {
      setTrackLoading(false);
    }
  }, [projectId, assetEntityId, demoMode]);
  useEffect(() => { void loadVersionTrack(); }, [loadVersionTrack]);

  // --- 关联分镜 ---
  const [usages, setUsages] = useState<LiteAssetUsageEntry[]>([]);
  // 按当前选中变体过滤(契约 v1.3:variantId 缺省 = 资产级,后端已按 bound+pending 一起过滤)
  const loadUsages = useCallback(async () => {
    if (demoMode) return;
    try {
      setUsages(await api.liteListAssetUsages(projectId, assetEntityId, selectedVariantId ?? undefined));
    } catch { /* 静默 */ }
  }, [projectId, assetEntityId, demoMode, selectedVariantId]);
  useEffect(() => { void loadUsages(); }, [loadUsages]);

  /** 刷新全部数据(弹窗 B 完成后调用)。 */
  const reloadAll = useCallback(() => {
    void detailResource.retry();
    void loadVariants();
    void loadVersionTrack();
    void loadUsages();
  }, [detailResource, loadVariants, loadVersionTrack, loadUsages]);

  // --- 按选中变体筛选版本图轨(null = 尚未选/变体为空,退化为全量)---
  const visibleVersionTrack = selectedVariantId
    ? versionTrack.filter((v) => v.variant_id === selectedVariantId)
    : versionTrack;

  // --- 主图(displayVersion 供 AI 生成信息区块与小封面缩略图用) ---
  // 优先展示主图;无主图时回落到第一张图(上传后未设主图的场景)
  const displayVersion = visibleVersionTrack.find((v) => v.is_primary) ?? visibleVersionTrack[0] ?? null;
  const hasImages = visibleVersionTrack.length > 0;

  // --- 主变体登记状态（自动登记触发模型 2026-08-19：媒体成为主变体即后台登记；
  //    这里 probe 现状，failed 给人工重试出口；asset_media_id 是登记行与 references 共认的键） ---
  const primaryTrackItem = versionTrack.find((v) => v.is_primary) ?? null;
  const primaryMediaKey = primaryTrackItem?.asset_media_id ?? null;
  const registrationEndpoints = useMemo<LiteRegistrationEndpoints>(() => ({
    get: (mediaId) => api.getAssetMediaSeedanceRegistration(assetEntityId, mediaId),
    refresh: (mediaId) => api.refreshAssetMediaSeedance(assetEntityId, mediaId),
    register: (mediaId) => api.registerAssetMediaSeedance(assetEntityId, mediaId),
  }), [assetEntityId]);
  const { registrations, startRegistration, probeRegistrations, reprobeRegistrations } = useLiteRegistrations({ demoMode, notify, endpoints: registrationEndpoints });
  // 主变体变更后立即 probe；自动登记行建行晚于 probe 的窗口由 handleSetPrimary 里的延迟 reprobe 兜底。
  useEffect(() => {
    if (!primaryMediaKey) return;
    probeRegistrations([primaryMediaKey]);
  }, [primaryMediaKey, probeRegistrations]);
  const primaryRegistration = primaryMediaKey ? (registrations[primaryMediaKey] ?? null) : null;

  // --- lightbox ---
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // 切换变体时,lightbox 索引可能越出新的版本轨范围,复位关闭
  useEffect(() => { setLightboxIndex(null); }, [selectedVariantId]);

  // --- 弹窗 B(给变体加图 / 新建变体) ---
  const [addImageDialog, setAddImageDialog] = useState<{ source: "upload" | "ai"; mode: "add_image" | "new_variant" } | null>(null);

  // --- 设主图 ---
  const [settingPrimary, setSettingPrimary] = useState(false);

  // --- 删图 / 删变体(软删,带确认) ---
  const [mediaDeleteBusy, setMediaDeleteBusy] = useState<string | null>(null);
  const [variantDeleteBusy, setVariantDeleteBusy] = useState<string | null>(null);
  /** v1.9 十.11：删除(图/变体)自定义二次确认弹窗状态。 */
  const [confirmState, setConfirmState] = useState<LiteConfirmState | null>(null);

  // --- 关联分镜增删(多条目表单:每行一集 + 分镜号 + 场景 + 变体选择) ---
  const [usageBusy, setUsageBusy] = useState<string | null>(null);
  const [showShotPicker, setShowShotPicker] = useState(false);

  // --- ✨ 匹配剧集(v1.6 路径②:AI 只给建议,勾选后才写入,按 manual 关联处理) ---
  const [suggestStage, setSuggestStage] = useState<"cover" | "list" | null>(null);
  const [suggestItems, setSuggestItems] = useState<LiteMatchSuggestItem[]>([]);
  const [suggestTruncated, setSuggestTruncated] = useState(false);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [suggestChecked, setSuggestChecked] = useState<Set<string>>(() => new Set());

  /** 点按钮 → 先弹覆盖说明层(八.2),确认后拉建议清单。 */
  async function startMatchSuggest(): Promise<void> {
    setSuggestStage("cover");
  }

  async function fetchMatchSuggestions(): Promise<void> {
    if (!selectedVariantId) return;
    setSuggestBusy(true);
    try {
      const result = await api.liteMatchVariantUsages(projectId, assetEntityId, selectedVariantId);
      setSuggestItems(result.items);
      setSuggestTruncated(result.truncated);
      setSuggestChecked(new Set());
      setSuggestStage("list");
    } catch (reason) {
      notify(humanErrorMessage(reason, "AI 匹配失败,请重试"), "error");
    } finally {
      setSuggestBusy(false);
    }
  }

  function toggleSuggestCheck(shotId: string): void {
    setSuggestChecked((prev) => {
      const next = new Set(prev);
      if (next.has(shotId)) next.delete(shotId); else next.add(shotId);
      return next;
    });
  }

  /** 确认勾选 → 走与手动关联完全相同的批量写入路径(八.2 写入段)。 */
  async function confirmMatchSuggestions(): Promise<void> {
    if (!selectedVariantId || suggestChecked.size === 0) return;
    setSuggestBusy(true);
    try {
      const items: LiteAddUsageItem[] = suggestItems
        .filter((item) => suggestChecked.has(item.shot_id))
        .map((item) => ({ shot_id: item.shot_id, variant_id: selectedVariantId }));
      const result = await api.liteAddShotUsages(projectId, assetEntityId, items);
      notify(`已关联 ${result.added} 个分镜${result.pending > 0 ? `(另有 ${result.pending} 条待绑定)` : ""}`, "success");
      setSuggestStage(null);
      setSuggestItems([]);
      setSuggestChecked(new Set());
      void loadUsages();
    } catch (reason) {
      notify(humanErrorMessage(reason, "关联失败,请重试"), "error");
    } finally {
      setSuggestBusy(false);
    }
  }
  const [usageDrafts, setUsageDrafts] = useState<UsageDraftRow[]>([]);

  // Esc 返回上一级(lightbox 开着时让 lightbox 自己处理;弹窗开着时由弹窗处理)
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && lightboxIndex === null && addImageDialog === null && suggestStage === null) {
        goBack(projectId);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [projectId, lightboxIndex, addImageDialog, suggestStage]);

  // --- 基础信息(v1.8 lite-assets 九.4a:三字段一个表单,唯一一对保存/取消) ---
  const [basicEditing, setBasicEditing] = useState(false);
  const [basicSaving, setBasicSaving] = useState(false);
  const [basicDraft, setBasicDraft] = useState({ name: "", intro: "", note: "" });

  function startBasicEdit(): void {
    setBasicDraft({
      name: detailResource.data?.name ?? "",
      intro: detailResource.data?.intro ?? "",
      note: detailResource.data?.note ?? "",
    });
    setBasicEditing(true);
  }

  /** 保存三字段:一次 PATCH name/intro/note(后端本就同收);取消整体回滚、不发请求。 */
  async function saveBasicInfo(): Promise<void> {
    const fallbackName = detailResource.data?.name || "未命名资产";
    const patch = {
      name: basicDraft.name.trim() || fallbackName,
      intro: basicDraft.intro.trim() || null,
      note: basicDraft.note.trim() || null,
    };
    setBasicSaving(true);
    try {
      if (!demoMode) {
        await api.liteUpdateAsset(projectId, assetEntityId, patch);
      }
      detailResource.setData((prev) => (prev ? { ...prev, ...patch } : prev));
      setBasicEditing(false);
      notify("已保存基础信息", "success");
    } catch (reason) {
      notify(humanErrorMessage(reason, "保存失败,请重试"), "error");
    } finally {
      setBasicSaving(false);
    }
  }

  /** 设主图(双 ID 空间:上传图 asset_media_id,生成图 media_result_id → 后端物化后翻转)。 */
  async function handleSetPrimary(item: LiteAssetVersionTrackItem): Promise<void> {
    setSettingPrimary(true);
    try {
      if (!demoMode) {
        await api.liteSetPrimaryMedia(projectId, assetEntityId, item.asset_media_id ?? undefined, item.media_result_id ?? undefined);
      }
      await loadVersionTrack();
      notify(item.media_kind === "audio" ? "已设为主音频" : "已设为主图", "success");
      // 自动登记是翻转提交后的后台任务，登记行可能晚于上面的 probe 建行；延迟 reprobe 兜底
      // （后端建行是毫秒级，3s 足以覆盖；probe 命中后由 10s 轮询接管到 ready/failed）。
      if (!demoMode) {
        const newPrimaryKey = item.asset_media_id ?? item.media_result_id;
        if (newPrimaryKey) window.setTimeout(() => reprobeRegistrations([newPrimaryKey]), 3000);
      }
    } catch (reason) {
      notify(humanErrorMessage(reason, "设主图失败,可能已被他人更改,请刷新"), "error");
      await loadVersionTrack();
    } finally {
      setSettingPrimary(false);
    }
  }

  /** 删除出现记录走二次确认(与删图/删变体同套弹窗):误删 manual 关联要能拦住。 */
  function requestRemoveUsage(entry: LiteAssetUsageEntry): void {
    setConfirmState({
      title: "移除这条出现记录？",
      description: `第${entry.episode_no ?? "?"}集 · 镜${entry.shot_no ?? "?"} 的关联将被移除；自动匹配下次运行时可能重新挂上，届时可再删。`,
      confirmLabel: "移除",
      onConfirm: () => void (async () => {
        await handleRemoveUsage(entry.usage_id);
        setConfirmState(null);
      })(),
    });
  }
  async function handleRemoveUsage(usageId: string): Promise<void> {
    setUsageBusy(usageId);
    try {
      if (!demoMode) {
        await api.liteRemoveShotUsage(projectId, assetEntityId, usageId);
      }
      setUsages((prev) => prev.filter((u) => u.usage_id !== usageId));
      notify("已移除关联", "success");
    } catch (reason) {
      notify(humanErrorMessage(reason, "移除关联失败"), "error");
    } finally {
      setUsageBusy(null);
    }
  }

  /** 新增一条关联表单行(v1.8 九.4b:变体下拉退役,新记录恒挂当前选中变体)。 */
  function addUsageRow(): void {
    setUsageDrafts((prev) => [
      ...prev,
      { id: newId(), episodeNo: "", shotNo: "", sceneName: "" },
    ]);
  }

  function updateUsageRow(id: string, patch: Partial<UsageDraftRow>): void {
    setUsageDrafts((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeUsageRow(id: string): void {
    setUsageDrafts((prev) => prev.filter((row) => row.id !== id));
  }

  /** 批量提交关联分镜(契约 v1.3:一次 liteAddShotUsages 提交数组,返回 added/pending)。 */
  async function handleAddUsages(): Promise<void> {
    const items: LiteAddUsageItem[] = [];
    for (const row of usageDrafts) {
      const episodeNo = parseInt(row.episodeNo.trim(), 10);
      const shotNo = parseInt(row.shotNo.trim(), 10);
      if (!Number.isFinite(episodeNo) || episodeNo <= 0 || !Number.isFinite(shotNo) || shotNo <= 0) {
        notify("请输入有效的集数与分镜号(数字)", "error");
        return;
      }
      items.push({
        episode_no: episodeNo,
        shot_no: shotNo,
        scene_name: row.sceneName.trim() || undefined,
        variant_id: selectedVariantId ?? variants[0]?.variant_id,
      });
    }
    if (items.length === 0) {
      notify("请至少填写一条关联分镜", "error");
      return;
    }
    setUsageBusy("add");
    try {
      let added = 0;
      let pending = 0;
      if (!demoMode) {
        const result = await api.liteAddShotUsages(projectId, assetEntityId, items);
        added = result.added;
        pending = result.pending;
      }
      await loadUsages();
      setUsageDrafts([]);
      setShowShotPicker(false);
      if (demoMode) {
        notify("已添加关联", "success");
      } else {
        notify(pending > 0 ? `已绑定 ${added} 条,${pending} 条待绑定` : `已绑定 ${added} 条`, "success");
      }
    } catch (reason) {
      notify(humanErrorMessage(reason, "添加关联失败,请检查集数和分镜号"), "error");
    } finally {
      setUsageBusy(null);
    }
  }

  /** 删图(双 ID 空间:asset_media_id ?? media_result_id,软删可恢复)。删后刷新全部数据。音频资产文案走音频口径。 */
  function handleDeleteMedia(item: LiteAssetVersionTrackItem, mediaId: string): void {
    const audio = item.media_kind === "audio";
    setConfirmState({
      title: audio ? "删除这段音频？" : "删除这张图？",
      description: "此操作为软删，可在回收站恢复。",
      onConfirm: () => void (async () => {
        setMediaDeleteBusy(mediaId);
        try {
          if (!demoMode) {
            await api.liteDeleteAssetMedia(projectId, assetEntityId, mediaId);
          }
          notify(audio ? "已删除音频" : "已删除图片", "success");
          setConfirmState(null);
          await reloadAll();
        } catch (reason) {
          notify(humanErrorMessage(reason, audio ? "删除音频失败" : "删除图片失败"), "error");
        } finally {
          setMediaDeleteBusy(null);
        }
      })(),
    });
  }

  function handleDeleteVariant(variantId: string, displayName: string): void {
    setConfirmState({
      title: `删除变体「${displayName}」？`,
      description: "其下图片与关联将一并移除。此操作为软删，可在回收站恢复。",
      onConfirm: () => void (async () => {
        setVariantDeleteBusy(variantId);
        try {
          if (!demoMode) {
            await api.liteDeleteAssetVariant(projectId, assetEntityId, variantId);
          }
          notify("已删除变体", "success");
          setConfirmState(null);
          await reloadAll();
        } catch (reason) {
          notify(humanErrorMessage(reason, "删除变体失败"), "error");
        } finally {
          setVariantDeleteBusy(null);
        }
      })(),
    });
  }

  const detail = detailResource.data;

  // --- 渲染 ---

  const workbenchContainer = "mx-auto flex min-h-0 w-full max-w-[1440px] 2xl:max-w-[1920px] flex-1 flex-col gap-4 px-4 py-2";

  if (detailResource.loading) {
    return (
      <div className={workbenchContainer}>
        <Skeleton className="h-12 w-full" />
        <div className="flex min-h-0 flex-1 gap-4">
          <Skeleton className="h-full w-full rounded-md" />
          <Skeleton className="h-full w-full rounded-md" />
        </div>
      </div>
    );
  }
  if (detailResource.error) {
    return (
      <div className={workbenchContainer}>
        <ErrorState message={detailResource.error} onRetry={detailResource.retry} />
      </div>
    );
  }
  if (!detail) {
    return (
      <div className={workbenchContainer}>
        <EmptyState
          title="资产不存在或已被删除"
          description="该资产可能已被移除，或链接有误。返回素材列表重新选择。"
          action={<Button variant="outline" onClick={() => goBack(projectId)}>返回素材</Button>}
        />
      </div>
    );
  }

  // 音频资产:版本轨/变体封面/加料入口全部走音频口径(播放器/图标),不套 <img>。
  const isAudio = detail.asset_kind === "audio";
  /** 音频资产的「主图」文案(徽记/按钮/提示),图片资产保持原文案。 */
  const primaryLabel = isAudio ? "主音频" : "主图";

  return (
    <div className={workbenchContainer}>
      {/* 页顶动作位(v1.9 十.9):删除资产入口收口到素材列表资产卡(二次确认);详情页不再设资产级删除 */}

      {/* 内容区:左右两栏等高、各自独立纵向滚动(§4.4.2) */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* 左栏:变体卡片两列网格(v1.4:主图大卡退役,看图走变体卡封面/小封面/版本轨 → lightbox) */}
        <div className="flex min-h-0 flex-[2] flex-col gap-4 overflow-y-auto pr-2">
          <div className="flex items-center justify-between px-0.5">
            <span className="text-section-title text-ink-2">共 {variants.length} 个变体</span>
          </div>

          {/* 变体卡片两列网格 + 尾行「＋ 新建变体」虚线引导卡 */}
          <div className="grid grid-cols-2 gap-4">
            {variants.map((v) => {
              // 变体封面:主图优先,无主图回落第一张;无版本图走占位不塌陷
              const ownTrack = versionTrack.filter((item) => item.variant_id === v.variant_id);
              const cover = ownTrack.find((item) => item.is_primary) ?? ownTrack[0] ?? null;
              const selected = selectedVariantId === v.variant_id;
              return (
                <div
                  key={v.variant_id}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "group flex cursor-pointer flex-col overflow-hidden rounded-lg border text-left transition-colors",
                    selected
                      ? "border-accent bg-surface-1 ring-1 ring-accent/50"
                      : "border-border-1 bg-surface-1 hover:border-accent/40 hover:bg-surface-2",
                  )}
                  onClick={() => setSelectedVariantId(v.variant_id)}
                  onKeyDown={(e) => { if (e.key === "Enter") setSelectedVariantId(v.variant_id); }}
                >
                  {/* 上图:变体封面(v1.4:封面点击进 lightbox,无媒体 → 弹窗 B add_image;音频资产封面走图标+播放) */}
                  <button
                    type="button"
                    className="relative flex aspect-square items-center justify-center overflow-hidden bg-surface-2"
                    title={cover ? (isAudio ? "点击播放音频" : "点击查看大图") : (isAudio ? "还没有音频,点击添加" : "还没有图片,点击添加")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedVariantId(v.variant_id);
                      if (cover) {
                        const idx = visibleVersionTrack.findIndex((item) => item === cover);
                        if (idx >= 0) setLightboxIndex(idx);
                      } else {
                        setAddImageDialog({ source: "ai", mode: "add_image" });
                      }
                    }}
                  >
                    {cover?.storage_url ? (
                      isAudio ? (
                        <div className="flex flex-col items-center justify-center gap-1 px-2 text-center text-ink-3">
                          <SpeakerHigh className="size-8" weight="duotone" />
                          <span className="w-full truncate text-aux">{v.display_name}</span>
                        </div>
                      ) : (
                        <img src={cover.storage_url} alt={v.display_name} className="h-full w-full object-cover" />
                      )
                    ) : (
                      <div className="flex flex-col items-center justify-center gap-1 px-2 text-center text-ink-4">
                        <AssetKindIcon kind={detail.asset_kind} className="size-6" />
                        <span className="w-full truncate text-aux">{v.display_name}</span>
                      </div>
                    )}
                    {v.is_primary ? (
                      <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-surface-0/90 px-2 py-0.5 text-[10px] text-accent">
                        <Star weight="fill" className="size-3" />{primaryLabel}
                      </span>
                    ) : null}
                    {/* 删变体入口(带确认;软删可恢复) */}
                    <button
                      type="button"
                      className="absolute right-1 top-1 hidden size-5 items-center justify-center rounded-full bg-surface-0/90 text-[11px] text-ink-3 transition-colors hover:text-error group-hover:flex"
                      title="删除该变体"
                      disabled={variantDeleteBusy === v.variant_id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteVariant(v.variant_id, v.display_name);
                      }}
                    >
                      {variantDeleteBusy === v.variant_id ? "…" : "✕"}
                    </button>
                  </button>
                  {/* 下名 */}
                  <div className="min-w-0 px-2 py-2">
                    <span className="block truncate text-section-title text-ink-1">{v.display_name}</span>
                  </div>
                </div>
              );
            })}
            {/* ＋ 新建变体:与变体卡同规格的虚线引导卡(弹窗 B new_variant 模式) */}
            <button
              type="button"
              className="group flex flex-col overflow-hidden rounded-lg border border-dashed border-border-2 text-left transition-colors hover:border-accent hover:bg-accent/5"
              onClick={() => setAddImageDialog({ source: "ai", mode: "new_variant" })}
              title={isAudio ? "新建变体并添加音频" : "新建变体并添加图片"}
            >
              <span className="flex aspect-square items-center justify-center rounded-t-md bg-surface-2/50 text-ink-3 transition-colors group-hover:bg-accent/5 group-hover:text-accent">
                <Plus className="size-6" />
              </span>
              <span className="px-2 py-2 text-center text-section-title text-ink-2 transition-colors group-hover:text-accent">
                新建变体
              </span>
            </button>
          </div>
        </div>

        {/* 右栏:选中变体信息面板 + 版本图素材轨 */}
        <div className="flex min-h-0 flex-[3] flex-col gap-5 overflow-y-auto border-l border-border-1 pl-4">
          {/* 生成中提示 */}
          {detail.has_pending_generation ? (
            <div className="flex items-center gap-2 rounded-md bg-accent/5 px-3 py-2 text-aux text-accent">
              <Sparkle className="size-4 animate-pulse" />{isAudio ? "有音频生成中…" : "有图片生成中…"}
            </div>
          ) : null}

          {/* 选中变体小封面(v1.4:大图区退役后的看图入口之一,点击进 lightbox;音频资产为播放入口) */}
          {displayVersion ? (
            <section className="flex flex-col gap-2">
              {isAudio ? (
                displayVersion.storage_url ? (
                  <audio controls preload="none" src={displayVersion.storage_url} className="h-10 w-64 max-w-full" />
                ) : (
                  <span className="text-aux text-ink-4">无音频</span>
                )
              ) : (
                <button
                  type="button"
                  className="flex aspect-square w-24 items-center justify-center overflow-hidden rounded-md border border-border-1 bg-surface-well/40 transition-colors hover:ring-1 hover:ring-accent/40"
                  title="点击查看大图"
                  onClick={() => {
                    const idx = visibleVersionTrack.findIndex((item) => item === displayVersion);
                    if (idx >= 0) setLightboxIndex(idx);
                  }}
                >
                  {displayVersion.storage_url ? (
                    <img src={displayVersion.storage_url} alt={detail.name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-aux text-ink-4">无图</span>
                  )}
                </button>
              )}
            </section>
          ) : null}

          {/* 基础信息(恒显):三字段一个表单、唯一一对保存/取消(v1.8 lite-assets 九.4a) */}
          <section className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-section-title text-ink-2">基础信息</h2>
              {basicEditing ? null : (
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={startBasicEdit}>编辑</Button>
              )}
            </div>
            {basicEditing ? (
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-aux text-ink-4">名称</span>
                  <Input value={basicDraft.name} onChange={(e) => setBasicDraft((d) => ({ ...d, name: e.target.value }))} placeholder="资产名称" className="h-8 text-xs" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-aux text-ink-4">描述</span>
                  <Textarea value={basicDraft.intro} onChange={(e) => setBasicDraft((d) => ({ ...d, intro: e.target.value }))} rows={2} placeholder="一句话介绍这个资产" className="text-xs" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-aux text-ink-4">备注</span>
                  <Textarea value={basicDraft.note} onChange={(e) => setBasicDraft((d) => ({ ...d, note: e.target.value }))} rows={2} placeholder="选填备注" className="text-xs" />
                </label>
                <div className="flex gap-1">
                  <Button size="sm" className="h-7 text-xs" loading={basicSaving} onClick={() => void saveBasicInfo()}>保存</Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={basicSaving} onClick={() => setBasicEditing(false)}>取消</Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <InfoRow label="名称" value={detail.name} />
                {detail.asset_kind === "audio" ? <InfoRow label="音频分类" value={audioKindLabel(detail.audio_kind)} /> : null}
                <InfoRow label="描述" value={detail.intro} />
                <InfoRow label="备注" value={detail.note} />
              </div>
            )}
          </section>

          {/* AI 生成信息(仅当前展示图 source === "ai") */}
          {displayVersion?.source === "ai" ? (
            <section className="flex flex-col gap-4">
              <h2 className="text-section-title text-ink-2">AI 生成信息</h2>
              <div className="flex items-center gap-2 rounded-md bg-surface-well/40 px-3 py-2">
                <Sparkle className="size-4 shrink-0 text-accent" />
                <span className="text-body text-ink-2">
                  AI 生成
                  {isAudio
                    ? (displayVersion.format ? ` · ${displayVersion.format}` : "")
                    : (displayVersion.width_px && displayVersion.height_px ? ` · ${displayVersion.width_px}×${displayVersion.height_px}` : "")}
                  {formatDate(displayVersion.created_at) ? ` · ${formatDate(displayVersion.created_at)}` : ""}
                </span>
              </div>
            </section>
          ) : null}

          {/* 出现记录(恒显,按选中变体过滤;pending 待绑定);v1.6 变体级「✨ 匹配剧集」 */}
          <section className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-section-title text-ink-2">出现记录</h2>
              {!demoMode && selectedVariantId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  icon={<Sparkle />}
                  onClick={() => void startMatchSuggest()}
                >
                  ✨ 匹配剧集
                </Button>
              ) : null}
            </div>
            <p className="text-aux text-ink-4">
              只匹配已生成分镜的集；未生成分镜的集不会出现在建议里。你手动添加的关联不会被自动匹配改动。
            </p>
            <div className="flex flex-col gap-2">
              {usages.length > 0 ? (
                usages.map((u) => {
                  const bound = u.status === "bound";
                  // 出现记录仅作展示、不可导航(契约 v1.3.1 六.4);pending 加「待绑定」徽记;
                  // 删除限 manual/pending/ai_auto(AI 自动挂可能错,用户要能纠;exact_name 由 backfill 管)。
                  const canRemove = u.matched_by === "manual" || u.matched_by === "ai_auto" || u.status === "pending";
                  return (
                    <div key={u.usage_id} className="flex items-center justify-between gap-2 rounded-md bg-surface-well/40 px-3 py-2">
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="min-w-0 truncate text-body text-ink-2">
                          第{u.episode_no ?? "?"}集 · 镜{u.shot_no ?? "?"}
                          {u.scene_name ? <span className="text-ink-4"> · {u.scene_name}</span> : null}
                          {bound && u.shot_label ? <span className="ml-2 text-aux text-ink-4">（{u.shot_label}）</span> : null}
                          {u.matched_by === "exact_name" ? <span className="ml-2 text-aux text-ink-4">(自动)</span> : null}
                          {u.matched_by === "ai_auto" ? <span className="ml-2 text-aux text-ink-4">(AI 匹配)</span> : null}
                        </span>
                        {bound ? (
                          <CheckCircle className="size-4 shrink-0 text-success" weight="fill" />
                        ) : (
                          <Badge tone="warning">待绑定</Badge>
                        )}
                      </span>
                      {canRemove ? (
                        <button
                          type="button"
                          className="shrink-0 text-aux text-ink-4 transition-colors hover:text-error"
                          disabled={usageBusy === u.usage_id}
                          onClick={() => requestRemoveUsage(u)}
                        >
                          {usageBusy === u.usage_id ? "…" : "删除"}
                        </button>
                      ) : null}
                    </div>
                  );
                })
              ) : (
                <p className="text-aux text-ink-4">暂无关联分镜</p>
              )}
              {showShotPicker ? (
                <div className="flex flex-col gap-2 rounded-md bg-surface-well/30 p-2">
                  {/* 多条目表单:每行 集数 + 分镜号 + 场景(v1.8 九.4b:变体下拉退役,新记录恒挂当前选中变体) */}
                  {usageDrafts.map((row) => (
                    <div key={row.id} className="flex flex-col gap-1.5 rounded-md bg-surface-1/50 p-1.5">
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="number"
                          min={1}
                          value={row.episodeNo}
                          onChange={(e) => updateUsageRow(row.id, { episodeNo: e.target.value })}
                          placeholder="集数 *"
                          className="h-7 w-20 text-xs"
                        />
                        <Input
                          type="number"
                          min={1}
                          value={row.shotNo}
                          onChange={(e) => updateUsageRow(row.id, { shotNo: e.target.value })}
                          placeholder="分镜号 *"
                          className="h-7 w-24 text-xs"
                        />
                        <Input
                          value={row.sceneName}
                          onChange={(e) => updateUsageRow(row.id, { sceneName: e.target.value })}
                          placeholder="场景(选填)"
                          className="h-7 min-w-0 flex-1 text-xs"
                        />
                        <button
                          type="button"
                          className="shrink-0 text-ink-4 hover:text-error"
                          title="删除该行"
                          onClick={() => removeUsageRow(row.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={addUsageRow}>+ 再加一行</Button>
                    <Button size="sm" className="ml-auto h-7 text-xs" loading={usageBusy === "add"} onClick={() => void handleAddUsages()}>确认</Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setShowShotPicker(false); setUsageDrafts([]); }}>取消</Button>
                  </div>
                </div>
              ) : variants.length > 0 ? (
                <Button size="sm" variant="ghost" className="h-7 justify-start text-xs" onClick={() => { setUsageDrafts([]); addUsageRow(); setShowShotPicker(true); }}>
                  + 新增关联分镜
                </Button>
              ) : null}
            </div>
          </section>

          {/* 版本图素材轨(按选中变体过滤;hover 浮「设为主图/主音频」/软删;音频资产轨走音频图标/播放) */}
          <section className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-section-title text-ink-2">{isAudio ? "音频版本轨" : "版本图素材轨"}</h2>
              {/* 主变体登记状态（自动登记触发；仅出现登记行后展示；failed 给重试出口） */}
              {primaryMediaKey !== null && primaryRegistration !== null ? (
                primaryRegistration.phase === "ready" ? (
                  <span className="inline-flex items-center gap-1 text-xs text-success" title={`该${isAudio ? "主音频" : "主图"}已登记为火山参考素材，可直接用于生视频参考`}>
                    <CheckCircle className="size-3.5" weight="fill" aria-hidden="true" />已登记
                  </span>
                ) : primaryRegistration.phase === "failed" ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-error" title={primaryRegistration.error ?? "素材登记未完成"}>
                    <WarningCircle className="size-3.5" weight="fill" aria-hidden="true" />登记失败
                    <button
                      type="button"
                      className="rounded border border-error/50 px-1.5 py-px text-[11px] leading-4 transition-colors hover:bg-error/10"
                      onClick={() => void startRegistration(primaryMediaKey)}
                    >重试</button>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-ink-3" role="status">
                    <SpinnerGap className="size-3.5 animate-spin text-accent-text" aria-hidden="true" />登记中…
                  </span>
                )
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                icon={<Plus />}
                onClick={() => setAddImageDialog({ source: "ai", mode: "add_image" })}
              >
                {isAudio ? "加音频" : "加图"}
              </Button>
            </div>
            <div className="flex gap-2 overflow-x-auto">
              {trackLoading ? (
                <Skeleton className="h-24 w-24 shrink-0" />
              ) : hasImages ? (
                visibleVersionTrack.map((item, idx) => {
                  // 双 ID 空间:优先 asset_media_id(上传),否则 media_result_id(AI 生成)
                  const mediaId = item.asset_media_id ?? item.media_result_id;
                  return (
                    <button
                      key={(item.asset_media_id ?? item.media_result_id) ?? idx}
                      type="button"
                      className="group relative shrink-0"
                      onClick={() => setLightboxIndex(idx)}
                      title={item.is_primary ? primaryLabel : (isAudio ? "点击播放音频" : "点击查看")}
                    >
                      {item.storage_url ? (
                        isAudio ? (
                          <div className={cn(
                            "flex h-24 w-24 items-center justify-center rounded-md border-2",
                            item.is_primary ? "border-accent" : "border-transparent",
                          )}>
                            <SpeakerHigh className="size-5 text-ink-3" weight="duotone" />
                          </div>
                        ) : (
                          <img
                            src={item.storage_url}
                            alt=""
                            className={cn(
                              "h-24 w-24 rounded-md border-2 object-cover",
                              item.is_primary ? "border-accent" : "border-transparent",
                            )}
                          />
                        )
                      ) : (
                        <div className="flex h-24 w-24 items-center justify-center rounded-md border-2 border-dashed border-border-1 text-ink-4">
                          无图
                        </div>
                      )}
                      {/* 来源标记 */}
                      <span className="absolute left-0.5 top-0.5">
                        {item.source === "upload"
                          ? <UploadSimple className="size-3 text-ink-3" weight="fill" />
                          : <Sparkle className="size-3 text-ink-3" weight="fill" />}
                      </span>
                      {item.is_primary ? (
                        <span className="absolute right-0.5 top-0.5">
                          <Star className="size-3 text-accent" weight="fill" />
                        </span>
                      ) : null}
                      {/* 删图入口(带确认;软删可恢复) */}
                      {mediaId ? (
                        <button
                          type="button"
                          className="absolute right-0.5 top-0.5 hidden size-4 items-center justify-center rounded-full bg-surface-1/90 text-[10px] text-ink-3 transition-colors hover:text-error group-hover:flex"
                          title={isAudio ? "删除这段音频" : "删除这张图"}
                          disabled={mediaDeleteBusy === mediaId}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteMedia(item, mediaId);
                          }}
                        >
                          {mediaDeleteBusy === mediaId ? "…" : "✕"}
                        </button>
                      ) : null}
                      {/* 设主图浮层 */}
                      {canSetAsPrimary(item) ? (
                        <button
                          type="button"
                          className="absolute inset-x-0 bottom-0 bg-surface-1/90 py-0.5 text-center text-[10px] text-accent opacity-0 transition-opacity group-hover:opacity-100"
                          disabled={settingPrimary}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleSetPrimary(item);
                          }}
                        >
                          {settingPrimary ? "…" : (isAudio ? "设为主音频" : "设为主图")}
                        </button>
                      ) : null}
                    </button>
                  );
                })
              ) : (
                <p className="text-aux text-ink-4">{isAudio ? "还没有音频 · 点右上角「加音频」上传或生成第一段" : "还没有图片 · 点右上角「加图」上传或生成第一张"}</p>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* lightbox */}
      {lightboxIndex !== null && visibleVersionTrack[lightboxIndex] && (
        <DetailLightbox
          items={visibleVersionTrack}
          index={lightboxIndex}
          primaryLabel={primaryLabel}
          onNavigate={(delta) => {
            setLightboxIndex((cur) => navigateLightbox(visibleVersionTrack.length, cur, delta));
          }}
          onClose={() => setLightboxIndex(null)}
          onSetPrimary={() => {
            const item = visibleVersionTrack[lightboxIndex];
            if (item) void handleSetPrimary(item);
          }}
          settingPrimary={settingPrimary}
        />
      )}

      {/* v1.9 十.11：删除(图/变体)自定义二次确认（取代浏览器原生 confirm） */}
      <LiteConfirmDialog
        state={confirmState}
        busy={mediaDeleteBusy !== null || variantDeleteBusy !== null || usageBusy !== null}
        onClose={() => setConfirmState(null)}
      />

      {/* 弹窗 B(给变体加图 / 新建变体) */}
      {addImageDialog ? (
        <LiteAssetAddImageDialog
          projectId={projectId}
          assetEntityId={assetEntityId}
          defaultSource={addImageDialog.source}
          mode={addImageDialog.mode}
          // v2.4 裁定:new_variant 仅首变体(资产无任何变体)预填资产名称/描述/备注,已有变体时空白
          noExistingVariant={variants.length === 0}
          // 契约 v1.3.1:add_image 模式把当前选中变体传入弹窗 B(仅选中具体变体时;new_variant 不传);
          // 停在「全部」时落到第一个变体;资产无任何变体时不传,由弹窗 B 自动创建第一个变体(六.3)
          variantId={addImageDialog.mode === "add_image" ? (selectedVariantId ?? variants[0]?.variant_id ?? undefined) : undefined}
          asset={detail}
          demoMode={demoMode}
          notify={notify}
          onClose={() => setAddImageDialog(null)}
          onCompleted={() => {
            setAddImageDialog(null);
            reloadAll();
          }}
        />
      ) : null}

      {/* ✨ 匹配剧集 · 覆盖说明层(八.2 覆盖提示:先说明,再拉建议) */}
      {suggestStage === "cover" ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-surface-well/90" onClick={(e) => { if (e.target === e.currentTarget && !suggestBusy) setSuggestStage(null); }}>
          <div className="w-[28rem] max-w-[90vw] rounded-lg border border-border-1 bg-surface-0 p-5 shadow-xl">
            <h3 className="text-base font-medium text-ink-1">✨ 匹配剧集</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              AI 只给建议,不会改动你已填的关联;只有你勾选的条目才会写入(按手动关联处理)。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" disabled={suggestBusy} onClick={() => setSuggestStage(null)}>取消</Button>
              <Button size="sm" loading={suggestBusy} onClick={() => void fetchMatchSuggestions()}>开始匹配</Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ✨ 匹配剧集 · 建议清单弹层(勾选后才写入;同镜已关联同资产其它变体标黄) */}
      {suggestStage === "list" ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-surface-well/90" onClick={(e) => { if (e.target === e.currentTarget && !suggestBusy) setSuggestStage(null); }}>
          <div className="flex max-h-[80vh] w-[36rem] max-w-[92vw] flex-col rounded-lg border border-border-1 bg-surface-0 p-5 shadow-xl">
            <h3 className="text-base font-medium text-ink-1">✨ 匹配剧集 · 建议清单</h3>
            <p className="mt-2 text-aux text-ink-3">勾选后按手动关联写入(manual,永不被自动匹配覆盖)</p>
            {suggestTruncated ? (
              <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-2 text-aux text-ink-2">
                命中超过 50 条,仅展示前 50 条:①收窄集范围重跑;②补充变体描述再匹配。
              </p>
            ) : null}
            {suggestItems.length > 0 ? (
              <div className="mt-2 flex items-center justify-between">
                <span className="text-aux text-ink-3">已选 {suggestChecked.size}/{suggestItems.length}</span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs"
                    disabled={suggestChecked.size === suggestItems.length}
                    onClick={() => setSuggestChecked(new Set(suggestItems.map((item) => item.shot_id)))}
                  >
                    全选
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs"
                    disabled={suggestChecked.size === 0}
                    onClick={() => setSuggestChecked(new Set())}
                  >
                    取消全选
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {suggestItems.length === 0 ? (
                <p className="text-aux text-ink-4">没有新的建议(已有关联已排除)。</p>
              ) : (
                suggestItems.map((item) => (
                  <label
                    key={item.shot_id}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors",
                      item.conflict_variant_name
                        ? "border-warning/50 bg-warning/10"
                        : "border-border-1 bg-surface-well/30 hover:border-accent/40",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={suggestChecked.has(item.shot_id)}
                      onChange={() => toggleSuggestCheck(item.shot_id)}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm text-ink-1">
                        第{item.episode_no}集 · 第{item.shot_no}个分镜
                        {item.scene_name ? <span className="text-ink-4"> · {item.scene_name}</span> : null}
                      </span>
                      {item.reason ? <span className="text-aux text-ink-3">{item.reason}</span> : null}
                      {item.conflict_variant_name ? (
                        <span className="text-aux text-warning">该镜头已关联「{item.conflict_variant_name}」,勾选则并存</span>
                      ) : null}
                    </span>
                  </label>
                ))
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" disabled={suggestBusy} onClick={() => setSuggestStage(null)}>取消</Button>
              <Button
                size="sm"
                loading={suggestBusy}
                disabled={suggestChecked.size === 0}
                onClick={() => void confirmMatchSuggestions()}
              >
                确认写入({suggestChecked.size})
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- 子组件 ---

/** 基础信息展示行(v1.8 九.4a:只读展示;编辑统一走区块内表单,三字段一对保存/取消)。 */
function InfoRow({ label, value }: { label: string; value: string | null }): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 px-2 py-2">
      <span className="shrink-0 text-aux text-ink-4">{label}</span>
      <span className={cn("min-w-0 flex-1 text-right text-body", value ? "text-ink-1" : "text-ink-4")}>
        {identityDisplay(value)}
      </span>
    </div>
  );
}

/** 详情页 lightbox(精简版) */
function DetailLightbox({ items, index, primaryLabel, onNavigate, onClose, onSetPrimary, settingPrimary }: {
  items: LiteAssetVersionTrackItem[];
  index: number;
  primaryLabel: string;
  onNavigate: (delta: number) => void;
  onClose: () => void;
  onSetPrimary: () => void;
  settingPrimary: boolean;
}): React.JSX.Element {
  const item = items[index];
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onNavigate(-1);
      if (e.key === "ArrowRight") onNavigate(1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onNavigate]);

  if (!item) return <></>;

  const isAudioItem = item.media_kind === "audio";

  return (
    <div className="fixed inset-0 z-[70] bg-surface-well/90" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* 顶栏 */}
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-5 py-3">
        <span className="text-sm text-ink-2">{index + 1} / {items.length}</span>
        <div className="flex gap-2">
          {canSetAsPrimary(item) && (
            <Button size="sm" loading={settingPrimary} onClick={onSetPrimary}>{primaryLabel}</Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>✕ 关闭</Button>
        </div>
      </div>
      {/* 媒体:音频渲染播放器,图片渲染原图 */}
      <div className="flex h-full items-center justify-center">
        {item.storage_url ? (
          isAudioItem ? (
            <div className="flex flex-col items-center gap-4 px-6">
              <SpeakerHigh className="size-20 text-ink-3" weight="duotone" />
              <audio controls autoPlay src={item.storage_url} className="w-[min(80vw,560px)]" />
            </div>
          ) : (
            <img src={item.storage_url} alt="" className="max-h-[86vh] max-w-[86vw] object-contain" />
          )
        ) : (
          <div className="flex h-48 items-center justify-center text-ink-4">{isAudioItem ? "无音频预览" : "无图预览"}</div>
        )}
      </div>
      {/* 导航 */}
      {items.length > 1 && (
        <>
          <button
            className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-surface-1/80 p-2 text-ink-2 hover:bg-surface-1"
            onClick={() => onNavigate(-1)}
          >◀</button>
          <button
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-surface-1/80 p-2 text-ink-2 hover:bg-surface-1"
            onClick={() => onNavigate(1)}
          >▶</button>
        </>
      )}
    </div>
  );
}

// --- 演示数据 ---
const DEMO_DETAIL: LiteAssetDetail = {
  asset_entity_id: "demo-asset",
  name: "雨声(演示)",
  intro: "演示模式:这是一个示例音频资产",
  asset_kind: "audio",
  audio_kind: "ambience",
  note: null,
  has_media: false,
  has_primary: false,
  has_pending_generation: false,
  last_modified_at: new Date().toISOString(),
  modified_by_user_id: null,
  gender: "female",
  age_value: 25,
  appearance: "短发,利落",
  hair_description: "齐耳短发",
  outfit_description: "黑色风衣",
  height_cm: 168,
  metadata_lite: null,
};
