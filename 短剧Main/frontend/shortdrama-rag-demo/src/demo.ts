import type { Asset, DashboardSummary, Episode, GenerationAttemptNotification, MediaVersion, Project, ProjectAssetRef, Scene, Shot, StoryboardImportRecord, TrashItem, User } from "./types";
import type { LiteAssetListItem, LiteAssetVariant, PlazaRecord, ScriptBreakdownRun, ScriptBreakdownRunDetail, ScriptVersion } from "./api";
import type { TaskQueueRow } from "./generation-task-queue";
import type { BreakdownCandidate, BreakdownRequirement } from "./requirement-breakdown";

export const demoUser: User = { id: "demo-user", username: "alice", display_name: "Alice", ui_mode: "full" };

export const demoProjects: Project[] = [
  { id: "demo-project-1", name: "《老公诈死》", description: "最近处理 EP1", status: "进行中", genre: "复仇", episode_count: 12, asset_count: 11, shot_count: 64, created_at: "2026-07-10T09:00:00Z", updated_at: "2026-07-22T09:00:00Z" },
  { id: "demo-project-2", name: "《杀穿女频》", description: "第 8 集细节待确认", status: "进行中", genre: "重生", episode_count: 18, asset_count: 15, shot_count: 96, created_at: "2026-07-01T09:00:00Z", updated_at: "2026-07-23T09:00:00Z" },
  { id: "demo-project-3", name: "《重返十八岁》", description: "场景清单与演员排期同步中", status: "进行中", episode_count: 24, asset_count: 20, shot_count: 120 },
  { id: "demo-project-4", name: "《她从火光中来》", description: "成片与宣发素材已交付", status: "已归档", episode_count: 24, asset_count: 24, shot_count: 120 },
  { id: "demo-project-5", name: "《入局》", description: "预算超出预估，需要复核", status: "进行中", episode_count: 16, asset_count: 14, shot_count: 80 },
  { id: "demo-project-6", name: "《回到1998》", description: "题材评估与爆款标签分析中", status: "进行中", genre: "穿越", episode_count: 20, asset_count: 8, shot_count: 90, created_at: "2026-07-15T09:00:00Z", updated_at: "2026-07-20T09:00:00Z" },
];

export const demoPersonalAssets: Asset[] = [
  { id: "asset-ren", asset_kind: "character", role: "character_identity", name: "任天野", display_name: "任天野", intro: "钦差官服，主角视觉锚点", scope: "personal", status: "ready", style_tags: ["青年", "人族"] },
  { id: "asset-lin", asset_kind: "character", name: "林秋棠", display_name: "林秋棠", intro: "女主造型待补充发饰", scope: "personal", status: "pending", style_tags: ["青年", "人族"] },
  { id: "asset-harbor", asset_kind: "scene", role: "scene", name: "巷口雨夜", display_name: "巷口雨夜", intro: "可复用夜戏外景氛围", scope: "personal", status: "ready", style_tags: ["夜戏", "外景"] },
  { id: "asset-knife", asset_kind: "prop", role: "prop", name: "银边短刀", display_name: "银边短刀", intro: "近景特写生成中", scope: "personal", status: "pending", style_tags: ["特写", "冷兵器"] },
  { id: "asset-costume", asset_kind: "costume", name: "钦差官服", display_name: "钦差官服", intro: "新增服装列样例，可绑定角色", scope: "personal", status: "ready", style_tags: ["古装", "主角"] },
  { id: "asset-light", asset_kind: "lighting", role: "style_env", name: "冷月光", display_name: "冷月光", intro: "冷色调光线参考", scope: "personal", status: "pending", style_tags: ["冷色"] },
  { id: "asset-camera", asset_kind: "camera", role: "camera_storyboard", name: "手持推进", display_name: "手持推进", intro: "自然相机运动模板", scope: "personal", status: "ready", style_tags: ["镜头", "运动"] },
  { id: "asset-sound", asset_kind: "sound", name: "低频脚步", display_name: "低频脚步", intro: "声音参考，本版只展示资产", scope: "personal", status: "pending", style_tags: ["脚步"] },
  /* S88：动物类资产样例（DC 判决——动物是角色的子类，展示「角色·动物」，与角色不并列）。 */
  { id: "asset-tiger", asset_kind: "animal", role: "character_identity", name: "山林猛虎", display_name: "山林猛虎", intro: "动物角色，山林戏视觉锚点", scope: "personal", status: "ready", style_tags: ["动物", "猛兽"] },
  /* P-07 验收基准：白发师父 1/2(只有特写=大头照,缺全身照)。 */
  { id: "demo-asset-master", asset_kind: "character", role: "character_identity", name: "白发师父", display_name: "白发师父", intro: "世外高人，主角师父", scope: "personal", status: "ready", style_tags: ["老年", "人族"] },
];

export const demoCommonAssets: Asset[] = [
  { ...demoPersonalAssets[0]!, id: "common-ren", name: "任天野标准版", display_name: "任天野标准版", scope: "common", intro: "由个人资产转为通用资产" },
  { ...demoPersonalAssets[4]!, id: "common-costume", name: "官服套装", display_name: "官服套装", scope: "common", intro: "服装资产，可复用绑定" },
  { ...demoPersonalAssets[2]!, id: "common-palace", name: "府衙正堂", display_name: "府衙正堂", scope: "common", intro: "古装审案场景" },
  { ...demoPersonalAssets[3]!, id: "common-jade", name: "玉佩信物", display_name: "玉佩信物", scope: "common", intro: "剧情关键道具" },
  { ...demoPersonalAssets[0]!, id: "common-child", name: "儿童小乞丐", display_name: "儿童小乞丐", scope: "common", intro: "群演资产，已入库", style_tags: ["儿童", "人族"] },
  { ...demoPersonalAssets[0]!, id: "common-middle", name: "中年掌柜", display_name: "中年掌柜", scope: "common", intro: "店铺经营角色", style_tags: ["中年", "人族"] },
  { ...demoPersonalAssets[0]!, id: "common-old", name: "老年族长", display_name: "老年族长", scope: "common", intro: "宗族戏份角色", style_tags: ["老年", "人族"] },
  { ...demoPersonalAssets[7]!, id: "common-music", name: "战鼓配乐", display_name: "战鼓配乐", scope: "common", intro: "战斗节奏模板" },
];

export const demoProjectAssets: ProjectAssetRef[] = [
  ...demoPersonalAssets.slice(0, 4).map((asset, index) => ({ id: `ref-${index + 1}`, project_id: "demo-project-2", asset_id: asset.id, asset })),
  { id: "ref-5", project_id: "demo-project-2", asset_id: "common-palace", asset: demoCommonAssets[2] },
  { id: "ref-6", project_id: "demo-project-2", asset_id: "common-costume", asset: demoCommonAssets[1] },
  { id: "ref-7", project_id: "demo-project-2", asset_id: "demo-asset-master", asset: demoPersonalAssets.find((asset) => asset.id === "demo-asset-master")! },
];

export const demoEpisodes: Episode[] = [
  { id: "demo-episode-1", project_id: "demo-project-2", episode_no: 1, name: "第1集", status: "active", shot_count: 6, sort_order: 1 },
  { id: "demo-episode-2", project_id: "demo-project-2", episode_no: 2, name: "第2集", status: "active", shot_count: 6, sort_order: 2 },
  { id: "demo-episode-3", project_id: "demo-project-2", episode_no: 3, name: "第3集", status: "active", shot_count: 6, sort_order: 3 },
];

export const demoShots: Shot[] = [
  { id: "demo-shot-1", episode_id: "demo-episode-1", shot_no: "1", title: "#1 · 中景 · 平视", script_text: "任天野骑在照夜玉狮子上，银甲染血，从边军后方走出。", image_prompt: "", video_prompt: "", sort_order: 1, selected_image_result_id: "demo-image-1", selected_video_result_id: "demo-video-1" },
  { id: "demo-shot-2", episode_id: "demo-episode-1", shot_no: "2", title: "#2 · 中景 · 平视", script_text: "任天野骑在照夜玉狮子上，银甲染血。", image_prompt: "", video_prompt: "", sort_order: 2, selected_image_result_id: "demo-image-2", selected_video_result_id: "demo-video-2" },
  { id: "demo-shot-3", episode_id: "demo-episode-1", shot_no: "3", title: "#3 · 中景 · 平视", script_text: "李承瑶高声训斥，众人回头。", image_prompt: "", video_prompt: "", sort_order: 3, selected_image_result_id: "demo-image-3", selected_video_result_id: "demo-video-3" },
  { id: "demo-shot-4", episode_id: "demo-episode-1", shot_no: "4", title: "#4 · 特写", script_text: "任天野的眼睛微微眯起，寒光一闪。", image_prompt: "", video_prompt: "", sort_order: 4, selected_image_result_id: "demo-image-4", selected_video_result_id: "demo-video-4" },
  { id: "demo-shot-5", episode_id: "demo-episode-1", shot_no: "5", title: "#5 · 中景", script_text: "任天野低声回应，马蹄停在雨中。", image_prompt: "", video_prompt: "", sort_order: 5, selected_image_result_id: "demo-image-5", selected_video_result_id: "demo-video-5" },
  /* K2-P(GP-27):#6 是缺口镜——视频未生成,不选视频主版本(进度条/集头/交付口径的「缺口」都从这里读)。 */
  { id: "demo-shot-6", episode_id: "demo-episode-1", shot_no: "6", title: "#6 · 远景", script_text: "侍令下去，众军缓缓散开。", image_prompt: "", video_prompt: "", sort_order: 6, selected_image_result_id: "demo-image-6" },
];

/* K2-P 幕四彩排 fixture(基于 K2-A 真源表重做):第 1 集「5 镜已过审可交付 + 1 镜缺口」——
   素材 1-5 图/视频主版本俱齐、已选主版本、review_status=accepted(K2-A 的审核队列与交付
   闸门都由 review_status 驱动:光有媒体没有 accepted 会全落待审,彩排就变了);
   素材 6 只有主图(缺口镜,视频未生成,任何视频条目都不挂)。
   demo 审核队列(demo-review-delivery.ts)以本表为唯一真源派生,两边不许各写一份状态。
   队列也要能演:主版本之外,素材 2/4 各挂一条待审候选粗剪、素材 5 挂一条已拒绝候选
   (都 is_primary=false——不进交付核算、不占卡片主版本位),待审/已通过/已拒绝三页签都有内容。
   storage_url 是离线占位,不代表真实文件:图=data: URI;K2U D-14 起主版本视频=
   public/demo-media 的 4 秒可播小样(视频库/预览全集/整集连播三处真播),
   非主版本候选仍是 storage.example 串(审核队列不播视频,不产网络请求)。 */
function demoStillUri(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="hsl(${hue},24%,18%)"/><text x="160" y="96" font-size="26" fill="hsl(${hue},30%,72%)" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/* 主版本视频全部过审=「5 镜可交付」的前提;素材 6 没有视频(缺口镜),不在此表。 */
const DEMO_VIDEO_REVIEW_STATUS: Record<string, string> = {
  "demo-video-1": "accepted",
  "demo-video-2": "accepted",
  "demo-video-3": "accepted",
  "demo-video-4": "accepted",
  "demo-video-5": "accepted",
};

/* 候选粗剪(非主版本):给审核队列留可演内容——2 条待审 + 1 条已拒绝。
   is_primary=false:不进交付核算(demoReadyVideoIds 只数视频主版本),不影响卡片与进度。 */
const DEMO_CANDIDATE_MEDIA: Record<string, MediaVersion[]> = {
  "demo-shot-2": [{
    id: "demo-video-2b",
    media_kind: "video",
    title: "素材 2 候选粗剪",
    is_primary: false,
    persistence_status: "persisted",
    review_status: "needs_review",
    storage_url: "https://storage.example/demo/ep1/shot-2-alt.mp4",
    created_at: "2026-07-21T12:30:00Z",
  }],
  "demo-shot-4": [{
    id: "demo-video-4b",
    media_kind: "video",
    title: "素材 4 候选粗剪",
    is_primary: false,
    persistence_status: "persisted",
    review_status: "needs_review",
    storage_url: "https://storage.example/demo/ep1/shot-4-alt.mp4",
    created_at: "2026-07-21T12:40:00Z",
  }],
  "demo-shot-5": [{
    id: "demo-video-5b",
    media_kind: "video",
    title: "素材 5 候选粗剪",
    is_primary: false,
    persistence_status: "persisted",
    review_status: "rejected",
    storage_url: "https://storage.example/demo/ep1/shot-5-alt.mp4",
    created_at: "2026-07-21T12:50:00Z",
  }],
};

export const demoShotMedia: Record<string, MediaVersion[]> = Object.fromEntries(
  demoShots.map((shot, index) => {
    const no = index + 1;
    const imageId = `demo-image-${no}`;
    const videoId = `demo-video-${no}`;
    const entries: MediaVersion[] = [{
      id: imageId,
      media_kind: "image",
      title: `素材 ${no} 主图`,
      is_primary: true,
      persistence_status: "persisted",
      review_status: "accepted",
      storage_url: demoStillUri(`素材 ${no}`, 210 + index * 24),
      created_at: `2026-07-21T0${index}:30:00Z`,
    }];
    /* 缺口镜 #6 只有主图:不挂视频条目,进度条才能如实说「素材 #6 还没有可用视频」。 */
    if (no !== 6) {
      entries.push({
        id: videoId,
        media_kind: "video",
        title: `素材 ${no} 粗剪`,
        is_primary: true,
        persistence_status: "persisted",
        review_status: DEMO_VIDEO_REVIEW_STATUS[videoId] ?? "needs_review",
        storage_url: `/demo-media/ep1-shot-${no}.mp4`,
        created_at: `2026-07-21T1${index}:00:00Z`,
      });
    }
    return [shot.id, [...entries, ...(DEMO_CANDIDATE_MEDIA[shot.id] ?? [])]];
  }),
);

/* K2W「全局生产任务队列」彩排 fixture(同样只属 demo-project-2):
   2 个在途(排队中·第 1 位 + 生成中)+ 1 个失败(带原因)+ 1 条已完成通知——
   面板三态都看得见;跳链直达对应镜工作台(episodeId 台账不存,demo 直接带)。
   离线标注照旧:demo 面板顶部固定一行「离线演示 · 示例任务」。 */
export const demoGenerationQueueTasks: TaskQueueRow[] = [
  {
    entry: { projectId: "demo-project-2", shotId: "demo-shot-2", mediaKind: "image", requestId: "demo-queue-req-1" },
    task: { generation_request_id: "demo-queue-req-1", status: "pending", phase: "provider_queued", queue_position: 1, estimated_duration_seconds: 45, estimated_duration_sample_count: 12, created_at: "2026-07-30T04:58:00Z" },
    projectName: "《杀穿女频》",
    shotLabel: "第1集 · #2 · 中景 · 平视",
    episodeId: "demo-episode-1",
  },
  {
    entry: { projectId: "demo-project-2", shotId: "demo-shot-4", mediaKind: "video", requestId: "demo-queue-req-2" },
    task: { generation_request_id: "demo-queue-req-2", status: "running", phase: "provider_running", queue_position: null, estimated_duration_seconds: 120, estimated_duration_sample_count: 12, created_at: "2026-07-30T04:56:00Z" },
    projectName: "《杀穿女频》",
    shotLabel: "第1集 · #4 · 特写",
    episodeId: "demo-episode-1",
  },
  {
    entry: { projectId: "demo-project-2", shotId: "demo-shot-5", mediaKind: "video", requestId: "demo-queue-req-3" },
    task: { generation_request_id: "demo-queue-req-3", status: "failed", phase: "complete", queue_position: null, display_reason: "视频生成没成：参考图尺寸不合规，请调整参考后重试。", created_at: "2026-07-30T04:50:00Z" },
    projectName: "《杀穿女频》",
    shotLabel: "第1集 · #5 · 中景",
    episodeId: "demo-episode-1",
  },
];

/** K2W 面板的终态通知近条目(demo):一条已完成,与在途/失败区互不重叠。
    status 断言同 home-next-step.test.ts 口径——GenerationStatus 被 `| string` 吸收,
    Extract 出 never,字面量构造处都要断一次。 */
export const demoGenerationQueueNotifications: GenerationAttemptNotification[] = [
  { id: "demo-queue-notice-1", generation_request_id: "demo-queue-req-0", attempt_id: "demo-queue-attempt-0", project_id: "demo-project-2", episode_id: "demo-episode-1", shot_id: "demo-shot-1", media_kind: "image", status: "succeeded" as GenerationAttemptNotification["status"], created_at: "2026-07-30T04:40:00Z" },
];

/* K2O/GP-04：demo fallback 按 projectId 隔离。fixture 全部挂在 demo-project-2 名下，
   别的项目（含本会话新建的项目）读不到数据就如实给空、显自己的名，
   不拿 demo-project-2 的集、镜头、资产顶上（真栈走 API 本就不串，这里管的是 demo 兜底口径）。 */

/* 板03 fixture：剧本集之外补两个空白集（同样只属 demo-project-2）。 */
export const demoBlankEpisodes: Episode[] = [
  { id: "demo-episode-blank-1", project_id: "demo-project-2", episode_no: 4, name: "空白集 4", status: "active", shot_count: 0, sort_order: 4 },
  { id: "demo-episode-blank-2", project_id: "demo-project-2", episode_no: 5, name: "空白集 5", status: "active", shot_count: 0, sort_order: 5 },
];

/** demo 会话内新建/改名过的项目（只活在本次会话，未写入服务）；
    项目页与顶栏按 projectId 从这里找回真名。 */
const demoSessionProjects = new Map<string, Project>();

/** 登记 demo 会话项目（新建或改名后调用）；同 id 覆盖。 */
export function registerDemoSessionProject(project: Project): void {
  demoSessionProjects.set(project.id, project);
}

/** 按 projectId 查 demo 项目：会话登记优先（新建/本会话改过名的），再查 fixture；
    都没有 = demo 不认识这个项目，调用方如实给空态，不拿 fixture 顶。 */
export function demoProjectById(projectId: string): Project | undefined {
  return demoSessionProjects.get(projectId) ?? demoProjects.find((item) => item.id === projectId);
}

/** 按 projectId 取 demo 集列表（含空白集）：只有 fixture 属主项目有集，其余项目如实空。 */
export function demoEpisodesForProject(projectId: string): Episode[] {
  return [...demoEpisodes, ...demoBlankEpisodes].filter((episode) => episode.project_id === projectId);
}

/** 按 projectId 取 demo 项目资产：同上，非属主项目如实空。 */
export function demoProjectAssetsForProject(projectId: string): ProjectAssetRef[] {
  return demoProjectAssets.filter((ref) => ref.project_id === projectId);
}

/** K2O/GP-04：demo 媒体 fixture（K2A 唯一真源 demoShotMedia）同样按 projectId 隔离，不绕开真源表——
    表以 shot.id 为键、不自带 project 字段，归属沿 shot→episode→project 推，按调用方 projectId 门控：
    demoShotMedia 只服务它声明归属的项目（demo-project-2），其他项目/陌生 id/陌生 shot 读媒体如实空，不串。 */
export function demoShotMediaForShot(projectId: string, shotId: string): MediaVersion[] {
  const shot = demoShots.find((item) => item.id === shotId);
  if (!shot) return [];
  const episode = demoEpisodesForProject(projectId).find((item) => item.id === shot.episode_id);
  if (!episode) return [];
  return demoShotMedia[shotId] ?? [];
}

/** K2O/GP-08：demo 导入预览的诚实形态——demo_sample 标记 + 文案明示示例数据，
    不冒充用户文件的解析结果。行内容沿用 K2N 十列示例（覆盖绑定试算三种状态——
    按名命中(客厅)/未命中(夜雨巷口)/相近候选(军营外←军营)，缺失单元格演示「未识别」标注），仅作样式示例。 */
export function demoStoryboardImportPreview(projectId: string, fileName: string): StoryboardImportRecord {
  return {
    id: "demo-import",
    project_id: projectId,
    file_name: fileName,
    status: "previewed",
    demo_sample: true,
    preview: {
      rows: [
        {
          source_row: 2,
          episode_no: 1,
          scene_name: "客厅",
          shot_no: demoShots[0]?.shot_no ?? "1",
          screen_description: demoShots[0]?.script_text ?? "",
          camera_movement: "推镜",
          shot_size_angle: "中景·平视",
          dialogue: "他来了。",
          sound_effect: "雨声渐强",
          reference_image_note: "巷口氛围参考A",
          storyboard_image_note: "分镜稿1",
        },
        {
          source_row: 3,
          episode_no: 1,
          scene_name: "夜雨巷口",
          shot_no: demoShots[1]?.shot_no ?? "2",
          screen_description: demoShots[1]?.script_text ?? "",
          camera_movement: "手持跟拍",
          shot_size_angle: "近景·侧拍",
        },
        {
          source_row: 4,
          episode_no: 1,
          scene_name: "军营外",
          shot_no: demoShots[2]?.shot_no ?? "3",
          screen_description: demoShots[2]?.script_text ?? "",
          camera_movement: "固定",
          shot_size_angle: "远景·俯拍",
          dialogue: "众军听令!",
          sound_effect: "号角",
        },
      ],
      issues: [{ level: "warning", message: `离线演示不做真实解析：下表 3 行是示例数据，不是「${fileName}」的内容；真机环境会解析并展示你文件的真实行。` }],
      can_confirm: false,
    },
  };
}

export const demoVersions: MediaVersion[] = [
  { id: "version-a", media_kind: "image", title: "版本A", is_primary: false, status: "ready" },
  { id: "version-b", media_kind: "image", title: "版本B", is_primary: true, status: "ready" },
  { id: "version-c", media_kind: "image", title: "版本C", is_primary: false, status: "draft" },
];

export const demoDashboard: DashboardSummary = {
  data: { projects: 6, assets: 42, episodes: 114, shots: 570, images: 38, videos: 17, succeeded: 51, failed: 4 },
  costs: {
    notice: "离线示例：预估消耗，非云平台实际账单",
    total_tasks: 55,
    succeeded_tasks: 51,
    active_tasks: 0,
    failed_tasks: 4,
    image_estimated_cost_fen: 1_552,
    video_estimated_cost_fen: 45_376,
    total_estimated_cost_fen: 46_928,
    by_project: [
      { project_id: "demo-project-2", project_name: "《杀穿女频》", tasks: 19, succeeded: 18, failed: 1, estimated_cost_fen: 18_520 },
      { project_id: "demo-project-1", project_name: "《老公诈死》", tasks: 15, succeeded: 14, failed: 1, estimated_cost_fen: 13_960 },
      { project_id: "demo-project-3", project_name: "《重返十八岁》", tasks: 12, succeeded: 11, failed: 1, estimated_cost_fen: 9_880 },
      { project_id: "demo-project-5", project_name: "《入局》", tasks: 9, succeeded: 8, failed: 1, estimated_cost_fen: 4_568 },
    ],
    by_user: [
      { user_id: "demo-user", user_name: "Alice", image_estimated_cost_fen: 1_552, video_estimated_cost_fen: 45_376, total_estimated_cost_fen: 46_928 },
    ],
    by_date: [
      { date: "2026-07-11", tasks: 6, estimated_cost_fen: 5_120 },
      { date: "2026-07-12", tasks: 11, estimated_cost_fen: 9_050 },
      { date: "2026-07-13", tasks: 8, estimated_cost_fen: 6_420 },
      { date: "2026-07-14", tasks: 15, estimated_cost_fen: 13_338 },
      { date: "2026-07-15", tasks: 15, estimated_cost_fen: 13_000 },
    ],
  },
};

export const demoTrash: TrashItem[] = [
  { id: "demo-project-deleted", kind: "project", name: "《旧版测试项目》", owner_user_id: "demo-user", deleted_at: "2026-07-14T10:30:00.000Z" },
  { id: "demo-asset-deleted", kind: "asset", name: "旧版角色定妆", owner_user_id: "demo-user", deleted_at: "2026-07-13T08:10:00.000Z" },
];

/* S30 ⌘K 命令面板 demo 内容。同步源=migrations/026_command_palette.sql 的
   三行种子(真源在服务端 config_entries);此处 fixture 只服务离线演示,
   改迁移播种时必须同步改这里,command-palette.test.ts 有防漂移断言。 */
export const demoCommandPaletteGroups = [
  {
    key: "production",
    title: "开拍",
    note: "手上这摊活,从这儿起。",
    sort: 1,
    items: [
      { command: "action.create_project", label: "新建项目", hint: "开一部新戏", keywords: ["xjxm", "lixiang", "立项"] },
      { command: "action.create_shot", label: "新建分镜", hint: "给当前这集加一条镜头", keywords: ["xjfj", "jingtou", "镜头"], context: "project" as const },
    ],
  },
  {
    key: "back_office",
    title: "后场",
    note: "设置与后台,都在这排。",
    sort: 2,
    items: [
      { command: "nav.settings", label: "打开设置", hint: "API、提示词与账户", keywords: ["sz", "shezhi"] },
      { command: "nav.releases", label: "版本计划", hint: "看看接下来上什么", keywords: ["bbjh", "jihua", "计划"] },
      { command: "nav.admin", label: "管理后台", hint: "用户与运营", keywords: ["glht", "houtai", "后台"], requires: "admin" as const },
    ],
  },
];

export const demoCommandPaletteCopy = {
  placeholder: "搜项目、剧集、分镜、资产,或直接下令…",
  emptyResults: "没找着。项目、剧集、场、分镜、资产都能搜,换个词再试试。",
  loadFailed: "搜索这会儿连不上,指令照常能用;搜东西请稍后再试。",
  searchGroupLabels: { projects: "项目", episodes: "剧集", scenes: "场", shots: "分镜", assets: "资产" },
};

/* ---------- K2 需求拆解彩排 fixture（离线演示假数据，不产出任何网络请求） ----------
   契约 v0.2.0 未批准前的形态彩排：一条 shot 作用域假 run 的需求清单，
   覆盖全部分支——matched 2、partially_matched 1（还差：发饰）、missing 1
   （无候选）、missing + 匿名汇总 1（clearance_blocked ×2，不泄露名字）、
   clearance_blocked 可见候选 1 个（能看不能选）、候选 >5 且已选候选不在
   前 5（演示中性占位）。第二条假 run=整场资产库暂不可查变体。
   工厂函数每次返回新副本（决定写在副本上），与状态机的克隆约定一致。 */

function demoBreakdownCandidate(
  input: Pick<BreakdownCandidate, "candidateId" | "displayName"> & Partial<BreakdownCandidate>,
): BreakdownCandidate {
  return {
    assetEntityId: `entity-${input.candidateId}`,
    assetMediaId: `media-${input.candidateId}`,
    mediaKind: "image",
    matchScore: 0.8,
    matchedAttributes: [],
    unmetAttributes: [],
    thumbnailUrl: null,
    canPreview: true,
    canSelect: true,
    canAddToControlPackage: true,
    selectionBlockers: [],
    controlPackageBlockers: [],
    ...input,
  };
}

function demoBreakdownRequirement(
  input: Pick<BreakdownRequirement, "id" | "ordinal" | "laneKey" | "displayName" | "needDescription"> &
    Partial<BreakdownRequirement>,
): BreakdownRequirement {
  return {
    requiredAssetKindKey: input.laneKey,
    match: { status: "matched", candidates: [], missingReasons: [] },
    decision: { status: "unreviewed", selectedCandidateId: null },
    generationBrief: null,
    ...input,
  };
}

/** 标准形态：6 条需求覆盖全部分支（彩排假数据，非真实拆解结果）。 */
export function demoBreakdownRequirements(): BreakdownRequirement[] {
  return [
    demoBreakdownRequirement({
      id: "req-01",
      ordinal: 1,
      laneKey: "character",
      displayName: "任天野",
      needDescription: "主角亮相：银甲染血，冷蓝色调，情绪紧绷",
      match: {
        status: "matched",
        candidates: [
          demoBreakdownCandidate({ candidateId: "cand-ren-1", displayName: "任天野定妆", matchedAttributes: ["古装", "冷色"], matchScore: 0.92 }),
          demoBreakdownCandidate({ candidateId: "cand-ren-2", displayName: "任天野标准版", matchedAttributes: ["古装"], unmetAttributes: ["冷色"], matchScore: 0.71 }),
        ],
        missingReasons: [],
      },
    }),
    demoBreakdownRequirement({
      id: "req-02",
      ordinal: 2,
      laneKey: "scene",
      displayName: "雨夜巷口",
      needDescription: "全景空间基准：夜戏外景，冷色反光，雨丝可见",
      match: {
        status: "matched",
        candidates: [
          demoBreakdownCandidate({ candidateId: "cand-scene-1", displayName: "巷口雨夜", matchedAttributes: ["夜戏", "外景"], matchScore: 0.9 }),
        ],
        missingReasons: [],
      },
    }),
    demoBreakdownRequirement({
      id: "req-03",
      ordinal: 3,
      laneKey: "character",
      displayName: "女主",
      needDescription: "雨夜奔跑回头，冷蓝色调，情绪紧绷",
      match: {
        status: "partially_matched",
        candidates: [
          demoBreakdownCandidate({ candidateId: "cand-lin-1", displayName: "林秋棠定妆", matchedAttributes: ["古装", "冷色"], unmetAttributes: ["发饰"], matchScore: 0.86 }),
          /* clearance_blocked 可见候选：能看不能选（契约 §7 第一层谓词） */
          demoBreakdownCandidate({
            candidateId: "cand-lin-2",
            displayName: "神秘女子侧影",
            matchedAttributes: ["古装", "冷色"],
            matchScore: 0.83,
            canSelect: false,
            canAddToControlPackage: false,
            selectionBlockers: ["clearance_blocked"],
          }),
          demoBreakdownCandidate({ candidateId: "cand-lin-3", displayName: "林秋棠便装", matchedAttributes: ["冷色"], unmetAttributes: ["古装", "发饰"], matchScore: 0.66 }),
          demoBreakdownCandidate({ candidateId: "cand-lin-4", displayName: "古装女子群像", matchedAttributes: ["古装"], unmetAttributes: ["冷色", "发饰"], matchScore: 0.58 }),
          demoBreakdownCandidate({ candidateId: "cand-lin-5", displayName: "雨中女子背影", matchedAttributes: ["冷色"], unmetAttributes: ["发饰"], matchScore: 0.55 }),
          /* 第 6 个候选：内嵌前 5 之外，走「更多候选」加载（契约 §8.1 游标） */
          demoBreakdownCandidate({ candidateId: "cand-lin-6", displayName: "林秋棠旧照", matchedAttributes: ["古装"], unmetAttributes: ["冷色", "发饰"], matchScore: 0.5 }),
        ],
        missingReasons: [],
      },
    }),
    demoBreakdownRequirement({
      id: "req-04",
      ordinal: 4,
      laneKey: "prop",
      displayName: "银边短刀",
      needDescription: "近景特写道具：冷兵器，雨夜反光",
      match: { status: "missing", candidates: [], missingReasons: ["no_candidate"] },
      generationBrief: { capability: "image", brief: "银边短刀道具定妆：冷兵器特写，雨夜反光，冷蓝色调" },
    }),
    demoBreakdownRequirement({
      id: "req-05",
      ordinal: 5,
      laneKey: "scene",
      displayName: "密室书房",
      needDescription: "对手戏室内空间：暖光对照冷色外景",
      /* 完全不可见的候选只贡献匿名汇总数字，不泄露名字（契约 §7） */
      match: { status: "missing", candidates: [], missingReasons: ["clearance_blocked", "clearance_blocked"] },
      generationBrief: { capability: "image", brief: "密室书房场景主视图：暖光烛火，与冷色外景对照" },
    }),
    demoBreakdownRequirement({
      id: "req-06",
      ordinal: 6,
      laneKey: "camera_motion",
      requiredAssetKindKey: "camera",
      displayName: "手持跟拍",
      needDescription: "奔跑段手持跟拍：自然晃动，中近景",
      match: {
        status: "matched",
        candidates: [
          demoBreakdownCandidate({ candidateId: "cand-cam-1", displayName: "手持推进小样", mediaKind: "video", matchedAttributes: ["手持"], matchScore: 0.88 }),
          demoBreakdownCandidate({ candidateId: "cand-cam-2", displayName: "跟拍稳定器参考", mediaKind: "video", matchedAttributes: ["跟拍"], matchScore: 0.8 }),
          demoBreakdownCandidate({ candidateId: "cand-cam-3", displayName: "夜景手持片段", mediaKind: "video", matchedAttributes: ["手持", "夜景"], matchScore: 0.77 }),
          demoBreakdownCandidate({ candidateId: "cand-cam-4", displayName: "雨景运动参考", mediaKind: "video", matchedAttributes: ["雨景"], matchScore: 0.72 }),
          demoBreakdownCandidate({ candidateId: "cand-cam-5", displayName: "巷战跟拍小样", mediaKind: "video", matchedAttributes: ["跟拍"], matchScore: 0.69 }),
          demoBreakdownCandidate({ candidateId: "cand-cam-6", displayName: "手持跟拍小样·夜景", mediaKind: "video", matchedAttributes: ["手持", "跟拍", "夜景"], matchScore: 0.67 }),
        ],
        missingReasons: [],
      },
      /* 已选候选不在内嵌前 5：演示决策中立占位（展开加载更多后解析为真卡） */
      decision: { status: "accepted", selectedCandidateId: "cand-cam-6" },
    }),
  ];
}

/** 资产库暂不可查变体：检索失败不连坐需求（契约 §6），需求已拆出、可先决定。 */
export function demoBreakdownRetrievalRequirements(): BreakdownRequirement[] {
  return [
    demoBreakdownRequirement({
      id: "req-r01",
      ordinal: 1,
      laneKey: "character",
      displayName: "女主",
      needDescription: "雨夜奔跑回头，冷蓝色调，情绪紧绷",
      match: { status: "retrieval_unavailable", candidates: [], missingReasons: ["retrieval_unavailable"] },
    }),
    demoBreakdownRequirement({
      id: "req-r02",
      ordinal: 2,
      laneKey: "scene",
      displayName: "雨夜巷口",
      needDescription: "全景空间基准：夜戏外景，冷色反光",
      match: { status: "retrieval_unavailable", candidates: [], missingReasons: ["retrieval_unavailable"] },
    }),
    demoBreakdownRequirement({
      id: "req-r03",
      ordinal: 3,
      laneKey: "prop",
      displayName: "银边短刀",
      needDescription: "近景特写道具：冷兵器，雨夜反光",
      match: { status: "retrieval_unavailable", candidates: [], missingReasons: ["retrieval_unavailable"] },
      generationBrief: { capability: "image", brief: "银边短刀道具定妆：冷兵器特写，雨夜反光" },
    }),
  ];
}

/** 分镜命名中的场景段：demo 用固定映射；真栈走 api.episodeScenes 真数据（S11-3），
    scene_id 匹配不上或真无场景才显示「未分场」。
    批次二(P-04 段落工作台)起从 project-pages 收编到本文件——demo fixture 唯一真源。 */
export const DEMO_SHOT_SCENES: Record<string, string> = {
  "demo-shot-1": "客厅",
  "demo-shot-2": "客厅",
  "demo-shot-3": "北疆战场",
  "demo-shot-4": "北疆战场",
  "demo-shot-5": "军营",
  "demo-shot-6": "军营",
};

/* K2N(GP-07):demo 第 1 集「已有场景」——与 DEMO_SHOT_SCENES 同源派生,
   供导入预览的场景核对试算与段落工作台(真栈走 api.episodeScenes)。 */
export const DEMO_EPISODE_SCENES: ReadonlyMap<string, Scene[]> = new Map([
  ["demo-episode-1", [...new Set(Object.values(DEMO_SHOT_SCENES))].map((name, index) => ({ id: `demo-scene-${index + 1}`, episode_id: "demo-episode-1", name }))],
]);

/* ---------- P-06 剧本分镜 demo fixture(左原文右草稿 6 场·待确认态) ----------
   与 demo 世界观同源(任天野/林秋棠/李承瑶);sceneDivisions 行区间与原文逐行对齐,
   shotCandidates.lineIndices 落在本场区间内;run=draft(待确认态,验收基准)。 */
const DEMO_SCRIPT_TEXT = `第一场 · 巷口雨夜
夜·外 巷口
任天野骑在照夜玉狮子上,银甲染血,从边军后方走出。
林秋棠撑伞立于巷尾,抬眼望来。
林秋棠:将军还认得这条路吗?

第二场 · 府衙正堂
日·内 府衙正堂
李承瑶高声训斥,众人回头。
任天野按剑不答,目光越过堂上。

第三场 · 客厅
夜·内 旧宅客厅
林秋棠推门,愣住。
林秋棠:你怎么会在这里?

第四场 · 北疆战场
日·外 北疆战场
银甲军冲阵,照夜玉狮子人立而起。
任天野的眼睛微微眯起,寒光一闪。

第五场 · 军营
夜·内 军营帐中
任天野低声回应,帐外马蹄停在雨中。
传令兵下去,众军缓缓散开。

第六场 · 城门长街
晨·外 城门长街
林秋棠登车回望,长街无人。
任天野立马城门下,目送。`;

const DEMO_SCRIPT_SCENES: Array<{ name: string; summary: string; characters: string[]; start: number; end: number; shots: number[][] }> = [
  { name: "巷口雨夜", summary: "雨夜归乡,旧人巷口相认", characters: ["任天野", "林秋棠"], start: 0, end: 5, shots: [[2], [3, 4]] },
  { name: "府衙正堂", summary: "府衙对峙,按剑不答", characters: ["李承瑶", "任天野"], start: 6, end: 10, shots: [[8], [9]] },
  { name: "客厅", summary: "旧宅重逢,惊见故人", characters: ["林秋棠"], start: 11, end: 15, shots: [[13], [14]] },
  { name: "北疆战场", summary: "北疆冲阵,寒光一闪", characters: ["任天野"], start: 16, end: 20, shots: [[18, 19]] },
  { name: "军营", summary: "帐中低语,众军散开", characters: ["任天野"], start: 21, end: 25, shots: [[23, 24]] },
  { name: "城门长街", summary: "长街目送,城门作别", characters: ["林秋棠", "任天野"], start: 26, end: 29, shots: [[28, 29]] },
];

export const DEMO_SCRIPT_VERSIONS: ReadonlyMap<string, ScriptVersion[]> = new Map([
  ["demo-episode-1", [{
    id: "demo-script-v1",
    episodeId: "demo-episode-1",
    versionNo: 1,
    title: "初稿",
    scriptSha256: "demo-sha",
    source: "manual",
    createdAt: "2026-07-30T07:50:00Z",
    scriptText: DEMO_SCRIPT_TEXT,
  }]],
]);

export const DEMO_SCRIPT_RUNS: ReadonlyMap<string, ScriptBreakdownRun[]> = new Map([
  ["demo-episode-1", [{
    id: "demo-run-1",
    episodeId: "demo-episode-1",
    scriptVersionId: "demo-script-v1",
    status: "draft",
    currentStage: null,
    modelName: "demo-k3",
    promptVersion: "s20-v3",
    targetDurationSec: null,
    errorCode: null,
    confirmedAt: null,
    discardedAt: null,
    supersededByRunId: null,
    createdAt: "2026-07-30T08:00:00Z",
    updatedAt: "2026-07-30T08:01:00Z",
  }]],
]);

let demoShotNo = 0;
export const DEMO_SCRIPT_RUN_DETAIL: ReadonlyMap<string, ScriptBreakdownRunDetail> = new Map([
  ["demo-run-1", {
    run: DEMO_SCRIPT_RUNS.get("demo-episode-1")![0]!,
    draft: {
      storySummary: "任天野雨夜归乡,旧宅重逢林秋棠,北疆旧事重提,城门长街作别。",
      sceneDivisions: DEMO_SCRIPT_SCENES.map((scene, index) => ({
        sceneIndex: index,
        name: scene.name,
        summary: scene.summary,
        startLineIndex: scene.start,
        endLineIndex: scene.end,
      })),
      assetCandidates: { characters: [], scenes: [], props: [], costumes: [], audios: [] },
      shotCandidates: DEMO_SCRIPT_SCENES.flatMap((scene, sceneIndex) => scene.shots.map((lines) => ({
        candidateId: `demo-cand-${demoShotNo + 1}`,
        shotNo: ++demoShotNo,
        sceneIndex,
        lineIndices: lines,
        elements: null,
        directorPrompt: "",
        imagePrompt: "",
        videoPrompt: "",
        durationSec: 4,
        characterNames: scene.characters,
        sceneNames: [scene.name],
        propNames: [],
        costumeNames: [],
      }))),
    },
    validation: {
      status: "pass_with_warnings",
      issues: [{ code: "unmatched_asset", message: "李承瑶还没有项目资产,确认后可到资产库补齐", path: null }],
      unmatchedAssets: [{ kind: "character", name: "李承瑶", shotCandidateIds: ["demo-cand-3", "demo-cand-4"] }],
      duplicateCoverage: [],
      shotCount: 9,
      totalDurationSec: 36,
    },
    stages: [
      { stageKey: "structure", stageOrder: 1, status: "succeeded", attemptCount: 1, errorCode: null, startedAt: "2026-07-30T08:00:00Z", completedAt: "2026-07-30T08:00:20Z" },
      { stageKey: "assets", stageOrder: 2, status: "succeeded", attemptCount: 1, errorCode: null, startedAt: "2026-07-30T08:00:20Z", completedAt: "2026-07-30T08:00:40Z" },
    ],
  }],
]);

/* ---------- 创作广场 fixture（项目维度：资产变体扁平化 + 生成记录回显） ----------
   资产/变体/版本轨三张表同口径：版本轨 media id 与生成记录 reference_manifest
   对得上，右侧记录点击回显才能真还原左侧勾选（demo 也走同一套还原逻辑）。 */
export const demoPlazaAssets: LiteAssetListItem[] = [
  { asset_entity_id: "asset-ren", name: "任天野", intro: "钦差官服，主角视觉锚点", asset_kind: "character", audio_kind: null, primary_media_url: demoStillUri("任天野", 210), has_media: true, has_primary: true, has_pending_generation: false, last_modified_at: "2026-07-22T09:00:00Z" },
  { asset_entity_id: "asset-lin", name: "林秋棠", intro: "女主造型待补充发饰", asset_kind: "character", audio_kind: null, primary_media_url: demoStillUri("林秋棠", 330), has_media: true, has_primary: true, has_pending_generation: false, last_modified_at: "2026-07-22T09:00:00Z" },
  { asset_entity_id: "demo-asset-master", name: "白发师父", intro: "世外高人，主角师父", asset_kind: "character", audio_kind: null, primary_media_url: demoStillUri("白发师父", 270), has_media: true, has_primary: true, has_pending_generation: false, last_modified_at: "2026-07-21T09:00:00Z" },
  { asset_entity_id: "asset-harbor", name: "巷口雨夜", intro: "可复用夜戏外景氛围", asset_kind: "scene", audio_kind: null, primary_media_url: demoStillUri("巷口雨夜", 190), has_media: true, has_primary: true, has_pending_generation: false, last_modified_at: "2026-07-20T09:00:00Z" },
  { asset_entity_id: "common-palace", name: "府衙正堂", intro: "古装审案场景", asset_kind: "scene", audio_kind: null, primary_media_url: demoStillUri("府衙正堂", 150), has_media: true, has_primary: true, has_pending_generation: false, last_modified_at: "2026-07-19T09:00:00Z" },
  { asset_entity_id: "asset-knife", name: "银边短刀", intro: "近景特写生成中", asset_kind: "prop", audio_kind: null, primary_media_url: demoStillUri("银边短刀", 20), has_media: true, has_primary: true, has_pending_generation: false, last_modified_at: "2026-07-18T09:00:00Z" },
  { asset_entity_id: "common-jade", name: "玉佩信物", intro: "剧情关键道具", asset_kind: "prop", audio_kind: null, primary_media_url: demoStillUri("玉佩信物", 90), has_media: true, has_primary: true, has_pending_generation: false, last_modified_at: "2026-07-17T09:00:00Z" },
];

export const demoPlazaVariants: Record<string, LiteAssetVariant[]> = {
  "asset-ren": [
    { variant_id: "variant-ren-official", variant_kind: "look", display_name: "官服形态", is_primary: true, image_url: demoStillUri("任天野·官服", 210) },
    { variant_id: "variant-ren-battle", variant_kind: "look", display_name: "战损形态", is_primary: false, image_url: demoStillUri("任天野·战损", 226) },
  ],
  "asset-lin": [{ variant_id: "variant-lin-default", variant_kind: "look", display_name: "默认造型", is_primary: true, image_url: demoStillUri("林秋棠", 330) }],
  "demo-asset-master": [{ variant_id: "variant-master-default", variant_kind: "look", display_name: "默认造型", is_primary: true, image_url: demoStillUri("白发师父", 270) }],
  "asset-harbor": [{ variant_id: "variant-harbor-night", variant_kind: "look", display_name: "夜景氛围", is_primary: true, image_url: demoStillUri("巷口雨夜", 190) }],
  "common-palace": [{ variant_id: "variant-palace-day", variant_kind: "look", display_name: "日堂审案", is_primary: true, image_url: demoStillUri("府衙正堂", 150) }],
  "asset-knife": [{ variant_id: "variant-knife-close", variant_kind: "look", display_name: "特写道具", is_primary: true, image_url: demoStillUri("银边短刀", 20) }],
  "common-jade": [{ variant_id: "variant-jade-default", variant_kind: "look", display_name: "默认形态", is_primary: true, image_url: demoStillUri("玉佩信物", 90) }],
};

/** 广场版本轨：media id 与 reference_manifest 对账用（回显还原勾选的唯一真源）。 */
export const demoPlazaVersions: Record<string, MediaVersion[]> = {
  "asset-ren": [
    { id: "demo-plaza-media-ren-1", asset_entity_id: "asset-ren", asset_variant_id: "variant-ren-official", media_kind: "image", is_primary: true, storage_url: demoStillUri("任天野·官服", 210) },
    { id: "demo-plaza-media-ren-2", asset_entity_id: "asset-ren", asset_variant_id: "variant-ren-battle", media_kind: "image", is_primary: false, storage_url: demoStillUri("任天野·战损", 226) },
  ],
  "asset-lin": [{ id: "demo-plaza-media-lin-1", asset_entity_id: "asset-lin", asset_variant_id: "variant-lin-default", media_kind: "image", is_primary: true, storage_url: demoStillUri("林秋棠", 330) }],
  "demo-asset-master": [{ id: "demo-plaza-media-master-1", asset_entity_id: "demo-asset-master", asset_variant_id: "variant-master-default", media_kind: "image", is_primary: true, storage_url: demoStillUri("白发师父", 270) }],
  "asset-harbor": [{ id: "demo-plaza-media-harbor-1", asset_entity_id: "asset-harbor", asset_variant_id: "variant-harbor-night", media_kind: "image", is_primary: true, storage_url: demoStillUri("巷口雨夜", 190) }],
  "common-palace": [{ id: "demo-plaza-media-palace-1", asset_entity_id: "common-palace", asset_variant_id: "variant-palace-day", media_kind: "image", is_primary: true, storage_url: demoStillUri("府衙正堂", 150) }],
  "asset-knife": [{ id: "demo-plaza-media-knife-1", asset_entity_id: "asset-knife", asset_variant_id: "variant-knife-close", media_kind: "image", is_primary: true, storage_url: demoStillUri("银边短刀", 20) }],
  "common-jade": [{ id: "demo-plaza-media-jade-1", asset_entity_id: "common-jade", asset_variant_id: "variant-jade-default", media_kind: "image", is_primary: true, storage_url: demoStillUri("玉佩信物", 90) }],
};

/** 广场生成记录（广场独立台账 plaza_records 的 demo 形态）：成功视频/成功图片/失败各一，回显三态都能演。 */
export const demoPlazaGenerations: PlazaRecord[] = [
  {
    id: "demo-plaza-rec-1",
    generation_request_id: "demo-plaza-gen-1",
    media_kind: "video",
    prompt: "雨夜巷口，任天野勒马回头，银甲染血，镜头缓缓推进。",
    tier_id: "vid-seedance20fast-916-720p-4s",
    parameters: { ratio: "9:16", resolution: "720p", duration_seconds: 4 },
    reference_manifest: [
      { media_id: "demo-plaza-media-ren-1", kind: "image", role: "reference_image" },
      { media_id: "demo-plaza-media-harbor-1", kind: "image", role: "reference_image" },
    ],
    status: "succeeded",
    estimated_cost_fen: 320,
    created_at: "2026-07-23T08:20:00Z",
    updated_at: "2026-07-23T08:26:00Z",
    media_results: [{ id: "demo-plaza-out-1", media_kind: "video", storage_url: "/demo-media/ep1-shot-1.mp4" }],
  },
  {
    id: "demo-plaza-rec-2",
    generation_request_id: "demo-plaza-gen-2",
    media_kind: "image",
    prompt: "银边短刀特写，冷月光下刀锋反光，胶片颗粒。",
    tier_id: "img-seedream5pro-169-2k-1",
    parameters: { ratio: "16:9", size: "2K" },
    reference_manifest: [{ media_id: "demo-plaza-media-knife-1", kind: "image", role: "reference_image" }],
    status: "succeeded",
    estimated_cost_fen: 60,
    created_at: "2026-07-23T07:40:00Z",
    updated_at: "2026-07-23T07:41:00Z",
    media_results: [{ id: "demo-plaza-out-2", media_kind: "image", storage_url: "/demo-media/still-duel.png" }],
  },
  {
    id: "demo-plaza-rec-3",
    generation_request_id: "demo-plaza-gen-3",
    media_kind: "image",
    prompt: "府衙正堂全景，日堂审案氛围。",
    tier_id: "img-seedream5pro-169-2k-1",
    parameters: { ratio: "16:9", size: "2K" },
    reference_manifest: [{ media_id: "demo-plaza-media-palace-1", kind: "image", role: "reference_image" }],
    status: "failed",
    display_reason: "参考素材暂不可用，请重试",
    estimated_cost_fen: 0,
    created_at: "2026-07-22T15:05:00Z",
    updated_at: "2026-07-22T15:06:00Z",
    media_results: [],
  },
];
