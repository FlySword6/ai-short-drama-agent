/* ============================================================
   plaza-page.tsx — 创作广场（项目维度）

   布局照企业微信截图口径：
   - 顶栏「视频 / 图片」双页签，切生成媒介；
   - 左栏 = 生成表单：项目资产按「角色 / 场景 / 道具 / 参考」分组，
     变体扁平化成卡片多选（可取消）；支持上传图片/音频作参考（上传件
     经广场上传接口成为项目资产，即可被勾选引用）；提示词输入；底部
     参数行（模型 + 比例/清晰度/时长等维度 popover，走档位引擎）+
     「生成视频 / 生成图片」按钮；
   - 右栏 = 广场自己的生成记录（plaza_records 独立台账，新→旧），
     不混入项目生产链的在途/产物；点一条记录左栏回显（媒介页签 /
     变体勾选 / 提示词 / 档位），可直接改后重新生成。

   数据：资产/变体/版本轨走 lite 只读接口；生成提交与记录走广场
   专属接口（后端 src/modules/plaza/routes.ts）；demo 走同名 fixture。
   资产分桶唯一判定 = lane-vocabulary 的 laneIdForAssetKind
   （S15 源码守卫：组件层禁写第二处 kinds 精确匹配）；落不了实体栏
   的 kind（上传参考/音频/光影/运镜等）入广场本地「参考」页签。
   ============================================================ */
import { CheckCircle, FilmStrip, Images, MagnifyingGlass, Upload, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type LiteAssetListItem, type LiteAssetVariant, type LiteAssetVersionTrackItem, type PlazaRecord } from "../api";
import {
  activeTiers,
  demoEstimatePoints,
  listCapabilityTiers,
  resolveSelectedTier,
  tierModelLabel,
  tierSubmitInput,
  type CapabilityTier,
} from "../capability-tiers";
import { TierDimensionPopovers } from "../components/gen-params-popover";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import { EmptyState, ErrorState, Select, Skeleton, Textarea } from "../components/ui/primitives";
import { demoPlazaAssets, demoPlazaGenerations, demoPlazaVariants, demoPlazaVersions, demoProjects } from "../demo";
import { businessErrorMessage } from "../error-copy";
import { formatCost } from "../generation-quotes";
import { resolveDimensionPick, type GenerationDimensionKey, type GenerationDimensionValue } from "../generation-dimensions";
import { laneEntries, laneIdForAssetKind } from "../lane-vocabulary";
import { formatDateTime, useResource } from "../ui";
import { newId } from "../uuid";
import type { Project } from "../types";
import type { PageRuntimeProps } from "./global-pages";

/* ---------- 扁平化变体卡 ---------- */

interface PlazaVariant {
  assetId: string;
  assetName: string;
  assetKind: string;
  variantId: string;
  displayName: string;
  isPrimary: boolean;
  imageUrl: string | null;
  /** 该变体可作生成参考的 asset_media id（无图/未登记 = null，勾选只作意向不作参考）。 */
  refMediaId: string | null;
}

interface PlazaBundle {
  assets: LiteAssetListItem[];
  variants: PlazaVariant[];
}

/** 广场本地页签：词表实体域三栏之外的一切（上传参考/音频/光影/运镜等）归「参考」。 */
const PLAZA_REFERENCE_TAB = "reference";

function plazaLaneOf(assetKind: string): string {
  return laneIdForAssetKind(assetKind) ?? PLAZA_REFERENCE_TAB;
}

function variantOfAsset(asset: LiteAssetListItem, variant: LiteAssetVariant, track: LiteAssetVersionTrackItem[]): PlazaVariant {
  const variantTrack = track.filter((item) => item.variant_id === variant.variant_id);
  const reference = variantTrack.find((item) => item.asset_media_id && (item.media_kind ?? "image") === "image") ?? null;
  return {
    assetId: asset.asset_entity_id,
    assetName: asset.name,
    assetKind: asset.asset_kind,
    variantId: variant.variant_id,
    displayName: variant.display_name,
    isPrimary: variant.is_primary,
    imageUrl: variant.image_url ?? variantTrack.find((item) => item.storage_url)?.storage_url ?? asset.primary_media_url,
    refMediaId: reference?.asset_media_id ?? null,
  };
}

async function loadPlazaBundle(projectId: string): Promise<PlazaBundle> {
  const list = await api.liteListAssets(projectId);
  const assets = list.items;
  const perAsset = await Promise.all(assets.map(async (asset) => {
    const [variants, track] = await Promise.all([
      api.liteListAssetVariants(projectId, asset.asset_entity_id),
      api.liteListVersionTrack(projectId, asset.asset_entity_id),
    ]);
    return variants.map((variant) => variantOfAsset(asset, variant, track));
  }));
  return { assets, variants: perAsset.flat() };
}

function demoPlazaBundle(): PlazaBundle {
  const variants = demoPlazaAssets.flatMap((asset) =>
    (demoPlazaVariants[asset.asset_entity_id] ?? []).map((variant) => {
      const track: LiteAssetVersionTrackItem[] = (demoPlazaVersions[asset.asset_entity_id] ?? []).map((version) => ({
        asset_media_id: version.id,
        media_result_id: null,
        storage_url: version.storage_url ?? null,
        is_primary: version.is_primary === true,
        source: "upload",
        width_px: null,
        height_px: null,
        media_kind: version.media_kind ?? "image",
        format: null,
        created_at: version.created_at ?? new Date(0).toISOString(),
        variant_id: version.asset_variant_id ?? null,
      }));
      return variantOfAsset(asset, variant, track);
    }),
  );
  return { assets: demoPlazaAssets, variants };
}

/* ---------- 生成记录状态徽标 ---------- */

function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case "succeeded": return { label: "已完成", className: "bg-success/14 text-success" };
    case "failed": return { label: "失败", className: "bg-danger/14 text-danger" };
    case "cancelled": return { label: "已取消", className: "bg-surface-2 text-ink-3" };
    default: return { label: status === "running" ? "生成中" : "排队中", className: "bg-accent/14 text-accent-text" };
  }
}

/** 在途状态（右侧列表轮询判据）。 */
const ACTIVE_STATUSES: Record<string, true> = { pending: true, running: true };

/* ---------- 页面 ---------- */

export function PlazaPage({ demoMode, notify, projectId: initialProjectId }: PageRuntimeProps & { projectId?: string }): React.JSX.Element {
  /* 项目维度：默认落最近的项目（demo 取 fixture 首个）。 */
  const [projects, setProjects] = useState<Project[]>(demoMode ? demoProjects : []);
  const [projectId, setProjectId] = useState<string>(() =>
    initialProjectId ?? new URLSearchParams(window.location.search).get("project") ?? (demoMode ? demoProjects[0]?.id ?? "" : ""));

  useEffect(() => {
    if (demoMode) return;
    void api.projects().then((list) => {
      setProjects(list.items);
      setProjectId((current) => current || list.items[0]?.id || "");
    }).catch(() => notify("项目列表读取失败，广场需要先选一个项目", "error"));
  }, [demoMode, notify]);

  /* ---------- 左栏：资产变体扁平化多选（页签 = 词表实体域三栏 + 参考） ---------- */
  const lanes = useMemo(() => [
    ...laneEntries().filter((entry) => entry.domain === "entity").map((entry) => ({ id: entry.id, label: entry.displayName })),
    { id: PLAZA_REFERENCE_TAB, label: "参考" },
  ], []);
  const [tab, setTab] = useState<string>(lanes[0]?.id ?? "character");
  const [search, setSearch] = useState("");
  const [selectedVariantIds, setSelectedVariantIds] = useState<ReadonlySet<string>>(new Set());

  const bundle = useResource(() => loadPlazaBundle(projectId), demoPlazaBundle(), demoMode, [projectId]);

  useEffect(() => {
    /* 换项目后旧勾选无意义，清空。 */
    setSelectedVariantIds(new Set());
  }, [projectId]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = Object.fromEntries(lanes.map((lane) => [lane.id, 0]));
    for (const asset of bundle.data?.assets ?? []) {
      const laneId = plazaLaneOf(asset.asset_kind);
      if (counts[laneId] !== undefined) counts[laneId]! += 1;
    }
    return counts;
  }, [bundle.data, lanes]);

  const visibleVariants = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (bundle.data?.variants ?? [])
      .filter((variant) => plazaLaneOf(variant.assetKind) === tab)
      .filter((variant) => !query || variant.assetName.toLowerCase().includes(query) || variant.displayName.toLowerCase().includes(query));
  }, [bundle.data, tab, search]);

  function toggleVariant(variantId: string): void {
    setSelectedVariantIds((current) => {
      const next = new Set(current);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  }

  /* ---------- 左栏：上传图片/音频作参考（上传件成为项目资产） ---------- */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  async function onUploadPicked(file: File): Promise<void> {
    if (demoMode) { notify("离线演示不会上传文件", "info"); return; }
    setUploading(true);
    try {
      await api.plazaUpload(projectId, file);
      notify("已加入项目资产，可在左栏勾选作参考", "success");
      bundle.retry();
    } catch (reason) {
      notify(businessErrorMessage(reason, "上传失败，请稍后重试"), "error");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  /* ---------- 左栏：媒介页签 + 档位配置 ---------- */
  const [mediaKind, setMediaKind] = useState<"video" | "image">("video");
  const [imageTiers, setImageTiers] = useState<CapabilityTier[]>([]);
  const [videoTiers, setVideoTiers] = useState<CapabilityTier[]>([]);
  const [imageTier, setImageTier] = useState<CapabilityTier | null>(null);
  const [videoTier, setVideoTier] = useState<CapabilityTier | null>(null);

  useEffect(() => {
    let active = true;
    void listCapabilityTiers("image", demoMode).then((result) => {
      if (!active) return;
      setImageTiers(result.tiers);
      setImageTier((current) => resolveSelectedTier(result.tiers, current?.tier_id ?? null));
    }).catch(() => notify("图片档位读取失败，请稍后重试", "error"));
    void listCapabilityTiers("video", demoMode).then((result) => {
      if (!active) return;
      setVideoTiers(result.tiers);
      setVideoTier((current) => resolveSelectedTier(result.tiers, current?.tier_id ?? null));
    }).catch(() => notify("视频档位读取失败，请稍后重试", "error"));
    return () => { active = false; };
  }, [demoMode, notify]);

  const tiers = mediaKind === "image" ? imageTiers : videoTiers;
  const selectedTier = mediaKind === "image" ? imageTier : videoTier;
  const setSelectedTier = mediaKind === "image" ? setImageTier : setVideoTier;

  function pickDimension(key: GenerationDimensionKey, value: GenerationDimensionValue): void {
    if (!selectedTier) return;
    if (key === "model_label") {
      /* 广场模型优先：切模型=换模型族，参数重置为该模型默认档（is_default→最便宜）。 */
      const pool = activeTiers(tiers).filter((tier) => tierModelLabel(tier) === value);
      if (pool.length === 0) return;
      const next = pool.find((tier) => tier.is_default === true)
        ?? [...pool].sort((a, b) => demoEstimatePoints(a) - demoEstimatePoints(b) || a.tier_id.localeCompare(b.tier_id))[0]!;
      setSelectedTier(next);
      return;
    }
    const next = resolveDimensionPick(tiers, selectedTier, mediaKind, key, value);
    if (next) setSelectedTier(next);
  }

  /* ---------- 左栏：提示词 ---------- */
  const [prompt, setPrompt] = useState("");

  /* ---------- 右栏：广场自己的生成记录（plaza_records 独立台账） ---------- */
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const history = useResource(
    () => api.plazaRecords(projectId),
    demoPlazaGenerations,
    demoMode,
    [projectId],
  );

  /* 在途任务轮询：有 pending/running 才起表，终态自动停。 */
  const hasActive = (history.data ?? []).some((task) => ACTIVE_STATUSES[task.status] === true);
  useEffect(() => {
    if (demoMode || !projectId || !hasActive) return;
    const timer = window.setInterval(() => history.retry(), 5000);
    return () => window.clearInterval(timer);
    // history 每渲染新身份，依赖只收轮询判据，与 ui.tsx useResource 同款豁免。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, projectId, hasActive]);

  /* ---------- 记录回显：媒介 / 勾选 / 提示词 / 档位 ---------- */
  function restoreRecord(task: PlazaRecord): void {
    setSelectedRecordId(task.id);
    if (task.media_kind === "image" || task.media_kind === "video") setMediaKind(task.media_kind);
    setPrompt(task.prompt);
    if (task.tier_id) {
      const kind: "image" | "video" = task.media_kind === "image" ? "image" : "video";
      const pool = kind === "image" ? imageTiers : videoTiers;
      const hit = activeTiers(pool).find((tier) => tier.tier_id === task.tier_id) ?? null;
      if (kind === "image") setImageTier(hit);
      else setVideoTier(hit);
    }
    /* 参考清单 → 变体勾选（media_id 对版本轨的 asset_media_id）。 */
    const manifest = task.reference_manifest ?? [];
    if (manifest.length > 0 && bundle.data) {
      const variantByMedia = new Map<string, string>();
      for (const variant of bundle.data.variants) {
        if (variant.refMediaId) variantByMedia.set(variant.refMediaId, variant.variantId);
      }
      const next = new Set(selectedVariantIds);
      let restored = 0;
      for (const item of manifest) {
        const variantId = item.media_id ? variantByMedia.get(item.media_id) : undefined;
        if (variantId) { next.add(variantId); restored += 1; }
      }
      if (restored > 0) setSelectedVariantIds(next);
    }
    notify("已回显该记录的提示词、参考与配置，可直接修改后重新生成", "info");
  }

  /* ---------- 提交：广场专属接口（后端走主链 quote→auto-confirm→create 并落台账） ---------- */
  const [submitting, setSubmitting] = useState(false);

  async function submit(): Promise<void> {
    if (!projectId) { notify("先选一个项目，生成要归到项目里", "error"); return; }
    if (!selectedTier) { notify("生成档位还没就绪，请稍后再试", "error"); return; }
    if (!prompt.trim()) { notify("写一句画面描述再生成", "error"); return; }
    const selected = (bundle.data?.variants ?? []).filter((variant) => selectedVariantIds.has(variant.variantId));
    const referenceMediaIds = selected.map((variant) => variant.refMediaId).filter((id): id is string => Boolean(id));
    const { parameters, quantity } = tierSubmitInput(selectedTier);
    if (demoMode) {
      /* 离线演示：合成一条成功记录进右栏，回显链路也能演。 */
      const synthesized: PlazaRecord = {
        id: `demo-plaza-local-${newId()}`,
        generation_request_id: `demo-plaza-local-req-${newId()}`,
        status: "succeeded",
        media_kind: mediaKind,
        prompt: prompt.trim(),
        tier_id: selectedTier.tier_id,
        parameters,
        reference_manifest: referenceMediaIds.map((mediaId) => ({ media_id: mediaId, kind: "image", role: "reference_image" })),
        estimated_cost_fen: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        media_results: mediaKind === "video"
          ? [{ id: `demo-plaza-local-out-${newId()}`, media_kind: "video", storage_url: "/demo-media/ep1-shot-2.mp4" }]
          : [{ id: `demo-plaza-local-out-${newId()}`, media_kind: "image", storage_url: "/demo-media/still-chase.png" }],
      };
      history.setData([synthesized, ...(history.data ?? [])]);
      setSelectedRecordId(synthesized.id);
      notify("离线演示：已记一条示例生成记录，不会提交真实生成", "info");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.plazaGenerate(projectId, {
        mediaKind,
        tierId: selectedTier.tier_id,
        prompt: prompt.trim(),
        referenceMediaIds,
        parameters,
        quantity,
      });
      notify(`${mediaKind === "video" ? "视频" : "图片"}生成任务已提交，右侧记录里看进度`, "success");
      history.retry();
      setSelectedRecordId(result.plaza_record_id);
    } catch (reason) {
      notify(businessErrorMessage(reason, "提交生成失败，请稍后重试"), "error");
    } finally {
      setSubmitting(false);
    }
  }

  /* ---------- 渲染 ---------- */
  const selectedVariants = (bundle.data?.variants ?? []).filter((variant) => selectedVariantIds.has(variant.variantId));

  return (
    <section className="mx-auto flex w-full max-w-[1600px] flex-col gap-4" aria-label="创作广场">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-ink-1">创作广场</h1>
        <Select aria-label="选择项目" className="w-[220px]" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          {projects.length === 0 ? <option value={projectId || ""}>{projectId ? "当前项目" : "暂无项目"}</option> : projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </Select>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-border-1 bg-surface-1 p-1" role="tablist" aria-label="生成媒介">
          {(["video", "image"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={mediaKind === kind}
              className={cn("rounded-md px-4 py-1.5 text-sm transition-colors", mediaKind === kind ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-surface-2/60 hover:text-ink-1")}
              onClick={() => setMediaKind(kind)}
            >
              {kind === "video" ? "视频" : "图片"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-[calc(100dvh-190px)] gap-4 max-[1100px]:flex-col">
        {/* ---------- 左栏：生成表单 ---------- */}
        <div className="flex w-[460px] shrink-0 flex-col gap-3 max-[1100px]:w-full">
          <div className="flex flex-col gap-3 rounded-xl border border-border-1 bg-surface-1 p-3">
            <div className="flex items-center gap-4 border-b border-border-1 pb-2" role="tablist" aria-label="资产分组">
              {lanes.map((lane) => (
                <button
                  key={lane.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === lane.id}
                  className={cn("border-b-2 pb-1 text-sm transition-colors", tab === lane.id ? "border-accent text-accent-text" : "border-transparent text-ink-3 hover:text-ink-1")}
                  onClick={() => setTab(lane.id)}
                >
                  {lane.label}（{tabCounts[lane.id] ?? 0}）
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-2 rounded-lg bg-surface-0/40 p-2">
              <p className="text-xs text-ink-3">当前显示 {visibleVariants.length} 个变体 · 可多选作参考</p>
              <div className="relative">
                <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-4" aria-hidden="true" />
                <input
                  aria-label="按名称搜索资产"
                  className="h-9 w-full rounded-md border border-border-1 bg-surface-0 pl-8 pr-3 text-sm text-ink-1 placeholder:text-ink-4 outline-none transition-colors focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40"
                  placeholder="按名称搜索资产"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>
            {bundle.loading ? (
              <div className="grid grid-cols-3 gap-2">{[0, 1, 2, 3, 4, 5].map((index) => <Skeleton key={index} className="h-24" />)}</div>
            ) : bundle.error ? (
              <ErrorState message={bundle.error} onRetry={bundle.retry} />
            ) : visibleVariants.length === 0 ? (
              <EmptyState title="这一组还没有资产变体" description="到项目资产里补几个角色/场景/道具，或在下方上传参考。" />
            ) : (
              <div className="grid max-h-[260px] grid-cols-3 gap-2 overflow-y-auto pr-1" role="listbox" aria-label="资产变体多选" aria-multiselectable="true">
                {visibleVariants.map((variant) => {
                  const selected = selectedVariantIds.has(variant.variantId);
                  return (
                    <button
                      key={variant.variantId}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      title={`${variant.assetName} · ${variant.displayName}${variant.refMediaId ? "" : "（无可用参考图）"}`}
                      className={cn(
                        "relative flex flex-col items-center gap-1 rounded-lg border p-2 transition-colors",
                        selected ? "border-accent bg-accent/10" : "border-border-1 bg-surface-0/40 hover:border-border-2",
                      )}
                      onClick={() => toggleVariant(variant.variantId)}
                    >
                      {selected ? <CheckCircle weight="fill" className="absolute right-1 top-1 size-4 text-accent-text" aria-hidden="true" /> : null}
                      {variant.imageUrl
                        ? <img src={variant.imageUrl} alt="" className="h-14 w-full rounded-md object-cover" />
                        : <span className="flex h-14 w-full items-center justify-center rounded-md bg-surface-2 text-lg text-ink-3">{variant.assetName.slice(0, 1)}</span>}
                      <span className="w-full truncate text-center text-xs text-ink-1">{variant.displayName}</span>
                      <span className="w-full truncate text-center text-[10px] text-ink-4">{variant.assetName}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 上传参考：图片/音频经广场上传接口成为项目资产，即可被勾选引用。 */}
          <div className="rounded-xl border border-dashed border-border-2 bg-surface-1/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={<Upload />} loading={uploading} onClick={() => fileInputRef.current?.click()}>
                上传图片 / 音频
              </Button>
              <span className="text-xs text-ink-4">上传后成为项目资产，可勾选作参考</span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,audio/*"
                className="hidden"
                aria-label="上传图片或音频作参考"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onUploadPicked(file);
                }}
              />
            </div>
            {selectedVariants.length === 0
              ? <p className="mt-2 text-xs text-ink-4">未选参考：可直接纯文生，也可勾选资产变体后生成。</p>
              : (
                <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="已选参考">
                  <span className="text-xs text-ink-3">已选 {selectedVariants.length} 个：</span>
                  {selectedVariants.map((variant) => (
                    <button key={variant.variantId} type="button" title="点击取消" className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent-subtle px-2 py-0.5 text-xs text-accent-text" onClick={() => toggleVariant(variant.variantId)}>
                      {variant.assetName}·{variant.displayName}
                      {!variant.refMediaId ? <WarningCircle className="size-3 text-warning" aria-label="无可用参考图" /> : null}
                    </button>
                  ))}
                </div>
              )}
          </div>

          <Textarea
            aria-label={mediaKind === "video" ? "视频提示词" : "图片提示词"}
            className="min-h-[140px] flex-1 rounded-xl border-border-1 bg-surface-1"
            placeholder={mediaKind === "video" ? "输入视频提示词，描述画面内容、动作、氛围..." : "输入图片提示词，描述画面内容、构图、光线..."}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />

          <div className="flex flex-wrap items-center gap-2">
            <TierDimensionPopovers tiers={tiers} mediaType={mediaKind} selectedTier={selectedTier} onPick={pickDimension} allowModelSwitch />
            <Button
              variant="primary"
              className="ml-auto"
              icon={mediaKind === "video" ? <FilmStrip /> : <Images />}
              loading={submitting}
              disabled={!projectId || !selectedTier || !prompt.trim()}
              onClick={() => void submit()}
            >
              {mediaKind === "video" ? "生成视频" : "生成图片"}
            </Button>
          </div>
        </div>

        {/* ---------- 右栏：广场生成记录 ---------- */}
        <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-border-1 bg-surface-1 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-1">生成记录</h2>
            <span className="text-xs text-ink-4">{history.data?.length ?? 0} 条 · 点击记录回显到左栏</span>
          </div>
          {history.loading ? (
            <div className="flex flex-col gap-2">{[0, 1, 2].map((index) => <Skeleton key={index} className="h-20" />)}</div>
          ) : history.error ? (
            <ErrorState message={history.error} onRetry={history.retry} />
          ) : (history.data ?? []).length === 0 ? (
            <EmptyState
              title="还没有生成记录"
              description="可直接纯文生，也可添加图片/视频/音频参考后生成。"
              icon={<FilmStrip className="size-8 text-ink-4" />}
            />
          ) : (
            <ul className="flex flex-col gap-2 overflow-y-auto pr-1" aria-label="生成记录列表">
              {(history.data ?? []).map((task) => {
                const badge = statusBadge(task.status);
                const cover = task.media_results.find((media) => media.media_kind === "image")?.storage_url
                  ?? task.media_results.find((media) => media.media_kind === "video")?.storage_url
                  ?? null;
                const isVideo = task.media_kind === "video";
                return (
                  <li key={task.id}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors",
                        selectedRecordId === task.id ? "border-accent bg-accent/10" : "border-border-1 bg-surface-0/40 hover:border-border-2",
                      )}
                      onClick={() => restoreRecord(task)}
                    >
                      {cover
                        ? (isVideo
                          ? <span className="relative h-14 w-20 shrink-0 overflow-hidden rounded-md bg-surface-2"><video src={cover} muted className="h-full w-full object-cover" /></span>
                          : <img src={cover} alt="" className="h-14 w-20 shrink-0 rounded-md object-cover" />)
                        : <span className="flex h-14 w-20 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-4">{isVideo ? <FilmStrip className="size-5" /> : <Images className="size-5" />}</span>}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink-1">{task.prompt || "（无提示词）"}</span>
                        <span className="mt-0.5 block text-xs text-ink-4">
                          {isVideo ? "视频" : task.media_kind === "image" ? "图片" : "音频"}
                          {typeof task.estimated_cost_fen === "number" && task.estimated_cost_fen > 0 ? ` · ${formatCost(task.estimated_cost_fen)}` : ""}
                          {task.created_at ? ` · ${formatDateTime(task.created_at)}` : ""}
                        </span>
                        {task.status === "failed" && task.display_reason ? <span className="mt-0.5 block truncate text-xs text-danger">{task.display_reason}</span> : null}
                      </span>
                      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs", badge.className)}>{badge.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
