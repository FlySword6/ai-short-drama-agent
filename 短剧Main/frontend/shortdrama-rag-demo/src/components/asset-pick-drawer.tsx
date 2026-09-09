/* ============================================================
   asset-pick-drawer.tsx — W5.5 台内资产抽屉（Dario #6）· S9-19 两模式分化

   「从资产库选」与「匹配 + 选择资产」不再开同一个抽屉：
   - browse（从资产库选）= 浏览选择器：类型过滤 + 搜索 + 分页，选中即加入项目；
     槽位感知——角色/场景/道具槽带 kind 锁定（角色槽只列角色类：含子类动物,族表上卷 K2T）。
   - match（匹配 + 选择资产）= 匹配候选流：已加入管理 + 候选列表带匹配理由 + 采纳按钮。
     匹配现状=本地子串过滤（assetMatchesPick），理由文案如实写「名称/简介包含关键词」，
     不暗示 AI 智能匹配（S9-13 定性半真触点，措辞诚实化）。
   分页：后端 GET /assets 不收 limit/offset/page（src/modules/assets/routes.ts
   assetListSchema 只有 scope/project_id/query/asset_kind/status），故前端切片分页。

   视图层：Tailwind utility + ui 原语（Button/Input/Select/Badge/Skeleton）；
   本模块不 import 任何 CSS，保证 node:test 可直接 import。
   ============================================================ */
import { Check, ImageSquare, MagnifyingGlass, VideoCamera, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { assetAttachGate, assetReviewLabelOf } from "../asset-review";
import { demoCommonAssets, demoPersonalAssets } from "../demo";
import { businessErrorMessage } from "../error-copy";
import { isRecord } from "../generation-quotes";
import type { Asset, ProjectAssetRef } from "../types";
import {
  assetKindLabel,
  assetKindRawTitle,
  assetName,
  findImageUrl,
  useResource,
} from "../ui";
import type { PageRuntimeProps } from "../pages/global-pages";
import { AssetKindSelectOptions, assetKindMatches } from "./asset-shared";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Badge, ErrorState, Input, Select, Skeleton } from "./ui/primitives";

/* ============================================================
   纯逻辑（供 src/workbench-w55.test.ts / src/s9-generation.test.ts 复用）
   ============================================================ */

/** 项目资产引用 → 参与匹配/展示的资产实体（与两个工作台页的 refAsset 同口径）。 */
export function pickRefAsset(ref: ProjectAssetRef): Asset {
  return ref.asset ?? ref.snapshot ?? ref.version_snapshot?.entity ?? { id: ref.asset_entity_id || ref.asset_id || ref.id, name: "未命名项目资产", asset_kind: "character" };
}

/** 引用的去重键：加入判断以资产实体 id 为准（同 asset-upload-modal 的 introducedIds 口径）。 */
export function refAssetKey(ref: ProjectAssetRef): string {
  return ref.asset_entity_id || ref.asset_id || ref.id;
}

/** 类型筛选 + 名称/简介搜索（大小写不敏感子串；空白关键词放行）。
   K2T：类型匹配走族表(assetKindMatches)——主值/别名命中+子类上卷,
   角色槽(kind=character)同时列出动物(animal parent=character),不再精确匹配。 */
export function assetMatchesPick(asset: Asset, kind: string, query: string): boolean {
  if (kind && !assetKindMatches(asset.asset_kind, kind)) return false;
  const keyword = query.trim().toLowerCase();
  if (!keyword) return true;
  return assetName(asset).toLowerCase().includes(keyword)
    || (asset.intro ?? "").toLowerCase().includes(keyword);
}

/**
 * S9-19 匹配理由（诚实口径）：现状匹配就是本地子串过滤，有什么说什么——
 * 关键词命中名称/简介，或只是类型/范围过滤的结果；不暗示 AI 智能匹配。
 */
export function matchReason(asset: Asset, kind: string, query: string): string {
  const keyword = query.trim();
  if (keyword) {
    const lower = keyword.toLowerCase();
    return assetName(asset).toLowerCase().includes(lower) ? `名称包含「${keyword}」` : `简介包含「${keyword}」`;
  }
  if (kind) return `类型筛选：${assetKindLabel(kind)}`;
  return "资产中心候选（未按相关度排序）";
}

/** 候选列表分页大小（前端切片；后端 /assets 尚无分页参数，见文件头注释）。 */
export const PICK_PAGE_SIZE = 12;

/** 前端切片分页：page 从 0 计，越界回空片。 */
export function slicePage<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const start = Math.max(0, page) * pageSize;
  return items.slice(start, start + pageSize);
}

/** 总页数（空列表也算 1 页，页码展示不出 0）。 */
export function pickPageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * 加入项目需要一个图片版本：先读资产实体上内嵌的主图（metadata.primary_image.id），
 * 读不到再查一次版本列表（与 project-pages 的 resolvePrimaryMediaId 同口径）。
 */
export async function resolveAssetPrimaryMediaId(asset: Asset): Promise<string | null> {
  const embedded = asset.metadata?.primary_image;
  if (isRecord(embedded) && typeof embedded.id === "string" && embedded.id) return embedded.id;
  try {
    const versions = await api.assetVersions(asset.id);
    return versions.items.find((item) => item.is_primary)?.id ?? versions.items[0]?.id ?? null;
  } catch {
    return null;
  }
}

/* ============================================================
   组件：台内资产抽屉
   ============================================================ */

/**
 * 迷你资产缩略（40px 井）：ui.tsx AssetThumb 的旧全局类带固定 150px 高度，
 * 工作台行内/抽屉列表统一用本件；两个工作台页也从这里取。
 */
export function AssetMiniThumb({ asset, kind = "image", size = "md" }: { asset?: Asset; kind?: "image" | "video"; size?: "md" | "sm" }): React.JSX.Element {
  const url = findImageUrl(asset);
  const box = size === "sm" ? "size-5" : "size-10";
  if (url) return <img className={`${box} shrink-0 rounded-sm border border-border-1 bg-surface-well object-cover`} src={url} alt={assetName(asset)} loading="lazy" />;
  const Icon = kind === "video" ? VideoCamera : ImageSquare;
  return <span className={`flex ${box} shrink-0 items-center justify-center rounded-sm border border-border-1 bg-surface-well text-ink-4`}><Icon aria-hidden="true" className={size === "sm" ? "size-3" : "size-4"} /></span>;
}

/** 分段开关（资产范围 / 生成模式共用样式）：选中=凸起，未选=文字。 */
export function segmentedOptionClass(active: boolean): string {
  return cn(
    "inline-flex items-center justify-center gap-1.5 rounded-sm px-3 py-1.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent [&_svg]:size-3.5",
    active ? "bg-surface-2 text-ink-1 shadow-sm" : "text-ink-2 hover:text-ink-1",
  );
}

interface AssetPickDrawerProps {
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  /** 当前项目已选资产（页面经 api.projectAssets 读入并传入，操作后页面侧刷新）。 */
  refs: ProjectAssetRef[];
  /** 页面侧加入实现：demo 本地加 / 真实 api.addProjectAsset + 刷新；返回是否成功加入。 */
  onAdd: (asset: Asset) => Promise<boolean>;
  /** 页面侧移出实现：demo 本地移出 / 真实 api.removeProjectAsset + 刷新。 */
  onRemove: (ref: ProjectAssetRef) => Promise<void>;
  onClose: () => void;
  /** S9-19 分化：match=匹配候选流（匹配理由+采纳）；browse=浏览选择器（类型过滤+搜索+分页）。 */
  mode?: "match" | "browse";
  /** 槽位感知：锁定只列某个资产类型（如角色槽只列角色类,子类动物随族表上卷）；缺省=不限，类型筛选可手改。 */
  kind?: string;
  /** R2 多选带入(browse 限定):行变勾选,底栏「带入 N 件」一次批量加入后关屉;
     用于备戏台一次拉齐多条 lane,消灭三次抽屉往返(T2 点击比 ≤1.2)。 */
  multi?: boolean;
  onAddMany?: (assets: Asset[]) => Promise<void>;
}

export function AssetPickDrawer({ demoMode, notify, refs, onAdd, onRemove, onClose, mode = "match", kind = "", multi = false, onAddMany }: AssetPickDrawerProps): React.JSX.Element {
  const browsing = mode === "browse";
  const [scope, setScope] = useState<"personal" | "common">("personal");
  const [kindFilter, setKindFilter] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [addingId, setAddingId] = useState("");
  const [removingId, setRemovingId] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [bringing, setBringing] = useState(false);
  /** 槽位锁定的类型优先；未锁定走手动类型筛选。 */
  const lockedKind = kind.trim();
  const effectiveKind = lockedKind || kindFilter;
  const title = browsing ? (multi ? "从资产库选（可多选带入）" : "从资产库选") : "匹配 + 选择资产";

  // Escape 关闭（与 modal/其他抽屉一致）
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const demoCandidates = scope === "personal" ? demoPersonalAssets : demoCommonAssets;
  const candidateState = useResource(
    () => api.assets({ scope }),
    { items: demoCandidates, count: demoCandidates.length },
    demoMode,
    [scope, demoCandidates],
  );

  // 过滤条件变化回第一页（不换数据源）
  useEffect(() => { setPage(0); setSearchPage(1); }, [scope, effectiveKind, query]);

  /* S13：混合检索接真——有查询词时走 POST /asset-search（词法+语义服务端融合，
     前端没有也不需要「模式」概念）；分页接真（page/page_size+has_more，前端切片退役）。
     槽位类型过滤保留为前端过滤（后端检索暂无 kind 参数，回执口径）。
     demo 走本地子串过滤（fixture，不打扰真链）。 */
  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length > 0 && !demoMode;
  const [searchPage, setSearchPage] = useState(1);
  const searchState = useResource(
    () => api.assetSearch(trimmedQuery, { scope, page: searchPage, pageSize: PICK_PAGE_SIZE }),
    { items: [] as Asset[], count: 0, page: 1, pageSize: PICK_PAGE_SIZE, hasMore: false },
    demoMode || !searching,
    [scope, trimmedQuery, searchPage],
  );

  const addedKeys = useMemo(() => new Set(refs.map(refAssetKey)), [refs]);
  const visibleRefs = useMemo(
    () => refs.filter((ref) => assetMatchesPick(pickRefAsset(ref), effectiveKind, query)),
    [refs, effectiveKind, query],
  );
  const filteredCandidates = useMemo(() => {
    if (searching) return (searchState.data?.items ?? []).filter((asset) => assetMatchesPick(asset, effectiveKind, ""));
    return (candidateState.data?.items ?? []).filter((asset) => assetMatchesPick(asset, effectiveKind, query));
  }, [searching, searchState.data, candidateState.data, effectiveKind, query]);
  const pageCount = pickPageCount(filteredCandidates.length, PICK_PAGE_SIZE);
  const currentPage = Math.min(page, pageCount - 1);
  const candidates = searching ? filteredCandidates : slicePage(filteredCandidates, currentPage, PICK_PAGE_SIZE);

  async function add(asset: Asset): Promise<void> {
    if (addingId) return;
    setAddingId(asset.id);
    try {
      await onAdd(asset);
    } catch (reason) {
      notify(businessErrorMessage(reason, "加入资产失败"), "error");
    } finally {
      setAddingId("");
    }
  }

  function toggleSelect(assetId: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  /** R2 多选带入:批量回调后关屉(已选条目由页面刷新自然呈现)。 */
  async function bringMany(): Promise<void> {
    if (!onAddMany || selectedIds.size === 0 || bringing) return;
    setBringing(true);
    try {
      const chosen = filteredCandidates.filter((asset) => selectedIds.has(asset.id));
      await onAddMany(chosen);
      onClose();
    } catch (reason) {
      notify(businessErrorMessage(reason, "带入失败，请重试"), "error");
    } finally {
      setBringing(false);
    }
  }

  async function remove(ref: ProjectAssetRef): Promise<void> {
    if (removingId) return;
    setRemovingId(ref.id);
    try {
      await onRemove(ref);
    } catch (reason) {
      notify(businessErrorMessage(reason, "移出项目失败"), "error");
    } finally {
      setRemovingId("");
    }
  }

  const rowClass = "flex items-center gap-2 rounded-md border border-border-1 bg-surface-2 p-2";

  return (
    <>
      <div className="fixed inset-0 z-[60] animate-fade-in bg-surface-well/70 backdrop-blur-sm" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()} />
      <aside className="fixed inset-y-0 right-0 z-[61] flex w-[min(640px,100vw)] animate-fade-up flex-col border-l border-border-2 bg-surface-1 shadow-[0_24px_48px_-16px_oklch(0_0_0/0.60)]" role="dialog" aria-modal="true" aria-label={title}>
        <header className="flex items-start justify-between gap-3 border-b border-border-1 px-5 py-4">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-ink-1 text-section-title">{title}</h2>
            <p className="text-xs text-ink-2">{browsing
              ? "浏览资产中心，选中即加入项目（建立引用，不复制文件）。"
              : "加入 = 建立项目引用（不复制文件）；移出只解除引用。全程不离开工作台。"}</p>
          </div>
          <Button size="icon" variant="ghost" aria-label="关闭" title="关闭" onClick={onClose}><X /></Button>
        </header>
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-52 flex-1">
              <MagnifyingGlass aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-2" />
              <Input
                className="pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜角色、场景、道具…支持自然语言"
              />
            </label>
            {lockedKind ? (
              <Badge tone="outline">只列{assetKindLabel(lockedKind)}</Badge>
            ) : (
              <Select aria-label="类型筛选" className="w-auto" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
                <option value="">全部类型</option>
                <AssetKindSelectOptions />
              </Select>
            )}
          </div>

          {browsing ? null : (
          <section className="flex flex-col gap-2" aria-label="已加入项目的资产">
            <h3 className="text-xs font-medium text-ink-2">已加入项目（{refs.length}）</h3>
            {refs.length === 0 ? (
              <p className="text-xs text-ink-2">还没有项目资产，从下方资产中心加入。</p>
            ) : visibleRefs.length === 0 ? (
              <p className="text-xs text-ink-2">筛选条件下没有已加入资产。</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {visibleRefs.map((ref) => {
                  const asset = pickRefAsset(ref);
                  /* GP-14：已加入的待审/已拒绝资产也要带徽标（栏内同源标识，移出始终允许）。 */
                  const joinedReview = assetReviewLabelOf(asset);
                  return (
                    <div className={rowClass} key={ref.id}>
                      <AssetMiniThumb asset={asset} />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <strong className="truncate text-xs font-semibold text-ink-1">{assetName(asset)}</strong>
                          {joinedReview ? <Badge tone={joinedReview === "已拒绝" ? "danger" : "warning"}>{joinedReview}</Badge> : null}
                        </span>
                        <small className="truncate text-[11px] text-ink-2" title={assetKindRawTitle(asset.asset_kind)}>{assetKindLabel(asset.asset_kind)}{asset.intro ? ` · ${asset.intro}` : ""}</small>
                      </div>
                      <Button
                        size="sm"
                        variant="danger-outline"
                        disabled={Boolean(removingId)}
                        title="移出 = 解除项目引用，不影响资产中心本体"
                        onClick={() => void remove(ref)}
                      >{removingId === ref.id ? "移出中…" : "移出"}</Button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          )}

          <section className="flex flex-col gap-2" aria-label={browsing ? "资产中心候选" : "匹配候选"}>
            <header className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-medium text-ink-2">{browsing ? "资产中心" : "匹配候选"}</h3>
              <div className="inline-flex items-center gap-1 rounded-md border border-border-1 bg-surface-0 p-1" role="group" aria-label="资产范围">
                <button className={segmentedOptionClass(scope === "personal")} type="button" aria-pressed={scope === "personal"} onClick={() => setScope("personal")}>个人资产</button>
                <button className={segmentedOptionClass(scope === "common")} type="button" aria-pressed={scope === "common"} onClick={() => setScope("common")}>通用资产</button>
              </div>
            </header>
            {browsing ? null : (
              <p className="text-[11px] text-ink-4">{searching ? "候选由平台检索按关键词召回（词法与语义已在服务端融合）。" : "已加入项目的资产与库内候选；输入关键词按平台检索召回。"}</p>
            )}
            {(searching ? searchState.loading : candidateState.loading) ? (
              <div className="flex flex-col gap-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
            ) : (searching ? searchState.error : candidateState.error) ? (
              <ErrorState message={(searching ? searchState.error : candidateState.error) ?? ""} onRetry={(searching ? searchState.retry : candidateState.retry)} />
            ) : filteredCandidates.length === 0 ? (
              searching ? (
                <p className="text-xs text-ink-2">没搜到「{trimmedQuery}」。<a className="text-accent-text underline underline-offset-4" href="/assets" target="_blank" rel="noreferrer">去资产中心看全部</a></p>
              ) : (
                <p className="text-xs text-ink-2">这个范围里没有符合筛选的资产。</p>
              )
            ) : (
              <div className="flex flex-col gap-1.5">
                {candidates.map((asset) => {
                  const added = addedKeys.has(asset.id);
                  const selected = selectedIds.has(asset.id);
                  /* GP-14（剧本步 10）：待审关口入口侧可见——徽标标出审核态；
                     挂入行为对齐后端 422（control-packages assertReferenceAccessible：
                     pending_review/rejected 挂控制包一律拒，「检索可见可看不可用」，全栏同口径），
                     故待审核/已拒绝候选置灰 + 人话原因，不再等点完被后端弹回来。 */
                  const reviewLabel = assetReviewLabelOf(asset);
                  const gate = assetAttachGate(asset);
                  const selectable = multi && !added && gate.allowed;
                  return (
                    <div
                      className={cn(rowClass, selectable && "cursor-pointer", selected && "border-accent bg-accent-subtle")}
                      key={asset.id}
                      data-review-status={reviewLabel ?? undefined}
                      role={selectable ? "checkbox" : undefined}
                      aria-checked={selectable ? selected : undefined}
                      onClick={selectable ? () => toggleSelect(asset.id) : undefined}
                    >
                      <AssetMiniThumb asset={asset} />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <strong className="truncate text-xs font-semibold text-ink-1">{assetName(asset)}</strong>
                          {reviewLabel ? <Badge tone={reviewLabel === "已拒绝" ? "danger" : "warning"}>{reviewLabel}</Badge> : null}
                        </span>
                        <small className="truncate text-[11px] text-ink-2" title={assetKindRawTitle(asset.asset_kind)}>{assetKindLabel(asset.asset_kind)}{asset.intro ? ` · ${asset.intro}` : ""}</small>
                        {browsing ? null : <small className="truncate text-[11px] text-ink-4">{searching ? `按「${trimmedQuery}」召回` : matchReason(asset, effectiveKind, query)}</small>}
                        {!gate.allowed && !added ? <small className="text-[11px] text-ink-4">{gate.reason}</small> : null}
                      </div>
                      {added ? (
                        <Badge tone="success"><Check aria-hidden="true" className="size-3" />已加入</Badge>
                      ) : multi ? (
                        <span
                          className={cn(
                            "flex size-5 shrink-0 items-center justify-center rounded-sm border transition-colors",
                            selected ? "border-accent bg-accent text-accent-ink" : "border-border-2 text-transparent",
                            !gate.allowed && "opacity-40",
                          )}
                          aria-hidden="true"
                        >
                          <Check className="size-3.5" weight="bold" />
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={Boolean(addingId) || !gate.allowed}
                          title={gate.allowed ? undefined : gate.reason}
                          onClick={() => void add(asset)}
                        >{addingId === asset.id ? "加入中…" : browsing ? "加入" : "采纳"}</Button>
                      )}
                    </div>
                  );
                })}
                {searching ? (
                  <div className="flex items-center justify-between gap-2 pt-1 text-xs text-ink-2">
                    <span>第 {searchPage} 页{searchState.data?.hasMore ? " · 还有下一页" : ""}</span>
                    <span className="flex items-center gap-1">
                      <Button size="sm" variant="outline" disabled={searchPage <= 1} onClick={() => setSearchPage(searchPage - 1)}>上一页</Button>
                      <Button size="sm" variant="outline" disabled={!searchState.data?.hasMore} onClick={() => setSearchPage(searchPage + 1)}>下一页</Button>
                    </span>
                  </div>
                ) : filteredCandidates.length > PICK_PAGE_SIZE ? (
                  <div className="flex items-center justify-between gap-2 pt-1 text-xs text-ink-2">
                    <span>第 {currentPage + 1} / {pageCount} 页 · 共 {filteredCandidates.length} 项</span>
                    <span className="flex items-center gap-1">
                      <Button size="sm" variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button>
                      <Button size="sm" variant="outline" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>下一页</Button>
                    </span>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border-1 px-5 py-3">
          <span className="mr-auto text-xs text-ink-2">{multi ? (selectedIds.size > 0 ? `已选 ${selectedIds.size} 件，一次带入` : "勾选多件，一次带入；资产本体不受影响。") : "操作即时生效并刷新已选资产条；资产本体不受影响。"}</span>
          {multi ? (
            <Button variant="secondary" disabled={selectedIds.size === 0 || bringing} onClick={() => void bringMany()}>
              {bringing ? "带入中…" : `带入 ${selectedIds.size > 0 ? selectedIds.size : ""} 件`}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>完成</Button>
        </footer>
      </aside>
    </>
  );
}
