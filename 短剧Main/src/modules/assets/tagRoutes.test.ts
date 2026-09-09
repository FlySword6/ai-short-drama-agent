import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { TagVocabularyService } from "../vocabulary/service.js";
import type {
  AssetTagRepository,
  TagEntry,
  TagVocabularyRepository,
} from "../vocabulary/types.js";
import { registerAssetTagRoutes } from "./tagRoutes.js";
import type { AssetAccessRecord } from "./access.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "99999999-9999-4999-8999-999999999999";
const ownAssetId = "33333333-3333-4333-8333-333333333333";
const commonAssetId = "44444444-4444-4444-8444-444444444444";
const foreignAssetId = "55555555-5555-4555-8555-555555555555";
const missingAssetId = "66666666-6666-4666-8666-666666666666";
const dummyDb = {} as Database;

const rainTag: TagEntry = { id: "雨夜", canonicalId: "雨夜", domain: "mood", displayName: "雨夜", sort: 1, active: true };
const rainyAlias: TagEntry = { id: "rainy_night", canonicalId: "雨夜", domain: "mood", displayName: "雨夜", sort: 101, active: true };

/* 与 vocabulary 模块测试同款的内存实现:接口语义一致,只是这里只需要标签一侧。 */
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
  return { repo, links };
}

const assetAccess: Record<string, AssetAccessRecord> = {
  [ownAssetId]: {
    id: ownAssetId, ownerUserId: actorId, visibility: "personal", status: "approved", deletedAt: null,
  },
  [commonAssetId]: {
    id: commonAssetId, ownerUserId: null, visibility: "common", status: "approved", deletedAt: null,
  },
  [foreignAssetId]: {
    id: foreignAssetId, ownerUserId: otherUserId, visibility: "personal", status: "approved", deletedAt: null,
  },
};

async function testApp(options: { authenticated?: boolean; store?: ReturnType<typeof createTagStore> } = {}) {
  const app = Fastify({ logger: false });
  if (options.authenticated !== false) {
    app.addHook("preHandler", async (request) => {
      request.authUser = { id: actorId, username: "tester", displayName: "测试用户" };
    });
  }
  const store = options.store ?? createTagStore([rainTag, rainyAlias]);
  await registerAssetTagRoutes(app, () => dummyDb, {
    createTagService: () => new TagVocabularyService(store.repo, store.repo),
    loadAssetAccess: async (_db, assetId) => assetAccess[assetId] ?? null,
  });
  return { app, store };
}

test("资产标签路由权限矩阵:缺失 404、他人个人资产 403、通用资产可读但不可写、未登录 401", async () => {
  const { app } = await testApp();
  const anonymous = await testApp({ authenticated: false });
  try {
    const missing = await app.inject({ method: "GET", url: `/api/v1/assets/${missingAssetId}/tags` });
    assert.equal(missing.statusCode, 404, missing.body);
    assert.match(missing.body, /资产不存在/);

    const foreign = await app.inject({ method: "GET", url: `/api/v1/assets/${foreignAssetId}/tags` });
    assert.equal(foreign.statusCode, 403, foreign.body);

    const commonRead = await app.inject({ method: "GET", url: `/api/v1/assets/${commonAssetId}/tags` });
    assert.equal(commonRead.statusCode, 200, commonRead.body);
    assert.deepEqual(commonRead.json().data, { items: [], count: 0 });

    const writeCommon = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${commonAssetId}/tags`,
      payload: { tag_id: "雨夜" },
    });
    assert.equal(writeCommon.statusCode, 403, writeCommon.body);
    assert.match(writeCommon.body, /通用资产为只读/);

    const writeForeign = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${foreignAssetId}/tags`,
      payload: { tag_id: "雨夜" },
    });
    assert.equal(writeForeign.statusCode, 403, writeForeign.body);

    assert.equal(
      (await anonymous.app.inject({ method: "GET", url: `/api/v1/assets/${ownAssetId}/tags` })).statusCode,
      401,
    );
  } finally {
    await app.close();
    await anonymous.app.close();
  }
});

test("打标:别名一跳落规范词 201,重复 200,未注册 404,读回 snake_case", async () => {
  const { app, store } = await testApp();
  try {
    const unregistered = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${ownAssetId}/tags`,
      payload: { tag_id: "不存在的标签" },
    });
    assert.equal(unregistered.statusCode, 404, unregistered.body);
    assert.match(unregistered.body, /标签未注册/);

    const attached = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${ownAssetId}/tags`,
      payload: { tag_id: "rainy_night" },
    });
    assert.equal(attached.statusCode, 201, attached.body);
    assert.equal(attached.json().data.created, true);
    assert.equal(attached.json().data.tag.id, "雨夜", "别名打标返回的恒为规范词");
    assert.equal(attached.json().data.tag.canonical_id, "雨夜");
    assert.deepEqual([...(store.links.get(ownAssetId) ?? [])], ["雨夜"], "落库恒为规范词 id");

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/assets/${ownAssetId}/tags`,
      payload: { tag_id: "雨夜" },
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().data.created, false, "重复打标幂等");

    const listed = await app.inject({ method: "GET", url: `/api/v1/assets/${ownAssetId}/tags` });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().data.count, 1);
    assert.deepEqual(listed.json().data.items, [
      { id: "雨夜", canonical_id: "雨夜", domain: "mood", display_name: "雨夜", sort: 1, active: true },
    ]);
  } finally {
    await app.close();
  }
});

test("摘标:别名一跳解析,未注册幂等,他人资产 403", async () => {
  const store = createTagStore([rainTag, rainyAlias]);
  const { app } = await testApp({ store });
  try {
    await app.inject({
      method: "POST",
      url: `/api/v1/assets/${ownAssetId}/tags`,
      payload: { tag_id: "雨夜" },
    });

    const detached = await app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${ownAssetId}/tags/rainy_night`,
    });
    assert.equal(detached.statusCode, 200, detached.body);
    assert.deepEqual(detached.json().data, { deleted: true });
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/assets/${ownAssetId}/tags` })).json().data.count, 0);

    const idempotent = await app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${ownAssetId}/tags/未注册标签`,
    });
    assert.equal(idempotent.statusCode, 200, "未注册标签摘标幂等");

    const foreign = await app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${foreignAssetId}/tags/雨夜`,
    });
    assert.equal(foreign.statusCode, 403, foreign.body);
  } finally {
    await app.close();
  }
});
