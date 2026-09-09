/**
 * 3D 导演台 · 左栏资产库面板（W5.5 · 资产面板）
 *
 * 数据源：GET /assets?scope=common（api.assets），客户端过滤出 3D 资产
 * （assetGlbUrl + 类目白名单，见 ../assets-library），按 kind 分 5 组
 * （角色/场景/道具/服装/参考，组头带计数），搜索为客户端名称子串过滤。
 *
 * 板14 四态：
 * - 加载中：骨架行（全局 .skeleton）
 * - 空：无 3D 资产（未入库）/ 搜索无匹配
 * - 错误：接口失败（网络/5xx），人话错误 + 重试
 * - 降级：接口 404/501（无后端路由）→ 回退内置几件资产，横幅明示
 *   「资产库未连接，当前为内置资产」；demoMode 用同一批 fixture，横幅标「示例」
 *
 * 性能：分组默认折叠，展开才渲染条目（519 条不平铺）；GLB 点「添加」才加载，
 * 不预取。添加落场景中心 [0,0,0]，走 UploadedModel 既有管线（ModelGuard 兜底），
 * 进度/失败态经 asset-load-store 回流到行内（加载中 / 失败 + 重试）。
 */
import { useCallback, useEffect, useState } from "react";

import { ArrowClockwise, CircleNotch, MagnifyingGlass, Plus, WarningCircle } from "@phosphor-icons/react";

import { ApiClientError, api } from "../../../api";
import type { Asset } from "../../../types";
import {
  BUILTIN_ASSETS,
  assetDisplayName,
  assetGlbUrl,
  fetchDirector3dAssets,
  filterAssetsByQuery,
  groupAssetsByKind,
  isDirectorDemoMode,
} from "../assets-library";
import type { DirectorAssetKind } from "../assets-library";
import { useAssetLoadStore } from "../asset-load-store";
import { useDirectorStore } from "../store";

import "./AssetsPanel.css";

/* ──────────────────────────── 数据装载 ──────────────────────────── */

type PanelData =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; source: "api" | "builtin" | "demo"; assets: Asset[] };

function useAssetLibrary(): { data: PanelData; reload: () => void } {
  const [data, setData] = useState<PanelData>({ phase: "loading" });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (isDirectorDemoMode()) {
      setData({ phase: "ready", source: "demo", assets: BUILTIN_ASSETS });
      return;
    }
    let cancelled = false;
    setData({ phase: "loading" });
    // W7-C：按 asset_kind 三拉合并（单次 500 上限曾截断到 432/519）
    fetchDirector3dAssets((kind) => api.assets({ scope: "common", assetKind: kind }))
      .then(({ assets }) => {
        if (cancelled) return;
        setData({ phase: "ready", source: "api", assets });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // 降级：后端没有资产路由（404/501）→ 内置资产；其余（网络/5xx）进错误态
        if (error instanceof ApiClientError && (error.status === 404 || error.status === 501)) {
          setData({ phase: "ready", source: "builtin", assets: BUILTIN_ASSETS });
          return;
        }
        setData({
          phase: "error",
          message: error instanceof Error ? error.message : "资产库加载失败，请稍后重试",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  return { data, reload: useCallback(() => setRevision((value) => value + 1), []) };
}

/* ──────────────────────────── 资产行 ──────────────────────────── */

function fileNameOf(url: string, name: string): string {
  const segment = url.split("/").pop()?.split(/[?#]/)[0];
  return segment && segment.length > 0 ? segment : `${name}.glb`;
}

function AssetRow({ asset }: { asset: Asset }) {
  const url = assetGlbUrl(asset);
  const entry = useAssetLoadStore((state) => (url ? state.byUrl[url] : undefined));
  const retry = useAssetLoadStore((state) => state.retry);
  const addObject = useDirectorStore((state) => state.addObject);
  const select = useDirectorStore((state) => state.select);
  const name = assetDisplayName(asset);

  const handleAdd = () => {
    if (!url) return;
    useAssetLoadStore.getState().begin(url);
    const id = addObject({
      name,
      type: "model",
      visible: true,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      assetUrl: url,
      fileName: fileNameOf(url, name),
    });
    select(id);
  };

  return (
    // name 已是中文映射名（P1-10）；title 优先简介，否则回显原始英文名（如 Female Looking Up）
    <li className="ds-assets__item" title={asset.intro ?? asset.name ?? name}>
      <span className="ds-assets__item-name">{name}</span>
      {entry?.status === "loading" ? (
        <span className="ds-assets__progress">
          <CircleNotch size={12} className="spin" />
          加载中…
        </span>
      ) : entry?.status === "error" ? (
        <span className="ds-assets__failure">
          <span className="ds-assets__failure-text" title={entry.message}>
            加载失败
          </span>
          <button type="button" className="ds-assets__retry" onClick={() => retry(url!)}>
            <ArrowClockwise size={12} />
            重试
          </button>
        </span>
      ) : (
        <button type="button" className="ds-assets__add" onClick={handleAdd} disabled={!url}>
          <Plus size={12} />
          添加
        </button>
      )}
    </li>
  );
}

/* ──────────────────────────── 面板主体 ──────────────────────────── */

export function AssetsPanel() {
  const { data, reload } = useAssetLibrary();
  const [query, setQuery] = useState("");
  // 分组折叠状态：默认全部折叠（519 条不平铺，展开才渲染条目）
  const [expanded, setExpanded] = useState<Partial<Record<DirectorAssetKind, boolean>>>({});

  const assets = data.phase === "ready" ? data.assets : [];
  const filtered = filterAssetsByQuery(assets, query);
  const groups = groupAssetsByKind(filtered);
  const keyword = query.trim();

  const toggleGroup = (kind: DirectorAssetKind) =>
    setExpanded((current) => ({ ...current, [kind]: !current[kind] }));

  return (
    <div className="ds-assets">
      <div className="ds-assets__head">
        资产库
        <span className="ds-assets__count">
          {data.phase === "ready" ? (keyword ? `${filtered.length}/${assets.length}` : assets.length) : "—"}
        </span>
      </div>

      {data.phase === "ready" && data.source !== "api" ? (
        <div className="ds-assets__banner" role="status">
          <WarningCircle size={13} />
          {data.source === "demo"
            ? "离线演示 · 以下为示例资产"
            : "资产库未连接，当前为内置资产"}
        </div>
      ) : null}

      <div className="ds-assets__search">
        <input
          className="ds-assets__search-input"
          type="text"
          autoComplete="off"
          value={query}
          placeholder="搜索资产名称"
          onChange={(event) => setQuery(event.target.value)}
        />
        <MagnifyingGlass className="ds-assets__search-icon" size={12} />
      </div>

      <div className="ds-assets__body">
        {data.phase === "loading" ? (
          <div className="ds-assets__skeletons" aria-busy="true" aria-label="资产库加载中">
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : null}

        {data.phase === "error" ? (
          <div className="ds-assets__notice" role="alert">
            <p>{data.message}</p>
            <button type="button" className="ds-assets__retry ds-assets__retry--block" onClick={reload}>
              <ArrowClockwise size={12} />
              重试
            </button>
          </div>
        ) : null}

        {data.phase === "ready" && assets.length === 0 ? (
          <div className="ds-assets__notice">资产库暂无 3D 资产（未入库）</div>
        ) : null}

        {data.phase === "ready" && assets.length > 0 && filtered.length === 0 ? (
          <div className="ds-assets__notice">无匹配资产，换个关键词试试</div>
        ) : null}

        {data.phase === "ready" && filtered.length > 0
          ? groups.map((group) => {
              const open = expanded[group.kind] === true;
              return (
                <div className="ds-assets__group" key={group.kind}>
                  <button
                    type="button"
                    className="ds-assets__group-head"
                    aria-expanded={open}
                    onClick={() => toggleGroup(group.kind)}
                  >
                    <span
                      className={
                        open ? "ds-assets__caret ds-assets__caret--open" : "ds-assets__caret"
                      }
                    />
                    <span className="ds-assets__group-label">{group.label}</span>
                    <span className="ds-assets__group-count">{group.items.length}</span>
                  </button>
                  {open ? (
                    <ul className="ds-assets__list">
                      {group.items.length === 0 ? (
                        <li className="ds-assets__group-empty">该分组暂无匹配资产</li>
                      ) : (
                        group.items.map((asset) => <AssetRow key={asset.id} asset={asset} />)
                      )}
                    </ul>
                  ) : null}
                </div>
              );
            })
          : null}
      </div>
    </div>
  );
}
