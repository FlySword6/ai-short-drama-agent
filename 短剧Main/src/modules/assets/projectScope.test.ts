import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { defaultAssetClearance, type AssetEntityRow, type AssetMediaRow } from "../../db/schema.js";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessRecord } from "../project-access/types.js";
import type { AssetCatalogService } from "./catalog.js";
import { parseAssetListQuery, registerAssetRoutes } from "./routes.js";
import {
  ProjectAssetCatalogService,
  isProjectReferenceMediaAllowed,
  type ProjectAssetReferenceReaderPort,
  type ProjectAssetReferenceView,
  type ProjectAssetViewReaderPort,
} from "./projectScope.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const firstAssetId = "33333333-3333-4333-8333-333333333333";
const secondAssetId = "44444444-4444-4444-8444-444444444444";
const selectedMediaId = "55555555-5555-4555-8555-555555555555";
const oldPrimaryMediaId = "66666666-6666-4666-8666-666666666666";
const secondPrimaryMediaId = "77777777-7777-4777-8777-777777777777";
const dummyDb = {} as Database;

test("项目范围先复用项目引用权限，再返回当前资产和明确选择的媒体", async () => {
  const calls: string[] = [];
  const references: ProjectAssetReferenceReaderPort = {
    list: async (actualActorId, actualProjectId) => {
      calls.push(`references:${actualActorId}:${actualProjectId}`);
      return [
        reference("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", firstAssetId, selectedMediaId),
        reference("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", secondAssetId, null),
      ];
    },
  };
  const views: ProjectAssetViewReaderPort = {
    loadVisible: async (actualActorId, assetIds) => {
      calls.push(`views:${actualActorId}:${assetIds.join(",")}`);
      return {
        assets: [asset(firstAssetId, "女将军"), asset(secondAssetId, "宫殿")],
        mediaByAssetId: new Map([
          [firstAssetId, [
            media(oldPrimaryMediaId, firstAssetId, true, "旧主图"),
            media(selectedMediaId, firstAssetId, false, "项目锁定图"),
          ]],
          [secondAssetId, [media(secondPrimaryMediaId, secondAssetId, true, "宫殿主图")]],
        ]),
      };
    },
  };
  const service = new ProjectAssetCatalogService(dummyDb, { references, views });

  const items = await service.list(actorId, projectId);

  assert.equal(items.length, 2);
  assert.deepEqual(calls, [
    `references:${actorId}:${projectId}`,
    `views:${actorId}:${firstAssetId},${secondAssetId}`,
  ]);
  assert.equal(items[0]?.scope, "project");
  assert.equal(items[0]?.projectReferenceId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(items[0]?.selectedMediaId, selectedMediaId);
  assert.equal((items[0]?.selectedMedia as Record<string, unknown>).id, selectedMediaId);
  assert.equal((items[0]?.currentMedia as Record<string, unknown>).id, selectedMediaId);
  assert.notEqual(items[0]?.storageUrl, `https://storage.example/${selectedMediaId}.png`);
  if (typeof items[0]?.storageUrl === "string") {
    assert.match(items[0].storageUrl, /asset-renditions\/v1\//u);
    assert.doesNotMatch(items[0].storageUrl, /x-tos-process/u);
  }
  assert.equal(items[1]?.selectedMedia, null);
  assert.equal((items[1]?.currentMedia as Record<string, unknown>).id, secondPrimaryMediaId);
});

test("项目权限失败时不会读取资产详情", async () => {
  let viewCalls = 0;
  const service = new ProjectAssetCatalogService(dummyDb, {
    references: {
      list: async () => { throw new ForbiddenError("无权查看项目"); },
    },
    views: {
      loadVisible: async () => {
        viewCalls += 1;
        return { assets: [], mediaByAssetId: new Map() };
      },
    },
  });
  await assert.rejects(service.list(actorId, projectId), (error: unknown) => error instanceof ForbiddenError);
  assert.equal(viewCalls, 0);
});

test("项目范围沿用资产筛选并保持引用顺序", async () => {
  const service = new ProjectAssetCatalogService(dummyDb, {
    references: {
      list: async () => [
        reference("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", firstAssetId, null),
        reference("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", secondAssetId, null),
      ],
    },
    views: {
      loadVisible: async () => ({
        assets: [
          asset(firstAssetId, "女将军", { assetKind: "character", status: "approved", intro: "红甲" }),
          asset(secondAssetId, "宫殿", { assetKind: "scene", status: "pending_review" }),
        ],
        mediaByAssetId: new Map(),
      }),
    },
  });
  const items = await service.list(actorId, projectId, {
    assetKind: "character",
    status: "approved",
    query: "红甲",
  });
  assert.deepEqual(items.map((item) => item.id), [firstAssetId]);
});

test("已有项目引用也不能继续展示待审或驳回的通用资产", async () => {
  const service = new ProjectAssetCatalogService(dummyDb, {
    references: {
      list: async () => [
        reference("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", firstAssetId, null),
        reference("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", secondAssetId, null),
      ],
    },
    views: {
      loadVisible: async () => ({
        assets: [
          asset(firstAssetId, "已过审角色", {
            ownerUserId: null,
            visibility: "common",
            status: "approved",
          }),
          asset(secondAssetId, "待审角色", {
            ownerUserId: null,
            visibility: "common",
            status: "pending_review",
            approved: null,
          }),
        ],
        mediaByAssetId: new Map(),
      }),
    },
  });

  const items = await service.list(actorId, projectId);
  assert.deepEqual(items.map((item) => item.id), [firstAssetId]);
});

test("已授权项目引用允许成员读取他人的个人资产，但只把该能力传给项目范围读取", async () => {
  const calls: unknown[] = [];
  const service = new ProjectAssetCatalogService(dummyDb, {
    references: {
      list: async (_actorId, _projectId, scope) => {
        calls.push({ referenceScope: scope });
        return [reference("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", firstAssetId, selectedMediaId)];
      },
    },
    views: {
      loadVisible: async (_actorId, _assetIds, options) => {
        calls.push({
          viewOptions: {
            allowReferencedPersonalAssets: options?.allowReferencedPersonalAssets,
            hasReferenceLocks: options?.referenceLocksByAssetId?.get(firstAssetId)?.assetMediaId === selectedMediaId,
          },
        });
        return {
          assets: [asset(firstAssetId, "协作角色", { ownerUserId: "other-user", visibility: "personal" })],
          mediaByAssetId: new Map([[firstAssetId, [media(selectedMediaId, firstAssetId, true, "项目引用图")]]]),
        };
      },
    },
  });

  const items = await service.list(actorId, projectId, {}, projectId);

  assert.equal(items.length, 1);
  assert.deepEqual(calls, [
    { referenceScope: projectId },
    { viewOptions: { allowReferencedPersonalAssets: true, hasReferenceLocks: true } },
  ]);
});

test("协作成员只能看到项目引用锁定的个人资产媒体，不能借引用窥视同实体其他媒体", () => {
  const lock = { assetVariantId: null, assetMediaId: selectedMediaId };
  const selected = media(selectedMediaId, firstAssetId, false, "项目锁定图");
  const other = media(oldPrimaryMediaId, firstAssetId, true, "同实体其他图");
  assert.equal(isProjectReferenceMediaAllowed(lock, selected, new Map(), new Map(), firstAssetId), true);
  assert.equal(isProjectReferenceMediaAllowed(lock, other, new Map(), new Map(), firstAssetId), false);
  assert.equal(isProjectReferenceMediaAllowed(undefined, selected, new Map(), new Map(), firstAssetId), false);
});

test("项目媒体锁只放行同资产同活动变体的已审精确 3D preview", () => {
  const variantA = "88888888-8888-4888-8888-888888888888";
  const variantB = "99999999-9999-4999-8999-999999999999";
  const source = {
    ...media(selectedMediaId, firstAssetId, false, "3D 源"),
    assetEntityId: null,
    assetVariantId: variantA,
    mediaKind: "model_3d",
  } satisfies AssetMediaRow;
  const validPreview = {
    ...media(oldPrimaryMediaId, firstAssetId, true, "精确预览"),
    assetEntityId: null,
    assetVariantId: variantA,
    metadata: {
      role: "director_3d_preview",
      sourceMediaId: source.id,
      sourceSha256: source.sha256,
    },
  } satisfies AssetMediaRow;
  const crossVariantPreview = {
    ...validPreview,
    id: secondPrimaryMediaId,
    assetVariantId: variantB,
  } satisfies AssetMediaRow;
  const conflictingOwnerPreview = {
    ...validPreview,
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    assetEntityId: firstAssetId,
    assetVariantId: variantB,
  } satisfies AssetMediaRow;
  const unapprovedPreview = {
    ...validPreview,
    id: "bbbbbbbb-1111-4111-8111-111111111111",
    approved: false,
  } satisfies AssetMediaRow;
  const rows = new Map<string, AssetMediaRow>([
    [source.id, source],
    [validPreview.id, validPreview],
    [crossVariantPreview.id, crossVariantPreview],
    [conflictingOwnerPreview.id, conflictingOwnerPreview],
    [unapprovedPreview.id, unapprovedPreview],
  ]);
  const owners = new Map([
    [variantA, firstAssetId],
    [variantB, secondAssetId],
  ]);
  const variantLock = { assetVariantId: variantA, assetMediaId: source.id };

  assert.equal(
    isProjectReferenceMediaAllowed(variantLock, source, rows, owners, firstAssetId),
    true,
  );
  assert.equal(
    isProjectReferenceMediaAllowed(variantLock, validPreview, rows, owners, firstAssetId),
    true,
  );
  assert.equal(
    isProjectReferenceMediaAllowed(variantLock, crossVariantPreview, rows, owners, firstAssetId),
    false,
  );
  assert.equal(
    isProjectReferenceMediaAllowed(variantLock, conflictingOwnerPreview, rows, owners, firstAssetId),
    false,
  );
  assert.equal(
    isProjectReferenceMediaAllowed(variantLock, unapprovedPreview, rows, owners, firstAssetId),
    false,
  );
});

test("项目范围缺少项目时明确返回业务语言 400", () => {
  assert.throws(() => parseAssetListQuery({ scope: "project" }), (error: unknown) => (
    error instanceof BadRequestError
      && error.statusCode === 400
      && error.message === "查看项目资产没成：请先选择项目。"
  ));
  assert.deepEqual(parseAssetListQuery({ scope: "project", project_id: projectId }), {
    scope: "project",
    project_id: projectId,
    sort: "composite",
    page: 1,
    page_size: 500,
  });
  assert.deepEqual(parseAssetListQuery({ scope: "common", page: "3", page_size: "24" }), {
    scope: "common",
    sort: "composite",
    page: 3,
    page_size: 24,
  });
  assert.deepEqual(parseAssetListQuery({
    scope: "common",
    asset_kind: "character",
    tags: "雨夜, 写实,雨夜",
    media: "image",
    gender: "female",
    age_band: "adult",
    sort: "newest",
  }).tags, ["雨夜", "写实"]);
  assert.throws(
    () => parseAssetListQuery({ scope: "common", asset_kind: "scene", gender: "female" }),
    (error: unknown) => error instanceof BadRequestError && error.message.includes("仅适用于角色资产"),
  );
});

test("GET /assets 的 project 范围调用项目资产目录并保留列表合同", async () => {
  const app = Fastify({ logger: false });
  let received: { actorId: string; projectId: string; authorizedProjectId?: string } | undefined;
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
  });
  await registerAssetRoutes(app, () => dummyDb, {
    createProjectAssetCatalogService: () => ({
      list: async (actualActorId, actualProjectId, _filters, authorizedProjectId) => {
        received = { actorId: actualActorId, projectId: actualProjectId, authorizedProjectId };
        return [{ id: firstAssetId, scope: "project", selectedMedia: { id: selectedMediaId } }];
      },
    }),
    createProjectAccessService: () => new ProjectAccessService({
      findAccessRecord: async (): Promise<ProjectAccessRecord> => ({
        projectId,
        ownerUserId: actorId,
        membershipRole: "viewer",
      }),
    }),
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/assets?scope=project&project_id=${projectId}`,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(received, { actorId, projectId, authorizedProjectId: projectId });
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        items: [{ id: firstAssetId, scope: "project", selected_media: { id: selectedMediaId } }],
        count: 1,
      },
    });
  } finally {
    await app.close();
  }
});

test("GET /assets 的 common 范围映射 browse-v1 参数并强制普通用户只见已过审资产", async () => {
  const app = Fastify({ logger: false });
  let received: unknown;
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
  });
  await registerAssetRoutes(app, () => dummyDb, {
    createAssetCatalogService: () => ({
      listPage: async (actualActorId: string, filters: unknown, page: number, pageSize: number) => {
        received = { actorId: actualActorId, filters, page, pageSize };
        return {
          items: [{ id: firstAssetId, scope: "common" }],
          total: 961,
          filteredTotal: 77,
          page,
          pageSize,
          hasMore: true,
          kindCounts: { character: 77, prop: 301 },
        };
      },
    }) as unknown as AssetCatalogService,
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/assets?scope=common&q=${encodeURIComponent("雨夜")}`
        + `&asset_kind=character&tags=${encodeURIComponent("写实,电影感")}`
        + `&media=image&category=${encodeURIComponent("现代")}&source=${projectId}`
        + "&gender=female&age_band=adult&status=rejected&sort=newest&page=2&page_size=24",
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(received, {
      actorId,
      filters: {
        scope: "common",
        query: "雨夜",
        assetKind: "character",
        status: "approved",
        tags: ["写实", "电影感"],
        media: "image",
        category: "现代",
        sourceProjectId: projectId,
        gender: "female",
        ageBand: "adult",
        sort: "newest",
      },
      page: 2,
      pageSize: 24,
    });
    assert.deepEqual(response.json(), {
      ok: true,
      data: {
        items: [{ id: firstAssetId, scope: "common" }],
        count: 961,
        total: 961,
        filtered_count: 77,
        page: 2,
        page_size: 24,
        has_more: true,
        kind_counts: { character: 77, prop: 301 },
      },
    });
  } finally {
    await app.close();
  }
});

test("GET /assets 仅允许平台管理员使用通用库 status 筛选", async () => {
  const app = Fastify({ logger: false });
  let received: unknown;
  app.addHook("preHandler", async (request) => {
    request.authUser = {
      id: actorId,
      username: "admin",
      displayName: "平台管理员",
      role: "admin",
    };
  });
  await registerAssetRoutes(app, () => dummyDb, {
    createAssetCatalogService: () => ({
      listPage: async (_actorId: string, filters: unknown, page: number, pageSize: number) => {
        received = filters;
        return {
          items: [],
          total: 0,
          filteredTotal: 0,
          page,
          pageSize,
          hasMore: false,
          kindCounts: {},
        };
      },
    }) as unknown as AssetCatalogService,
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/assets?scope=common&status=pending_review&page_size=24",
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(received, {
      scope: "common",
      status: "pending_review",
      allowUnapprovedCommon: true,
      sort: "composite",
    });
  } finally {
    await app.close();
  }
});

test("GET /assets/:id 仅向管理员开放待审通用资产详情能力", async () => {
  for (const item of [
    { role: "member" as const, expected: false },
    { role: "admin" as const, expected: true },
  ]) {
    const app = Fastify({ logger: false });
    let received: unknown;
    app.addHook("preHandler", async (request) => {
      request.authUser = {
        id: actorId,
        username: item.role,
        displayName: item.role,
        role: item.role,
      };
    });
    await registerAssetRoutes(app, () => dummyDb, {
      createAssetCatalogService: () => ({
        get: async (actualActorId: string, actualAssetId: string, options: unknown) => {
          received = { actorId: actualActorId, assetId: actualAssetId, options };
          return { id: actualAssetId };
        },
      }) as unknown as AssetCatalogService,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/assets/${firstAssetId}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(received, {
        actorId,
        assetId: firstAssetId,
        options: { allowUnapprovedCommon: item.expected },
      });
    } finally {
      await app.close();
    }
  }
});

test("GET /assets?scope=project 与项目资产路由使用同一成员可见性口径", async () => {
  const cases = [
    { label: "viewer", actor: { id: "viewer", role: "member" as const }, membership: "viewer" as const, expected: 200 },
    { label: "nonmember", actor: { id: "nonmember", role: "member" as const }, membership: null, expected: 404 },
    { label: "operator", actor: { id: "operator", role: "operator" as const }, membership: null, expected: 200 },
  ];
  for (const item of cases) {
    const app = Fastify({ logger: false });
    let catalogCalls = 0;
    app.addHook("preHandler", async (request) => {
      request.authUser = { id: item.actor.id, username: item.actor.id, displayName: item.actor.id, role: item.actor.role };
    });
    await registerAssetRoutes(app, () => dummyDb, {
      createProjectAssetCatalogService: () => ({
        list: async () => {
          catalogCalls += 1;
          return [];
        },
      }),
      createProjectAccessService: () => new ProjectAccessService({
        findAccessRecord: async (): Promise<ProjectAccessRecord> => ({
          projectId,
          ownerUserId: actorId,
          membershipRole: item.membership,
        }),
      }),
    });
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/assets?scope=project&project_id=${projectId}` });
      assert.equal(response.statusCode, item.expected, item.label);
      assert.equal(catalogCalls, item.expected === 200 ? 1 : 0, item.label);
    } finally {
      await app.close();
    }
  }
});

function reference(id: string, assetEntityId: string, assetMediaId: string | null): ProjectAssetReferenceView {
  return {
    id,
    projectId,
    assetEntityId,
    assetVariantId: null,
    assetMediaId,
    versionSnapshot: {},
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
  };
}

function asset(
  id: string,
  name: string,
  overrides: Partial<AssetEntityRow> = {},
): AssetEntityRow {
  const now = new Date("2026-07-15T00:00:00.000Z");
  return {
    id,
    copiedFromAssetEntityId: null,
    sourceProjectId: null,
    sourceProjectName: null,
    ownerUserId: actorId,
    visibility: "personal",
    assetKind: "character",
    role: null,
    usageMode: null,
    name,
    displayName: null,
    intro: null,
    appearance: null,
    ageValue: null,
    gender: null,
    heightCm: null,
    hairDescription: null,
    outfitDescription: null,
    category: null,
    styleTags: [],
    approved: true,
    reuseScope: "all_projects",
    status: "approved",
    sourceFileUrl: null,
    metadata: {},
    clearance: { ...defaultAssetClearance },
    searchText: "",
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    deletedAt: null,
    deletedByUserId: null,
    ...overrides,
  };
}

function media(
  id: string,
  assetEntityId: string,
  isPrimary: boolean,
  title: string,
): AssetMediaRow {
  return {
    id,
    assetEntityId,
    assetVariantId: null,
    mediaKind: "image",
    viewAngle: "front",
    title,
    description: null,
    storageBucket: "test-bucket",
    storagePath: `assets/${id}.png`,
    storageUrl: `https://storage.example/${id}.png`,
    widthPx: 1024,
    heightPx: 1024,
    format: "png",
    sha256: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    isPrimary,
    approved: true,
    sortOrder: isPrimary ? 0 : 1,
    metadata: {},
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
    deletedAt: null,
    deletedByUserId: null,
  };
}

test("项目范围 assetKind 过滤经词表端口展开别名，缺省 identity 保持精确匹配", async () => {
  const references: ProjectAssetReferenceReaderPort = {
    list: async () => [
      reference("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", firstAssetId, null),
      reference("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", secondAssetId, null),
    ],
  };
  const views: ProjectAssetViewReaderPort = {
    loadVisible: async () => ({
      assets: [
        asset(firstAssetId, "戏服", { assetKind: "costume" }),
        asset(secondAssetId, "道具", { assetKind: "prop" }),
      ],
      mediaByAssetId: new Map(),
    }),
  };
  const calls: string[] = [];
  const service = new ProjectAssetCatalogService(dummyDb, {
    references,
    views,
    kinds: {
      async expandKinds(input: string) {
        calls.push(input);
        return input === "clothing" ? ["costume", "clothing"] : [input];
      },
    },
  });

  const listed = await service.list(actorId, projectId, { assetKind: "clothing" });

  assert.deepEqual(calls, ["clothing"]);
  assert.deepEqual(listed.map((row) => row.id), [firstAssetId]);

  const identityService = new ProjectAssetCatalogService(dummyDb, { references, views });
  const identityMiss = await identityService.list(actorId, projectId, { assetKind: "clothing" });
  assert.equal(identityMiss.length, 0);
  const identityHit = await identityService.list(actorId, projectId, { assetKind: "costume" });
  assert.deepEqual(identityHit.map((row) => row.id), [firstAssetId]);
});

test("项目范围 tag 过滤按规范词集合匹配，未注册标签短路为空且不查关联", async () => {
  const references: ProjectAssetReferenceReaderPort = {
    list: async () => [
      reference("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", firstAssetId, null),
      reference("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", secondAssetId, null),
    ],
  };
  const views: ProjectAssetViewReaderPort = {
    loadVisible: async () => ({
      assets: [asset(firstAssetId, "女将"), asset(secondAssetId, "宫殿")],
      mediaByAssetId: new Map(),
    }),
  };
  const linkCalls: string[][] = [];
  const service = new ProjectAssetCatalogService(dummyDb, {
    references,
    views,
    tags: {
      async resolveTagId(input: string) {
        return input === "rainy_night" ? "雨夜" : null;
      },
    },
    tagLinks: {
      async listTagIdsByAssetIds(assetIds: string[]) {
        linkCalls.push(assetIds);
        return new Map([[firstAssetId, new Set(["雨夜"])]]);
      },
    },
  });

  const listed = await service.list(actorId, projectId, { tag: "rainy_night" });

  assert.deepEqual(linkCalls, [[firstAssetId, secondAssetId]]);
  assert.deepEqual(listed.map((row) => row.id), [firstAssetId]);

  linkCalls.length = 0;
  const missed = await service.list(actorId, projectId, { tag: "未注册标签" });
  assert.equal(missed.length, 0);
  assert.deepEqual(linkCalls, []);
});

test("无 kind/tag 过滤时词表端口完全不被调用", async () => {
  let portCalls = 0;
  const service = new ProjectAssetCatalogService(dummyDb, {
    references: {
      list: async () => [reference("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", firstAssetId, null)],
    },
    views: {
      loadVisible: async () => ({
        assets: [asset(firstAssetId, "女将主角")],
        mediaByAssetId: new Map(),
      }),
    },
    kinds: {
      async expandKinds(input: string) {
        portCalls += 1;
        return [input];
      },
    },
    tags: {
      async resolveTagId(input: string) {
        portCalls += 1;
        return input;
      },
    },
    tagLinks: {
      async listTagIdsByAssetIds() {
        portCalls += 1;
        return new Map();
      },
    },
  });

  const listed = await service.list(actorId, projectId, { query: "女将" });

  assert.equal(listed.length, 1);
  assert.equal(portCalls, 0);
});
