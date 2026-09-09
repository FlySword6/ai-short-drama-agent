/* ============================================================
   grid-split-modal.tsx — W6-2 宫格切分（LibTV 参考，控制材料生产第一步）
   对已生成图做纯本地等分裁切（canvas 逐格出 PNG）。切分的目的是下一步生产：
   - 选格创建粗剪素材组：每格图入资产库并挂进项目资产，同时建成对应粗剪素材
     （Dario 第一性原理指正：切完不该还要去资产中心手动引入）；
   - 逐格入资产库备用（复用 W5-1 通道：ingestJsonAssets + uploadAssetMedia）；
   - 单格高清化：接口未接入，置灰明示（纪律：高清/扩图/重绘不出现在可用 UI）。
   一键全存：一次批量 ingest + 逐格挂图，部分失败如实报数。
   纪律：高清/扩图/重绘/擦除/抠图不出现在 UI。
   视图层：Tailwind utility + ui 原语（Dialog/Button/Skeleton/Input）；
   本模块不 import 任何 CSS，保证 node:test 可直接 import。
   ============================================================ */
import { ArrowClockwise, CheckCircle, FilmStrip, FolderPlus, GridFour, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, api } from "../api";
import { fetchReadableImage } from "../asset-media";
import { humanErrorMessage } from "../pages/batch-generate-drawer";
import type { PageRuntimeProps } from "../pages/global-pages";
import type { JsonAssetIngestItem, Shot } from "../types";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input, Skeleton } from "./ui/primitives";
import {
  PROMOTE_MAX_FILE_BYTES,
  buildPromoteIngestItem,
  type PromoteSourceMedia,
} from "./promote-asset-modal";
/* ============================================================
   纯逻辑（src/w6-grid.test.ts 直接断言）
   ============================================================ */

export interface GridSpec {
  rows: number;
  cols: number;
}

/** 预置宫格选项；自定义走 normalizeGridSpec（rows 1-6 × cols 1-6）。 */
export const GRID_PRESET_OPTIONS: ReadonlyArray<{ key: string; label: string; spec: GridSpec }> = [
  { key: "2x2", label: "2×2", spec: { rows: 2, cols: 2 } },
  { key: "3x3", label: "3×3", spec: { rows: 3, cols: 3 } },
  { key: "4x4", label: "4×4", spec: { rows: 4, cols: 4 } },
  { key: "5x5", label: "5×5", spec: { rows: 5, cols: 5 } },
];

export const GRID_CUSTOM_MIN = 1;
export const GRID_CUSTOM_MAX = 6;

/** 自定义行列 clamp：非有限数回落 1，超出 1-6 截断。 */
export function clampGridDimension(value: number): number {
  if (!Number.isFinite(value)) return GRID_CUSTOM_MIN;
  return Math.min(GRID_CUSTOM_MAX, Math.max(GRID_CUSTOM_MIN, Math.round(value)));
}

export function normalizeGridSpec(rows: number, cols: number): GridSpec {
  return { rows: clampGridDimension(rows), cols: clampGridDimension(cols) };
}

export interface GridCellRect {
  /** 1-based 行列（命名 R{row}C{col}）。 */
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 等分裁切坐标：行/列方向先取整除得基准边长，奇数余数逐 1px 分配给
   前面的行/列，保证整组坐标无缝铺满原图（不丢像素、不越界）。
 */
export function gridCellRects(width: number, height: number, spec: GridSpec): GridCellRect[] {
  const { rows, cols } = normalizeGridSpec(spec.rows, spec.cols);
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const baseColWidth = Math.floor(w / cols);
  const extraCols = w % cols;
  const baseRowHeight = Math.floor(h / rows);
  const extraRows = h % rows;
  const rects: GridCellRect[] = [];
  let y = 0;
  for (let row = 1; row <= rows; row += 1) {
    const cellHeight = baseRowHeight + (row <= extraRows ? 1 : 0);
    let x = 0;
    for (let col = 1; col <= cols; col += 1) {
      const cellWidth = baseColWidth + (col <= extraCols ? 1 : 0);
      rects.push({ row, col, x, y, width: cellWidth, height: cellHeight });
      x += cellWidth;
    }
    y += cellHeight;
  }
  return rects;
}

/** 宫格命名：R{行}C{列}（1-based）。 */
export function gridCellLabel(row: number, col: number): string {
  return `R${row}C${col}`;
}

/** 入库资产名：`{素材标题} · 宫格 R{行}C{列}`；标题空回落「素材图」。 */
export function gridCellAssetName(baseTitle: string, row: number, col: number): string {
  const base = baseTitle.trim() || "素材图";
  return `${base} · 宫格 ${gridCellLabel(row, col)}`;
}

/**
 * 宫格资产基底名（S7-11）：切出来的格是素材（关键帧），不是分镜——
 * 自动生成的「分镜 N」标题归一为「素材 N」；有实义标题（如「北疆战场」）沿用；
 * 无标题按镜号回落「素材 N」，再缺回落「素材图」。
 */
export function gridAssetBaseName(shot: Pick<Shot, "title" | "shot_no"> | null | undefined): string {
  const title = shot?.title?.trim() ?? "";
  const autoShotTitle = /^分镜\s*(\d+)$/.exec(title);
  if (autoShotTitle) return `素材 ${autoShotTitle[1]}`;
  if (title) return title;
  const shotNo = shot?.shot_no?.trim();
  return shotNo ? `素材 ${shotNo}` : "素材图";
}

/** 宫格入库实体：复用 W5-1 buildPromoteIngestItem（kind=keyframe），metadata 标注宫格来源。 */
export function buildGridIngestItem(input: {
  name: string;
  sourceUrl: string;
  shotId?: string | null;
  rows: number;
  cols: number;
  row: number;
  col: number;
}): JsonAssetIngestItem {
  const item = buildPromoteIngestItem({
    kind: "keyframe",
    name: input.name,
    intro: `${input.rows}×${input.cols} 宫格切分 · ${gridCellLabel(input.row, input.col)}`,
    sourceUrl: input.sourceUrl,
    shotId: input.shotId,
  });
  item.metadata = {
    ...item.metadata,
    origin: "grid_split",
    grid_rows: input.rows,
    grid_cols: input.cols,
    grid_row: input.row,
    grid_col: input.col,
  };
  return item;
}

export interface GridSaveOutcome {
  total: number;
  saved: number;
  failed: number;
}

/** 全存聚合文案：N 成功 M 失败如实报数；全败/全胜分别给明确说法。 */
export function summarizeGridSave(outcome: GridSaveOutcome): string {
  if (outcome.total <= 0) return "";
  if (outcome.failed === 0) return `已入库 ${outcome.saved} 格`;
  if (outcome.saved === 0) return `${outcome.failed} 格入库失败，可逐格重试`;
  return `已入库 ${outcome.saved} 格，${outcome.failed} 格失败，可逐格重试`;
}

/* ============================================================
   组件：宫格切分弹窗
   ============================================================ */

interface GridSplitModalProps {
  projectId: string;
  shot: Shot;
  /** 待切分的图片产物（入口侧已按 promoteEntryState 过滤：图片 + 有 storage_url）。 */
  media: PromoteSourceMedia;
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  onClose: () => void;
}

type LoadStage = "loading" | "error" | "ready";

interface GridCell {
  row: number;
  col: number;
  name: string;
  blob: Blob;
  objectUrl: string;
  status: "idle" | "saving" | "saved" | "failed";
  error?: string;
  /** 批量登记成功后保留实体 id：挂图失败的单格重试只补挂图，不重复建实体。 */
  assetId?: string;
  /** 挂图成功后保留媒体版本 id：建素材组时挂项目资产要用。 */
  mediaId?: string;
}

export function GridSplitModal({ projectId, shot, media, demoMode, notify, onClose }: GridSplitModalProps): React.JSX.Element {
  const url = media.storage_url?.trim() ?? "";
  const [loadStage, setLoadStage] = useState<LoadStage>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [gridChoice, setGridChoice] = useState("3x3");
  const [customRows, setCustomRows] = useState(3);
  const [customCols, setCustomCols] = useState(3);
  const spec = useMemo<GridSpec>(() => {
    const preset = GRID_PRESET_OPTIONS.find((option) => option.key === gridChoice);
    return preset ? preset.spec : normalizeGridSpec(customRows, customCols);
  }, [gridChoice, customRows, customCols]);

  const [splitting, setSplitting] = useState(false);
  const [splitError, setSplitError] = useState("");
  const [cells, setCells] = useState<GridCell[] | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null);
  const [saveSummary, setSaveSummary] = useState("");
  /* 选格建素材组：点击宫格卡选择（多选），整组建素材；grouping=创建中 */
  const [selectedCells, setSelectedCells] = useState<ReadonlySet<number>>(new Set());
  const [grouping, setGrouping] = useState(false);
  const [groupProgress, setGroupProgress] = useState<{ done: number; total: number } | null>(null);
  const cellsRef = useRef<GridCell[]>([]);
  cellsRef.current = cells ?? [];

  /* ---------- 原图加载：登录保护的本站图片代理（TOS 无需开放 CORS） ---------- */
  useEffect(() => {
    if (demoMode || !url) return undefined;
    let active = true;
    let sourceObjectUrl: string | undefined;
    setLoadStage("loading");
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      imageRef.current = image;
      setLoadStage("ready");
    };
    image.onerror = () => {
      if (!active) return;
      imageRef.current = null;
      setLoadStage("error");
    };
    void fetchReadableImage(url).then(async (response) => {
      if (!response.ok) throw new Error("image unavailable");
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("not an image");
      if (!active) return;
      sourceObjectUrl = URL.createObjectURL(blob);
      image.src = sourceObjectUrl;
    }).catch(() => {
      if (!active) return;
      imageRef.current = null;
      setLoadStage("error");
    });
    return () => {
      active = false;
      if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
    };
  }, [url, demoMode, reloadKey]);

  /* ---------- 卸载时释放 objectURL ---------- */
  useEffect(() => () => {
    for (const cell of cellsRef.current) URL.revokeObjectURL(cell.objectUrl);
  }, []);

  /* S7-11：基底名走 gridAssetBaseName——自动「分镜 N」标题归一「素材 N」，实义标题沿用 */
  const baseName = gridAssetBaseName(shot);
  const busy = splitting || savingAll || grouping;

  function patchCell(index: number, patch: Partial<GridCell>): void {
    setCells((current) => current?.map((cell, i) => (i === index ? { ...cell, ...patch } : cell)) ?? current);
  }

  /* ---------- 切分：canvas 等分裁切，纯本地零请求 ---------- */
  async function split(): Promise<void> {
    const image = imageRef.current;
    if (!image || splitting) return;
    setSplitting(true);
    setSplitError("");
    const nextCells: GridCell[] = [];
    try {
      const rects = gridCellRects(image.naturalWidth, image.naturalHeight, spec);
      for (const rect of rects) {
        const blob = await cropCell(image, rect);
        nextCells.push({
          row: rect.row,
          col: rect.col,
          name: gridCellAssetName(baseName, rect.row, rect.col),
          blob,
          objectUrl: URL.createObjectURL(blob),
          status: "idle",
        });
      }
      setCells(nextCells);
    } catch (reason) {
      for (const cell of nextCells) URL.revokeObjectURL(cell.objectUrl);
      setSplitError(humanErrorMessage(reason, "切分失败，请重试"));
    } finally {
      setSplitting(false);
    }
  }

  /**
   * 单格持久化（W5-1 通道）：ingestJsonAssets 建实体 + uploadAssetMedia 挂图。
   * 挂图失败后的重试沿用已登记实体/媒体（断点续传，同 W5-1 纪律）；
   * 返回 {assetId, mediaId} 供「创建粗剪素材组」挂项目资产。
   */
  async function persistCell(index: number): Promise<{ assetId: string; mediaId: string }> {
    const cell = cellsRef.current[index];
    if (!cell) throw new Error("宫格不存在，请重新切分");
    if (cell.blob.size > PROMOTE_MAX_FILE_BYTES) throw new Error("宫格图超过 10MB，资产库无法接收。");
    let assetId = cell.assetId ?? "";
    if (!assetId) {
      const ingested = await api.ingestJsonAssets(
        [buildGridIngestItem({ name: cell.name, sourceUrl: url, shotId: shot.id, rows: spec.rows, cols: spec.cols, row: cell.row, col: cell.col })],
        { source_project_id: projectId },
      );
      assetId = ingested.items[0]?.id ?? "";
      if (!assetId) throw new ApiClientError("资产库已受理但响应缺少新资产编号，请重试", { code: "invalid_response" });
    }
    let mediaId = cell.mediaId ?? "";
    if (!mediaId) {
      const file = new File([cell.blob], `${cell.name}.png`, { type: "image/png" });
      const media = await api.uploadAssetMedia(assetId, file, { title: cell.name, isPrimary: true });
      mediaId = media.id;
    }
    patchCell(index, { status: "saved", assetId, mediaId });
    return { assetId, mediaId };
  }

  /** 单格入库：persistCell + 状态补丁。 */
  async function saveCell(index: number): Promise<void> {
    const cell = cells?.[index];
    if (!cell || cell.status === "saving" || cell.status === "saved") return;
    patchCell(index, { status: "saving", error: undefined });
    try {
      await persistCell(index);
    } catch (reason) {
      patchCell(index, { status: "failed", error: humanErrorMessage(reason, "入库失败，请重试") });
    }
  }

  /* ---------- 选格创建粗剪素材组：图入项目资产 + 建成素材，不跳资产中心 ---------- */
  function toggleCellSelected(index: number): void {
    if (busy) return;
    setSelectedCells((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  /** 整组建素材：逐格 persistCell → 挂项目资产 → createShot；逐项失败如实报数。 */
  async function createShotGroup(): Promise<void> {
    if (grouping || !cells || selectedCells.size === 0) return;
    const indexes = [...selectedCells].filter((index) => cells[index]).sort((a, b) => a - b);
    setGrouping(true);
    setGroupProgress({ done: 0, total: indexes.length });
    let created = 0;
    const failures: string[] = [];
    try {
      for (const index of indexes) {
        const cell = cells[index]!;
        try {
          const { assetId, mediaId } = await persistCell(index);
          await api.addProjectAsset(projectId, assetId, mediaId);
          await api.createShot(shot.episode_id, { title: cell.name });
          created += 1;
        } catch (reason) {
          failures.push(`${gridCellLabel(cell.row, cell.col)}：${humanErrorMessage(reason, "创建失败")}`);
        } finally {
          setGroupProgress((current) => (current ? { ...current, done: current.done + 1 } : current));
        }
      }
    } finally {
      setGrouping(false);
      setGroupProgress(null);
    }
    if (created > 0) {
      setSelectedCells(new Set());
      window.dispatchEvent(new Event("production-progress-changed"));
    }
    if (failures.length === 0) {
      notify(`已创建 ${created} 个粗剪素材：宫格图已入项目资产，回生产页可见`, "success");
    } else {
      notify(`建素材组：成功 ${created} 个，失败 ${failures.length} 个（${failures.join("；")}）`, created > 0 ? "info" : "error");
    }
  }

  /* ---------- 一键全存：一次批量 ingest 全部实体 + 逐格挂图；部分失败如实报数 ---------- */
  async function saveAll(): Promise<void> {
    if (savingAll || !cells) return;
    const pending = cells
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell }) => cell.status !== "saved" && cell.status !== "saving");
    if (pending.length === 0) return;
    setSavingAll(true);
    setSaveSummary("");
    setSaveProgress({ done: 0, total: pending.length });
    // 本地结果台账：汇总不依赖 React 重渲染时序（finally 里 state 可能未 flush）。
    const results = new Map<number, "saved" | "failed">();
    try {
      const oversized = pending.filter(({ cell }) => cell.blob.size > PROMOTE_MAX_FILE_BYTES);
      for (const { index } of oversized) {
        patchCell(index, { status: "failed", error: "宫格图超过 10MB，资产库无法接收。" });
        results.set(index, "failed");
      }
      if (oversized.length > 0) {
        setSaveProgress((current) => (current ? { ...current, done: current.done + oversized.length } : current));
      }
      const uploadable = pending.filter(({ cell }) => cell.blob.size <= PROMOTE_MAX_FILE_BYTES);
      // 已有实体 id 的格（单格重试留下的）只补挂图，不重复建实体。
      const needsIngest = uploadable.filter(({ cell }) => !cell.assetId);
      const ingestIds = new Map<number, string>();
      if (needsIngest.length > 0) {
        try {
          const ingested = await api.ingestJsonAssets(
            needsIngest.map(({ cell }) => buildGridIngestItem({
              name: cell.name,
              sourceUrl: url,
              shotId: shot.id,
              rows: spec.rows,
              cols: spec.cols,
              row: cell.row,
              col: cell.col,
            })),
            { source_project_id: projectId },
          );
          needsIngest.forEach(({ index }, i) => ingestIds.set(index, ingested.items[i]?.id ?? ""));
        } catch (reason) {
          const message = humanErrorMessage(reason, "批量登记失败，请重试");
          for (const { index } of needsIngest) {
            patchCell(index, { status: "failed", error: message });
            results.set(index, "failed");
          }
          setSaveProgress((current) => (current ? { ...current, done: current.done + needsIngest.length } : current));
        }
      }
      for (const { cell, index } of uploadable) {
        if (needsIngest.some((entry) => entry.index === index) && !ingestIds.has(index)) continue;
        const assetId = cell.assetId ?? ingestIds.get(index) ?? "";
        patchCell(index, { status: "saving", assetId: assetId || undefined });
        try {
          if (!assetId) throw new Error("资产库响应缺少该格的新资产编号");
          const file = new File([cell.blob], `${cell.name}.png`, { type: "image/png" });
          const media = await api.uploadAssetMedia(assetId, file, { title: cell.name, isPrimary: true });
          patchCell(index, { status: "saved", mediaId: media.id });
          results.set(index, "saved");
        } catch (reason) {
          patchCell(index, { status: "failed", error: humanErrorMessage(reason, "挂图失败，可重试") });
          results.set(index, "failed");
        } finally {
          setSaveProgress((current) => (current ? { ...current, done: current.done + 1 } : current));
        }
      }
    } finally {
      setSavingAll(false);
      setSaveProgress(null);
      const outcome = (cells ?? []).reduce<GridSaveOutcome>(
        (acc, cell, index) => {
          const status = results.get(index) ?? cell.status;
          return {
            total: acc.total + 1,
            saved: acc.saved + (status === "saved" ? 1 : 0),
            failed: acc.failed + (status === "failed" ? 1 : 0),
          };
        },
        { total: 0, saved: 0, failed: 0 },
      );
      const summary = summarizeGridSave(outcome);
      setSaveSummary(summary);
      if (summary) notify(summary, outcome.failed > 0 ? "error" : "success");
    }
  }

  const closeGuard = (): void => { if (!busy) onClose(); };

  /** 重选宫格：丢弃本次切分结果（已入库的格不受影响），释放本地 objectURL。 */
  function reconfigure(): void {
    if (busy) return;
    for (const cell of cells ?? []) URL.revokeObjectURL(cell.objectUrl);
    setCells(null);
    setSplitError("");
    setSaveSummary("");
  }

  /* ---------- 渲染 ---------- */
  const chipClass = (selected: boolean) => cn(
    "rounded-full border px-3 py-1 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent disabled:text-ink-4",
    selected
      ? "border-accent bg-accent-subtle text-accent-text"
      : "border-border-1 bg-surface-1 text-ink-1 hover:border-border-2 hover:bg-surface-2",
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) closeGuard(); }}>
      <DialogContent size="large">
        <DialogHeader>
          <DialogTitle>宫格切分</DialogTitle>
          <DialogDescription>按宫格等分裁切这张生成图，逐格入资产库。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {demoMode ? (
            <p className="text-xs text-ink-2">离线演示不切分不写入。</p>
          ) : loadStage === "loading" ? (
            <div className="flex flex-col gap-3" aria-busy="true" aria-label="正在加载原图">
              <Skeleton className="h-[260px] w-full" />
              <p className="text-xs text-ink-2">正在加载原图…</p>
            </div>
          ) : loadStage === "error" ? (
            <div className="flex items-start gap-3 rounded-md border border-danger bg-danger/10 p-4" role="alert">
              <WarningCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
              <div className="flex flex-col gap-1">
                <strong className="text-sm text-ink-1">原图读取失败</strong>
                <p className="mb-2 text-sm text-ink-2">存储服务拒绝了跨域读取（CORS）或网络受限。请确认存储桶已允许本站跨域访问后重试。</p>
                <div><Button icon={<ArrowClockwise />} onClick={() => setReloadKey((value) => value + 1)}>重试</Button></div>
              </div>
            </div>
          ) : !cells ? (
            <>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="选择宫格">
                  {GRID_PRESET_OPTIONS.map((option) => (
                    <button
                      className={chipClass(gridChoice === option.key)}
                      type="button"
                      key={option.key}
                      aria-pressed={gridChoice === option.key}
                      disabled={busy}
                      onClick={() => setGridChoice(option.key)}
                    >{option.label}</button>
                  ))}
                  <button
                    className={chipClass(gridChoice === "custom")}
                    type="button"
                    aria-pressed={gridChoice === "custom"}
                    disabled={busy}
                    onClick={() => setGridChoice("custom")}
                  >自定义</button>
                  {gridChoice === "custom" ? (
                    <span className="inline-flex items-center gap-2 text-sm text-ink-2">
                      <label className="inline-flex items-center gap-1">行
                        <Input
                          className="w-14 px-2"
                          type="number"
                          min={GRID_CUSTOM_MIN}
                          max={GRID_CUSTOM_MAX}
                          value={customRows}
                          disabled={busy}
                          aria-label="自定义行数"
                          onChange={(event) => setCustomRows(clampGridDimension(Number(event.target.value)))}
                        />
                      </label>
                      <span aria-hidden="true">×</span>
                      <label className="inline-flex items-center gap-1">列
                        <Input
                          className="w-14 px-2"
                          type="number"
                          min={GRID_CUSTOM_MIN}
                          max={GRID_CUSTOM_MAX}
                          value={customCols}
                          disabled={busy}
                          aria-label="自定义列数"
                          onChange={(event) => setCustomCols(clampGridDimension(Number(event.target.value)))}
                        />
                      </label>
                    </span>
                  ) : null}
                </div>
                <div className="relative overflow-hidden rounded-md border border-border-1 bg-surface-well">
                  {/* 预览 <img> 只展示不读像素，可直接用原 URL */}
                  <img src={url} alt="待切分原图" className="block max-h-[360px] w-full object-contain" />
                  <div
                    className="pointer-events-none absolute inset-0 grid"
                    aria-hidden="true"
                    style={{ gridTemplateRows: `repeat(${spec.rows}, 1fr)`, gridTemplateColumns: `repeat(${spec.cols}, 1fr)` }}
                  >
                    {Array.from({ length: spec.rows * spec.cols }, (_, index) => <span key={index} className="border border-accent bg-accent-subtle" />)}
                  </div>
                </div>
              </div>
              {splitError ? <div className="rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{splitError}</div> : null}
            </>
          ) : (
            <>
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${spec.cols}, 1fr)` }}>
                {cells.map((cell, index) => {
                  const selected = selectedCells.has(index);
                  return (
                    <figure
                      className={cn(
                        "m-0 flex cursor-pointer flex-col overflow-hidden rounded-md border bg-surface-1 outline-none transition-colors",
                        selected ? "border-accent ring-2 ring-accent" : "border-border-1 hover:border-border-2",
                        cell.status === "saved" && !selected && "border-success",
                      )}
                      key={cell.objectUrl}
                      data-status={cell.status}
                      role="checkbox"
                      aria-checked={selected}
                      aria-label={`选择 ${gridCellLabel(cell.row, cell.col)} 建粗剪素材`}
                      tabIndex={0}
                      onClick={() => toggleCellSelected(index)}
                      onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); toggleCellSelected(index); } }}
                    >
                      <span className="relative block">
                        <img src={cell.objectUrl} alt={cell.name} className="block aspect-square w-full bg-surface-well object-contain" />
                        {selected ? (
                          <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-accent text-surface-0"><CheckCircle aria-hidden="true" className="size-4" weight="fill" /></span>
                        ) : null}
                      </span>
                      <figcaption className="flex flex-col gap-2 p-2">
                        <span className="font-mono text-xs text-ink-2">{gridCellLabel(cell.row, cell.col)}</span>
                        {cell.status === "saved" ? (
                          <span className="inline-flex items-center gap-1 text-sm text-success"><CheckCircle aria-hidden="true" className="size-4" />已入库</span>
                        ) : (
                          <Button size="sm" icon={<FolderPlus />} loading={cell.status === "saving"} disabled={busy} onClick={(event) => { event.stopPropagation(); void saveCell(index); }}>入资产库</Button>
                        )}
                        {cell.status === "failed" && cell.error ? <span className="text-xs text-danger" role="alert">{cell.error}</span> : null}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
              <p className="text-xs text-ink-2">点击宫格选中后可整组建成粗剪素材（图随素材进项目资产）；逐格入资产库只是备用。</p>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {cells ? (
            <>
              <span className="mr-auto text-xs text-ink-2">
                {groupProgress ? `正在建素材组 ${groupProgress.done}/${groupProgress.total}…` : saveProgress ? `正在入库 ${saveProgress.done}/${saveProgress.total}…` : saveSummary || (selectedCells.size > 0 ? `已选 ${selectedCells.size} 格` : "点击宫格选中，整组建素材")}
              </span>
              <Button icon={<GridFour />} disabled={busy} onClick={reconfigure}>重选宫格</Button>
              <Button disabled={busy} onClick={closeGuard}>关闭</Button>
              <Button
                icon={<FolderPlus />}
                loading={savingAll}
                disabled={busy || cells.every((cell) => cell.status === "saved")}
                title="把全部宫格入资产库备用（不建素材）"
                onClick={() => void saveAll()}
              >一键全存</Button>
              <Button disabled title="单格高清化即将上线">单格高清化</Button>
              <Button
                variant="primary"
                icon={<FilmStrip />}
                loading={grouping}
                disabled={selectedCells.size === 0}
                title="选中的宫格各自建成粗剪素材，图片随素材进项目资产"
                onClick={() => void createShotGroup()}
              >创建粗剪素材组{selectedCells.size > 0 ? `（${selectedCells.size}）` : ""}</Button>
            </>
          ) : (
            <>
              <span className="mr-auto text-xs text-ink-2">切分在本地完成，不发请求不扣费</span>
              <Button disabled={busy} onClick={closeGuard}>取消</Button>
              <Button variant="primary" icon={<GridFour />} loading={splitting} disabled={loadStage !== "ready"} onClick={() => void split()}>切分</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 单格裁切：canvas 等分 drawImage + toBlob 出 PNG。 */
async function cropCell(image: HTMLImageElement, rect: GridCellRect): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器不支持画布裁切，请换用最新版浏览器。");
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("宫格图导出失败，请重试。");
  return blob;
}
