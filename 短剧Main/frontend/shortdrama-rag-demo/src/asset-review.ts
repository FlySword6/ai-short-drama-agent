/* ============================================================
   asset-review.ts — 资产审核态的入口侧呈现（GP-14 / 剧本步 10 口径）

   后端规则真源（src/modules/control-packages/repository.ts assertReferenceAccessible，
   bug 账 A 裁决「检索可见可看不可用」）：
   资产实体 status 为 pending_review / rejected 时，挂入控制包（参考组）一律 422——
   「资产《X》尚未通过审核（当前：待审核/已拒绝），先在资产审核中通过后再挂栏」；
   不分栏类型，全栏同一口径。加入项目引用（POST /projects/:id/assets）不校验审核态，
   生成提交也不校验——入口侧唯一真正的关口就是「挂入参考」这一步，故前端在入口置灰。

   wire 词表两套：真栈实体 status ∈ automatic_review/pending_review/approved/rejected
   （migrations/007_review_domain.sql）；demo fixture 用 pending/ready。
   徽标文案与 K2A 产物审核映射（version-modal reviewStatusLabelOf）同口径：
   待审核 / 已拒绝（已通过侧不标，默认外观即已通过）。
   ============================================================ */

import type { Asset } from "./types";

/** 入口侧需要标出的审核态（ready/approved/automatic_review 不标，保持默认外观）。 */
export type AssetReviewLabel = "待审核" | "已拒绝";

/** 资产 → 审核徽标文案；两套词表都认，空/未知状态不标（不猜）。 */
export function assetReviewLabelOf(asset: Pick<Asset, "status">): AssetReviewLabel | null {
  const status = (asset.status ?? "").trim();
  if (status === "pending" || status === "pending_review") return "待审核";
  if (status === "rejected") return "已拒绝";
  return null;
}

/**
 * 挂入闸门（对齐后端 422，全栏一律）：待审核/已拒绝 → 不可挂入 + 人话原因；
 * 其余放行。原因文案与后端 422 同一说法（先在资产审核中通过后再挂入）。
 */
export function assetAttachGate(asset: Pick<Asset, "status">): { allowed: boolean; reason: string } {
  const label = assetReviewLabelOf(asset);
  if (label === "待审核") return { allowed: false, reason: "待审核：先在资产审核中通过，才能挂入参考" };
  if (label === "已拒绝") return { allowed: false, reason: "已拒绝：审核未通过的资产不能挂入参考" };
  return { allowed: true, reason: "" };
}
