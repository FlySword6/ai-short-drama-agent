/* ============================================================
   tier-selection.ts — 当前选中档的会话级共享（K2S 返工轮）

   口径「同镜同档同价」：批量清单抽屉（板03 分镜管理页）与工作台单镜估价
   （板04 工作台）分属两个页面，档选择状态原是工作台组件私有——批量抽屉
   只能恒取首 active 档，S83 之后单镜随档变价、批量不动，同镜两价。
   本模块把「当前选中档 id」按媒体类型记入 sessionStorage：
   - 写方：workbench-page.tsx——demo 模式下当前选中档（含缺省首档）落盘；
   - 读方：batch-generate-drawer.tsx——demo 批量估价按它解析同一档，
     行价与单镜同一函数 demoEstimatePoints 同一档；
   - 只服务 demo 随档取价；真栈批量按服务端 batchEstimate 报价，不读本记录。

   存储读写全部防御式（隐私模式写不进、旧数据损坏都不抛错），
   与 routing.ts 项目位置记录同一款式；storage 注入便于 node:test 直测。
   ============================================================ */

import type { CapabilityMediaType } from "./capability-tiers";

/** 只需 get/set 两方法的存储面（window.sessionStorage 与测试替身都满足）。 */
export interface TierSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const TIER_SELECTION_KEY = "shortdrama_v011_selected_tier";

function readRecord(storage: TierSelectionStorage): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(storage.getItem(TIER_SELECTION_KEY) || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // 存储损坏/读失败按空记录处理
  }
  return {};
}

/** 记住某媒体类型的当前选中档 id（写入失败静默——读方会回落首 active 档，不阻塞估价）。 */
export function rememberSelectedTierId(
  storage: TierSelectionStorage,
  mediaType: CapabilityMediaType,
  tierId: string,
): void {
  if (!tierId) return;
  try {
    storage.setItem(TIER_SELECTION_KEY, JSON.stringify({ ...readRecord(storage), [mediaType]: tierId }));
  } catch {
    // 隐私模式等写入失败不影响导航与估价
  }
}

/** 读出某媒体类型最近选中的档 id；没选过/记录损坏返回 null（调用方回落首 active 档）。 */
export function recallSelectedTierId(
  storage: TierSelectionStorage,
  mediaType: CapabilityMediaType,
): string | null {
  const value = readRecord(storage)[mediaType];
  return typeof value === "string" && value.length > 0 ? value : null;
}
