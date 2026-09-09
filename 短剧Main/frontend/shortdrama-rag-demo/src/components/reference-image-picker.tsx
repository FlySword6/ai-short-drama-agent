/* ============================================================
   reference-image-picker.tsx — 从资产里选参考图（卡 #151）

   硬规矩（project.md §4.2 + assets.md §9.1）：
   - 参考图只能从项目资产或资产中心里挑，不在这里另起一套上传——
     同一张图不该在系统里存两份；
   - 选中的是资产的当前媒体（media id），生成时按 id 引用，不复制文件；
   - 两个来源两个页签：项目资产 / 资产中心；分类筛选从数据推导，不写死。
   ============================================================ */
import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle, ImageSquare } from "@phosphor-icons/react";
import { api } from "../api";
import { cn } from "./ui/cn";
import { Button } from "./ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { EmptyState, LoadingState } from "./ui/primitives";
import type { Asset, ProjectAssetRef } from "../types";

/** 选择器里的一张候选图：媒体 id + 缩略图 + 名字 + 分类。 */
export interface ReferenceCandidate {
  mediaId: string;
  name: string;
  category: string;
  thumbUrl: string | null;
}

/** 一次最多带的参考图张数（生成接口参考集上限留有余量）。 */
export const REFERENCE_PICK_LIMIT = 6;

function candidateFromAsset(asset: Asset): ReferenceCandidate | null {
  const mediaId = asset.selected_media_id ?? asset.current_media?.id ?? null;
  if (!mediaId) return null;
  return {
    mediaId,
    name: asset.display_name ?? asset.name ?? "未命名",
    category: asset.category ?? asset.asset_kind ?? "未分类",
    thumbUrl: asset.thumbnail_url ?? asset.storage_url ?? null,
  };
}

function candidateFromProjectRef(ref: ProjectAssetRef): ReferenceCandidate | null {
  const mediaId = ref.asset_media_id ?? ref.asset?.selected_media_id ?? ref.asset?.current_media?.id ?? null;
  if (!mediaId) return null;
  const asset: Asset | undefined = ref.asset ?? ref.snapshot;
  return {
    mediaId,
    name: asset?.display_name ?? asset?.name ?? "未命名",
    category: asset?.category ?? asset?.asset_kind ?? "未分类",
    thumbUrl: asset?.thumbnail_url ?? asset?.storage_url ?? null,
  };
}

export function ReferenceImagePicker({ projectId, demoMode, selected, onConfirm, onClose }: {
  projectId: string;
  demoMode: boolean;
  /** 已选中的媒体 id（顺序即引用顺序）。 */
  selected: string[];
  /** 确认时回传选中 id 与其展示信息（名字/缩略图），供设置页渲染已选列表。 */
  onConfirm: (mediaIds: string[], info: Array<{ mediaId: string; name: string; thumbUrl: string | null }>) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [source, setSource] = useState<"project" | "common">("project");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [candidates, setCandidates] = useState<ReferenceCandidate[]>([]);
  const [picked, setPicked] = useState<string[]>(selected);
  const [category, setCategory] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      if (source === "project") {
        const page = await api.projectAssets(projectId);
        setCandidates((page.items ?? []).map(candidateFromProjectRef).filter((item): item is ReferenceCandidate => item !== null));
      } else {
        const page = await api.assets({ scope: "common", media: "image" });
        setCandidates((page.items ?? []).map(candidateFromAsset).filter((item): item is ReferenceCandidate => item !== null));
      }
    } catch {
      setLoadError("资产列表读取失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, [source, projectId]);

  useEffect(() => {
    if (demoMode) { setCandidates([]); setLoading(false); return; }
    void load();
  }, [load, demoMode]);

  const categories = useMemo(() => Array.from(new Set(candidates.map((item) => item.category))).sort(), [candidates]);
  const visible = useMemo(() => (category ? candidates.filter((item) => item.category === category) : candidates), [candidates, category]);

  function toggle(mediaId: string): void {
    setPicked((current) => {
      if (current.includes(mediaId)) return current.filter((id) => id !== mediaId);
      if (current.length >= REFERENCE_PICK_LIMIT) return current;
      return [...current, mediaId];
    });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="large">
        <DialogHeader>
          <DialogTitle>选参考图</DialogTitle>
          <DialogDescription>只能从资产库里挑。想用新图还没进库，先去资产页建成资产——随手传的图不进库，下次没法再用，跟镜也对不上。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <nav className="flex gap-1 border-b border-border-1 pb-2" aria-label="参考图来源">
            {([["project", "项目资产"], ["common", "资产中心"]] as const).map(([key, label]) => (
              <button key={key} type="button" className={cn("rounded-sm px-3 py-1.5 text-sm", source === key ? "bg-accent-subtle text-accent-text" : "text-ink-2 hover:text-ink-1")} onClick={() => { setSource(key); setCategory(""); }}>{label}</button>
            ))}
          </nav>
          {categories.length > 1 ? (
            <div className="flex flex-wrap gap-1.5" aria-label="按分类筛选">
              <button type="button" className={cn("rounded-full border px-2.5 py-0.5 text-xs", category === "" ? "border-accent text-accent-text" : "border-border-1 text-ink-2")} onClick={() => setCategory("")}>全部</button>
              {categories.map((item) => (
                <button key={item} type="button" className={cn("rounded-full border px-2.5 py-0.5 text-xs", category === item ? "border-accent text-accent-text" : "border-border-1 text-ink-2")} onClick={() => setCategory(item)}>{item}</button>
              ))}
            </div>
          ) : null}
          {loading ? <LoadingState label="正在读取资产" /> : null}
          {!loading && loadError ? <p className="rounded-sm bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{loadError}</p> : null}
          {!loading && !loadError && visible.length === 0 ? (
            <EmptyState
              title={source === "project" ? "这个项目还没有可用的图片资产" : "资产中心还没有可用的图片"}
              description={source === "project" ? "先在资产页把图加进这个项目，再回来挑。" : "先在资产中心入库，再回来挑。"}
              icon={<ImageSquare />}
            />
          ) : null}
          {!loading && !loadError && visible.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2" role="listbox" aria-label="可选参考图" aria-multiselectable="true">
              {visible.map((item) => {
                const order = picked.indexOf(item.mediaId);
                const active = order >= 0;
                const full = picked.length >= REFERENCE_PICK_LIMIT && !active;
                return (
                  <button
                    key={item.mediaId}
                    type="button"
                    role="option"
                    aria-selected={active}
                    aria-disabled={full}
                    title={full ? `一次最多带 ${REFERENCE_PICK_LIMIT} 张` : item.name}
                    className={cn(
                      "relative flex flex-col items-stretch gap-1 rounded-md border p-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                      active ? "border-accent bg-accent-subtle" : "border-border-1 bg-surface-1 hover:border-border-2",
                      full ? "cursor-not-allowed opacity-50" : "",
                    )}
                    onClick={() => toggle(item.mediaId)}
                  >
                    <span className="relative block aspect-square w-full overflow-hidden rounded-sm bg-surface-well">
                      {item.thumbUrl ? <img src={item.thumbUrl} alt={item.name} className="size-full object-cover" loading="lazy" /> : <ImageSquare className="absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-ink-4" aria-hidden="true" />}
                      {active ? (
                        <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-surface-0" aria-label={`第 ${order + 1} 张`}>
                          {order + 1}
                        </span>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-ink-1">{item.name}</span>
                    <span className="truncate text-[11px] text-ink-4">{item.category}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter className="items-center">
          <span className="mr-auto text-xs text-ink-2" aria-live="polite">
            {picked.length > 0 ? `这次选了 ${picked.length} 张（顺序就是引用顺序）` : "还没选"}
          </span>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button icon={<CheckCircle />} onClick={() => {
            const info = picked.map((mediaId) => {
              const hit = candidates.find((item) => item.mediaId === mediaId);
              return { mediaId, name: hit?.name ?? "参考图", thumbUrl: hit?.thumbUrl ?? null };
            });
            onConfirm(picked, info);
          }}>{picked.length > 0 ? `用这 ${picked.length} 张` : "不选参考图"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
