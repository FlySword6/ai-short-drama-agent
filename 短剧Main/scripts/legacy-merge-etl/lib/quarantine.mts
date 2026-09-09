/**
 * 人工指定资产隔离清单(plan/apply 共用)。
 * 用途:归属抽查等人工审核发现某源 asset_entities 行"带病"(如图片归属错配),
 * 在人工处置完成前不许进目标库——与 users/projects 的 manual_confirmed 对称,
 * 这里是 manual_quarantined:显式名单 + 理由 + 登记人,不自动猜、不静默放过。
 *
 * 文件形状(cli --asset-quarantine):
 * {
 *   "assets": {
 *     "<source asset_entities.id>": { "reason": "为什么带病", "decidedBy": "登记人" }
 *   }
 * }
 */

export interface AssetQuarantineEntry {
  reason: string;
  decidedBy: string;
}

/** 解析并校验隔离清单 JSON(已 JSON.parse 的对象);非法即抛错,fail-fast。 */
export function parseAssetQuarantine(parsed: unknown): Map<string, AssetQuarantineEntry> {
  const result = new Map<string, AssetQuarantineEntry>();
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("资产隔离清单必须是对象: { \"assets\": { \"<sourcePk>\": { reason, decidedBy } } }");
  }
  const assets = (parsed as { assets?: unknown }).assets;
  if (assets === undefined || assets === null) return result;
  if (typeof assets !== "object" || Array.isArray(assets)) {
    throw new Error("资产隔离清单 assets 必须是对象映射: sourcePk → { reason, decidedBy }");
  }
  for (const [sourcePk, entry] of Object.entries(assets as Record<string, unknown>)) {
    if (sourcePk.trim() === "") throw new Error("资产隔离清单存在空 sourcePk");
    const e = entry as Partial<AssetQuarantineEntry> | null;
    if (!e || typeof e.reason !== "string" || e.reason.trim() === "" || typeof e.decidedBy !== "string" || e.decidedBy.trim() === "") {
      throw new Error(`资产隔离清单 assets["${sourcePk}"] 非法:必须是 { "reason": "<非空理由>", "decidedBy": "<登记人>" }`);
    }
    result.set(sourcePk, { reason: e.reason, decidedBy: e.decidedBy });
  }
  return result;
}
