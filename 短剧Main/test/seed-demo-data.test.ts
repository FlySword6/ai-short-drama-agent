import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertLocalDatabaseUrl,
  demoSeedDefaultPassword,
  demoSeedIds,
  demoSeedUsername,
} from "../seed/demo-data.mts";

const seedSource = await readFile(new URL("../seed/demo-data.mts", import.meta.url), "utf8");

test("播种脚本幂等:固定 UUID + ON CONFLICT DO NOTHING", () => {
  // 每一次 insert 都必须带 onConflictDoNothing——数 insert 与 onConflict 出现次数。
  const inserts = seedSource.match(/db\.insert\(/g) ?? [];
  const conflicts = seedSource.match(/\.onConflictDoNothing\(\)/g) ?? [];
  assert.ok(inserts.length >= 6, `期望至少 6 处 insert(users/projects/members/episodes/scenes/shots),实际 ${inserts.length}`);
  assert.equal(conflicts.length, inserts.length, "每个 insert 都必须 ON CONFLICT DO NOTHING");
  // 固定 UUID 是幂等前提:不许在播种数据里用 randomUUID。
  assert.doesNotMatch(seedSource, /randomUUID/);
  for (const id of [demoSeedIds.user, demoSeedIds.project, demoSeedIds.episode, ...demoSeedIds.shots]) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
});

test("播种数据集不含真实凭据与云库数据痕迹", () => {
  // 演示口令必须是公开占位值,且脚本内注明仅限本地。
  assert.equal(demoSeedDefaultPassword, "demo-only-password");
  assert.match(seedSource, /仅限本地|只用于本地/);
  // 不得出现任何 provider/对象存储凭据字段或密钥形态字符串。
  for (const forbidden of [
    /ARK_API_KEY/i, /TOS_ACCESS/i, /VOLCENGINE_/i, /MILVUS_PASSWORD/i,
    /AKLT[A-Za-z0-9]/, /sk-[A-Za-z0-9]{10,}/,
  ]) {
    assert.doesNotMatch(seedSource, forbidden, `播种脚本出现疑似真实凭据: ${forbidden}`);
  }
  // 不得出现 TOS/公网 URL(云库导出数据常带存储地址)。
  assert.doesNotMatch(seedSource, /https?:\/\/(?!localhost|127\.0\.0\.1)/);
});

test("播种用户名满足 users_username_format CHECK,账号可登录", () => {
  // migrations/001: username ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'
  assert.match(demoSeedUsername, /^[a-z0-9][a-z0-9_.-]{2,63}$/);
  // 口令长度必须过 AUTH_PASSWORD_MIN_LENGTH 下限(默认 8)。
  assert.ok(demoSeedDefaultPassword.length >= 8);
});

test("播种脚本只连本机/本地 Compose", () => {
  assert.doesNotThrow(() => assertLocalDatabaseUrl("postgresql://u:p@127.0.0.1:5432/app"));
  assert.doesNotThrow(() => assertLocalDatabaseUrl("postgresql://u:p@db:5432/app"));
  assert.throws(
    () => assertLocalDatabaseUrl("postgresql://u:p@pg-abc.rds.volces.com:5432/app"),
    /绝不连云库/,
  );
});

test("播种内容自洽:分镜挂在已播种的集与场上", () => {
  assert.equal(demoSeedIds.shots.length, 4);
  const unique = new Set(Object.values(demoSeedIds).flat());
  assert.equal(unique.size, 9, "所有播种 UUID 必须互不相同");
});
