/**
 * 3D 导演台 · 左栏页签坞（W5.5：场景对象 / 资产库 双页签）
 *
 * 占满 .ds-left 网格位（padding 清零、纵向 flex），顶部页签切换两个面板：
 * - 场景对象 <ObjectListPanel />（原左栏清单，含清空按钮）
 * - 资产库 <AssetsPanel />（asset_entities 3D 资产，分组/搜索/添加入台）
 *
 * 页签状态组件内 useState（不进 store，不随快照持久化）。
 */
import { useState } from "react";

import { Package, Stack } from "@phosphor-icons/react";

import { AssetsPanel } from "./AssetsPanel";
import { ObjectListPanel } from "./ObjectListPanel";

import "./LeftDock.css";

type DockTab = "objects" | "assets";

export function LeftDock() {
  const [tab, setTab] = useState<DockTab>("objects");

  return (
    <aside className="ds-left ds-dock">
      <div className="ds-dock__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "objects"}
          className={tab === "objects" ? "ds-dock__tab ds-dock__tab--on" : "ds-dock__tab"}
          onClick={() => setTab("objects")}
        >
          <Stack size={13} />
          场景对象
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "assets"}
          className={tab === "assets" ? "ds-dock__tab ds-dock__tab--on" : "ds-dock__tab"}
          onClick={() => setTab("assets")}
        >
          <Package size={13} />
          资产库
        </button>
      </div>
      {tab === "objects" ? <ObjectListPanel /> : <AssetsPanel />}
    </aside>
  );
}
