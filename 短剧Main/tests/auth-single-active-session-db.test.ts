import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { resolveSingleActiveSession, settings } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import { sessions, users } from "../src/db/schema.js";
import { AuthRepository } from "../src/modules/auth/repository.js";

const execFileAsync = promisify(execFile);
const POSTGRES_IMAGE = process.env.POSTGRES_IMAGE ?? "postgres:14-alpine";
const schema = settings.postgresSchema;
const quotedSchema = quoteIdentifier(schema);
const passwordHash = "argon2-stand-in-for-the-current-password";
const expiresAt = new Date("2027-01-01T00:00:00.000Z");

test("同一账号能不能多处登录：按环境推导，生产照踢，开发与测试不踢", { timeout: 240_000 }, async (context) => {
  const postgres = await startTemporaryPostgres();
  const handle = createDatabase(postgres.databaseUrl);
  context.after(async () => { await handle.pool.end(); await postgres.stop(); });
  await applyAllMigrations(handle.pool);
  const db = handle.db;

  for (const environment of ["development", "test", "production"] as const) {
    const shouldRevoke = environment === "production";
    await context.test(
      `${environment}：先登的会话${shouldRevoke ? "被挤下线" : "继续有效"}`,
      async () => {
        const userId = await createUser(db, `login-${environment}`);
        const previousWeb = await seedHumanSession(db, userId, "web");
        const previousCli = await seedHumanSession(db, userId, "cli");

        const repository = new AuthRepository(db, resolveSingleActiveSession(undefined, environment));
        const created = await repository.createHumanSession({
          userId,
          expectedPasswordHash: passwordHash,
          tokenHash: freshTokenHash(),
          source: "web",
          userAgent: "browser/second-device",
          expiresAt,
        });

        assert.ok(created, "新登录必须签出会话");
        assert.equal(await isRevoked(db, previousWeb), shouldRevoke, "先前的网页会话状态不符");
        assert.equal(await isRevoked(db, previousCli), shouldRevoke, "先前的命令行会话状态不符");
        assert.equal(await isRevoked(db, created), false, "新签出的会话不该是撤销态");
      },
    );
  }

  await context.test("显式开关双向覆盖环境默认", async () => {
    const forcedOnUser = await createUser(db, "login-forced-on");
    const forcedOnPrevious = await seedHumanSession(db, forcedOnUser, "web");
    // 测试环境临时打开单点登录，验证「后登的把先登的挤下线」这条行为本身。
    await new AuthRepository(db, resolveSingleActiveSession(true, "test")).createHumanSession({
      userId: forcedOnUser,
      expectedPasswordHash: passwordHash,
      tokenHash: freshTokenHash(),
      source: "web",
      userAgent: "browser/forced-on",
      expiresAt,
    });
    assert.equal(await isRevoked(db, forcedOnPrevious), true, "显式打开后仍然没踢");

    const forcedOffUser = await createUser(db, "login-forced-off");
    const forcedOffPrevious = await seedHumanSession(db, forcedOffUser, "web");
    // 生产临时关掉单点登录排障。
    await new AuthRepository(db, resolveSingleActiveSession(false, "production")).createHumanSession({
      userId: forcedOffUser,
      expectedPasswordHash: passwordHash,
      tokenHash: freshTokenHash(),
      source: "web",
      userAgent: "browser/forced-off",
      expiresAt,
    });
    assert.equal(await isRevoked(db, forcedOffPrevious), false, "显式关闭后仍然踢了");
  });

  await context.test("竞态守卫仍在：账号停用或密码已变，建不出会话", async () => {
    const disabledUser = await createUser(db, "login-disabled");
    await db.update(users).set({ active: false }).where(eq(users.id, disabledUser));
    const afterDisable = await new AuthRepository(db, false).createHumanSession({
      userId: disabledUser,
      expectedPasswordHash: passwordHash,
      tokenHash: freshTokenHash(),
      source: "web",
      userAgent: "browser/disabled",
      expiresAt,
    });
    assert.equal(afterDisable, undefined, "停用的账号不该签出会话");

    const rotatedUser = await createUser(db, "login-rotated");
    const withStaleHash = await new AuthRepository(db, false).createHumanSession({
      userId: rotatedUser,
      expectedPasswordHash: "hash-of-an-already-replaced-password",
      tokenHash: freshTokenHash(),
      source: "web",
      userAgent: "browser/stale-hash",
      expiresAt,
    });
    assert.equal(withStaleHash, undefined, "密码哈希对不上时不该签出会话");
  });

  await context.test("竞态守卫仍在：行锁让建会话等改密事务落定，之后拒绝旧密码", async () => {
    const userId = await createUser(db, "login-race");
    const holder = await handle.pool.connect();
    let settled = false;
    try {
      await holder.query("BEGIN");
      // 模拟管理员改密事务：先占住这一行，再在建会话等待期间改掉密码。
      await holder.query(`SELECT password_hash FROM ${quotedSchema}.users WHERE id = $1 FOR UPDATE`, [userId]);

      const pending = new AuthRepository(db, false).createHumanSession({
        userId,
        expectedPasswordHash: passwordHash,
        tokenHash: freshTokenHash(),
        source: "web",
        userAgent: "browser/racing-login",
        expiresAt,
      }).then((value) => { settled = true; return value; });
      await new Promise((resolve) => setTimeout(resolve, 750));
      assert.equal(settled, false, "建会话没有等改密事务落定，竞态窗口是敞开的");

      await holder.query(
        `UPDATE ${quotedSchema}.users SET password_hash = $2 WHERE id = $1`,
        [userId, "argon2-stand-in-for-the-new-password"],
      );
      await holder.query("COMMIT");

      assert.equal(await pending, undefined, "改密提交后，用旧密码仍然签出了会话");
    } finally {
      if (!settled) await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
    const remaining = await handle.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${quotedSchema}.sessions WHERE user_id = $1`,
      [userId],
    );
    assert.equal(remaining.rows[0]?.count, 0, "被拒绝的登录不该留下会话行");
  });
});

async function createUser(db: ReturnType<typeof createDatabase>["db"], username: string): Promise<string> {
  const id = randomUUID();
  const now = new Date("2026-08-11T00:00:00.000Z");
  await db.insert(users).values({
    id,
    username: `${username}-${id.slice(0, 8)}`,
    email: null,
    emailVerifiedAt: null,
    displayName: "会话开关回归用户",
    passwordHash,
    role: "member",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedHumanSession(
  db: ReturnType<typeof createDatabase>["db"],
  userId: string,
  source: "web" | "cli",
): Promise<string> {
  const id = randomUUID();
  await db.insert(sessions).values({
    id,
    userId,
    tokenHash: freshTokenHash(),
    credentialSource: source,
    agentType: null,
    userAgent: `${source}/first-device`,
    credentialLabel: null,
    issuedBySessionId: null,
    expiresAt,
    revokedAt: null,
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
  });
  return id;
}

async function isRevoked(db: ReturnType<typeof createDatabase>["db"], sessionId: string): Promise<boolean> {
  const rows = await db.select({ revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.id, sessionId));
  assert.equal(rows.length, 1, "会话行不见了");
  return rows[0]!.revokedAt !== null;
}

function freshTokenHash(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

async function applyAllMigrations(pool: ReturnType<typeof createDatabase>["pool"]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    const files = (await readdir("migrations")).filter((file) => /^\d{3}_.*\.sql$/.test(file)).sort();
    for (const file of files) await client.query(renderMigrationSql(await readFile(`migrations/${file}`, "utf8"), schema));
  } finally {
    client.release();
  }
}

interface TemporaryPostgres { databaseUrl: string; stop(): Promise<void>; }

async function startTemporaryPostgres(): Promise<TemporaryPostgres> {
  const name = `auth-session-switch-${process.pid}-${randomUUID().slice(0, 8)}`;
  const password = "session-switch-test";
  const database = "auth_session_switch";
  await docker([
    "run", "-d", "--rm", "--name", name,
    "-e", `POSTGRES_PASSWORD=${password}`,
    "-e", `POSTGRES_DB=${database}`,
    "--tmpfs", "/var/lib/postgresql/data:rw,size=512m",
    "-p", "127.0.0.1::5432", POSTGRES_IMAGE,
  ]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await dockerResult(["exec", name, "psql", "-U", "postgres", "-d", database, "-tAc", "select 1"])).stdout.trim() === "1") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await docker(["exec", name, "psql", "-U", "postgres", "-d", database, "-c", "create extension if not exists pg_trgm"]);
  const port = /:(\d+)\s*$/.exec(await docker(["port", name, "5432/tcp"]))?.[1];
  if (!port) throw new Error("postgres port unavailable");
  return {
    databaseUrl: `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`,
    stop: async () => { await dockerResult(["rm", "-f", name]); },
  };
}

async function docker(args: string[]): Promise<string> {
  return (await execFileAsync("docker", args, { encoding: "utf8" })).stdout;
}

async function dockerResult(args: string[]): Promise<{ stdout: string }> {
  try {
    return { stdout: await docker(args) };
  } catch (error) {
    return { stdout: (error as { stdout?: string }).stdout ?? "" };
  }
}
