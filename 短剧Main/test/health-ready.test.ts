/* 就绪探针三段校验(连通 → schema 存在 → 迁移版本追平代码)与 404 信封。
   全部回归走整应用 createApp——裸 Fastify 模块级测试曾绕开鉴权 hook,
   让「/ready 挂在鉴权后返回 401」的事故漏网,这是教训,不是风格偏好。 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { createApp, type AppOptions } from "../src/app.js";
import { UNKNOWN_COMMIT_SHA, commitShaSchema, settings } from "../src/config/env.js";
import type { Database } from "../src/db/client.js";
import { resolveExpectedMigration } from "../src/modules/health/readiness.js";

const dialect = new PgDialect();
const migrationsDirectory = path.resolve("migrations");

interface ReadinessFakeBehavior {
  /** select 1 抛出的错误(连通性失败场景)。 */
  connectivityError?: unknown;
  /** pg_namespace 的 exists 结果,默认 true。 */
  schemaExists?: boolean;
  /** schema_migrations.max(version) 结果,默认取 migrations/ 目录推导的最高版本。 */
  maxMigrationVersion?: string | null;
  /** schema_migrations 查询本身抛出的错误(如 42P01 表不存在)。 */
  migrationQueryError?: unknown;
}

/** 按 SQL 文本分派的 fake db:与 checkReadiness 的三段查询一一对应。 */
function fakeReadinessDatabase(behavior: ReadinessFakeBehavior = {}): Database {
  const expected = resolveExpectedMigration(migrationsDirectory);
  return {
    execute: async (query: SQL) => {
      const text = dialect.sqlToQuery(query).sql;
      if (text === "select 1") {
        if (behavior.connectivityError) throw behavior.connectivityError;
        return { rows: [{ "?column?": 1 }] };
      }
      if (text.includes("pg_namespace")) {
        return { rows: [{ exists: behavior.schemaExists ?? true }] };
      }
      if (text.includes("schema_migrations")) {
        if (behavior.migrationQueryError) throw behavior.migrationQueryError;
        return { rows: [{ max_version: behavior.maxMigrationVersion ?? expected?.fileName ?? null }] };
      }
      throw new Error(`fake db 收到未预期的查询: ${text}`);
    },
  } as unknown as Database;
}

function appWithDatabase(db: Database, options: Partial<AppOptions> = {}) {
  return createApp({
    logger: false,
    startGenerationWorker: false,
    databaseHandle: { db, pool: {} as unknown as Pool },
    ...options,
  });
}

test("ready:三段校验全过返回 200(期望版本从 migrations/ 推导,不硬编码)", async () => {
  const expected = resolveExpectedMigration(migrationsDirectory);
  assert.ok(expected, "migrations/ 目录应能推导出期望迁移版本");
  const app = await appWithDatabase(fakeReadinessDatabase());
  const res = await app.inject({ method: "GET", url: "/api/v1/ready" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.status, "ready");
  await app.close();
});

test("ready:迁移落后代码期望版本返回 503,给出双方版本号", async () => {
  const expected = resolveExpectedMigration(migrationsDirectory);
  assert.ok(expected);
  const app = await appWithDatabase(fakeReadinessDatabase({ maxMigrationVersion: "013_control_packages.sql" }));
  const res = await app.inject({ method: "GET", url: "/api/v1/ready" });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "not_ready");
  assert.equal(body.error.message, "服务尚未就绪：数据库版本落后，请联系管理员完成升级。");
  assert.equal(body.error.retryable, true);
  assert.deepEqual(body.error.details, {
    reason: "migration_behind",
    schema: settings.postgresSchema,
    db_version: "013",
    expected: expected.version,
  });
  await app.close();
});

test("ready:目标 schema 不存在返回 503 schema_missing", async () => {
  const app = await appWithDatabase(fakeReadinessDatabase({ schemaExists: false }));
  const res = await app.inject({ method: "GET", url: "/api/v1/ready" });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.deepEqual(body.error.details, { reason: "schema_missing", schema: settings.postgresSchema });
  await app.close();
});

test("ready:schema 已建但从未执行迁移(42P01)返回 503 migrations_not_applied", async () => {
  const expected = resolveExpectedMigration(migrationsDirectory);
  assert.ok(expected);
  const undefinedTable = Object.assign(new Error('relation "fixture_schema.schema_migrations" does not exist'), { code: "42P01" });
  const app = await appWithDatabase(fakeReadinessDatabase({ migrationQueryError: undefinedTable }));
  const res = await app.inject({ method: "GET", url: "/api/v1/ready" });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.deepEqual(body.error.details, {
    reason: "migrations_not_applied",
    schema: settings.postgresSchema,
    expected: expected.version,
  });
  await app.close();
});

test("ready:库连不上返回 503 db_unreachable,响应体不泄露主机名与用户名", async () => {
  const leakedHost = "db.internal.example.com";
  const leakedUser = "shortdrama_test";
  const connectivityError = Object.assign(
    new Error(`connect ECONNREFUSED ${leakedHost}:5432 user=${leakedUser}`),
    { code: "ECONNREFUSED" },
  );
  const app = await appWithDatabase(fakeReadinessDatabase({ connectivityError }));
  const res = await app.inject({ method: "GET", url: "/api/v1/ready" });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.error.code, "not_ready");
  assert.equal(body.error.message, "服务尚未就绪：数据库暂时不可用，请稍后重试。");
  assert.deepEqual(body.error.details, { reason: "db_unreachable", schema: settings.postgresSchema });
  assert.ok(!res.body.includes(leakedHost), "响应体泄露了数据库主机名");
  assert.ok(!res.body.includes(leakedUser), "响应体泄露了数据库用户名");
  await app.close();
});

test("ready/health:health 恒 200 不触库;库炸时 ready 是 503 而非 401", async () => {
  const app = await appWithDatabase(fakeReadinessDatabase({ connectivityError: new Error("conn refused") }));
  // health 与 DB 状态无关:LB 探针绿≠服务可用,验收看 /ready。
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode, 200);
  const ready = await app.inject({ method: "GET", url: "/api/v1/ready" });
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json().error.code, "not_ready");
  await app.close();
});

/* ---- 制品身份:health 自报 commit sha ----
   2026-07-28 环境版本审计的直接回归:镜像不自报提交,只能靠前端中文文案 +
   migrations 最新编号反推,最后仍只定位到 9~18 个提交的窗口。 */

test("health:带 sha 字段;未注入构建参数时是 unknown 而不是空串或缺字段", async () => {
  const app = await appWithDatabase(fakeReadinessDatabase());
  const res = await app.inject({ method: "GET", url: "/api/v1/health" });
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(typeof data.sha, "string", "sha 必须存在且是字符串");
  assert.ok(data.sha.length > 0, "sha 不得是空串——查不到要显式说 unknown");
  // 测试环境不注入 APP_COMMIT_SHA,此处必然是兜底值;这条同时锁住"降级不静默"。
  assert.equal(data.sha, UNKNOWN_COMMIT_SHA);
  assert.equal(data.sha, settings.appCommitSha);
  await app.close();
});

// 红线护栏:本端点未鉴权公开,键集合封闭,新增任何环境信息都要先撞这条断言。
test("health:响应键集合封闭,只有制品身份不含运行环境信息", async () => {
  const app = await appWithDatabase(fakeReadinessDatabase());
  const res = await app.inject({ method: "GET", url: "/api/v1/health" });
  assert.deepEqual(
    Object.keys(res.json().data).sort(),
    ["app_name", "sha", "status", "version"],
    "公开端点的字段集变了:主机名/用户名/连接串/分支名一律不得进入这里",
  );
  await app.close();
});

test("commit sha 格式白名单:收 hex,拒分支名与镜像 tag", () => {
  const fullSha = "c28feea8a35ad9299fe811568cd91a95713e1e5c";
  assert.equal(commitShaSchema.parse(fullSha), fullSha);
  assert.equal(commitShaSchema.parse("c28feea"), "c28feea", "本地 short sha 也要收");
  // 未注入的三种形态都归一到同一个兜底值,不让空串漏到公开端点。
  assert.equal(commitShaSchema.parse(undefined), UNKNOWN_COMMIT_SHA);
  assert.equal(commitShaSchema.parse(""), UNKNOWN_COMMIT_SHA);
  assert.equal(commitShaSchema.parse("  "), UNKNOWN_COMMIT_SHA);

  // 构建参数传错时要在启动期崩掉,而不是把这些值送到未鉴权的公开端点上。
  for (const invalid of [
    "integration/v011",
    "v0.1.2-c28feea8a35ad9299fe811568cd91a95713e1e5c",
    "C28FEEA8A35AD9299FE811568CD91A95713E1E5C",
    "c28feea8a35ad9299fe811568cd91a95713e1e5c-dirty",
    "shortdrama-main-test.col.com",
    "c28fee",
  ]) {
    assert.throws(
      () => commitShaSchema.parse(invalid),
      `构建参数误传 ${invalid} 时必须拒绝,错误的 sha 比没有 sha 更糟`,
    );
  }
});

// 这条断言探针在无 token 时不被鉴权门禁拦下(线上 401 事故的直接回归)。
test("ready/health 在整应用上无 token 可达(不得 401)", async () => {
  const app = await appWithDatabase(fakeReadinessDatabase());
  for (const url of ["/api/v1/health", "/api/v1/ready"]) {
    const res = await app.inject({ method: "GET", url });
    assert.notEqual(res.statusCode, 401, `${url} 被鉴权挡住了:探针必须公开`);
  }
  await app.close();
});

test("404:鉴权豁免路径上的方法不匹配返回标准错误信封(code/message/retryable/details)", async () => {
  const app = await appWithDatabase(fakeReadinessDatabase());
  // 报告实测场景:对 POST-only 的 /auth/login 发 GET(鉴权豁免,直达 404 处理器)
  const res = await app.inject({ method: "GET", url: "/api/v1/auth/login" });
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "not_found");
  assert.ok("retryable" in body.error && "details" in body.error, "缺标准信封字段");
  await app.close();
});

/* 护栏:代码支持 sha 但构建链路不传,线上照样查不到——这条断言的是"注入这一步真
   的存在"。文本断言是有意的:真跑一次镜像构建要几分钟且依赖 Docker,不适合放进
   单元测试;它守的是"这行别被改没了",实际生效仍以发布后 health 实测 sha 为准。 */
test("Dockerfile 把 GIT_SHA 构建参数接到运行时 APP_COMMIT_SHA", async () => {
  const fs = await import("node:fs/promises");
  const dockerfile = await fs.readFile(path.resolve("Dockerfile"), "utf8");
  assert.match(dockerfile, /^ARG GIT_SHA=""$/m, "Dockerfile 缺 GIT_SHA 构建参数");
  assert.match(
    dockerfile,
    /^ENV APP_COMMIT_SHA=\$\{GIT_SHA\}$/m,
    "GIT_SHA 没接到 APP_COMMIT_SHA,镜像跑起来仍然自报 unknown",
  );
  // 分支名与构建时间只进 label,不进运行时环境——它们不该经未鉴权端点外泄。
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{GIT_SHA\}"/);
  assert.doesNotMatch(
    dockerfile,
    /^ENV\s+\w*(GIT_REF|BUILD_TIME)/m,
    "分支名/构建时间不得进运行时环境变量",
  );
});

// 护栏:schema 兜底值绝不能指向 `common`——那是团队旧系统的活数据 schema,
// 且其属主就是本应用的数据库账号。漏配 POSTGRES_SCHEMA 时必须落在自己的库上。
test("schema 兜底不得指向他人活数据 schema common", async () => {
  const { parseCompatibleEnv } = await import("../src/config/env.js");
  assert.ok(typeof parseCompatibleEnv === "function");
  const source = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../src/config/env.ts", import.meta.url), "utf8"));
  assert.ok(
    !/POSTGRES_SCHEMA:\s*z\.string\(\)\.default\("fixture_schema"\)/.test(source),
    "POSTGRES_SCHEMA 默认值不得为 common",
  );
});
