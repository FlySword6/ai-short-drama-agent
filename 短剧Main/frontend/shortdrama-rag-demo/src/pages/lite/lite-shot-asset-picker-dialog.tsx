/* ============================================================
   lite-shot-asset-picker-dialog.tsx — 分镜详情「匹配+选择」资产多选弹窗
   （2026-08-18 用户裁定：弹窗优于跳转——不离开分镜详情，保留左栏未保存编辑
   与滚动位置；2026-08-19 用户追问「不能默认勾选/取消已匹配变体」→ 升级为
   **双向编辑**：
   - 已关联本镜的 (asset, variant) 打开即默认勾选（selected 以 linkedKeys 为种子）；
   - 取消勾选 = 移除关联：manual 项经 liteListAssetUsages 解析 usage_id 后走
     liteRemoveShotUsage（素材页「出现的场景」同一条删除路径，R1 合规、幂等）；
     auto(exact_name) 项走 liteRemoveShotAutoRef（快照删除 + removedAutoRefs 抑制）；
   - 变体**平铺罗列**（弃展开式）：资产下所有变体一次可见，单一变体资产 = 一个
     可见 checkbox 一步勾选；列表受 9 个分类 tab 约束，卡片行紧凑 + DialogBody
     最大高滚动，抵消变体增多的屏占。无变体资产退化为资产级 checkbox。
   写入 = 资产侧「关联分镜」同一条批量路径（POST .../usages，addAssetShotUsages），
   服务端按 deterministicUsageId 去重，重复添加同 (asset, variant, shot) 幂等不重复。
   demoMode：无资产数据（与素材页 demo 空态一致），写操作不调用。

   匹配合同 docs/design/prd-v2/lite-assets-page.md 问题八 8.8/8.9。
   ============================================================ */
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ImageSquare, SpinnerGap, X } from "@phosphor-icons/react";
import { api, type LiteAssetListItem, type LiteAssetListResult, type LiteAssetVariant } from "../../api";
import { assetKindLabel } from "../../asset-kind-labels";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Badge, EmptyState } from "../../components/ui/primitives";
import { useResource } from "../../ui";
import { humanErrorMessage } from "../batch-generate-drawer";

const h = React.createElement;

/** tab 定义与素材列表页同口径：「全部」+ 五类可解析资产 + 三类纯上传参考通道。 */
const PICKER_ASSET_TABS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "all", label: "全部" },
  { key: "character", label: "角色" },
  { key: "scene", label: "场景" },
  { key: "prop", label: "道具" },
  { key: "costume", label: "服装" },
  { key: "audio", label: "音频" },
  { key: "light_ref", label: "光线参考" },
  { key: "photo_ref", label: "摄影参考" },
  { key: "video_ref", label: "视频参考" },
];

/* ============================================================
   纯逻辑（供 node:test 复用；无 DOM 依赖）
   ============================================================ */

/** 选择键：`assetEntityId::variantId`；无变体资产用 `assetEntityId::asset`（资产级）。 */
export function pickerKey(assetId: string, variantId: string | null): string {
  return `${assetId}::${variantId ?? "asset"}`;
}

/** 拆选择键 → { assetId, variantKey }；坏键回退资产级。 */
export function splitPickerKey(key: string): { assetId: string; variantKey: string } {
  const sep = key.indexOf("::");
  if (sep <= 0) return { assetId: key, variantKey: "asset" };
  return { assetId: key.slice(0, sep), variantKey: key.slice(sep + 2) };
}

/** 是否已关联本镜（linkedKeys 由调用方从 reference_asset_snapshots 构建）。 */
export function isLinked(linkedKeys: ReadonlySet<string>, assetId: string, variantId: string | null): boolean {
  return linkedKeys.has(pickerKey(assetId, variantId));
}

/** 把选择键按资产分组为写入 items（shot_id 固定本镜；资产级变体不传 variant_id）。 */
export function groupPickerKeysByAsset(
  keys: ReadonlySet<string>,
  shotId: string,
): Map<string, Array<{ shot_id: string; variant_id?: string }>> {
  const byAsset = new Map<string, Array<{ shot_id: string; variant_id?: string }>>();
  for (const key of keys) {
    if (key.indexOf("::") <= 0) continue; /* 坏键跳过，避免拿坏 assetId 打写接口 */
    const { assetId, variantKey } = splitPickerKey(key);
    const items = byAsset.get(assetId) ?? [];
    items.push(variantKey === "asset" ? { shot_id: shotId } : { shot_id: shotId, variant_id: variantKey });
    byAsset.set(assetId, items);
  }
  return byAsset;
}

/** 编辑差异：toAdd = selected − linkedKeys；toRemove = linkedKeys − selected。 */
export function splitPickerChanges(
  selected: ReadonlySet<string>,
  linkedKeys: ReadonlySet<string>,
): { toAdd: string[]; toRemove: string[] } {
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const key of selected) if (!linkedKeys.has(key)) toAdd.push(key);
  for (const key of linkedKeys) if (!selected.has(key)) toRemove.push(key);
  return { toAdd, toRemove };
}

/** 选择键 → 展示名（资产名 + 变体名，资产级只显资产名）。 */
export function pickerKeyLabel(
  key: string,
  assets: readonly LiteAssetListItem[],
  variantsByAsset: Readonly<Record<string, readonly LiteAssetVariant[]>>,
): string {
  const { assetId, variantKey } = splitPickerKey(key);
  const assetName = assets.find((a) => a.asset_entity_id === assetId)?.name ?? "未命名资产";
  if (variantKey === "asset") return assetName;
  const variantName = (variantsByAsset[assetId] ?? []).find((v) => v.variant_id === variantKey)?.display_name;
  return variantName ? `${assetName} · ${variantName}` : assetName;
}

/** 弹窗（挂载即拉数据；由分镜详情条件渲染，每次打开重新挂载）。 */
export function LiteShotAssetPickerDialog(props: {
  projectId: string;
  shotId: string;
  demoMode: boolean;
  /** 已关联本镜的全部键（reference_asset_snapshots → pickerKey）。打开即默认勾选。 */
  linkedKeys: ReadonlySet<string>;
  /** linkedKeys 中 exact_name（auto 回填）子集；取消勾选走 liteRemoveShotAutoRef。 */
  autoRefKeys: ReadonlySet<string>;
  notify: (message: string, kind?: "error" | "success" | "info") => void;
  onClose: () => void;
  /** 关联成功/取消后回调（分镜详情 retryShot）。 */
  onLinked: () => void;
}): React.ReactNode {
  const { projectId, shotId, demoMode, linkedKeys, autoRefKeys, notify, onClose, onLinked } = props;
  const [tab, setTab] = useState("all");

  /* 素材列表：demo 模式空数据（与素材页一致）；tab 切换服务端过滤。 */
  const listState = useResource(
    () => api.liteListAssets(projectId, tab === "all" ? undefined : tab),
    { items: [] as LiteAssetListItem[], tab_counts: [] } as LiteAssetListResult,
    demoMode,
    [projectId, tab],
  );

  /* 变体：平铺罗列——列表加载后对所有资产并行惰性拉取并缓存（渲染以
     variantsByAsset[assetId] === undefined 判「读取中」，无需额外 loading 态）。 */
  const [variantsByAsset, setVariantsByAsset] = useState<Record<string, LiteAssetVariant[]>>({});
  const fetchedAssetsRef = useRef<Set<string>>(new Set());
  const assets = listState.data?.items ?? [];
  useEffect(() => {
    if (demoMode || listState.loading || assets.length === 0) return;
    for (const asset of assets) {
      const assetId = asset.asset_entity_id;
      if (fetchedAssetsRef.current.has(assetId)) continue;
      fetchedAssetsRef.current.add(assetId);
      void api.liteListAssetVariants(projectId, assetId)
        .then((items) => setVariantsByAsset((prev) => ({ ...prev, [assetId]: items })))
        .catch((reason: unknown) => notify(humanErrorMessage(reason, "读取变体失败，请重试"), "error"));
    }
  }, [demoMode, projectId, listState.loading, listState.data, assets, notify]);

  /* 已关联(manual)项的 usage_id：挂载后按资产解析，供取消勾选时删除（auto 项走
     liteRemoveShotAutoRef，不需要 usage_id）。解析失败/查不到 → 视为已移除，跳过。 */
  const manualAssets = useMemo(() => {
    const set = new Set<string>();
    for (const key of linkedKeys) {
      if (autoRefKeys.has(key)) continue;
      set.add(splitPickerKey(key).assetId);
    }
    return [...set];
  }, [linkedKeys, autoRefKeys]);
  const [usageIdByKey, setUsageIdByKey] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (demoMode || manualAssets.length === 0) return;
    let cancelled = false;
    void (async () => {
      const map = new Map<string, string>();
      for (const assetId of manualAssets) {
        try {
          const usages = await api.liteListAssetUsages(projectId, assetId);
          for (const u of usages) {
            if (u.shot_id !== shotId || !u.usage_id) continue;
            map.set(pickerKey(assetId, u.variant_id), u.usage_id);
          }
        } catch {
          /* 读 usage 失败不阻断编辑；确认时按未解析跳过（该关联视为已不存在）。 */
        }
      }
      if (!cancelled) setUsageIdByKey(map);
    })();
    return () => { cancelled = true; };
  }, [demoMode, projectId, shotId, manualAssets]);

  /* 双向编辑：selected 以 linkedKeys 为种子（打开即默认勾选已关联项）。 */
  const [selected, setSelected] = useState<Set<string>>(() => new Set(linkedKeys));
  const [saving, setSaving] = useState(false);

  const { toAdd, toRemove } = useMemo(() => splitPickerChanges(selected, linkedKeys), [selected, linkedKeys]);
  const hasChanges = toAdd.length + toRemove.length > 0;

  const tabCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const tab of listState.data?.tab_counts ?? []) map.set(tab.kind, tab.count);
    return map;
  }, [listState.data?.tab_counts]);
  const listTotal = listState.data?.items.length ?? 0;

  const toggleVariant = (assetId: string, variantId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = pickerKey(assetId, variantId);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleAssetLevel = (assetId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = pickerKey(assetId, null);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const removeSelected = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const confirm = async (): Promise<void> => {
    if (saving || !hasChanges) return;
    if (demoMode) {
      notify("离线演示不会写入", "info");
      return;
    }
    setSaving(true);
    try {
      /* 新增：按资产分组走批量路径（幂等）。 */
      const byAsset = groupPickerKeysByAsset(new Set(toAdd), shotId);
      const results = await Promise.all([...byAsset].map(([assetId, items]) =>
        api.liteAddShotUsages(projectId, assetId, items),
      ));
      const added = results.reduce((sum, r) => sum + r.added, 0);
      const pending = results.reduce((sum, r) => sum + r.pending, 0);

      /* 取消：manual 项按 usage_id 删，auto 项走 shot 侧 auto-ref 删除（写抑制名单）。 */
      const removals: Array<Promise<void>> = [];
      for (const key of toRemove) {
        const { assetId, variantKey } = splitPickerKey(key);
        if (autoRefKeys.has(key)) {
          if (variantKey === "asset") continue;
          removals.push(api.liteRemoveShotAutoRef(projectId, shotId, assetId, variantKey));
        } else {
          const usageId = usageIdByKey.get(key);
          if (!usageId) continue; /* 已不存在，跳过 */
          removals.push(api.liteRemoveShotUsage(projectId, assetId, usageId));
        }
      }
      await Promise.all(removals);
      const removed = removals.length;

      const parts: string[] = [];
      if (added > 0) parts.push(`已关联 ${added} 项${pending > 0 ? `（另有 ${pending} 条待绑定）` : ""}`);
      if (removed > 0) parts.push(`已取消 ${removed} 项`);
      notify(parts.length > 0 ? parts.join(" · ") : "没有变化", "success");
      onLinked();
      onClose();
    } catch (reason) {
      notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
    } finally {
      setSaving(false);
    }
  };

  return h(Dialog, { open: true, onOpenChange: (open: boolean) => { if (!open && !saving) onClose(); } },
    h(DialogContent, { size: "large" },
      h(DialogHeader, null,
        h(DialogTitle, null, "选择参考资产"),
        h(DialogDescription, null,
          "已在本镜的资产默认勾选；取消勾选会移除关联。确认后批量保存。",
        ),
      ),
      h(DialogBody, { className: "flex min-h-[40vh] max-h-[70vh] flex-col gap-3 overflow-y-auto" },
        /* 分类 tab：与素材列表页同口径，计数取服务端 tab_counts。 */
        h("div", { className: "flex flex-wrap gap-1.5" },
          PICKER_ASSET_TABS.map((tabDef) => {
            const count = tabDef.key === "all" ? (tab === "all" ? listTotal : listState.data?.items.length ?? 0) : tabCounts.get(tabDef.key) ?? 0;
            const active = tab === tabDef.key;
            return h("button", {
              key: tabDef.key,
              type: "button",
              onClick: () => setTab(tabDef.key),
              className: active
                ? "rounded-md bg-accent-subtle px-2.5 py-1.5 text-xs font-medium text-accent-text"
                : "rounded-md px-2.5 py-1.5 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink-1",
              "aria-selected": active,
            }, `${tabDef.label}（${count}）`);
          }),
        ),
        /* 资产列表：变体平铺罗列。 */
        listState.loading
          ? h("div", { className: "flex items-center justify-center gap-2 py-8 text-xs text-ink-3" },
            h(SpinnerGap, { className: "size-4 animate-spin" }), "读取素材中…",
          )
          : listState.error
            ? h("div", { className: "py-4" },
              h("p", { className: "text-sm text-error" }, listState.error),
              h(Button, { variant: "outline", size: "sm", onClick: listState.retry }, "重试"),
            )
            : assets.length === 0
              ? h(EmptyState, {
                title: demoMode ? "离线演示没有素材数据" : "这里还没有资产",
                description: demoMode
                  ? "真实模式下点「匹配+选择」可从素材库勾选参考资产。"
                  : "去素材页先添加资产，再回来勾选。",
              })
              : h("div", { className: "flex flex-col gap-2" },
                assets.map((asset) => {
                  const assetId = asset.asset_entity_id;
                  const variantList = variantsByAsset[assetId];
                  const assetLinked = isLinked(linkedKeys, assetId, null);
                  return h("div", { key: assetId, className: "rounded-lg border border-border-1 bg-surface-0" },
                    /* 资产名行（纯展示；变体在下方平铺）。 */
                    h("div", { className: "flex items-center gap-2 px-3 py-2" },
                      asset.primary_media_url
                        ? h("img", { src: asset.primary_media_url, alt: asset.name, className: "size-9 shrink-0 rounded-md object-cover" })
                        : h("div", { className: "flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-well/40 text-ink-3" },
                          h(ImageSquare, { className: "size-5", weight: "duotone" }),
                        ),
                      h("div", { className: "min-w-0 flex-1" },
                        h("div", { className: "flex items-center gap-1.5" },
                          h("strong", { className: "truncate text-sm font-medium text-ink-1" }, asset.name),
                          h(Badge, { title: asset.asset_kind }, assetKindLabel(asset.asset_kind)),
                        ),
                        h("p", { className: "truncate text-xs text-ink-3" },
                          asset.intro ?? "暂无描述",
                        ),
                      ),
                      assetLinked
                        ? h(Badge, { tone: "neutral" }, "已关联")
                        : null,
                    ),
                    /* 变体区（平铺）：加载中 / 无变体 → 资产级 / 变体行。 */
                    h("div", { className: "border-t border-border-1 px-3 py-1.5" },
                      variantList === undefined
                        ? h("div", { className: "flex items-center gap-2 py-2 text-xs text-ink-3" },
                          h(SpinnerGap, { className: "size-3.5 animate-spin" }), "读取变体…",
                        )
                        : variantList.length === 0
                          ? h("div", { className: "flex items-center gap-2 py-1.5" },
                            h("button", {
                              type: "button",
                              onClick: () => toggleAssetLevel(assetId),
                              className: "flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
                              style: { borderColor: selected.has(pickerKey(assetId, null)) ? "var(--color-accent)" : undefined },
                              "aria-pressed": selected.has(pickerKey(assetId, null)),
                            },
                              selected.has(pickerKey(assetId, null)) ? h(Check, { className: "size-3.5 text-accent-text" }) : null,
                            ),
                            h("div", { className: "min-w-0 flex-1" },
                              h("div", { className: "flex items-center gap-1.5" },
                                h("span", { className: "truncate text-xs font-medium text-ink-1" }, "资产级关联"),
                                assetLinked ? h(Badge, { tone: "neutral" }, "已关联") : null,
                              ),
                            ),
                          )
                          : variantList.map((variant) => {
                            const linked = isLinked(linkedKeys, assetId, variant.variant_id);
                            const checked = selected.has(pickerKey(assetId, variant.variant_id));
                            return h("div", { key: variant.variant_id, className: "flex items-center gap-2 py-1.5" },
                              h("button", {
                                type: "button",
                                onClick: () => toggleVariant(assetId, variant.variant_id),
                                className: "flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
                                style: { borderColor: checked ? "var(--color-accent)" : undefined },
                                "aria-pressed": checked,
                              },
                                checked ? h(Check, { className: "size-3.5 text-accent-text" }) : null,
                              ),
                              variant.image_url
                                ? h("img", { src: variant.image_url, alt: variant.display_name || "变体", className: "size-8 shrink-0 rounded-md border border-border-1 object-cover" })
                                : h("div", { className: "flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-[10px] text-ink-3" }, "变体"),
                              h("div", { className: "min-w-0 flex-1" },
                                h("div", { className: "flex items-center gap-1.5" },
                                  h("span", { className: "truncate text-xs font-medium text-ink-1" }, variant.display_name || "默认变体"),
                                  variant.is_primary ? h(Badge, { tone: "neutral" }, "主") : null,
                                  linked ? h(Badge, { tone: "neutral" }, "已关联") : null,
                                ),
                                variant.variant_kind ? h("p", { className: "text-[11px] text-ink-3" }, variant.variant_kind) : null,
                              ),
                            );
                          }),
                    ),
                  );
                }),
              ),
      ),
      h(DialogFooter, { className: "flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between" },
        /* 已选清单 + 差异提示：让用户明确将新增/取消哪些。 */
        h("div", { className: "flex min-w-0 flex-wrap items-center gap-2" },
          h(Badge, { tone: selected.size > 0 ? "accent" : "neutral" }, `已选 ${selected.size} 个`),
          toAdd.length > 0 ? h(Badge, { tone: "accent" }, `新增 ${toAdd.length}`) : null,
          toRemove.length > 0 ? h(Badge, { tone: "danger" }, `取消 ${toRemove.length}`) : null,
          selected.size > 0
            ? h("div", { className: "flex max-w-[26rem] flex-wrap gap-1 overflow-y-auto" },
              [...selected].map((key) => h("span", {
                key,
                className: "inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-1",
              },
                pickerKeyLabel(key, assets, variantsByAsset),
                h("button", {
                  type: "button",
                  onClick: () => removeSelected(key),
                  className: "text-ink-3 hover:text-error",
                  "aria-label": `移除 ${key}`,
                }, h(X, { className: "size-3" })),
              )),
            )
            : null,
        ),
        h("div", { className: "flex items-center justify-end gap-2" },
          h(Button, { variant: "outline", onClick: onClose, disabled: saving }, "取消"),
          h(Button, {
            variant: "primary",
            loading: saving,
            disabled: !hasChanges,
            onClick: () => void confirm(),
          }, toAdd.length + toRemove.length > 0 ? `确认（+${toAdd.length} −${toRemove.length}）` : "确认"),
        ),
      ),
    ),
  );
}
