/* dev 环境防呆护栏（S21 任务 D 验收核心）：
   dev 配置指向云端 RDS 主机名时必须显眼报错、拒绝启动——今天的教训是
   "配置错了但服务照样起来，错误延迟到用户点登录才暴露"，dev 必须 fail fast。
   同时守 .env.example 与 src/config/env.ts 的逐项对齐，以及 dev compose 的
   PG14 + pg_trgm 硬要求。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertDevDatabaseTarget,
  effectiveDevEnv,
  parseEnvFile,
  resolvePostgresHost,
} from "../scripts/dev-guard.mts";

const repoRoot = path.resolve(import.meta.dirname, "..");

/** assert.throws 在本 Node 版本不返回异常对象，自己捕获以便检查报错文案。 */
function captureError(fn: () => void): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  assert.fail("预期抛错但没有抛");
}

// ---- 护栏：本机目标放行 ----

test("dev 护栏：localhost / 127.0.0.1 / ::1 放行（POSTGRES_HOST 与 DATABASE_URL 两种形态）", () => {
  assert.doesNotThrow(() => assertDevDatabaseTarget({ POSTGRES_HOST: "localhost" }));
  assert.doesNotThrow(() => assertDevDatabaseTarget({ POSTGRES_HOST: "127.0.0.1" }));
  assert.doesNotThrow(() => assertDevDatabaseTarget({ POSTGRES_HOST: "::1" }));
  assert.doesNotThrow(() => assertDevDatabaseTarget({
    DATABASE_URL: "postgresql://u:p@localhost:5432/shortdrama",
  }));
  assert.doesNotThrow(() => assertDevDatabaseTarget({
    DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/shortdrama",
  }));
});

// ---- 护栏：云端 RDS 拒绝（任务 D 核心场景）----

test("dev 护栏：云上 RDS 主机名显眼报错（含 configmap 里的真实主机形态）", () => {
  const cloudHosts = [
    // deploy/k8s/configmap.yaml 里登记的真实 RDS 私网端点形态。
    "postgres4a3018919997.rds-pg.ivolces.com",
    "shortdrama-pg.rds.ivolces.com",
    "other-pg.rds.ivolces.com",
    "pg-abcdef.rds.volces.com",
    "mydb.abcdefghij.rds.amazonaws.com",
  ];
  for (const host of cloudHosts) {
    const error = captureError(() => assertDevDatabaseTarget({ POSTGRES_HOST: host }));
    assert.match(String(error), /云端 RDS|不是本机/);
  }
});

test("dev 护栏：DATABASE_URL 里的云主机同样拒绝，且报错不泄露连接串凭据", () => {
  const error = captureError(() => assertDevDatabaseTarget({
    DATABASE_URL: "postgresql://shortdrama:s3cret@postgres4a3018919997.rds-pg.ivolces.com:5432/shortdrama",
  }));
  assert.match(String(error), /云端 RDS/);
  assert.doesNotMatch(String(error), /s3cret/);
});

test("dev 护栏：DATABASE_URL 优先于 POSTGRES_HOST（URL 指云、HOST 指本机也拒绝）", () => {
  assert.throws(() => assertDevDatabaseTarget({
    DATABASE_URL: "postgresql://u:p@pg-x.rds.volces.com/db",
    POSTGRES_HOST: "localhost",
  }));
});

test("dev 护栏：非本机非云的任意主机也 fail-closed 拒绝", () => {
  const error = captureError(() => assertDevDatabaseTarget({ POSTGRES_HOST: "db.internal.example.com" }));
  assert.match(String(error), /不是本机/);
});

test("dev 护栏：完全没有数据库配置时报错并指引 dev:up", () => {
  const error = captureError(() => assertDevDatabaseTarget({}));
  assert.match(String(error), /dev:up/);
});

test("dev 护栏：生效配置遵循 process.env 优先于 .env（与 src/config/env.ts 同语义）", () => {
  const effective = effectiveDevEnv(
    { POSTGRES_HOST: "localhost", POSTGRES_DB: "shortdrama" },
    { POSTGRES_HOST: "postgres4a3018919997.rds-pg.ivolces.com" },
  );
  assert.equal(resolvePostgresHost(effective), "postgres4a3018919997.rds-pg.ivolces.com");
  assert.throws(() => assertDevDatabaseTarget(effective));
});

// ---- .env.example：逐项对齐 + 一个真值都不许有 ----

function envExampleKeys(): string[] {
  const content = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
  return Object.keys(parseEnvFile(content));
}

function envSchemaExpressions(): Record<string, string> {
  const source = readFileSync(path.join(repoRoot, "src", "config", "env.ts"), "utf8")
    .replace(/\r\n?/g, "\n");
  const match = source.match(/envSchema\s*=\s*z\.object\(\{([\s\S]*?)\n\}\)/);
  assert.ok(match, "env.ts 里找不到 envSchema 的 z.object 定义");
  const expressions: Record<string, string> = {};
  // 一个键的定义可能链式换行写。续行要并进同一条表达式，否则下面那条「留空的键能不能
  // 吃空串」只看得见第一行（真实漏网：整条 .regex(...).optional() 被拆到第 2、4 行）。
  let currentKey: string | undefined;
  for (const line of match[1].split("\n")) {
    if (line.trimStart().startsWith("//")) continue;
    const keyMatch = line.match(/^\s{2}(?:"([^"]+)"|([A-Za-z0-9_]+)):(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1] ?? keyMatch[2];
      expressions[currentKey] = keyMatch[3]!;
    } else if (currentKey) {
      expressions[currentKey] += ` ${line.trim()}`;
    }
  }
  return expressions;
}

function envSchemaKeys(): string[] {
  return Object.keys(envSchemaExpressions());
}

test(".env.example 与 src/config/env.ts 的字段逐项对齐", () => {
  const exampleKeys = envExampleKeys();
  const schemaKeys = envSchemaKeys();
  assert.ok(schemaKeys.length > 50, `env.ts 应解析出 50+ 个键，实际 ${schemaKeys.length}`);
  assert.deepEqual(
    exampleKeys.filter((key) => !schemaKeys.includes(key)),
    [],
    ".env.example 有 env.ts 不认识的键",
  );
  assert.deepEqual(
    schemaKeys.filter((key) => !exampleKeys.includes(key)),
    [],
    "env.ts 的键在 .env.example 里缺失",
  );
});

test(".env.example 不含任何真实凭据/云端真值", () => {
  const content = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
  // 云端 RDS / Milvus / TOS 真实主机与桶名（取自 deploy/k8s/configmap.yaml 的形态）。
  for (const forbidden of [
    "rds-pg.ivolces.com",
    "rds.ivolces.com",
    "rds.volces.com",
    "milvus.volces.com",
    "drama-asset",
    "postgres4a3018919997",
  ]) {
    assert.ok(!content.includes(forbidden), `.env.example 不该出现真实值：${forbidden}`);
  }
  const values = parseEnvFile(content);
  // dev 的数据库必须指本机，schema 必须是 v0.2.0 主线的 app（common 是别人活数据）。
  assert.equal(values.POSTGRES_HOST, "localhost");
  assert.equal(values.POSTGRES_SCHEMA, "app");
  assert.match(values.POSTGRES_PASSWORD ?? "", /dev-only|not-a-secret|change-me/i);
});

test(".env.example 留空的键必须能吃空串——带格式/数值/枚举约束的键留空会让 zod parse 直接失败", () => {
  // 真实事故：dev:up 把 example 复制成 .env，应用一启动就 ZodError。
  // `.optional()` 不算数：它只接受「键不存在」，而 `KEY=` 到了 process.env 是空串。
  // 能吃空串的只有两类：显式 union 了 z.literal("")，或 transform 把假值转成 undefined
  // ——本文件顶部那几个 optionalXxx 辅助器就是干这个的。
  const emptyTolerant = /\boptional(String|Url|HttpsUrl|Sha256)\b|z\.literal\(""\)/;
  const formatConstrained = /\.url\(\)|\.email\(\)|\.min\(|\.regex\(|z\.coerce\.number|z\.enum/;
  const values = parseEnvFile(readFileSync(path.join(repoRoot, ".env.example"), "utf8"));
  const offenders: string[] = [];
  for (const [key, expression] of Object.entries(envSchemaExpressions())) {
    if (emptyTolerant.test(expression)) continue;
    if (!formatConstrained.test(expression)) continue;
    if (!(values[key] ?? "").trim()) offenders.push(key);
  }
  assert.deepEqual(offenders, [], "这些键在 .env.example 里留空，zod parse 会失败，dev 起不来");
});

// ---- dev compose：PG14 + pg_trgm 硬要求 ----

test("docker-compose.dev.yml 用 PostgreSQL 14 且挂载 pg_trgm 初始化", () => {
  const compose = readFileSync(path.join(repoRoot, "docker-compose.dev.yml"), "utf8");
  // 与云上 RDS 的 PG14 对齐；16 行为有差异，明确不用。
  assert.match(compose, /image:\s*postgres:14-/);
  assert.doesNotMatch(compose, /postgres:1[56]/);
  assert.match(compose, /dev-pg-init\.sql:\/docker-entrypoint-initdb\.d\//);

  const initSql = readFileSync(path.join(repoRoot, "scripts", "dev-pg-init.sql"), "utf8");
  // 迁移 017 的硬前置；缺了整条迁移链 fail-closed。
  assert.match(initSql, /CREATE EXTENSION IF NOT EXISTS pg_trgm/i);
});

test("package.json 暴露 dev:up / dev:down / dev:reset，且 npm run dev 带启动期护栏", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const name of ["dev:up", "dev:down", "dev:reset"]) {
    assert.ok(pkg.scripts[name], `package.json 缺 ${name}`);
  }
  assert.match(pkg.scripts.dev, /dev-guard\.mts/);
});
