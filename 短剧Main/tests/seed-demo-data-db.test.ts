import assert from "node:assert/strict";
import test from "node:test";

/**
 * 演示数据集真库验证(PostgreSQL 14)。S22 护栏 C。
 *
 * 默认跳过:设置 SEED_DEMO_TEST_DATABASE_URL 指向本机/本地 Compose PG 后运行。
 * 覆盖:两遍播种幂等、金路径数据可查、演示账号口令可通过应用同款校验。
 */
const databaseUrl = process.env.SEED_DEMO_TEST_DATABASE_URL;
const schema = "s22_seed_test";

test("演示数据集:两遍播种幂等且金路径数据完整", { skip: !databaseUrl }, async () => {
  process.env.POSTGRES_SCHEMA = schema;
  const { seedDemoData, demoSeedIds, demoSeedUsername, demoSeedDefaultPassword } = await import("../seed/demo-data.mts");
  const { default: pg } = await import("pg");

  // 测试自备干净起点(播种本身不做 DROP——它必须对既有数据安全)。
  const cleaner = new pg.Pool({ connectionString: databaseUrl });
  await cleaner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await cleaner.end();

  const first = await seedDemoData({ databaseUrl: databaseUrl!, schema });
  assert.deepEqual(first.totals, { users: 1, projects: 1, episodes: 1, scenes: 2, shots: 4 });
  assert.equal(Object.values(first.inserted).reduce((sum, n) => sum + n, 0), 9);

  const second = await seedDemoData({ databaseUrl: databaseUrl!, schema });
  assert.deepEqual(second.totals, first.totals, "重复跑总数不得变化");
  assert.deepEqual(
    Object.fromEntries(Object.entries(second.inserted).map(([k, v]) => [k, v])),
    { users: 0, projects: 0, projectMembers: 0, episodes: 0, scenes: 0, shots: 0 },
    "重复跑不得新插任何行",
  );

  // 金路径查询:demo.admin 经 project_members 看到项目,集→场→分镜齐全有序。
  const { settings } = await import("../src/config/env.js");
  const { createDatabase } = await import("../src/db/client.js");
  const tables = await import("../src/db/schema.js");
  const { and, asc, eq, isNull } = await import("drizzle-orm");
  assert.equal(settings.postgresSchema, schema);
  const handle = createDatabase(databaseUrl!);
  try {
    const visibleProjects = await handle.db
      .select({ id: tables.projects.id, name: tables.projects.name })
      .from(tables.projectMembers)
      .innerJoin(tables.projects, eq(tables.projects.id, tables.projectMembers.projectId))
      .where(and(
        eq(tables.projectMembers.userId, demoSeedIds.user),
        eq(tables.projectMembers.role, "owner"),
        isNull(tables.projects.deletedAt),
      ));
    assert.deepEqual(visibleProjects, [{ id: demoSeedIds.project, name: "演示项目·金路径样例" }]);

    const storyboard = await handle.db
      .select({
        sceneNo: tables.scenes.sceneNo,
        shotCode: tables.shots.shotCode,
        scriptText: tables.shots.scriptText,
      })
      .from(tables.shots)
      .innerJoin(tables.scenes, eq(tables.shots.sceneId, tables.scenes.id))
      .where(and(eq(tables.shots.episodeId, demoSeedIds.episode), isNull(tables.shots.deletedAt)))
      .orderBy(asc(tables.shots.sortOrder));
    assert.equal(storyboard.length, 4);
    assert.deepEqual(storyboard.map((row) => row.shotCode), ["E01-S01-001", "E01-S01-002", "E01-S02-001", "E01-S02-002"]);
    assert.ok(storyboard.every((row) => row.scriptText && row.scriptText.length > 0));

    // 演示账号可通过应用同款口令校验(即真的能登录)。
    const { verifyPassword } = await import("../src/modules/auth/service.js");
    const [user] = await handle.db
      .select({ passwordHash: tables.users.passwordHash, role: tables.users.role, active: tables.users.active })
      .from(tables.users)
      .where(eq(tables.users.username, demoSeedUsername));
    assert.ok(user);
    assert.equal(user.role, "admin");
    assert.equal(user.active, true);
    assert.equal(await verifyPassword(demoSeedDefaultPassword, user.passwordHash), true);
  } finally {
    await handle.pool.end();
  }
});
