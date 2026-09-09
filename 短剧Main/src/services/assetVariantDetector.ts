export interface AssetVariantInfo {
  parentName: string;
  variantName: string;
  variantKind: string;
  sourceName: string;
}

const PREFIX_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ["心魔版", "心魔版"],
  ["心魔", "心魔版"],
  ["天尊版", "天尊版"],
  ["升级版", "升级版"],
  ["古装版", "古装版"],
  ["现代版", "现代版"],
  ["礼服版", "礼服版"],
  ["战斗版", "战斗版"],
];

const SUFFIX_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ["心魔版", "心魔版"],
  ["天尊版", "天尊版"],
  ["升级版", "升级版"],
  ["古装版", "古装版"],
  ["现代版", "现代版"],
  ["礼服版", "礼服版"],
  ["战斗版", "战斗版"],
];

export function detectAssetVariant(assetKind: string, assetName?: string | null): AssetVariantInfo | null {
  if (assetKind !== "character") return null;
  const sourceName = cleanName(assetName);
  if (!sourceName) return null;

  for (const [marker, variantName] of PREFIX_VARIANTS) {
    if (!sourceName.startsWith(marker)) continue;
    const parentName = sourceName.slice(marker.length).trim();
    if (parentName) return { parentName, variantName, variantKind: "look", sourceName };
  }

  for (const [marker, variantName] of SUFFIX_VARIANTS) {
    if (!sourceName.endsWith(marker)) continue;
    const parentName = sourceName.slice(0, -marker.length).trim();
    if (parentName) return { parentName, variantName, variantKind: "look", sourceName };
  }

  return null;
}

function cleanName(value?: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, "");
}
