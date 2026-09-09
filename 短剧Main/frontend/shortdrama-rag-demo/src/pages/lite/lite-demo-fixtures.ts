/* ============================================================
   lite-demo-fixtures.ts — Lite 壳与分镜详情共享的离线演示 fixture
   （v1.6 反馈①追加：分镜切换 tab 上壳顶栏后，壳与详情页共用同一份
   演示数据，不许两处各写一套。）
   ============================================================ */
import type { Episode, Project, Scene, Shot } from "../../types";

export const DEMO_PROJECT: Project = {
  id: "demo-lite-project",
  name: "演示短剧项目",
  lite_episode_id: "demo-lite-episode",
};

export const DEMO_EPISODE: Episode = {
  id: "demo-lite-episode",
  project_id: "demo-lite-project",
  episode_no: 1,
  name: "演示第一集",
};

export const DEMO_EPISODES: Episode[] = [DEMO_EPISODE];

export const DEMO_SCENES: Scene[] = [
  { id: "demo-scene-1", episode_id: "demo-lite-episode", name: "旧宅门口" },
  { id: "demo-scene-2", episode_id: "demo-lite-episode", name: "客厅" },
];

export const DEMO_SHOT: Shot = {
  id: "demo-lite-shot-1",
  episode_id: "demo-lite-episode",
  shot_no: "3",
  title: "旧宅门口",
  scene_id: "demo-scene-1",
  script_text: "林晚：你怎么会在这里？",
  breakdown_elements: { subject: "任天野（男主）", action: "从夜色中走出", visual: "旧宅门口、昏黄灯光", camera_language: "中景·平视" },
  duration_seconds: 4,
  video_prompt: "示例视频提示词：夜色中任天野缓步走出，镜头跟随，氛围压抑。",
  metadata: { atmosphere: "压抑", dialogue: { lines: [{ speaker: "林晚", text: "你怎么会在这里？" }] }, prompt_locked: false },
  sort_order: 3,
  /* v1.5.1：Lite 分镜引用真值 = reference_asset_snapshots（三路写入，合同 8.8）。 */
  reference_asset_snapshots: [
    { asset_entity_id: "demo-asset-ren", variant_id: "demo-var-1", name: "任天野", asset_kind: "character", matched_by: "exact_name", status: "bound", image_url: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=96&h=96&q=60" },
    { asset_entity_id: "demo-asset-door", variant_id: null, name: "旧宅铁门", asset_kind: "prop", matched_by: "exact_name", status: "bound", image_url: "https://images.unsplash.com/photo-1523217582562-09d0def993a6?auto=format&fit=crop&w=96&h=96&q=60" },
  ],
};

export const DEMO_SHOTS: Shot[] = [
  DEMO_SHOT,
  {
    id: "demo-lite-shot-2",
    episode_id: "demo-lite-episode",
    shot_no: "4",
    title: "客厅对峙",
    script_text: "任天野：进屋再说。",
    breakdown_elements: { subject: "任天野", action: "推门进屋", visual: "客厅", camera_language: "全景·跟拍" },
    duration_seconds: 5,
    sort_order: 4,
  },
];
