import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import type { EpisodeRow, ProjectRow, ShotRow } from "../../db/schema.js";
import { ConflictError, NotFoundError, ForbiddenError } from "../../shared/errors.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessRecord, ProjectMembershipRole } from "../project-access/types.js";
import type { EffectiveShotMediaStore } from "../shot-media/effectiveSelectionRepository.js";
import { ProductionRepository } from "./repository.js";
import {
  DEFAULT_IMAGE_PROMPT_TEMPLATE,
  DEFAULT_VIDEO_PROMPT_TEMPLATE,
  ProductionService,
} from "./service.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const episodeId = "44444444-4444-4444-8444-444444444444";
const db = {} as Database;

test("viewer 可读项目与剧集，但不能创建内容", async () => {
  let createEpisodeCalls = 0;
  const service = createService({
    memberships: new Map([[actorId, "viewer"]]),
    repository: {
      createEpisode: async () => {
        createEpisodeCalls += 1;
        return episode();
      },
    },
  });

  const project = await service.getProject({ id: actorId, role: "member" }, projectId);
  assert.equal(project.id, projectId);
  const fetchedEpisode = await service.getEpisode({ id: actorId, role: "member" }, episodeId);
  assert.equal(fetchedEpisode.id, episodeId);
  await assert.rejects(
    service.createEpisode({ id: actorId, role: "member" }, projectId, { episodeNo: 2 }),
    isProjectActionForbidden,
  );
  assert.equal(createEpisodeCalls, 0);
});

test("editor 能保存生成配置，但不能归档或删除项目", async () => {
  let createEpisodeCalls = 0;
  let deletedProject = false;
  let persistedGenerationConfig: Parameters<ProductionRepository["updateProject"]>[1]["generationConfig"];
  const service = createService({
    memberships: new Map([[actorId, "editor"]]),
    repository: {
      createEpisode: async () => {
        createEpisodeCalls += 1;
        return episode({ episodeNo: 2 });
      },
      softDeleteProject: async () => {
        deletedProject = true;
      },
      updateProject: async (_id, input) => {
        persistedGenerationConfig = input.generationConfig;
        return project({
          defaultImageResolution: input.generationConfig?.defaultImageResolution ?? "1K",
        });
      },
    },
  });

  const created = await service.createEpisode({ id: actorId, role: "member" }, projectId, { episodeNo: 2 });
  assert.equal(created.episode_no, 2);
  assert.equal(createEpisodeCalls, 1);
  await assert.rejects(
    service.updateProject({ id: actorId, role: "member" }, projectId, { status: "archived" }),
    isProjectActionForbidden,
  );
  const updated = await service.updateProject({ id: actorId, role: "member" }, projectId, {
    generationConfig: { defaultImageResolution: "2K" },
  });
  assert.equal(persistedGenerationConfig?.defaultImageResolution, "2K");
  assert.equal(updated.generation_config.default_image_resolution, "2K");
  await assert.rejects(
    service.deleteProject({ id: actorId, role: "member" }, projectId),
    isProjectActionForbidden,
  );
  assert.equal(deletedProject, false);
});

test("owner 仍能保存生成配置并归档项目", async () => {
  const updates: Parameters<ProductionRepository["updateProject"]>[1][] = [];
  const service = createService({
    memberships: new Map([[actorId, "owner"]]),
    repository: {
      updateProject: async (_id, input) => {
        updates.push(input);
        return project({
          status: input.status ?? "active",
          defaultImageResolution: input.generationConfig?.defaultImageResolution ?? "1K",
        });
      },
    },
  });

  await service.updateProject({ id: actorId, role: "member" }, projectId, {
    generationConfig: { defaultImageResolution: "2K" },
  });
  const archived = await service.updateProject({ id: actorId, role: "member" }, projectId, { status: "archived" });

  assert.equal(updates[0]?.generationConfig?.defaultImageResolution, "2K");
  assert.equal(updates[1]?.status, "archived");
  assert.equal(archived.status, "archived");
});

test("项目默认生成配置独立保存图片和视频分辨率，并回显平台模板", async () => {
  let persisted: Parameters<ProductionRepository["updateProject"]>[1] | undefined;
  const service = createService({
    memberships: new Map([[actorId, "owner"]]),
    repository: {
      updateProject: async (_id, input) => {
        persisted = input;
        return project({
          defaultImageResolution: input.generationConfig?.defaultImageResolution ?? "1K",
          defaultVideoResolution: input.generationConfig?.defaultVideoResolution ?? "720p",
        });
      },
    },
  });

  const updated = await service.updateProject({ id: actorId, role: "member" }, projectId, {
    generationConfig: { defaultImageResolution: "2K", defaultVideoResolution: "1080p" },
  });

  assert.equal(persisted?.generationConfig?.defaultImageResolution, "2K");
  assert.equal(persisted?.generationConfig?.defaultVideoResolution, "1080p");
  assert.equal(updated.generation_config.default_image_resolution, "2K");
  assert.equal(updated.generation_config.default_video_resolution, "1080p");
  assert.equal(updated.generation_config.image.prompt_template, DEFAULT_IMAGE_PROMPT_TEMPLATE);
  assert.equal(updated.generation_config.image.prompt_template_source, "platform_default");
  assert.equal(updated.generation_config.video.prompt_template, DEFAULT_VIDEO_PROMPT_TEMPLATE);
  assert.equal(updated.generation_config.video.prompt_template_source, "platform_default");
});

test("项目生成配置 PATCH 按当前行合并嵌套图片配置", async () => {
  let persisted: Parameters<ProductionRepository["updateProject"]>[1] | undefined;
  const service = createService({
    memberships: new Map([[actorId, "owner"]]),
    repository: {
      getProject: async () => project({
        imageStyleDescription: "旧图片风格",
        imageStyleReferenceMediaIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        videoStyleDescription: "旧视频风格",
        videoStyleReferenceMediaIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      }),
      updateProject: async (_id, input) => {
        persisted = input;
        return project({
          imageStyleDescription: input.generationConfig?.imageStyleDescription ?? null,
          imageStyleReferenceMediaIds: input.generationConfig?.imageStyleReferenceMediaIds ?? [],
          videoStyleDescription: input.generationConfig?.videoStyleDescription ?? null,
          videoStyleReferenceMediaIds: input.generationConfig?.videoStyleReferenceMediaIds ?? [],
        });
      },
    },
  });

  await service.updateProject({ id: actorId, role: "member" }, projectId, {
    generationConfig: { imageStyleDescription: "新图片风格" },
  });

  assert.equal(persisted?.generationConfig?.imageStyleDescription, "新图片风格");
  assert.deepEqual(persisted?.generationConfig?.imageStyleReferenceMediaIds, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  assert.equal(persisted?.generationConfig?.videoStyleDescription, "旧视频风格");
  assert.deepEqual(persisted?.generationConfig?.videoStyleReferenceMediaIds, ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
});

test("风格参考图没有最终风格描述时拒绝创建和更新", async () => {
  const service = createService({ memberships: new Map([[actorId, "owner"]]) });
  await assert.rejects(
    service.createProject({ id: actorId, role: "member" }, {
      name: "缺少图片风格描述",
      generationConfig: { imageStyleReferenceMediaIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] },
    }),
    isStyleDescriptionRequired,
  );
  await assert.rejects(
    service.updateProject({ id: actorId, role: "member" }, projectId, {
      generationConfig: { videoStyleReferenceMediaIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] },
    }),
    isStyleDescriptionRequired,
  );
});

test("operator 只读，admin 可跨项目创建和删除", async () => {
  let createdFor: string | undefined;
  let deletedBy: string | undefined;
  const service = createService({
    memberships: new Map(),
    repository: {
      createProject: async (input) => {
        createdFor = input.ownerUserId;
        return project({ ownerUserId: input.ownerUserId, name: input.name });
      },
      softDeleteProject: async (_id, userId) => {
        deletedBy = userId;
      },
    },
  });

  await service.getProject({ id: actorId, role: "operator" }, projectId);
  await assert.rejects(
    service.createProject({ id: actorId, role: "operator" }, { name: "不能创建" }),
    (error: unknown) => error instanceof ForbiddenError && error.statusCode === 403,
  );
  const created = await service.createProject({ id: actorId, role: "admin" }, { name: "后台项目" });
  assert.equal(created.owner_user_id, actorId);
  assert.equal(createdFor, actorId);
  await service.deleteProject({ id: actorId, role: "admin" }, projectId);
  assert.equal(deletedBy, actorId);
});

test("普通成员创建项目受平台开关控制，旧字符串调用默认为 member", async () => {
  let created = 0;
  const disabled = createService({
    memberships: new Map(),
    allowMemberCreateProject: false,
  });
  await assert.rejects(
    disabled.createProject(actorId, { name: "关闭时失败" }),
    (error: unknown) => error instanceof ForbiddenError && error.statusCode === 403,
  );

  const enabled = createService({
    memberships: new Map(),
    allowMemberCreateProject: true,
    repository: {
      createProject: async (input) => {
        created += 1;
        return project({ ownerUserId: input.ownerUserId, name: input.name });
      },
    },
  });
  await enabled.createProject(actorId, { name: "开放时成功" });
  assert.equal(created, 1);
});

test("项目列表对 member 走成员可见性，对 admin/operator 请求全量", async () => {
  const calls: Array<{ actorId: string; includeAll: boolean }> = [];
  const service = createService({
    memberships: new Map(),
    repository: {
      listProjects: async (actualActorId, includeAll) => {
        calls.push({ actorId: actualActorId, includeAll: includeAll ?? false });
        return [project()];
      },
      listProjectCounts: async () => new Map(),
    },
  });
  await service.listProjects({ id: actorId, role: "member" });
  await service.listProjects({ id: actorId, role: "operator" });
  await service.listProjects({ id: actorId, role: "admin" });
  assert.deepEqual(calls, [
    { actorId, includeAll: false },
    { actorId, includeAll: true },
    { actorId, includeAll: true },
  ]);
});

test("项目列表与详情响应透出 lite_episode_id（Lite 项目判定依据，060 迁移起）", async () => {
  const liteEpisodeIdValue = "55555555-5555-4555-8555-555555555555";
  const service = createService({
    memberships: new Map([[actorId, "viewer"]]),
    repository: {
      listProjects: async () => [project({ liteEpisodeId: liteEpisodeIdValue }), project()],
      listProjectCounts: async () => new Map(),
      getProject: async () => project({ liteEpisodeId: liteEpisodeIdValue }),
    },
  });

  const list = await service.listProjects({ id: actorId, role: "member" });
  assert.equal(list[0]?.lite_episode_id, liteEpisodeIdValue);
  assert.equal(list[1]?.lite_episode_id, null);
  const detail = await service.getProject({ id: actorId, role: "member" }, projectId);
  assert.equal(detail.lite_episode_id, liteEpisodeIdValue);
});

test("生产分镜读取系统默认定稿并标明来源", async () => {
  const imageId = "55555555-5555-4555-8555-555555555555";
  const service = createService({
    memberships: new Map([[actorId, "viewer"]]),
    repository: { listShots: async () => [shot()] },
    effectiveShotMedia: {
      resolve: async () => new Map([[
        shot().id,
        { image: { id: imageId, source: "latest_default" }, video: null },
      ]]),
    },
  });

  const [result] = await service.listShots({ id: actorId, role: "member" }, episodeId);
  assert.equal(result?.selected_image_result_id, imageId);
  assert.equal(result?.image_selection_source, "latest_default");
  assert.equal(result?.selected_video_result_id, null);
  assert.equal(result?.video_selection_source, null);
});

test("读取分镜时快照注入主图 image_url(读路径水合:未含 image_url 的旧快照也显示缩略图)", async () => {
  const shotId = "66666666-6666-4666-8666-666666666666";
  const manualSnap = {
    asset_entity_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    variant_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    asset_name: "林雪",
  };
  const exactSnap = {
    asset_entity_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    asset_name: "林雪",
  };
  const imageUrl = "https://tos.example.test/main.png";
  let resolveCalls = 0;
  const service = createService({
    memberships: new Map([[actorId, "owner"]]),
    repository: {
      getShot: async () => ({ shot: shot({ id: shotId, referenceAssetSnapshots: [manualSnap, exactSnap] }), projectId, ownerUserId: ownerId }),
      listShots: async () => [shot({ id: shotId, referenceAssetSnapshots: [manualSnap, exactSnap] })],
      resolveSnapshotImages: async (snapshots) => {
        resolveCalls += 1;
        assert.deepEqual(snapshots, [manualSnap, exactSnap]);
        return new Map([[`${manualSnap.asset_entity_id}::${manualSnap.variant_id}`, imageUrl]]);
      },
      resolveSnapshotVariantNames: async (snapshots) => {
        assert.deepEqual(snapshots, [manualSnap, exactSnap]);
        return new Map([[manualSnap.variant_id, "默认外观"]]);
      },
    },
    effectiveShotMedia: { resolve: async () => new Map() },
  });

  const detail = await service.getShot({ id: actorId, role: "member" }, shotId);
  assert.equal(detail?.reference_asset_snapshots?.[0]?.image_url, imageUrl);
  assert.equal("image_url" in (detail?.reference_asset_snapshots?.[1] ?? {}), false);
  assert.equal(detail?.reference_asset_snapshots?.[0]?.variant_name, "默认外观");
  assert.equal("variant_name" in (detail?.reference_asset_snapshots?.[1] ?? {}), false);

  const [listed] = await service.listShots({ id: actorId, role: "member" }, episodeId);
  assert.equal(listed?.reference_asset_snapshots?.[0]?.image_url, imageUrl);
  assert.equal("image_url" in (listed?.reference_asset_snapshots?.[1] ?? {}), false);
  assert.equal(resolveCalls, 2);
});

test("非成员和不存在项目在生产主链返回同一个 404", async () => {
  const access = new ProjectAccessService({
    findAccessRecord: async () => null,
  });
  const service = new ProductionService(db, repository({
    getProject: async () => project(),
  }), { access, allowMemberCreateProject: true });
  await assert.rejects(
    service.getProject({ id: actorId, role: "member" }, projectId),
    isHiddenProjectNotFound,
  );
  const missing = new ProductionService(db, repository({
    getProject: async () => undefined,
  }), { access, allowMemberCreateProject: true });
  await assert.rejects(
    missing.getProject({ id: actorId, role: "member" }, projectId),
    isHiddenProjectNotFound,
  );
});

function createService(input: {
  memberships: Map<string, ProjectMembershipRole>;
  repository?: Partial<ProductionRepository>;
  allowMemberCreateProject?: boolean;
  effectiveShotMedia?: EffectiveShotMediaStore;
}) {
  const access = new ProjectAccessService({
    findAccessRecord: async (requestedActorId, requestedProjectId): Promise<ProjectAccessRecord | null> => {
      if (requestedProjectId !== projectId) return null;
      return {
        projectId,
        ownerUserId: ownerId,
        membershipRole: input.memberships.get(requestedActorId) ?? null,
      };
    },
  });
  return new ProductionService(db, repository(input.repository), {
    access,
    allowMemberCreateProject: input.allowMemberCreateProject ?? true,
    effectiveShotMedia: input.effectiveShotMedia,
  });
}

function repository(overrides: Partial<ProductionRepository> = {}): ProductionRepository {
  return {
    listProjects: async () => [project()],
    getProject: async () => project(),
    createProject: async (input: Parameters<ProductionRepository["createProject"]>[0]) => (
      project({ ownerUserId: input.ownerUserId, name: input.name })
    ),
    updateProject: async () => project(),
    softDeleteProject: async () => undefined,
    listEpisodes: async () => [episode()],
    getEpisode: async () => ({ episode: episode(), ownerUserId: ownerId }),
    createEpisode: async () => episode(),
    updateEpisode: async () => episode(),
    softDeleteEpisode: async () => undefined,
    listScenes: async () => [],
    getScene: async () => undefined,
    createScene: async () => { throw new Error("not used"); },
    updateScene: async () => { throw new Error("not used"); },
    softDeleteScene: async () => undefined,
    listShots: async () => [],
    getShot: async () => undefined,
    resolveSnapshotImages: async () => new Map(),
    resolveSnapshotVariantNames: async () => new Map(),
    createShot: async () => { throw new Error("not used"); },
    updateShot: async () => { throw new Error("not used"); },
    softDeleteShot: async () => undefined,
    ...overrides,
  } as unknown as ProductionRepository;
}

function project(overrides: Partial<ProjectRow> = {}): ProjectRow {
  const now = new Date("2026-07-24T00:00:00.000Z");
  return {
    id: projectId,
    ownerUserId: ownerId,
    teamId: null,
    genre: null,
    name: "权限测试项目",
    description: null,
    status: "active",
    defaultRatio: "9:16",
    defaultImageResolution: "1K",
    defaultVideoResolution: "720p",
    imageStyleDescription: null,
    videoStyleDescription: null,
    imageStyleReferenceMediaIds: [],
    videoStyleReferenceMediaIds: [],
    imagePromptTemplate: null,
    videoPromptTemplate: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
    liteEpisodeId: null,
    ...overrides,
  };
}

function episode(overrides: Partial<EpisodeRow> = {}): EpisodeRow {
  const now = new Date("2026-07-24T00:00:00.000Z");
  return {
    id: episodeId,
    projectId,
    episodeNo: 1,
    name: "第 1 集",
    synopsis: "",
    sortOrder: 1,
    status: "active",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
    ...overrides,
  };
}

function shot(overrides: Partial<ShotRow> = {}): ShotRow {
  const now = new Date("2026-07-24T00:00:00.000Z");
  return {
    id: "66666666-6666-4666-8666-666666666666",
    episodeId,
    sceneId: null,
    shotCode: "G01",
    title: null,
    scriptText: null,
    breakdownElements: null,
    directorPrompt: null,
    imagePrompt: null,
    videoPrompt: null,
    storyboardDetail: null,
    durationSeconds: null,
    sortOrder: 1,
    referenceAssetSnapshots: [],
    metadata: {},
    sourceBreakdownRunId: null,
    sourceCandidateId: null,
    selectedImageResultId: null,
    selectedVideoResultId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
    ...overrides,
  };
}

function isHiddenProjectNotFound(error: unknown): boolean {
  return error instanceof NotFoundError
    && error.statusCode === 404
    && error.message === "项目不存在或你没有访问权限";
}

function isProjectActionForbidden(error: unknown): boolean {
  return error instanceof ForbiddenError
    && error.statusCode === 403
    && error.message === "你没有在该项目中执行此操作的权限";
}

function isStyleDescriptionRequired(error: unknown): boolean {
  return error instanceof ConflictError
    && error.statusCode === 409
    && /风格参考图需要.*风格描述/.test(error.message);
}
