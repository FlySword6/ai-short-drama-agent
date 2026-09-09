import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import type { ShotAssetRefRow, ShotRow } from "../../db/schema.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessRecord } from "../project-access/types.js";
import { ProductionRepository, type ShotAssetRefView } from "./repository.js";
import { ProductionService } from "./service.js";

/* v1.4(迁移 065):分镜-资产引用 shot_asset_refs 的服务层契约——
   访问控制(写需 create)、实体归属项目校验、跨镜引用守卫、asset_entity_id 不可改、
   metadata 合并式 PATCH(只覆盖出现的 lite.shot 键,保留其它命名空间)。 */

const actorId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const episodeId = "44444444-4444-4444-8444-444444444444";
const shotId = "66666666-6666-4666-8666-666666666666";
const db = {} as Database;

function isProjectActionForbidden(error: unknown): boolean {
  return error instanceof ForbiddenError
    && error.statusCode === 403
    && error.message === "你没有在该项目中执行此操作的权限";
}

function isRefNotFound(error: unknown): boolean {
  return error instanceof NotFoundError && error.message === "分镜资产引用不存在";
}

function isAssetNotInProject(error: unknown): boolean {
  return error instanceof NotFoundError && error.message === "项目资产不存在或不属于当前项目";
}

function shot(overrides: Partial<ShotRow> = {}): ShotRow {
  const now = new Date("2026-07-24T00:00:00.000Z");
  return {
    id: shotId,
    episodeId,
    sceneId: null,
    shotCode: "G01",
    title: null,
    scriptText: "朕绝不退让。",
    breakdownElements: { subject: "皇帝", action: "拍案", visual: "烛火摇曳", camera_language: "中景" },
    directorPrompt: "皇帝独坐沉思",
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

function refRow(overrides: Partial<ShotAssetRefRow> = {}): ShotAssetRefRow {
  const now = new Date("2026-07-24T00:00:00.000Z");
  return {
    id: "99999999-9999-4999-8999-999999999999",
    shotId,
    assetEntityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    assetVariantId: null,
    assetMediaId: null,
    usageMode: null,
    enabled: true,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
    ...overrides,
  };
}

function refView(overrides: Partial<ShotAssetRefView> = {}): ShotAssetRefView {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    shot_id: shotId,
    asset_entity_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    asset_variant_id: null,
    asset_media_id: null,
    usage_mode: null,
    enabled: true,
    sort_order: 0,
    asset_name: "龙袍",
    asset_display_name: null,
    asset_role: "costume",
    asset_kind: "costume",
    variant_name: null,
    media_title: null,
    thumb_url: null,
    created_at: new Date("2026-07-24T00:00:00.000Z").toISOString(),
    updated_at: new Date("2026-07-24T00:00:00.000Z").toISOString(),
    ...overrides,
  };
}

function createService(input: {
  memberships: Map<string, "owner" | "editor" | "viewer">;
  repository?: Partial<ProductionRepository>;
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
  return new ProductionService(db, input.repository as unknown as ProductionRepository, {
    access,
    allowMemberCreateProject: true,
  });
}

const emptyRepository = (): Partial<ProductionRepository> => ({
  getShot: async () => ({ shot: shot(), projectId, ownerUserId: ownerId }),
});

const viewer = { id: actorId, role: "member" as const };

test("asset-refs:member 可读可建,viewer 不能建", async () => {
  const created: Array<Parameters<ProductionRepository["createShotAssetRef"]>[0]> = [];
  let validateCalls = 0;
  const service = createService({
    memberships: new Map([[actorId, "editor"]]),
    repository: {
      ...emptyRepository(),
      listShotAssetRefs: async () => [refView()],
      requireShotProjectAsset: async () => {
        validateCalls += 1;
      },
      createShotAssetRef: async (input) => {
        created.push(input);
        return refRow();
      },
    },
  });

  const listed = await service.listShotAssetRefs(viewer, shotId);
  assert.equal(listed.length, 1);

  const item = await service.createShotAssetRef(viewer, shotId, { assetEntityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  assert.equal(item.assetEntityId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(validateCalls, 1);
  assert.deepEqual(created[0], {
    shotId,
    assetEntityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    assetVariantId: undefined,
    assetMediaId: undefined,
    usageMode: undefined,
    enabled: undefined,
    sortOrder: 0,
  });
});

test("asset-refs:create 校验实体归属项目——不属于则拒绝且不落库", async () => {
  let createCalls = 0;
  const service = createService({
    memberships: new Map([[actorId, "editor"]]),
    repository: {
      ...emptyRepository(),
      requireShotProjectAsset: async () => {
        throw new NotFoundError("项目资产不存在或不属于当前项目");
      },
      createShotAssetRef: async () => {
        createCalls += 1;
        return refRow();
      },
    },
  });

  await assert.rejects(
    service.createShotAssetRef(viewer, shotId, { assetEntityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    isAssetNotInProject,
  );
  assert.equal(createCalls, 0);
});

test("asset-refs:create 被 viewer 拒绝,不触达仓储", async () => {
  let createCalls = 0;
  const service = createService({
    memberships: new Map([[actorId, "viewer"]]),
    repository: {
      ...emptyRepository(),
      createShotAssetRef: async () => {
        createCalls += 1;
        return refRow();
      },
    },
  });

  await assert.rejects(
    service.createShotAssetRef(viewer, shotId, { assetEntityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    isProjectActionForbidden,
  );
  assert.equal(createCalls, 0);
});

test("asset-refs:update 引用必须属于该分镜——跨镜引用拒绝", async () => {
  const service = createService({
    memberships: new Map([[actorId, "editor"]]),
    repository: {
      ...emptyRepository(),
      getShotAssetRef: async () => refRow({ shotId: "77777777-7777-4777-8777-777777777777" }),
    },
  });

  await assert.rejects(
    service.updateShotAssetRef(viewer, shotId, "99999999-9999-4999-8999-999999999999", { enabled: false }),
    isRefNotFound,
  );
});

test("asset-refs:update 不接收 asset_entity_id(实体不可改),换媒体时校验仍属原实体", async () => {
  let updated: Array<{ id: string; input: unknown }> = [];
  let variantValidated = false;
  let mediaValidated = false;
  const service = createService({
    memberships: new Map([[actorId, "editor"]]),
    repository: {
      ...emptyRepository(),
      getShotAssetRef: async () => refRow(),
      requireShotProjectAsset: async (_projectId, _entityId, variantId, mediaId) => {
        if (variantId) variantValidated = true;
        if (mediaId) mediaValidated = true;
      },
      updateShotAssetRef: async (id, input) => {
        updated.push({ id, input });
        return refRow();
      },
    },
  });

  await service.updateShotAssetRef(viewer, shotId, "99999999-9999-4999-8999-999999999999", {
    assetVariantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    assetMediaId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    enabled: false,
  });
  assert.ok(variantValidated);
  assert.ok(mediaValidated);
  assert.deepEqual(updated[0]!.input, {
    assetVariantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    assetMediaId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    enabled: false,
  });
});

test("asset-refs:delete 软删除并记录操作者;跨镜引用拒绝;viewer 拒绝", async () => {
  let deletedUserId: string | undefined;
  let deleteCalls = 0;
  const service = createService({
    memberships: new Map([[actorId, "editor"]]),
    repository: {
      ...emptyRepository(),
      getShotAssetRef: async () => refRow(),
      softDeleteShotAssetRef: async (_id, userId) => {
        deletedUserId = userId;
        deleteCalls += 1;
      },
    },
  });

  await service.deleteShotAssetRef(viewer, shotId, "99999999-9999-4999-8999-999999999999");
  assert.equal(deletedUserId, actorId);
  assert.equal(deleteCalls, 1);

  const crossShot = createService({
    memberships: new Map([[actorId, "editor"]]),
    repository: {
      ...emptyRepository(),
      getShotAssetRef: async () => refRow({ shotId: "77777777-7777-4777-8777-777777777777" }),
    },
  });
  await assert.rejects(
    crossShot.deleteShotAssetRef(viewer, shotId, "99999999-9999-4999-8999-999999999999"),
    isRefNotFound,
  );

  const readOnly = createService({
    memberships: new Map([[actorId, "viewer"]]),
    repository: { ...emptyRepository(), getShotAssetRef: async () => refRow() },
  });
  await assert.rejects(
    readOnly.deleteShotAssetRef(viewer, shotId, "99999999-9999-4999-8999-999999999999"),
    isProjectActionForbidden,
  );
});

test("updateShot:metadata 合并式 PATCH——只覆盖出现的 lite.shot 键,保留其它命名空间", async () => {
  let captured: { metadata: unknown } | undefined;
  const service = createService({
    memberships: new Map([[actorId, "editor"]]),
    repository: {
      ...emptyRepository(),
      getShot: async () => ({
        shot: shot({ metadata: {
          other_namespace: { keep: true },
          lite: { shot: { atmosphere: "旧氛围", prompt_locked: true, other_key: "保留" } },
        } as unknown as ShotRow["metadata"] }),
        projectId,
        ownerUserId: ownerId,
      }),
      updateShot: async (_id, input) => {
        captured = { metadata: input.metadata };
        return shot();
      },
    },
  });

  await service.updateShot(viewer, shotId, { metadata: { lite: { shot: { atmosphere: "新氛围", dialogue_note: "新对白" } } } });

  assert.deepEqual(captured!.metadata, {
    other_namespace: { keep: true },
    lite: {
      shot: {
        atmosphere: "新氛围",
        dialogue_note: "新对白",
        prompt_locked: true,
        other_key: "保留",
      },
    },
  });
});
