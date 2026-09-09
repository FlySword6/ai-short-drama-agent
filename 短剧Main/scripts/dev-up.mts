/**
 * dev:up —— 一条命令把本地开发环境起到"能登录"。
 *
 * 步骤：护栏 → 起库（docker compose，PG14 + pg_trgm）→ 迁移 001→最新 →
 * Day-0 管理员（复用 scripts/bootstrap-production-admin.ts）→ 最小演示数据。
 * 幂等：已起的库、已跑的迁移、已建的管理员/演示数据都会跳过，可反复执行。
 * 推倒重来用 npm run dev:reset。
 */
import { Client } from "pg";
import { assertDevDatabaseTarget } from "./dev-guard.mts";
import {
  devAdminUsername,
  devComposeFile,
  dotEnvPath,
  ensureDotEnv,
  loadEffectiveEnv,
  runCompose,
  runTsx,
} from "./dev-env.mts";

const schemaNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const bootstrapConfirmation = "CREATE_INITIAL_PRODUCTION_ADMIN";

function buildDatabaseUrl(env: Record<string, string | undefined>): string {
  if (env.DATABASE_URL?.trim()) return env.DATABASE_URL.trim();
  const user = encodeURIComponent(env.POSTGRES_USER ?? "");
  const password = encodeURIComponent(env.POSTGRES_PASSWORD ?? "");
  return `postgresql://${user}:${password}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT ?? "5432"}/${env.POSTGRES_DB}`;
}

async function userExists(databaseUrl: string, schema: string, username: string): Promise<boolean> {
  if (!schemaNamePattern.test(schema)) throw new Error(`POSTGRES_SCHEMA 不合法：${schema}`);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT 1 FROM "${schema}".users WHERE username = $1 LIMIT 1`,
      [username],
    );
    return result.rowCount !== null && result.rowCount > 0;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const { created } = ensureDotEnv();
  if (created) {
    console.log(`已从 .env.example 生成 ${dotEnvPath}（本机 dev 默认值，可随手改）。`);
  }

  const env = loadEffectiveEnv();
  // 任务 D 护栏：数据库目标必须是本机；指向云端 RDS 时在这里显眼报错。
  assertDevDatabaseTarget(env);

  const schema = env.POSTGRES_SCHEMA?.trim() || "app";
  const adminUsername = devAdminUsername({
    ADMIN_USERNAMES: process.env.ADMIN_USERNAMES ?? env.ADMIN_USERNAMES,
  });

  console.log("\n== 1/4 起本地 PostgreSQL 14（docker compose，含 pg_trgm）==");
  await runCompose(["up", "-d", "--wait", "db"]);

  console.log("\n== 2/4 跑迁移 001→最新 ==");
  await runTsx("src/db/migrate.ts");

  console.log("\n== 3/4 Day-0 管理员 ==");
  const databaseUrl = buildDatabaseUrl(env);
  if (await userExists(databaseUrl, schema, adminUsername)) {
    console.log(`管理员 ${adminUsername} 已存在，跳过（忘记密码可 npm run dev:reset 重建）。`);
  } else {
    // DC 2026-07-27:密码固定在 .env 的 DEV_ADMIN_PASSWORD,不再每次生成随机值。
    if (!env.DEV_ADMIN_PASSWORD?.trim()) {
      throw new Error("请先在 .env 配置 DEV_ADMIN_PASSWORD（开发环境 admin 的固定登录密码）");
    }
    await runTsx("scripts/bootstrap-production-admin.ts", [
      "--apply",
      "--confirm", bootstrapConfirmation,
      "--username", adminUsername,
      "--display-name", "本地管理员",
      "--schema", schema,
      "--password-env", "DEV_ADMIN_PASSWORD",
    ], { DEV_ADMIN_PASSWORD: env.DEV_ADMIN_PASSWORD.trim() });
  }

  console.log("\n== 4/4 播种最小演示数据 ==");
  await runTsx("scripts/dev-seed.mts", ["--username", adminUsername]);

  console.log([
    "",
    "开发环境就绪。下一步：",
    "  1. npm run dev          # 启动后端（8000，带启动期护栏）",
    "  2. 另开一个终端起前端：cd frontend/shortdrama-rag-demo && npm run dev（5173）",
    `  3. 打开 http://localhost:5173 ，登录：${adminUsername} / 密码见 .env 的 DEV_ADMIN_PASSWORD（固定不变）`,
    "",
    "页面在 5173，8000 只提供接口；只改接口可以跳过第 2 步，直接打开 8000 会给一页指引。",
    `推倒重来：npm run dev:reset；只停库：docker compose -f ${devComposeFile} down`,
  ].join("\n"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
