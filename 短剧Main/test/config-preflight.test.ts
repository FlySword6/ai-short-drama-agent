/* 启动期数据库配置自检:缺变量点名拒绝启动;真实连库探测三类可运维区分
   (连不上主机 / 认证失败 / 库或 schema 不存在);任何输出不回显密码与连接串。
   自检只在 src/server.ts 引导里,不进 createApp——最后一条用例守住这个边界。 */
import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import {
  assertDatabaseConfigComplete,
  describeProbeFailure,
  findMissingDatabaseConfig,
  probeDatabaseConnection,
  type ProbeClientLike,
  type ProbePoolLike,
} from "../src/config/database-preflight.js";

test("配置完整性:DATABASE_URL 存在即视为完整", () => {
  const env = { DATABASE_URL: "postgres://user:pass@db.example.com:5432/shortdrama" };
  assert.deepEqual(findMissingDatabaseConfig(env), []);
  assert.doesNotThrow(() => assertDatabaseConfigComplete(env));
});

test("配置完整性:缺 POSTGRES_USER 时抛错并点名变量", () => {
  const env = { POSTGRES_HOST: "h", POSTGRES_DB: "d", POSTGRES_PASSWORD: "p" };
  assert.deepEqual(findMissingDatabaseConfig(env), ["POSTGRES_USER"]);
  assert.throws(() => assertDatabaseConfigComplete(env), /POSTGRES_USER/);
});

test("配置完整性:全缺时四个拼件全部点名", () => {
  assert.deepEqual(findMissingDatabaseConfig({}), [
    "POSTGRES_HOST",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
  ]);
  try {
    assertDatabaseConfigComplete({});
    assert.fail("应当抛错");
  } catch (error) {
    const message = (error as Error).message;
    for (const name of ["POSTGRES_HOST", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"]) {
      assert.ok(message.includes(name), `错误信息未点名 ${name}`);
    }
  }
});

test("配置完整性:空白字符串视为未设置", () => {
  assert.deepEqual(
    findMissingDatabaseConfig({ POSTGRES_HOST: "   ", POSTGRES_DB: "d", POSTGRES_USER: "u", POSTGRES_PASSWORD: "p" }),
    ["POSTGRES_HOST"],
  );
  assert.equal(findMissingDatabaseConfig({ DATABASE_URL: "   " }).length, 4);
});

test("配置完整性:DATABASE_URL 格式非法抛错,但不回显其值", () => {
  const illegalUrl = "postgres://user:Sup3rSecret@not a valid host";
  try {
    assertDatabaseConfigComplete({ DATABASE_URL: illegalUrl });
    assert.fail("应当抛错");
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /DATABASE_URL 格式非法/);
    assert.ok(!message.includes("Sup3rSecret"), "错误信息回显了密码");
    assert.ok(!message.includes(illegalUrl), "错误信息回显了连接串");
  }
});

/** 查询行为可配的 fake client;release 通过闭包计数。 */
function fakeClient(behavior: { queryError?: unknown; schemaExists?: boolean } = {}) {
  let released = false;
  const client: ProbeClientLike = {
    async query(text: string) {
      if (behavior.queryError) throw behavior.queryError;
      if (text.includes("pg_namespace")) return { rows: [{ exists: behavior.schemaExists ?? true }] };
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  return { client, wasReleased: () => released };
}

test("探测:连通且 schema 存在时通过,并释放连接", async () => {
  const { client, wasReleased } = fakeClient();
  const pool: ProbePoolLike = { connect: async () => client };
  const result = await probeDatabaseConnection(pool, { schemaName: "common" });
  assert.equal(result, null);
  assert.equal(wasReleased(), true);
});

test("探测:ECONNREFUSED 归类为连不上主机", async () => {
  const pool: ProbePoolLike = {
    connect: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" });
    },
  };
  const result = await probeDatabaseConnection(pool, { schemaName: "common" });
  assert.equal(result?.kind, "host_unreachable");
  assert.match(describeProbeFailure(result!), /无法连接数据库主机/);
});

test("探测:28P01 归类为认证失败", async () => {
  const pool: ProbePoolLike = {
    connect: async () => {
      throw Object.assign(new Error('password authentication failed for user "app"'), { code: "28P01" });
    },
  };
  const result = await probeDatabaseConnection(pool, { schemaName: "common" });
  assert.equal(result?.kind, "auth_failed");
  assert.match(describeProbeFailure(result!), /认证失败/);
});

test("探测:3D000 归类为库或 schema 不存在", async () => {
  const pool: ProbePoolLike = {
    connect: async () => {
      throw Object.assign(new Error('database "shortdrama" does not exist'), { code: "3D000" });
    },
  };
  const result = await probeDatabaseConnection(pool, { schemaName: "common" });
  assert.equal(result?.kind, "database_or_schema_missing");
});

test("探测:目标 schema 不存在归类为 database_or_schema_missing 并点名 schema", async () => {
  const { client } = fakeClient({ schemaExists: false });
  const pool: ProbePoolLike = { connect: async () => client };
  const result = await probeDatabaseConnection(pool, { schemaName: "missing_schema" });
  assert.equal(result?.kind, "database_or_schema_missing");
  assert.match(result?.detail ?? "", /missing_schema/);
});

test("探测:查询期错误同样归类,且连接被释放", async () => {
  const { client, wasReleased } = fakeClient({
    queryError: Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }),
  });
  const pool: ProbePoolLike = { connect: async () => client };
  const result = await probeDatabaseConnection(pool, { schemaName: "common" });
  assert.equal(result?.kind, "host_unreachable");
  assert.equal(wasReleased(), true);
});

test("探测:挂起的连接在超时后归类为 host_unreachable,不傻等默认超时", async () => {
  const pool: ProbePoolLike = { connect: () => new Promise<ProbeClientLike>(() => undefined) };
  const startedAt = Date.now();
  const result = await probeDatabaseConnection(pool, { schemaName: "common", timeoutMs: 20 });
  assert.equal(result?.kind, "host_unreachable");
  assert.match(result?.detail ?? "", /超时/);
  assert.ok(Date.now() - startedAt < 1_000, "应当按传入的 timeoutMs 快速失败");
});

test("边界:createApp 不带数据库句柄也能构造(自检只在 server.ts 引导里)", async () => {
  const app = await createApp({ logger: false, startGenerationWorker: false });
  await app.close();
});
