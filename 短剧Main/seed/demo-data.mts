#!/usr/bin/env tsx
/**
 * 最小可用演示数据集(金路径播种)。S22 数据库工程护栏 C 包,S21 一键起环境时调用。
 *
 * 内容:1 个演示账号 + 1 个项目 + 1 集 + 2 场 + 4 条分镜——够走通
 * 「登录 → 项目 → 集 → 分镜」金路径,除此之外什么都不播。
 *
 * 纪律:
 *   - 幂等:全部固定 UUID + ON CONFLICT DO NOTHING,重复跑不炸、不产生重复数据。
 *   - 不含任何真实凭据,不含从云库导出的数据;演示密码是公开占位值,只用于本地。
 *   - 只连本机/本地 Compose PostgreSQL(主机白名单),绝不连云库。
 *   - 迁移未跑过的库会先按 migrations/extensions.json 预装扩展、再跑迁移(幂等),
 *     保证一条命令即可从空库到可登录。
 *
 * 用法:
 *   npx tsx seed/demo-data.mts                      # 用 .env / POSTGRES_* 配置
 *   npx tsx seed/demo-data.mts --database-url postgresql://… [--schema app] [--password …]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const localHosts = new Set(["127.0.0.1", "localhost", "::1", "db", "postgres"]);

export const demoSeedIds = {
  user: "00000000-5eed-4000-8000-000000000001",
  project: "00000000-5eed-4000-8000-000000000002",
  episode: "00000000-5eed-4000-8000-000000000003",
  sceneMorning: "00000000-5eed-4000-8000-000000000004",
  sceneNight: "00000000-5eed-4000-8000-000000000005",
  shots: [
    "00000000-5eed-4000-8000-000000000011",
    "00000000-5eed-4000-8000-000000000012",
    "00000000-5eed-4000-8000-000000000013",
    "00000000-5eed-4000-8000-000000000014",
  ],
} as const;

export const demoSeedUsername = "demo.admin";
/** 公开占位口令,仅用于本地演示数据;不是任何环境的真实凭据。 */
export const demoSeedDefaultPassword = "demo-only-password";

export function assertLocalDatabaseUrl(databaseUrl: string): void {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("数据库连接串无法解析");
  }
  if (!localHosts.has(host)) {
    throw new Error(`播种脚本只允许本机或本地 Compose PostgreSQL(主机 ${host} 被拒绝),绝不连云库`);
  }
}

export interface SeedSummary {
  schema: string;
  username: string;
  inserted: Record<string, number>;
  totals: Record<string, number>;
}

export async function seedDemoData(options: {
  databaseUrl: string;
  schema?: string;
  password?: string;
  migrationsDirectory?: string;
}): Promise<SeedSummary> {
  assertLocalDatabaseUrl(options.databaseUrl);
  const migrationsDirectory = options.migrationsDirectory ?? path.resolve("migrations");
  if (options.schema) process.env.POSTGRES_SCHEMA = options.schema;

  // settings 在 import 时冻结,应用模块一律动态 import。
  const [{ Pool }, { settings }, { createDatabase }, migrate, schema, auth] = await Promise.all([
    import("pg"),
    import("../src/config/env.js"),
    import("../src/db/client.js"),
    import("../src/db/migrate.js"),
    import("../src/db/schema.js"),
    import("../src/modules/auth/service.js"),
  ]);
  const targetSchema = options.schema ?? settings.postgresSchema;
  if (targetSchema !== settings.postgresSchema) {
    // settings 在首次 import 时冻结;若进程里有人更早 import 过 env.ts,
    // 这里的 --schema 会被静默忽略——宁可报错也不许把数据播进别的 schema。
    throw new Error(
      `播种目标 schema 不一致: 期望 ${targetSchema},但应用配置已冻结为 ${settings.postgresSchema}` +
      `(POSTGRES_SCHEMA 必须在 import 应用模块前设置)`,
    );
  }
  const { quoteIdentifier, runMigrations } = migrate;

  const admin = new Pool({ connectionString: options.databaseUrl, max: 2 });
  const handle = createDatabase(options.databaseUrl);
  try {
    // 声明的扩展是 DBA 预置条件:本地库由播种按 extensions.json 登记预装。
    const { readFile } = await import("node:fs/promises");
    const registry = JSON.parse(
      await readFile(path.join(migrationsDirectory, "extensions.json"), "utf8"),
    ) as { extensions: Array<{ name: string }> };
    for (const entry of registry.extensions) {
      await admin.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(entry.name)}`);
    }
    await runMigrations(handle, migrationsDirectory);

    const db = handle.db;
    const now = new Date("2026-07-26T00:00:00.000Z");
    const passwordHash = await auth.hashPassword(options.password ?? demoSeedDefaultPassword);
    const inserted: Record<string, number> = {};
    const count = (rows: unknown[]) => rows.length;

    inserted.users = count(await db.insert(schema.users).values({
      id: demoSeedIds.user,
      username: demoSeedUsername,
      displayName: "演示管理员",
      passwordHash,
      active: true,
      role: "admin",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning({ id: schema.users.id }));

    inserted.projects = count(await db.insert(schema.projects).values({
      id: demoSeedIds.project,
      ownerUserId: demoSeedIds.user,
      genre: "甜宠",
      name: "演示项目·金路径样例",
      description: "S22 播种的最小演示项目:一集两场四条分镜,供本地环境走通金路径。",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning({ id: schema.projects.id }));

    // 016 的项目负责人同步触发器可能已补过 owner 行;ON CONFLICT 兜底,重复跑安全。
    inserted.projectMembers = count(await db.insert(schema.projectMembers).values({
      projectId: demoSeedIds.project,
      userId: demoSeedIds.user,
      role: "owner",
      addedByUserId: demoSeedIds.user,
      createdAt: now,
    }).onConflictDoNothing().returning({ projectId: schema.projectMembers.projectId }));

    inserted.episodes = count(await db.insert(schema.episodes).values({
      id: demoSeedIds.episode,
      projectId: demoSeedIds.project,
      episodeNo: 1,
      name: "第 1 集",
      sortOrder: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning({ id: schema.episodes.id }));

    inserted.scenes = count(await db.insert(schema.scenes).values([
      {
        id: demoSeedIds.sceneMorning, episodeId: demoSeedIds.episode, sceneNo: 1,
        name: "日·内·咖啡厅", description: "男女主第一次重逢。", sortOrder: 1,
        createdAt: now, updatedAt: now,
      },
      {
        id: demoSeedIds.sceneNight, episodeId: demoSeedIds.episode, sceneNo: 2,
        name: "夜·外·天台", description: "误会说开,关系推进。", sortOrder: 2,
        createdAt: now, updatedAt: now,
      },
    ]).onConflictDoNothing().returning({ id: schema.scenes.id }));

    inserted.shots = count(await db.insert(schema.shots).values([
      {
        id: demoSeedIds.shots[0], episodeId: demoSeedIds.episode, sceneId: demoSeedIds.sceneMorning,
        shotCode: "E01-S01-001", title: "推门入镜",
        scriptText: "女主推开咖啡厅门,风铃响,男主抬头。",
        imagePrompt: "日式咖啡厅门口,午后暖光,女主推门,风铃特写",
        videoPrompt: "固定机位,女主推门走入,风铃轻晃,2 秒",
        durationSeconds: 2, sortOrder: 1, referenceAssetSnapshots: [], createdAt: now, updatedAt: now,
      },
      {
        id: demoSeedIds.shots[1], episodeId: demoSeedIds.episode, sceneId: demoSeedIds.sceneMorning,
        shotCode: "E01-S01-002", title: "对视愣神",
        scriptText: "两人对视,都愣住,背景音乐停半拍。",
        imagePrompt: "咖啡厅内,男女主隔桌对视,浅景深",
        videoPrompt: "正反打,对视愣神,各 1.5 秒",
        durationSeconds: 3, sortOrder: 2, referenceAssetSnapshots: [], createdAt: now, updatedAt: now,
      },
      {
        id: demoSeedIds.shots[2], episodeId: demoSeedIds.episode, sceneId: demoSeedIds.sceneNight,
        shotCode: "E01-S02-001", title: "天台夜风",
        scriptText: "夜风吹乱头发,男主把外套披给女主。",
        imagePrompt: "城市天台夜景,霓虹远景,男主披外套",
        videoPrompt: "缓推镜头,披外套动作,3 秒",
        durationSeconds: 3, sortOrder: 3, referenceAssetSnapshots: [], createdAt: now, updatedAt: now,
      },
      {
        id: demoSeedIds.shots[3], episodeId: demoSeedIds.episode, sceneId: demoSeedIds.sceneNight,
        shotCode: "E01-S02-002", title: "误会说开",
        scriptText: "女主笑场,两人并肩看向城市灯火,本集完。",
        imagePrompt: "天台栏杆边,两人并肩背影,城市灯火",
        videoPrompt: "背影定格,灯火虚化,渐暗收尾,2 秒",
        durationSeconds: 2, sortOrder: 4, referenceAssetSnapshots: [], createdAt: now, updatedAt: now,
      },
    ]).onConflictDoNothing().returning({ id: schema.shots.id }));

    const totals: Record<string, number> = {};
    for (const [label, sql] of [
      ["users", `SELECT count(*)::int AS n FROM ${quoteIdentifier(targetSchema)}.users WHERE id = $1`],
      ["projects", `SELECT count(*)::int AS n FROM ${quoteIdentifier(targetSchema)}.projects WHERE id = $1`],
      ["episodes", `SELECT count(*)::int AS n FROM ${quoteIdentifier(targetSchema)}.episodes WHERE id = $1`],
      ["scenes", `SELECT count(*)::int AS n FROM ${quoteIdentifier(targetSchema)}.scenes WHERE episode_id = $1`],
      ["shots", `SELECT count(*)::int AS n FROM ${quoteIdentifier(targetSchema)}.shots WHERE episode_id = $1`],
    ] as const) {
      const idParam = label === "scenes" || label === "shots" ? demoSeedIds.episode
        : label === "projects" ? demoSeedIds.project
        : label === "episodes" ? demoSeedIds.episode
        : demoSeedIds.user;
      const result = await admin.query<{ n: number }>(sql, [idParam]);
      totals[label] = result.rows[0]?.n ?? 0;
    }

    return { schema: targetSchema, username: demoSeedUsername, inserted, totals };
  } finally {
    await handle.pool.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const readArg = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  // settings 在首次 import 时冻结:--schema 必须先于任何应用模块 import 生效。
  const schemaArg = readArg("--schema");
  if (schemaArg) process.env.POSTGRES_SCHEMA = schemaArg;
  const { settings } = await import("../src/config/env.js");
  const databaseUrl = readArg("--database-url") ?? process.env.SEED_DEMO_DATABASE_URL ?? settings.databaseUrl;
  if (!databaseUrl) {
    process.stderr.write(
      "用法: npx tsx seed/demo-data.mts [--database-url postgresql://…] [--schema app] [--password …]\n" +
      "未显式给出时读取 .env / POSTGRES_* 配置;只允许本机或本地 Compose 库。\n",
    );
    process.exitCode = 1;
    return;
  }
  const summary = await seedDemoData({
    databaseUrl,
    schema: schemaArg,
    password: readArg("--password"),
  });
  const insertedTotal = Object.values(summary.inserted).reduce((sum, n) => sum + n, 0);
  process.stdout.write(
    `演示数据集就绪(schema ${summary.schema}): 本次新插 ${insertedTotal} 行(重复跑为 0,幂等)\n` +
    `  内容: ${Object.entries(summary.totals).map(([k, v]) => `${k}=${v}`).join(" ")}\n` +
    `  演示账号: ${summary.username} / ${demoSeedDefaultPassword}(公开占位口令,仅限本地)\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
