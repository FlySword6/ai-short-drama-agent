/**
 * 读参照答案(金标)。金标由更强的模型独立标注,不看平台拆解结果;
 * 剧本正文是版权件不进仓库,金标只留 sha256 与行号锚点。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GoldAssetEpisode, GoldSceneEpisode } from "./types.js";
import type { GoldBundle } from "./metrics.js";

function readEpisodes<T>(dir: string): Map<string, T> {
  const entries = new Map<string, T>();
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("ep-") || !name.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as T & { episodeId: string };
    entries.set(parsed.episodeId, parsed);
  }
  return entries;
}

export function loadGold(goldRoot: string): GoldBundle {
  return {
    asset: readEpisodes<GoldAssetEpisode>(join(goldRoot, "asset")),
    scene: readEpisodes<GoldSceneEpisode>(join(goldRoot, "scene")),
  };
}
