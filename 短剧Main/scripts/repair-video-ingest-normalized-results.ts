import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client.js";
import { assetEntities, assetMedia, videoIngestTasks } from "../src/db/schema.js";
import type { JsonObject } from "../src/domain/assets/types.js";
import { AssetEntityRepository } from "../src/repositories/assetEntityRepository.js";
import { VectorSyncService } from "../src/services/vectorSyncService.js";
import {
  buildVideoEntityVectorText,
  buildVideoVectorText,
  normalizeVideoUnderstanding,
} from "../src/modules/video-ingest/normalizer.js";
import {
  buildVideoAssetName,
  shouldReplaceVideoAssetName,
  VideoIngestRepository,
} from "../src/modules/video-ingest/repository.js";

interface Options {
  taskId?: string;
  write: boolean;
  syncVector: boolean;
  limit: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { db, pool } = createDatabase();
  try {
    const tasks = options.taskId
      ? await db.select().from(videoIngestTasks).where(eq(videoIngestTasks.id, options.taskId)).limit(1)
      : await db.select().from(videoIngestTasks)
        .where(sql`${videoIngestTasks.status} = 'succeeded' and ${videoIngestTasks.rawResult} is not null`)
        .orderBy(videoIngestTasks.createdAt)
        .limit(options.limit);
    if (tasks.length === 0) {
      console.log("[video-repair] 没有找到可修复的视频解析任务");
      return;
    }

    const repository = new VideoIngestRepository(db);
    const entities = new AssetEntityRepository(db);
    const vectorSync = new VectorSyncService();
    let vectorFailed = 0;
    for (const task of tasks) {
      const raw = task.rawResult as JsonObject | null;
      if (!raw) continue;
      const normalized = normalizeVideoUnderstanding(raw, task.sourceVideoPath);
      const vectorText = buildVideoVectorText(normalized);
      const previous = task.normalizedResult as Record<string, unknown> | null;
      const [asset] = await db.select().from(assetEntities).where(eq(assetEntities.id, task.assetEntityId)).limit(1);
      const [media] = await db.select().from(assetMedia).where(eq(assetMedia.id, task.assetMediaId)).limit(1);
      const resolution = resolutionFromRawResult(raw);
      const nextName = buildVideoAssetName(normalized, asset?.name ?? media?.title ?? "参考视频");
      const willRename = shouldReplaceVideoAssetName(asset?.name ?? null, media?.title ?? null);
      console.log("[video-repair] preview", {
        task_id: task.id,
        asset_entity_id: task.assetEntityId,
        asset_media_id: task.assetMediaId,
        source_video_path: task.sourceVideoPath,
        previous_asset_name: asset?.name ?? null,
        previous_media_title: media?.title ?? null,
        next_asset_name: willRename ? nextName : asset?.name ?? nextName,
        will_rename: willRename,
        previous_media_description: media?.description ?? null,
        previous_width_px: media?.widthPx ?? null,
        previous_height_px: media?.heightPx ?? null,
        previous_summary: previous?.summary ?? null,
        next_summary: normalized.summary,
        next_scene: normalized.scene,
        next_tags: normalized.tags,
        next_width_px: resolution.widthPx ?? media?.widthPx ?? null,
        next_height_px: resolution.heightPx ?? media?.heightPx ?? null,
        write: options.write,
      });
      if (!options.write) continue;
      const updated = await repository.markSucceeded({
        taskId: task.id,
        rawResult: raw,
        normalizedResult: normalized,
        vectorText,
      });
      if (options.syncVector) {
        try {
          const entity = entities.toData(updated);
          await vectorSync.syncEntityWithText(entity, buildVideoEntityVectorText(entity.name, vectorText));
          console.log("[video-repair] vector synced", { asset_entity_id: updated.id });
        } catch (error) {
          vectorFailed += 1;
          console.error("[video-repair] vector sync failed", {
            asset_entity_id: updated.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (!options.write) {
      console.log("[video-repair] 当前是预览模式；确认后加 --write 写回数据库。");
    }
    if (vectorFailed > 0) {
      console.error(`[video-repair] ${vectorFailed} 条向量同步失败；PostgreSQL 已按 --write 写回，可稍后单独重试 --sync-vector。`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

function parseArgs(args: string[]): Options {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (args.includes("--help") || args.includes("-h")) {
    console.log([
      "用法:",
      "  npx.cmd tsx scripts/repair-video-ingest-normalized-results.ts",
      "  npx.cmd tsx scripts/repair-video-ingest-normalized-results.ts --task-id <id> --write --sync-vector",
      "",
      "参数:",
      "  --task-id <id>   只修复指定任务。",
      "  --limit <n>      未指定 task-id 时最多扫描多少条，默认 50。",
      "  --write          写回 normalized_result、资产 intro/appearance/tags。",
      "  --sync-vector    写回后同步向量检索投影。",
    ].join("\n"));
    process.exit(0);
  }
  return {
    taskId: value("task-id"),
    write: args.includes("--write"),
    syncVector: args.includes("--sync-vector"),
    limit: numberArg(value("limit"), 50),
  };
}

function numberArg(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`数字参数非法: ${raw}`);
  return value;
}

function resolutionFromRawResult(raw: JsonObject): { widthPx: number | null; heightPx: number | null } {
  const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
    ? raw.data as Record<string, unknown>
    : {};
  const resolution = typeof data.resolution === "string"
    ? data.resolution
    : typeof raw.resolution === "string"
      ? raw.resolution
      : "";
  const match = /(\d{2,5})\s*[xX×]\s*(\d{2,5})/u.exec(resolution);
  if (match) return { widthPx: Number(match[1]), heightPx: Number(match[2]) };
  return {
    widthPx: positiveInteger(data.width ?? data.width_px ?? data.video_width ?? raw.width ?? raw.width_px),
    heightPx: positiveInteger(data.height ?? data.height_px ?? data.video_height ?? raw.height ?? raw.height_px),
  };
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

main().catch((error: unknown) => {
  console.error("[video-repair] failed", error);
  process.exitCode = 1;
});
