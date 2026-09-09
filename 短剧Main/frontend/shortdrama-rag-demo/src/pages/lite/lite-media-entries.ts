/* ============================================================
   lite-media-entries.ts — Lite 图/视频/下载页共用的生成结果展开逻辑与
   demo fixture。数据源唯一：api.projectGenerations（后端 generationData
   wire：任务级 status/phase/created_at + media_results 媒体行；model/failure_reason
   已随主线 FABLE-007 不再下发，Lite 展示不编造模型名，失败原因读 display_reason）。
   已核实的后端事实（施工时读代码确认，不凭印象）：
   - generations 列表的 media_results 只含 persistence_status='persisted'
     的行（generation/repository.ts persistedMedia），未持久化结果不进列表；
   - wire 的 media_results 行带 id/media_kind/storage_url/mime_type/created_at，
     不带 duration_seconds / 文件大小 / prompt（下载页不编造这些列）；
   - delivery 下载端点只放 persisted（delivery/repository.ts getDownload）。
   ============================================================ */
import type { GenerationTask, MediaResult } from "../../types";

/** 一条可展示的媒体结果 = 媒体行 + 所属任务（状态/阶段都在任务级）。 */
export interface LiteMediaEntry {
  task: GenerationTask;
  media: MediaResult;
}

/** 展开项目生成任务为媒体条目（新→旧；媒体行缺 storage_url 的不展示——没有可渲染地址）。 */
export function liteMediaEntries(tasks: GenerationTask[], kind: "image" | "video"): LiteMediaEntry[] {
  const entries: LiteMediaEntry[] = [];
  for (const task of tasks) {
    for (const media of task.media_results ?? []) {
      if (media.media_kind !== kind || !media.storage_url) continue;
      entries.push({ task, media });
    }
  }
  return entries.sort((a, b) => liteMediaEntryTime(b).localeCompare(liteMediaEntryTime(a)));
}

/** 条目时间：媒体行 created_at，兜底任务 created_at/updated_at（wire 三项都可空，空串排最后）。 */
export function liteMediaEntryTime(entry: LiteMediaEntry): string {
  return entry.media.created_at ?? entry.task.created_at ?? entry.task.updated_at ?? "";
}

/** 下载闸门：delivery 端点要求 persisted。generations wire 当前不输出
    persistence_status（列表已只含 persisted 行），缺省视为可下载；
    显式非 persisted → 调用方给「归档中」禁用态，不拼假下载。 */
export function liteMediaDownloadable(entry: LiteMediaEntry): boolean {
  return mediaDownloadable(entry.media);
}

/** 同一条闸门的原子形态：手里只有 media 行(如分镜卡的出片列表)时用这个,别再抄一份判定。 */
export function mediaDownloadable(media: { persistence_status?: string | null }): boolean {
  const status = media.persistence_status;
  return status == null || status === "persisted";
}

/* ---------- demo fixture（离线演示；storage_url 为占位串，不代表真实文件） ---------- */

/** 与 demo.ts demoStillUri 同手法：data: SVG 离线占位图。 */
function liteDemoStill(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="hsl(${hue},24%,18%)"/><text x="160" y="96" font-size="26" fill="hsl(${hue},30%,72%)" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Lite 图片页 fixture：3 个图像任务 4 张候选图（含多候选；wire 已不下发 model，不再编造）。 */
export const demoLiteImageTasks: GenerationTask[] = [
  {
    generation_request_id: "demo-gen-img-3",
    status: "succeeded",
    phase: "complete",
    media_results: [
      { id: "demo-img-3a", media_kind: "image", storage_url: liteDemoStill("候选图 3A", 172), mime_type: "image/png", created_at: "2026-08-06T09:12:00Z" },
      { id: "demo-img-3b", media_kind: "image", storage_url: liteDemoStill("候选图 3B", 200), mime_type: "image/png", created_at: "2026-08-06T09:12:00Z" },
    ],
    created_at: "2026-08-06T09:10:00Z",
    updated_at: "2026-08-06T09:12:00Z",
  },
  {
    generation_request_id: "demo-gen-img-2",
    status: "succeeded",
    phase: "complete",
    media_results: [
      { id: "demo-img-2a", media_kind: "image", storage_url: liteDemoStill("候选图 2", 260), mime_type: "image/png", created_at: "2026-08-05T15:40:00Z" },
    ],
    created_at: "2026-08-05T15:38:00Z",
    updated_at: "2026-08-05T15:40:00Z",
  },
  {
    generation_request_id: "demo-gen-img-1",
    status: "succeeded",
    phase: "complete",
    media_results: [
      { id: "demo-img-1a", media_kind: "image", storage_url: liteDemoStill("候选图 1", 320), mime_type: "image/png", created_at: "2026-08-04T11:05:00Z" },
    ],
    created_at: "2026-08-04T11:02:00Z",
    updated_at: "2026-08-04T11:05:00Z",
  },
];

/** Lite 视频/下载页 fixture：2 条已归档成片 + 1 条归档中（演示「归档中」禁用态与下载页过滤）。 */
export const demoLiteVideoTasks: GenerationTask[] = [
  {
    generation_request_id: "demo-gen-vid-2",
    status: "succeeded",
    phase: "complete",
    media_results: [
      { id: "demo-video-b", media_kind: "video", storage_url: "https://storage.example/demo/ep1/shot-2.mp4", mime_type: "video/mp4", created_at: "2026-08-06T10:02:00Z" },
    ],
    created_at: "2026-08-06T09:58:00Z",
    updated_at: "2026-08-06T10:02:00Z",
  },
  {
    generation_request_id: "demo-gen-vid-1",
    status: "succeeded",
    phase: "complete",
    media_results: [
      { id: "demo-video-a", media_kind: "video", storage_url: "https://storage.example/demo/ep1/shot-1.mp4", mime_type: "video/mp4", created_at: "2026-08-05T16:20:00Z", persistence_status: "persisted" },
    ],
    created_at: "2026-08-05T16:15:00Z",
    updated_at: "2026-08-05T16:20:00Z",
  },
  {
    generation_request_id: "demo-gen-vid-0",
    status: "succeeded",
    phase: "persisting",
    media_results: [
      { id: "demo-video-c", media_kind: "video", storage_url: "https://storage.example/demo/ep1/shot-3.mp4", mime_type: "video/mp4", created_at: "2026-08-06T10:30:00Z", persistence_status: "pending" },
    ],
    created_at: "2026-08-06T10:26:00Z",
    updated_at: "2026-08-06T10:30:00Z",
  },
];
