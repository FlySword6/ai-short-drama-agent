import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerVocabularyRoutes } from "./routes.js";
import {
  AssetKindVocabularyService,
  TagVocabularyService,
  expandKindAliases,
  resolveTagCanonical,
} from "./service.js";
import type {
  AssetKindEntry,
  AssetKindVocabularyRepository,
  AssetTagRepository,
  TagEntry,
  TagVocabularyRepository,
} from "./types.js";

/* ---------------- 内存 fake:与 Drizzle 实现同一份接口语义 ---------------- */

function createTagStore(initial: TagEntry[] = []) {
  const tags = new Map(initial.map((tag) => [tag.id, tag]));
  const links = new Map<string, Set<string>>();
  const repo: TagVocabularyRepository & AssetTagRepository = {
    async listTags() { return [...tags.values()]; },
    async findTag(id) { return tags.get(id) ?? null; },
    async createTag(input) {
      if (tags.has(input.id)) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      const entry: TagEntry = {
        id: input.id,
        canonicalId: input.canonicalId,
        domain: input.domain ?? "general",
        displayName: input.displayName ?? input.id,
        sort: input.sort ?? 0,
        active: true,
      };
      tags.set(entry.id, entry);
      return entry;
    },
    async listByAsset(assetEntityId) {
      const ids = links.get(assetEntityId) ?? new Set<string>();
      return [...ids].map((id) => tags.get(id)).filter((tag): tag is TagEntry => Boolean(tag));
    },
    async attach({ assetEntityId, tagId }) {
      const set = links.get(assetEntityId) ?? new Set<string>();
      if (set.has(tagId)) return false;
      set.add(tagId);
      links.set(assetEntityId, set);
      return true;
    },
    async detach(assetEntityId, tagId) { links.get(assetEntityId)?.delete(tagId); },
    async listTagIdsByAssetIds(ids) {
      const out = new Map<string, Set<string>>();
      for (const id of ids) {
        const set = links.get(id);
        if (set) out.set(id, new Set(set));
      }
      return out;
    },
  };
  return { repo, tags, links };
}

function createKindStore(initial: AssetKindEntry[] = []) {
  const kinds = new Map(initial.map((kind) => [kind.id, kind]));
  const repo: AssetKindVocabularyRepository = {
    async listAssetKinds() { return [...kinds.values()]; },
    async findAssetKind(id) { return kinds.get(id) ?? null; },
    async createAssetKind(input) {
      if (kinds.has(input.id)) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      const entry: AssetKindEntry = {
        id: input.id,
        canonicalId: input.canonicalId,
        displayName: input.displayName ?? input.id,
        sort: input.sort ?? 0,
        active: true,
      };
      kinds.set(entry.id, entry);
      return entry;
    },
  };
  return { repo, kinds };
}

const costumeKind: AssetKindEntry = { id: "costume", canonicalId: "costume", displayName: "服装", sort: 4, active: true };
const clothingAlias: AssetKindEntry = { id: "clothing", canonicalId: "costume", displayName: "服装", sort: 101, active: true };
const characterKind: AssetKindEntry = { id: "character", canonicalId: "character", displayName: "角色", sort: 1, active: true };

const rainTag: TagEntry = { id: "雨夜", canonicalId: "雨夜", domain: "mood", displayName: "雨夜", sort: 1, active: true };
const rainyAlias: TagEntry = { id: "rainy_night", canonicalId: "雨夜", domain: "mood", displayName: "雨夜", sort: 101, active: true };

/* ---------------- 解析纯函数:自指 canonical 的读侧语义 ---------------- */

test("expandKindAliases:别名输入展开为规范词+全部同族活跃词条", () => {
  const entries = [characterKind, costumeKind, clothingAlias];
  assert.deepEqual(expandKindAliases(entries, "clothing").sort(), ["clothing", "costume"]);
  assert.deepEqual(expandKindAliases(entries, "costume").sort(), ["clothing", "costume"]);
  assert.deepEqual(expandKindAliases(entries, "character"), ["character"]);
});

test("expandKindAliases:未收录输入原样返回(开放词表,精确匹配仍有效)", () => {
  assert.deepEqual(expandKindAliases([characterKind], "storyboard"), ["storyboard"]);
  assert.deepEqual(expandKindAliases([], "storyboard"), ["storyboard"]);
});

test("expandKindAliases:停用词条不参与展开", () => {
  const inactiveAlias = { ...clothingAlias, active: false };
  assert.deepEqual(expandKindAliases([costumeKind, inactiveAlias], "costume"), ["costume"]);
  // 输入本身是停用词条:按未收录处理,原样精确匹配。
  assert.deepEqual(expandKindAliases([costumeKind, inactiveAlias], "clothing"), ["clothing"]);
});

test("resolveTagCanonical:别名一跳到规范词;未注册或停用为 null", () => {
  const entries = [rainTag, rainyAlias, { ...rainTag, id: "废稿", canonicalId: "废稿", active: false }];
  assert.equal(resolveTagCanonical(entries, "rainy_night"), "雨夜");
  assert.equal(resolveTagCanonical(entries, "雨夜"), "雨夜");
  assert.equal(resolveTagCanonical(entries, "不存在"), null);
  assert.equal(resolveTagCanonical(entries, "废稿"), null);
});

/* ---------------- 服务层:ensure/别名校验/打标幂等 ---------------- */

test("ensureTag 只建规范词(canonical 自指),重复 ensure 幂等", async () => {
  const { repo } = createTagStore();
  const service = new TagVocabularyService(repo, repo);

  const first = await service.ensureTag("雨夜", { domain: "mood" });
  assert.equal(first.created, true);
  assert.equal(first.entry.canonicalId, "雨夜");
  assert.equal(first.entry.displayName, "雨夜", "display_name 缺省 = id");
  assert.equal(first.entry.domain, "mood");

  const again = await service.ensureTag("雨夜");
  assert.equal(again.created, false);
  assert.equal(again.entry.id, "雨夜");
});

test("createTag 别名一跳校验:目标缺失 400、目标是别名(多级链)400、重复 id 409", async () => {
  const { repo } = createTagStore([rainTag, rainyAlias]);
  const service = new TagVocabularyService(repo, repo);

  await assert.rejects(
    service.createTag({ id: "rainy", canonicalId: "不存在" }),
    /别名要对应一个已登记的标准名称/,
  );
  await assert.rejects(
    service.createTag({ id: "rainy", canonicalId: "rainy_night" }),
    /别名不能再指向别名/,
  );
  await assert.rejects(
    service.createTag({ id: "雨夜", canonicalId: "雨夜" }),
    /词条已存在/,
  );

  const created = await service.createTag({ id: "暴雨", canonicalId: "雨夜", displayName: "暴雨" });
  assert.equal(created.canonicalId, "雨夜");
  assert.equal(created.domain, "general", "domain 缺省 general");
});

test("attachTag:别名一跳落规范词 id,重复打标幂等;未注册 404;detach 幂等", async () => {
  const { repo, links } = createTagStore([rainTag, rainyAlias]);
  const service = new TagVocabularyService(repo, repo);
  const assetId = "asset-1";

  await assert.rejects(service.attachTag(assetId, "不存在"), /标签未注册/);

  const attached = await service.attachTag(assetId, "rainy_night");
  assert.equal(attached.created, true);
  assert.equal(attached.tag.id, "雨夜", "返回的恒为规范词");
  assert.deepEqual([...(links.get(assetId) ?? [])], ["雨夜"], "落库恒为规范词 id");

  const again = await service.attachTag(assetId, "雨夜");
  assert.equal(again.created, false, "重复打标幂等");
  assert.equal((await service.listAssetTags(assetId)).length, 1);

  await service.detachTag(assetId, "rainy_night");
  assert.equal((await service.listAssetTags(assetId)).length, 0, "别名摘标同样一跳解析");
  await service.detachTag(assetId, "不存在"); // 未注册标签摘标不报错(幂等)
});

/* ---------------- 路由层:HTTP 契约 + 权限矩阵 ---------------- */

async function testApp(options: {
  role?: string;
  tagStore?: ReturnType<typeof createTagStore>;
  kindStore?: ReturnType<typeof createKindStore>;
} = {}) {
  const app = Fastify({ logger: false });
  if (options.role) {
    const role = options.role;
    app.addHook("preHandler", async (request) => {
      request.authUser = {
        id: "user-id",
        username: "producer",
        displayName: "制作人",
        ...(role === "admin" ? { role: "admin" as const } : {}),
      };
    });
  }
  await registerVocabularyRoutes(app, () => ({}) as never, {
    createTagRepository: () => (options.tagStore ?? createTagStore([rainTag, rainyAlias])).repo,
    createAssetKindRepository: () => (options.kindStore ?? createKindStore([characterKind, costumeKind, clothingAlias])).repo,
  });
  return app;
}

test("登录可读标签/资产类型词表,响应 snake_case 且带 canonical_id", async () => {
  const app = await testApp({ role: "member" });
  try {
    const tags = await app.inject({ method: "GET", url: "/api/v1/vocabulary/tags" });
    assert.equal(tags.statusCode, 200, tags.body);
    assert.deepEqual(tags.json().data.tags, [
      { id: "雨夜", canonical_id: "雨夜", domain: "mood", display_name: "雨夜", sort: 1, active: true },
      { id: "rainy_night", canonical_id: "雨夜", domain: "mood", display_name: "雨夜", sort: 101, active: true },
    ]);

    const kinds = await app.inject({ method: "GET", url: "/api/v1/vocabulary/asset-kinds" });
    assert.equal(kinds.statusCode, 200, kinds.body);
    const clothing = kinds.json().data.kinds.find((kind: { id: string }) => kind.id === "clothing");
    assert.equal(clothing.canonical_id, "costume");
  } finally {
    await app.close();
  }
});

test("未登录读标签/资产类型词表返回 401", async () => {
  const app = await testApp();
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/vocabulary/tags" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/vocabulary/asset-kinds" })).statusCode, 401);
  } finally {
    await app.close();
  }
});

test("登录成员可 ensure 规范词:新词 201,重复 200;不能 ensure 出别名", async () => {
  const store = createTagStore();
  const app = await testApp({ role: "member", tagStore: store });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/vocabulary/tags",
      payload: { id: "雨夜", domain: "mood" },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().data.created, true);
    assert.equal(created.json().data.entry.canonical_id, "雨夜", "ensure 只能建自指规范词");
    assert.equal(created.json().data.entry.display_name, "雨夜");

    const again = await app.inject({ method: "POST", url: "/api/v1/vocabulary/tags", payload: { id: "雨夜" } });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().data.created, false);
    assert.equal(store.tags.size, 1, "重复 ensure 不长新词");
  } finally {
    await app.close();
  }
});

test("管理员建别名 201;多级链 400;重复 409;普通成员 403", async () => {
  const store = createTagStore([rainTag]);
  const admin = await testApp({ role: "admin", tagStore: store });
  const member = await testApp({ role: "member", tagStore: store });
  try {
    const alias = await admin.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/tags",
      payload: { id: "rainy_night", canonical_id: "雨夜", display_name: "雨夜(英)" },
    });
    assert.equal(alias.statusCode, 201, alias.body);
    assert.equal(alias.json().data.entry.canonical_id, "雨夜");

    assert.equal((await admin.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/tags",
      payload: { id: "rainy", canonical_id: "rainy_night" },
    })).statusCode, 400, "目标是别名必须 400(不做多级链)");

    const dup = await admin.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/tags",
      payload: { id: "雨夜" },
    });
    assert.equal(dup.statusCode, 409);
    assert.match(dup.body, /词条已存在/);

    assert.equal((await member.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/tags",
      payload: { id: "暴雨" },
    })).statusCode, 403);
  } finally {
    await admin.close();
    await member.close();
  }
});

test("管理员登记资产类型:新规范词自指,别名指向规范词", async () => {
  const store = createKindStore([costumeKind]);
  const app = await testApp({ role: "admin", kindStore: store });
  try {
    const canonical = await app.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/asset-kinds",
      payload: { id: "storyboard", display_name: "分镜表" },
    });
    assert.equal(canonical.statusCode, 201, canonical.body);
    assert.equal(canonical.json().data.entry.canonical_id, "storyboard");

    const alias = await app.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/asset-kinds",
      payload: { id: "clothing", canonical_id: "costume" },
    });
    assert.equal(alias.statusCode, 201, alias.body);
    assert.equal(alias.json().data.entry.canonical_id, "costume");

    assert.equal((await app.inject({
      method: "POST",
      url: "/api/v1/admin/vocabulary/asset-kinds",
      payload: { id: "x", canonical_id: "clothing" },
    })).statusCode, 400, "别名套别名必须 400");
  } finally {
    await app.close();
  }
});

test("AssetKindVocabularyService.expandKinds 经词表展开别名", async () => {
  const { repo } = createKindStore([characterKind, costumeKind, clothingAlias]);
  const service = new AssetKindVocabularyService(repo);
  assert.deepEqual((await service.expandKinds("clothing")).sort(), ["clothing", "costume"]);
  assert.deepEqual(await service.expandKinds("storyboard"), ["storyboard"], "未收录值原样精确匹配");
});
