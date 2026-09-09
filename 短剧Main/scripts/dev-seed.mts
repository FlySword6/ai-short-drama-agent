/**
 * dev-seed —— 播种最小可用演示数据：一个项目、一集、两场、三条分镜，
 * 够走通"登录 → 项目列表 → 项目详情看分镜"的全流程。
 *
 * 纪律：不从云库导数据、不引用任何真实凭据；全部是在编的最小虚构内容。
 * 幂等：用 dev 保留 UUID 段（00000000-de70-*），已播种过就跳过。
 *
 * 用法：npx tsx scripts/dev-seed.mts [--username <项目属主，默认 admin>]
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import {
  assetEntities,
  assetMedia,
  assetUploadTasks,
  episodes,
  generationAttemptNotifications,
  generationAttempts,
  generationRequests,
  mediaResults,
  projectAssetRefs,
  projects,
  scenes,
  shots,
  users,
} from "../src/db/schema.js";

type DatabaseHandle = ReturnType<typeof createDatabase>;

/** dev 保留 ID 段：固定值让重复执行安全跳过，也一眼看得出是演示数据。 */
const SEED_IDS = {
  project: "00000000-de70-4000-8000-000000000001",
  episode: "00000000-de70-4000-8000-000000000002",
  sceneA: "00000000-de70-4000-8000-000000000003",
  sceneB: "00000000-de70-4000-8000-000000000004",
  shot1: "00000000-de70-4000-8000-000000000005",
  shot2: "00000000-de70-4000-8000-000000000006",
  shot3: "00000000-de70-4000-8000-000000000007",
} as const;

function parseUsername(args: readonly string[]): string {
  const index = args.indexOf("--username");
  if (index === -1) return "admin";
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--username 需要一个值");
  return value;
}

async function main(): Promise<void> {
  const username = parseUsername(process.argv.slice(2));
  const handle = createDatabase();
  try {
    const ownerRows = await handle.db.select({ id: users.id }).from(users)
      .where(eq(users.username, username)).limit(1);
    const owner = ownerRows[0];
    if (!owner) {
      throw new Error(`找不到用户 ${username}（schema ${settings.postgresSchema}）。先跑 npm run dev:up 建 Day-0 管理员。`);
    }

    const existing = await handle.db.select({ id: projects.id }).from(projects)
      .where(eq(projects.id, SEED_IDS.project)).limit(1);
    if (existing.length > 0) {
      console.log("最小演示包已存在，跳过（想重建就 npm run dev:reset）。");
    } else {
      await seedMinimal(handle, owner.id);
      console.log(`最小演示包就绪：项目「本地演示项目」+ 第 1 集 + 2 场 + 3 条分镜（属主 ${username}）。`);
    }

    const wudaoSeeded = await handle.db.select({ id: projects.id }).from(projects)
      .where(eq(projects.id, R147_IDS.projectWudao)).limit(1);
    if (wudaoSeeded.length > 0) {
      console.log("雾岛宇宙演示包已存在，跳过。");
    } else {
      await seedWudao(handle, owner.id);
      console.log(`雾岛宇宙演示包就绪：《雾岛来信》(在拍+海报)、《长街灯火》(备戏+海报)、《山海食堂》(在拍)、《旧城往事》(已交)+ 资产 3 件 + 动态 2 条（属主 ${username}）。`);
    }

    /* 长街灯火建集+交付物链独立判重:雾岛包已 seed 过的 dev 库也能单独补齐。 */
    const changjieSeeded = await handle.db.select({ id: episodes.id }).from(episodes)
      .where(eq(episodes.id, R147_IDS.epChangjie)).limit(1);
    if (changjieSeeded.length > 0) {
      console.log("长街灯火补建包已存在，跳过。");
    } else {
      await seedChangjie(handle, owner.id);
      console.log("长街灯火补建就绪：第 1 集「灯市」+ 1 场 1 镜 + 书封海报 + 视频交付物。");
    }
  } finally {
    await handle.pool.end();
  }
}

/** 原最小包：一个项目、一集、两场、三条分镜。 */
async function seedMinimal(handle: DatabaseHandle, ownerId: string): Promise<void> {
  const now = new Date();
    // projects 行插入后，016 的 sync_project_owner_membership 触发器会自动补
    // project_members 的 owner 行，与应用内创建项目的可见性规则一致。
    await handle.db.insert(projects).values({
      id: SEED_IDS.project,
      ownerUserId: ownerId,
      teamId: null,
      genre: "都市情感",
      name: "本地演示项目",
      description: "本地演示数据，可随时清空重建（dev:reset）。",
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(episodes).values({
      id: SEED_IDS.episode,
      projectId: SEED_IDS.project,
      episodeNo: 1,
      name: "第 1 集（演示）",
      sortOrder: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(scenes).values([
      {
        id: SEED_IDS.sceneA, episodeId: SEED_IDS.episode, sceneNo: 1,
        name: "夜·出租屋", description: "演示场景 A", sortOrder: 1,
        createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
      },
      {
        id: SEED_IDS.sceneB, episodeId: SEED_IDS.episode, sceneNo: 2,
        name: "日·天台", description: "演示场景 B", sortOrder: 2,
        createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
      },
    ]);
    await handle.db.insert(shots).values([
      {
        id: SEED_IDS.shot1, episodeId: SEED_IDS.episode, sceneId: SEED_IDS.sceneA,
        shotCode: "EP01-SC01-001", title: "演示分镜 1",
        scriptText: "主角盯着手机上的催款消息，窗外雨声渐密。",
        directorPrompt: null, imagePrompt: null, videoPrompt: null,
        durationSeconds: 5, sortOrder: 1, referenceAssetSnapshots: [],
        selectedImageResultId: null, selectedVideoResultId: null,
        createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
      },
      {
        id: SEED_IDS.shot2, episodeId: SEED_IDS.episode, sceneId: SEED_IDS.sceneA,
        shotCode: "EP01-SC01-002", title: "演示分镜 2",
        scriptText: "门被敲响，主角把手机扣在桌上。",
        directorPrompt: null, imagePrompt: null, videoPrompt: null,
        durationSeconds: 4, sortOrder: 2, referenceAssetSnapshots: [],
        selectedImageResultId: null, selectedVideoResultId: null,
        createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
      },
      {
        id: SEED_IDS.shot3, episodeId: SEED_IDS.episode, sceneId: SEED_IDS.sceneB,
        shotCode: "EP01-SC02-001", title: "演示分镜 3",
        scriptText: "天台逆光，两人对峙，风吹起合同纸页。",
        directorPrompt: null, imagePrompt: null, videoPrompt: null,
        durationSeconds: 6, sortOrder: 3, referenceAssetSnapshots: [],
        selectedImageResultId: null, selectedVideoResultId: null,
        createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
      },
    ]);
}

/* ---------- R147 雾岛宇宙演示包 ----------
   目标：DC 打开 5173 的观感与 Figma 稿同一世界——看板四列有真内容卡、
   书封海报(Figma Demo Stills 372:3 五张剧照,public/demo-media/)、
   资产库配图配名示例、最近动态与「继续上次工作」有真示例。
   边界：只种演示数据,不碰真图管线;剧照 URL 指向 5173 静态资源(演示专用)。
   海报链:media_results(persisted+origin=asset_media+绝对 URL)→ shot.selected_image_result_id
   → useProjectCover 经 deliverables 取首图。 */
const R147_IDS = {
  projectWudao: "00000000-de70-4100-8000-000000000101",
  projectChangjie: "00000000-de70-4100-8000-000000000102",
  projectShanhai: "00000000-de70-4100-8000-000000000103",
  projectJiucheng: "00000000-de70-4100-8000-000000000104",
  epWudao: "00000000-de70-4100-8000-000000000111",
  epShanhai: "00000000-de70-4100-8000-000000000112",
  epJiucheng: "00000000-de70-4100-8000-000000000113",
  sceneWudaoA: "00000000-de70-4100-8000-000000000121",
  sceneWudaoB: "00000000-de70-4100-8000-000000000122",
  sceneShanhai: "00000000-de70-4100-8000-000000000123",
  sceneJiucheng: "00000000-de70-4100-8000-000000000124",
  shotWudao1: "00000000-de70-4100-8000-000000000131",
  shotWudao2: "00000000-de70-4100-8000-000000000132",
  shotWudao3: "00000000-de70-4100-8000-000000000133",
  shotShanhai1: "00000000-de70-4100-8000-000000000134",
  shotJiucheng1: "00000000-de70-4100-8000-000000000135",
  mediaWudaoPoster: "00000000-de70-4100-8000-000000000141",
  mediaWudaoChase: "00000000-de70-4100-8000-000000000142",
  mediaWudaoDuel: "00000000-de70-4100-8000-000000000143",
  mediaShanhaiPoster: "00000000-de70-4100-8000-000000000144",
  mediaJiuchengPoster: "00000000-de70-4100-8000-000000000145",
  assetGuzhou: "00000000-de70-4100-8000-000000000151",
  assetNoodle: "00000000-de70-4100-8000-000000000152",
  assetRain: "00000000-de70-4100-8000-000000000153",
  assetMediaGuzhou: "00000000-de70-4100-8000-000000000161",
  assetMediaNoodle: "00000000-de70-4100-8000-000000000162",
  assetMediaRain: "00000000-de70-4100-8000-000000000163",
  assetMediaWudaoPoster: "00000000-de70-4100-8000-000000000164",
  assetMediaShanhaiPoster: "00000000-de70-4100-8000-000000000165",
  refGuzhou: "00000000-de70-4100-8000-000000000171",
  refNoodle: "00000000-de70-4100-8000-000000000172",
  refRain: "00000000-de70-4100-8000-000000000173",
  genRequest: "00000000-de70-4100-8000-000000000181",
  genAttempt: "00000000-de70-4100-8000-000000000182",
  genNotification: "00000000-de70-4100-8000-000000000183",
  genRequestShanhai: "00000000-de70-4100-8000-000000000184",
  genAttemptShanhai: "00000000-de70-4100-8000-000000000185",
  genRequestJiucheng: "00000000-de70-4100-8000-000000000186",
  genAttemptJiucheng: "00000000-de70-4100-8000-000000000187",
  genRequestWudao1: "00000000-de70-4100-8000-000000000188",
  genAttemptWudao1: "00000000-de70-4100-8000-000000000189",
  genRequestWudao3: "00000000-de70-4100-8000-00000000018a",
  genAttemptWudao3: "00000000-de70-4100-8000-00000000018b",
  videoWudao1: "00000000-de70-4100-8000-0000000001a1",
  videoWudao2: "00000000-de70-4100-8000-0000000001a2",
  videoWudao3: "00000000-de70-4100-8000-0000000001a3",
  videoShanhai: "00000000-de70-4100-8000-0000000001a4",
  videoJiucheng: "00000000-de70-4100-8000-0000000001a5",
  uploadTask: "00000000-de70-4100-8000-000000000191",
  /* 长街灯火建集+交付物链(01a6 起,接 videoJiucheng 01a5 之后)。 */
  epChangjie: "00000000-de70-4100-8000-0000000001a6",
  sceneChangjie: "00000000-de70-4100-8000-0000000001a7",
  shotChangjie: "00000000-de70-4100-8000-0000000001a8",
  assetMediaChangjiePoster: "00000000-de70-4100-8000-0000000001a9",
  mediaChangjiePoster: "00000000-de70-4100-8000-0000000001aa",
  genRequestChangjie: "00000000-de70-4100-8000-0000000001ab",
  genAttemptChangjie: "00000000-de70-4100-8000-0000000001ac",
  videoChangjie: "00000000-de70-4100-8000-0000000001ad",
} as const;

const R147_MEDIA_BASE = "http://localhost:5173/demo-media";

function r147MediaRow(id: string, shotId: string, sourceAssetMediaId: string, file: string, ownerId: string, now: Date) {
  return {
    id,
    requestId: null,
    attemptId: null,
    shotId,
    originKind: "asset_media",
    sourceAssetMediaId,
    registeredByUserId: ownerId,
    mediaKind: "image",
    resultIndex: 0,
    providerResultKey: null,
    providerUrl: null,
    providerUrlExpiresAt: null,
    persistenceStatus: "persisted",
    storageBucket: "demo-media",
    storagePath: `demo-media/${file}`,
    storageUrl: `${R147_MEDIA_BASE}/${file}`,
    sha256: null,
    mimeType: "image/png",
    widthPx: 150,
    heightPx: 150,
    durationSeconds: null,
    reviewStatus: "accepted",
    complianceMetadata: {},
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

/** 视频行(generation origin,XOR:requestId+attemptId 非空,sourceAssetMediaId 置空)。 */
function r147VideoRow(id: string, shotId: string, requestId: string, attemptId: string, file: string, providerResultKey: string, now: Date) {
  return {
    id,
    requestId,
    attemptId,
    shotId,
    originKind: "generation",
    sourceAssetMediaId: null,
    registeredByUserId: null,
    mediaKind: "video",
    resultIndex: 0,
    providerResultKey,
    providerUrl: null,
    providerUrlExpiresAt: null,
    persistenceStatus: "persisted",
    storageBucket: "demo-media",
    storagePath: `demo-media/${file}`,
    storageUrl: `${R147_MEDIA_BASE}/${file}`,
    sha256: null,
    mimeType: "video/mp4",
    widthPx: null,
    heightPx: null,
    durationSeconds: 4,
    reviewStatus: "accepted",
    complianceMetadata: {},
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

async function seedWudao(handle: DatabaseHandle, ownerId: string): Promise<void> {
  const now = new Date();
  const day = 24 * 3600 * 1000;
  await handle.db.insert(projects).values([
    { id: R147_IDS.projectWudao, ownerUserId: ownerId, teamId: null, genre: "悬疑", name: "雾岛来信", description: "雾岛老街的深夜来信，牵出二十年前巷口旧案。", status: "active", createdAt: new Date(now.getTime() - 12 * day), updatedAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.projectChangjie, ownerUserId: ownerId, teamId: null, genre: "古装", name: "长街灯火", description: "上元夜长街三百盏，巡灯人捡到一盏不灭的灯。", status: "active", createdAt: new Date(now.getTime() - 3 * day), updatedAt: new Date(now.getTime() - 3 * day), deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.projectShanhai, ownerUserId: ownerId, teamId: null, genre: "治愈", name: "山海食堂", description: "海边小城的深夜食堂，一桌菜熨帖一桌人。", status: "active", createdAt: new Date(now.getTime() - 20 * day), updatedAt: new Date(now.getTime() - 2 * day), deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.projectJiucheng, ownerUserId: ownerId, teamId: null, genre: "年代", name: "旧城往事", description: "九十年代旧城改造，一条街的最后影像。", status: "archived", createdAt: new Date(now.getTime() - 60 * day), updatedAt: new Date(now.getTime() - 30 * day), deletedAt: null, deletedByUserId: null },
  ]);
  await handle.db.insert(episodes).values([
    { id: R147_IDS.epWudao, projectId: R147_IDS.projectWudao, episodeNo: 1, name: "第 1 集 · 来信", sortOrder: 1, status: "active", createdAt: new Date(now.getTime() - 10 * day), updatedAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.epShanhai, projectId: R147_IDS.projectShanhai, episodeNo: 1, name: "第 1 集 · 开灶", sortOrder: 1, status: "active", createdAt: new Date(now.getTime() - 18 * day), updatedAt: new Date(now.getTime() - 2 * day), deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.epJiucheng, projectId: R147_IDS.projectJiucheng, episodeNo: 1, name: "第 1 集 · 拆迁令", sortOrder: 1, status: "active", createdAt: new Date(now.getTime() - 58 * day), updatedAt: new Date(now.getTime() - 45 * day), deletedAt: null, deletedByUserId: null },
  ]);
  await handle.db.insert(scenes).values([
    { id: R147_IDS.sceneWudaoA, episodeId: R147_IDS.epWudao, sceneNo: 1, name: "巷口雨夜", description: "老街巷口，雨后青石反光。", sortOrder: 1, createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.sceneWudaoB, episodeId: R147_IDS.epWudao, sceneNo: 2, name: "面馆深夜", description: "巷尾面馆，黄灯一盏。", sortOrder: 2, createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.sceneShanhai, episodeId: R147_IDS.epShanhai, sceneNo: 1, name: "食堂灶间", description: "灶火正旺，蒸汽氤氲。", sortOrder: 1, createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.sceneJiucheng, episodeId: R147_IDS.epJiucheng, sceneNo: 1, name: "旧街黄昏", description: "搬空的老街，最后一批灯笼。", sortOrder: 1, createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null },
  ]);
  /* 资产库示例三件(角色/场景/光影,配图配名);先资产媒体,media_results 的 source 才有合法宿主(XOR 约束)。 */
  await handle.db.insert(assetEntities).values([
    { id: R147_IDS.assetGuzhou, copiedFromAssetEntityId: null, sourceProjectId: null, sourceProjectName: null, ownerUserId: ownerId, visibility: "personal", assetKind: "character", role: "character_identity", usageMode: null, name: "沈孤舟", displayName: "沈孤舟", intro: "冷面刀客，雨夜寻仇二十年，左眼下一道旧疤。", appearance: null, ageValue: null, gender: null, heightCm: null, hairDescription: null, outfitDescription: null, category: null, styleTags: ["古装", "冷面", "男主"], approved: true, reuseScope: "all_projects", status: "approved", sourceFileUrl: null, metadata: {}, createdAt: now, updatedAt: now, useCount: 0, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.assetNoodle, copiedFromAssetEntityId: null, sourceProjectId: null, sourceProjectName: null, ownerUserId: ownerId, visibility: "personal", assetKind: "scene", role: "scene", usageMode: null, name: "巷口面馆", displayName: "巷口面馆", intro: "雾岛老街尽头的深夜面馆，一盏黄灯不灭。", appearance: null, ageValue: null, gender: null, heightCm: null, hairDescription: null, outfitDescription: null, category: null, styleTags: ["夜戏", "内景", "暖光"], approved: true, reuseScope: "all_projects", status: "approved", sourceFileUrl: null, metadata: {}, createdAt: now, updatedAt: now, useCount: 0, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.assetRain, copiedFromAssetEntityId: null, sourceProjectId: null, sourceProjectName: null, ownerUserId: ownerId, visibility: "personal", assetKind: "lighting", role: "style_env", usageMode: null, name: "雨夜青蓝", displayName: "雨夜青蓝", intro: "青蓝雨夜基调，压暗部保灯笼暖，全剧影调锚。", appearance: null, ageValue: null, gender: null, heightCm: null, hairDescription: null, outfitDescription: null, category: null, styleTags: ["冷色", "雨夜", "影调"], approved: true, reuseScope: "all_projects", status: "approved", sourceFileUrl: null, metadata: {}, createdAt: now, updatedAt: now, useCount: 0, deletedAt: null, deletedByUserId: null },
  ]);
  await handle.db.insert(assetMedia).values([
    { id: R147_IDS.assetMediaGuzhou, assetEntityId: R147_IDS.assetGuzhou, assetVariantId: null, mediaKind: "image", viewAngle: null, title: "沈孤舟 · 雨夜定妆", description: null, storageBucket: "demo-media", storagePath: "demo-media/still-duel.png", storageUrl: `${R147_MEDIA_BASE}/still-duel.png`, widthPx: 150, heightPx: 150, format: "png", sha256: null, isPrimary: true, approved: true, sortOrder: 1, metadata: {}, createdAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.assetMediaNoodle, assetEntityId: R147_IDS.assetNoodle, assetVariantId: null, mediaKind: "image", viewAngle: null, title: "巷口面馆 · 外景", description: null, storageBucket: "demo-media", storagePath: "demo-media/poster-changjie.png", storageUrl: `${R147_MEDIA_BASE}/poster-changjie.png`, widthPx: 150, heightPx: 150, format: "png", sha256: null, isPrimary: true, approved: true, sortOrder: 1, metadata: {}, createdAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.assetMediaRain, assetEntityId: R147_IDS.assetRain, assetVariantId: null, mediaKind: "image", viewAngle: null, title: "雨夜青蓝 · 影调基准", description: null, storageBucket: "demo-media", storagePath: "demo-media/still-chase.png", storageUrl: `${R147_MEDIA_BASE}/still-chase.png`, widthPx: 150, heightPx: 150, format: "png", sha256: null, isPrimary: true, approved: true, sortOrder: 1, metadata: {}, createdAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.assetMediaWudaoPoster, assetEntityId: R147_IDS.assetRain, assetVariantId: null, mediaKind: "image", viewAngle: null, title: "雾岛来信 · 书封", description: null, storageBucket: "demo-media", storagePath: "demo-media/poster-wudao.png", storageUrl: `${R147_MEDIA_BASE}/poster-wudao.png`, widthPx: 150, heightPx: 150, format: "png", sha256: null, isPrimary: false, approved: true, sortOrder: 2, metadata: {}, createdAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.assetMediaShanhaiPoster, assetEntityId: R147_IDS.assetNoodle, assetVariantId: null, mediaKind: "image", viewAngle: null, title: "山海食堂 · 书封", description: null, storageBucket: "demo-media", storagePath: "demo-media/poster-shanhai.png", storageUrl: `${R147_MEDIA_BASE}/poster-shanhai.png`, widthPx: 150, heightPx: 150, format: "png", sha256: null, isPrimary: false, approved: true, sortOrder: 2, metadata: {}, createdAt: now, deletedAt: null, deletedByUserId: null },
  ]);
  await handle.db.insert(shots).values([
    { id: R147_IDS.shotWudao1, episodeId: R147_IDS.epWudao, sceneId: R147_IDS.sceneWudaoA, shotCode: "EP01-SC01-001", title: "来信", scriptText: "雨夜，沈孤舟在巷口拆开一封没有落款的信。", directorPrompt: null, imagePrompt: null, videoPrompt: null, durationSeconds: 5, sortOrder: 1, referenceAssetSnapshots: [], selectedImageResultId: null, selectedVideoResultId: null, createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.shotWudao2, episodeId: R147_IDS.epWudao, sceneId: R147_IDS.sceneWudaoA, shotCode: "EP01-SC01-002", title: "追逐", scriptText: "黑影掠过长街，沈孤舟追进雨里。", directorPrompt: null, imagePrompt: null, videoPrompt: null, durationSeconds: 4, sortOrder: 2, referenceAssetSnapshots: [], selectedImageResultId: null, selectedVideoResultId: null, createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.shotWudao3, episodeId: R147_IDS.epWudao, sceneId: R147_IDS.sceneWudaoB, shotCode: "EP01-SC02-001", title: "对峙", scriptText: "面馆黄灯下，两个故人隔桌无言。", directorPrompt: null, imagePrompt: null, videoPrompt: null, durationSeconds: 6, sortOrder: 3, referenceAssetSnapshots: [], selectedImageResultId: null, selectedVideoResultId: null, createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.shotShanhai1, episodeId: R147_IDS.epShanhai, sceneId: R147_IDS.sceneShanhai, shotCode: "EP01-SC01-001", title: "开灶", scriptText: "灶火升起，第一锅汤滚了。", directorPrompt: null, imagePrompt: null, videoPrompt: null, durationSeconds: 5, sortOrder: 1, referenceAssetSnapshots: [], selectedImageResultId: null, selectedVideoResultId: null, createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.shotJiucheng1, episodeId: R147_IDS.epJiucheng, sceneId: R147_IDS.sceneJiucheng, shotCode: "EP01-SC01-001", title: "熄灯", scriptText: "最后一盏灯笼熄灭前，老人又把它点亮。", directorPrompt: null, imagePrompt: null, videoPrompt: null, durationSeconds: 6, sortOrder: 1, referenceAssetSnapshots: [], selectedImageResultId: null, selectedVideoResultId: null, createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null },
  ]);
  /* shots↔media_results 互引:先插镜(selected 置空),再插图(source=对应资产媒体,XOR 合规),最后回写 selected。 */
  await handle.db.insert(mediaResults).values([
    r147MediaRow(R147_IDS.mediaWudaoPoster, R147_IDS.shotWudao1, R147_IDS.assetMediaWudaoPoster, "poster-wudao.png", ownerId, now),
    r147MediaRow(R147_IDS.mediaWudaoChase, R147_IDS.shotWudao2, R147_IDS.assetMediaRain, "still-chase.png", ownerId, now),
    r147MediaRow(R147_IDS.mediaWudaoDuel, R147_IDS.shotWudao3, R147_IDS.assetMediaGuzhou, "still-duel.png", ownerId, now),
    r147MediaRow(R147_IDS.mediaShanhaiPoster, R147_IDS.shotShanhai1, R147_IDS.assetMediaShanhaiPoster, "poster-shanhai.png", ownerId, now),
    r147MediaRow(R147_IDS.mediaJiuchengPoster, R147_IDS.shotJiucheng1, R147_IDS.assetMediaNoodle, "poster-changjie.png", ownerId, now),
  ]);
  await handle.db.update(shots).set({ selectedImageResultId: R147_IDS.mediaWudaoPoster }).where(eq(shots.id, R147_IDS.shotWudao1));
  await handle.db.update(shots).set({ selectedImageResultId: R147_IDS.mediaWudaoChase }).where(eq(shots.id, R147_IDS.shotWudao2));
  await handle.db.update(shots).set({ selectedImageResultId: R147_IDS.mediaWudaoDuel }).where(eq(shots.id, R147_IDS.shotWudao3));
  await handle.db.update(shots).set({ selectedImageResultId: R147_IDS.mediaShanhaiPoster }).where(eq(shots.id, R147_IDS.shotShanhai1));
  await handle.db.update(shots).set({ selectedImageResultId: R147_IDS.mediaJiuchengPoster }).where(eq(shots.id, R147_IDS.shotJiucheng1));
  await handle.db.insert(projectAssetRefs).values([
    { id: R147_IDS.refGuzhou, projectId: R147_IDS.projectWudao, assetEntityId: R147_IDS.assetGuzhou, assetVariantId: null, assetMediaId: R147_IDS.assetMediaGuzhou, versionSnapshot: {}, createdByUserId: ownerId, createdAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.refNoodle, projectId: R147_IDS.projectWudao, assetEntityId: R147_IDS.assetNoodle, assetVariantId: null, assetMediaId: R147_IDS.assetMediaNoodle, versionSnapshot: {}, createdByUserId: ownerId, createdAt: now, deletedAt: null, deletedByUserId: null },
    { id: R147_IDS.refRain, projectId: R147_IDS.projectWudao, assetEntityId: R147_IDS.assetRain, assetVariantId: null, assetMediaId: R147_IDS.assetMediaRain, versionSnapshot: {}, createdByUserId: ownerId, createdAt: now, deletedAt: null, deletedByUserId: null },
  ]);
  /* 最近动态:一条生图完成(雾岛·追逐)+一条入库成功(沈孤舟定妆),都记 admin 名下未读 */
  const requestHash = createHash("sha256").update("seed-r147-wudao-chase").digest("hex");
  await handle.db.insert(generationRequests).values({
    id: R147_IDS.genRequest, userId: ownerId, projectId: R147_IDS.projectWudao,
    episodeId: R147_IDS.epWudao, sceneId: R147_IDS.sceneWudaoA, shotId: R147_IDS.shotWudao2,
    targetAssetEntityId: null, mediaKind: "image",
    prompt: "雨夜长街追逐,青蓝影调,保灯笼暖光,电影感。", referenceMediaIds: [], referenceAssetSnapshots: [],
    parameters: {}, quantity: 1, clientIdempotencyKey: "seed-r147-wudao-chase", requestHash,
    chargedPoints: 60, createdAt: new Date(now.getTime() - 3600_000), updatedAt: new Date(now.getTime() - 3600_000),
  });
  await handle.db.insert(generationAttempts).values({
    id: R147_IDS.genAttempt, requestId: R147_IDS.genRequest, attemptNo: 1, retryIdempotencyKey: null,
    provider: "ark", providerTaskId: null, model: "doubao-seedream-5-0-pro-260628",
    parameters: {}, quantity: 1, status: "succeeded", phase: "complete",
    providerStatus: "succeeded", providerResponse: null, errorCode: null, errorMessage: null,
    retryable: false, estimatedCostFen: 60, actualCostFen: 60, actualCostStatus: "confirmed",
    pricingRuleId: null, priceSnapshot: {}, lastQueryError: null, nextPollAt: null, lastPolledAt: null,
    leaseOwner: null, leaseUntil: null,
    submittedAt: new Date(now.getTime() - 3600_000), startedAt: new Date(now.getTime() - 3590_000),
    finishedAt: new Date(now.getTime() - 3540_000),
    createdAt: new Date(now.getTime() - 3600_000), updatedAt: new Date(now.getTime() - 3540_000),
  });
  await handle.db.insert(generationAttemptNotifications).values({
    id: R147_IDS.genNotification, attemptId: R147_IDS.genAttempt,
    generationRequestId: R147_IDS.genRequest, projectId: R147_IDS.projectWudao,
    userId: ownerId, acknowledgedAt: null, createdAt: new Date(now.getTime() - 3540_000),
  });
  await handle.db.insert(assetUploadTasks).values({
    id: R147_IDS.uploadTask, userId: ownerId, status: "succeeded",
    originalFileName: "沈孤舟定妆照.png", contentType: "image/png", assetKindHint: "character",
    stagedPath: "demo-media/still-duel.png", stagedBytes: 38358,
    resultAssetEntityId: R147_IDS.assetGuzhou, resultAssetName: "沈孤舟",
    errorMessage: null, durationSeconds: 2, acknowledgedAt: null,
    createdAt: new Date(now.getTime() - 7200_000), startedAt: new Date(now.getTime() - 7190_000),
    finishedAt: new Date(now.getTime() - 7180_000),
  });

  /* 视频主版本(generation origin):交付清单「每镜已持久化+审核通过视频」门槛的另一半,
     书封海报链才能通(deliverables 就绪→useProjectCover 取首图)。
     视频=public/demo-media 既有 5 个 4 秒小样(占位演示素材,非真图管线产物)。 */
  await handle.db.insert(generationRequests).values([
    { id: R147_IDS.genRequestWudao1, userId: ownerId, projectId: R147_IDS.projectWudao, episodeId: R147_IDS.epWudao, sceneId: R147_IDS.sceneWudaoA, shotId: R147_IDS.shotWudao1, targetAssetEntityId: null, mediaKind: "video", prompt: "雨夜巷口拆信,青蓝影调,电影感。", referenceMediaIds: [], referenceAssetSnapshots: [], parameters: {}, quantity: 1, clientIdempotencyKey: "seed-r147-wudao1-video", requestHash: createHash("sha256").update("seed-r147-wudao1-video").digest("hex"), chargedPoints: 320, createdAt: new Date(now.getTime() - 5400_000), updatedAt: new Date(now.getTime() - 5400_000) },
    { id: R147_IDS.genRequestWudao3, userId: ownerId, projectId: R147_IDS.projectWudao, episodeId: R147_IDS.epWudao, sceneId: R147_IDS.sceneWudaoB, shotId: R147_IDS.shotWudao3, targetAssetEntityId: null, mediaKind: "video", prompt: "面馆黄灯下隔桌对峙,暖光夜戏。", referenceMediaIds: [], referenceAssetSnapshots: [], parameters: {}, quantity: 1, clientIdempotencyKey: "seed-r147-wudao3-video", requestHash: createHash("sha256").update("seed-r147-wudao3-video").digest("hex"), chargedPoints: 320, createdAt: new Date(now.getTime() - 5400_000), updatedAt: new Date(now.getTime() - 5400_000) },
    { id: R147_IDS.genRequestShanhai, userId: ownerId, projectId: R147_IDS.projectShanhai, episodeId: R147_IDS.epShanhai, sceneId: R147_IDS.sceneShanhai, shotId: R147_IDS.shotShanhai1, targetAssetEntityId: null, mediaKind: "video", prompt: "灶火升起,蒸汽氤氲,暖黄食堂内景。", referenceMediaIds: [], referenceAssetSnapshots: [], parameters: {}, quantity: 1, clientIdempotencyKey: "seed-r147-shanhai-video", requestHash: createHash("sha256").update("seed-r147-shanhai-video").digest("hex"), chargedPoints: 320, createdAt: new Date(now.getTime() - 5400_000), updatedAt: new Date(now.getTime() - 5400_000) },
    { id: R147_IDS.genRequestJiucheng, userId: ownerId, projectId: R147_IDS.projectJiucheng, episodeId: R147_IDS.epJiucheng, sceneId: R147_IDS.sceneJiucheng, shotId: R147_IDS.shotJiucheng1, targetAssetEntityId: null, mediaKind: "video", prompt: "旧街黄昏,灯笼逐一点亮,年代质感。", referenceMediaIds: [], referenceAssetSnapshots: [], parameters: {}, quantity: 1, clientIdempotencyKey: "seed-r147-jiucheng-video", requestHash: createHash("sha256").update("seed-r147-jiucheng-video").digest("hex"), chargedPoints: 320, createdAt: new Date(now.getTime() - 45 * 24 * 3600_000), updatedAt: new Date(now.getTime() - 45 * 24 * 3600_000) },
  ]);
  await handle.db.insert(generationAttempts).values([
    { id: R147_IDS.genAttemptWudao1, requestId: R147_IDS.genRequestWudao1, attemptNo: 1, retryIdempotencyKey: null, provider: "ark", providerTaskId: null, model: "doubao-seedance-2-0-fast-260128", parameters: {}, quantity: 1, status: "succeeded", phase: "complete", providerStatus: "succeeded", providerResponse: null, errorCode: null, errorMessage: null, retryable: false, estimatedCostFen: 320, actualCostFen: 320, actualCostStatus: "confirmed", pricingRuleId: null, priceSnapshot: {}, lastQueryError: null, nextPollAt: null, lastPolledAt: null, leaseOwner: null, leaseUntil: null, submittedAt: new Date(now.getTime() - 5400_000), startedAt: new Date(now.getTime() - 5390_000), finishedAt: new Date(now.getTime() - 5300_000), createdAt: new Date(now.getTime() - 5400_000), updatedAt: new Date(now.getTime() - 5300_000) },
    { id: R147_IDS.genAttemptWudao3, requestId: R147_IDS.genRequestWudao3, attemptNo: 1, retryIdempotencyKey: null, provider: "ark", providerTaskId: null, model: "doubao-seedance-2-0-fast-260128", parameters: {}, quantity: 1, status: "succeeded", phase: "complete", providerStatus: "succeeded", providerResponse: null, errorCode: null, errorMessage: null, retryable: false, estimatedCostFen: 320, actualCostFen: 320, actualCostStatus: "confirmed", pricingRuleId: null, priceSnapshot: {}, lastQueryError: null, nextPollAt: null, lastPolledAt: null, leaseOwner: null, leaseUntil: null, submittedAt: new Date(now.getTime() - 5400_000), startedAt: new Date(now.getTime() - 5390_000), finishedAt: new Date(now.getTime() - 5300_000), createdAt: new Date(now.getTime() - 5400_000), updatedAt: new Date(now.getTime() - 5300_000) },
    { id: R147_IDS.genAttemptShanhai, requestId: R147_IDS.genRequestShanhai, attemptNo: 1, retryIdempotencyKey: null, provider: "ark", providerTaskId: null, model: "doubao-seedance-2-0-fast-260128", parameters: {}, quantity: 1, status: "succeeded", phase: "complete", providerStatus: "succeeded", providerResponse: null, errorCode: null, errorMessage: null, retryable: false, estimatedCostFen: 320, actualCostFen: 320, actualCostStatus: "confirmed", pricingRuleId: null, priceSnapshot: {}, lastQueryError: null, nextPollAt: null, lastPolledAt: null, leaseOwner: null, leaseUntil: null, submittedAt: new Date(now.getTime() - 5400_000), startedAt: new Date(now.getTime() - 5390_000), finishedAt: new Date(now.getTime() - 5300_000), createdAt: new Date(now.getTime() - 5400_000), updatedAt: new Date(now.getTime() - 5300_000) },
    { id: R147_IDS.genAttemptJiucheng, requestId: R147_IDS.genRequestJiucheng, attemptNo: 1, retryIdempotencyKey: null, provider: "ark", providerTaskId: null, model: "doubao-seedance-2-0-fast-260128", parameters: {}, quantity: 1, status: "succeeded", phase: "complete", providerStatus: "succeeded", providerResponse: null, errorCode: null, errorMessage: null, retryable: false, estimatedCostFen: 320, actualCostFen: 320, actualCostStatus: "confirmed", pricingRuleId: null, priceSnapshot: {}, lastQueryError: null, nextPollAt: null, lastPolledAt: null, leaseOwner: null, leaseUntil: null, submittedAt: new Date(now.getTime() - 45 * 24 * 3600_000), startedAt: new Date(now.getTime() - 45 * 24 * 3600_000), finishedAt: new Date(now.getTime() - 45 * 24 * 3600_000 + 90_000), createdAt: new Date(now.getTime() - 45 * 24 * 3600_000), updatedAt: new Date(now.getTime() - 45 * 24 * 3600_000 + 90_000) },
  ]);
  await handle.db.insert(mediaResults).values([
    r147VideoRow(R147_IDS.videoWudao1, R147_IDS.shotWudao1, R147_IDS.genRequestWudao1, R147_IDS.genAttemptWudao1, "ep1-shot-1.mp4", "seed-video-wudao-1", now),
    r147VideoRow(R147_IDS.videoWudao2, R147_IDS.shotWudao2, R147_IDS.genRequest, R147_IDS.genAttempt, "ep1-shot-2.mp4", "seed-video-wudao-2", now),
    r147VideoRow(R147_IDS.videoWudao3, R147_IDS.shotWudao3, R147_IDS.genRequestWudao3, R147_IDS.genAttemptWudao3, "ep1-shot-3.mp4", "seed-video-wudao-3", now),
    r147VideoRow(R147_IDS.videoShanhai, R147_IDS.shotShanhai1, R147_IDS.genRequestShanhai, R147_IDS.genAttemptShanhai, "ep1-shot-4.mp4", "seed-video-shanhai-1", now),
    r147VideoRow(R147_IDS.videoJiucheng, R147_IDS.shotJiucheng1, R147_IDS.genRequestJiucheng, R147_IDS.genAttemptJiucheng, "ep1-shot-5.mp4", "seed-video-jiucheng-1", now),
  ]);
  await handle.db.update(shots).set({ selectedVideoResultId: R147_IDS.videoWudao1 }).where(eq(shots.id, R147_IDS.shotWudao1));
  await handle.db.update(shots).set({ selectedVideoResultId: R147_IDS.videoWudao2 }).where(eq(shots.id, R147_IDS.shotWudao2));
  await handle.db.update(shots).set({ selectedVideoResultId: R147_IDS.videoWudao3 }).where(eq(shots.id, R147_IDS.shotWudao3));
  await handle.db.update(shots).set({ selectedVideoResultId: R147_IDS.videoShanhai }).where(eq(shots.id, R147_IDS.shotShanhai1));
  await handle.db.update(shots).set({ selectedVideoResultId: R147_IDS.videoJiucheng }).where(eq(shots.id, R147_IDS.shotJiucheng1));
}

/* 长街灯火补建:建集+交付物链,让项目卡挂上书封海报。
   海报链同雾岛三坑:shots↔media_results 互引(先镜后图再回写)、origin XOR、
   deliverables 派生门槛(generation origin 视频 persisted+accepted 且 request.shot_id 匹配)。 */
async function seedChangjie(handle: DatabaseHandle, ownerId: string): Promise<void> {
  const now = new Date();
  await handle.db.insert(episodes).values({
    id: R147_IDS.epChangjie, projectId: R147_IDS.projectChangjie, episodeNo: 1,
    name: "第 1 集 · 灯市", sortOrder: 1, status: "active",
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  });
  await handle.db.insert(scenes).values({
    id: R147_IDS.sceneChangjie, episodeId: R147_IDS.epChangjie, sceneNo: 1,
    name: "长街灯市", description: "上元夜灯市，巡灯人沿街巡灯，拾到一盏不灭的灯。", sortOrder: 1,
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  });
  /* 书封宿主媒体挂在既有资产「巷口面馆」下(同 assetMediaWudaoPoster 挂 assetRain 的做法)。 */
  await handle.db.insert(assetMedia).values({
    id: R147_IDS.assetMediaChangjiePoster, assetEntityId: R147_IDS.assetNoodle, assetVariantId: null,
    mediaKind: "image", viewAngle: null, title: "长街灯火 · 书封", description: null,
    storageBucket: "demo-media", storagePath: "demo-media/poster-changjie.png",
    storageUrl: `${R147_MEDIA_BASE}/poster-changjie.png`, widthPx: 150, heightPx: 150,
    format: "png", sha256: null, isPrimary: false, approved: true, sortOrder: 3,
    metadata: {}, createdAt: now, deletedAt: null, deletedByUserId: null,
  });
  await handle.db.insert(shots).values({
    id: R147_IDS.shotChangjie, episodeId: R147_IDS.epChangjie, sceneId: R147_IDS.sceneChangjie,
    shotCode: "EP01-SC01-001", title: "拾灯",
    scriptText: "上元夜，巡灯人在长街拾到一盏不灭的灯。",
    directorPrompt: null, imagePrompt: null, videoPrompt: null,
    durationSeconds: 5, sortOrder: 1, referenceAssetSnapshots: [],
    selectedImageResultId: null, selectedVideoResultId: null,
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  });
  /* 书封海报(asset_media origin,XOR:requestId/attemptId 置空,sourceAssetMediaId 非空)。 */
  await handle.db.insert(mediaResults).values(
    r147MediaRow(R147_IDS.mediaChangjiePoster, R147_IDS.shotChangjie, R147_IDS.assetMediaChangjiePoster, "poster-changjie.png", ownerId, now),
  );
  await handle.db.update(shots).set({ selectedImageResultId: R147_IDS.mediaChangjiePoster }).where(eq(shots.id, R147_IDS.shotChangjie));
  /* 视频主版本(generation origin):交付门槛的另一半,占位小样复用 ep1-shot-1.mp4。 */
  await handle.db.insert(generationRequests).values({
    id: R147_IDS.genRequestChangjie, userId: ownerId, projectId: R147_IDS.projectChangjie,
    episodeId: R147_IDS.epChangjie, sceneId: R147_IDS.sceneChangjie, shotId: R147_IDS.shotChangjie,
    targetAssetEntityId: null, mediaKind: "video",
    prompt: "上元夜长街灯市，灯笼绵延三百盏，巡灯人俯身拾灯，暖光夜戏，电影感。",
    referenceMediaIds: [], referenceAssetSnapshots: [], parameters: {}, quantity: 1,
    clientIdempotencyKey: "seed-r147-changjie-video",
    requestHash: createHash("sha256").update("seed-r147-changjie-video").digest("hex"),
    chargedPoints: 320, createdAt: now, updatedAt: now,
  });
  await handle.db.insert(generationAttempts).values({
    id: R147_IDS.genAttemptChangjie, requestId: R147_IDS.genRequestChangjie, attemptNo: 1, retryIdempotencyKey: null,
    provider: "ark", providerTaskId: null, model: "doubao-seedance-2-0-fast-260128",
    parameters: {}, quantity: 1, status: "succeeded", phase: "complete",
    providerStatus: "succeeded", providerResponse: null, errorCode: null, errorMessage: null,
    retryable: false, estimatedCostFen: 320, actualCostFen: 320, actualCostStatus: "confirmed",
    pricingRuleId: null, priceSnapshot: {}, lastQueryError: null, nextPollAt: null, lastPolledAt: null,
    leaseOwner: null, leaseUntil: null,
    submittedAt: now, startedAt: now, finishedAt: now,
    createdAt: now, updatedAt: now,
  });
  await handle.db.insert(mediaResults).values(
    r147VideoRow(R147_IDS.videoChangjie, R147_IDS.shotChangjie, R147_IDS.genRequestChangjie, R147_IDS.genAttemptChangjie, "ep1-shot-1.mp4", "seed-video-changjie-1", now),
  );
  await handle.db.update(shots).set({ selectedVideoResultId: R147_IDS.videoChangjie }).where(eq(shots.id, R147_IDS.shotChangjie));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
