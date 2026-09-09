import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import { adminOperationActions, sessions, users, wecomAuthTransactions, wecomUserIdentities } from "../src/db/schema.js";
import { AuthRepository } from "../src/modules/auth/repository.js";
import { AuthService } from "../src/modules/auth/service.js";

const execFileAsync = promisify(execFile);
const POSTGRES_IMAGE = process.env.POSTGRES_IMAGE ?? "postgres:14-alpine";
const schema = settings.postgresSchema;
const quotedSchema = quoteIdentifier(schema);
const baseNow = new Date("2026-08-21T00:00:00.000Z");

test("企业微信认证地基在真 PostgreSQL 上保持唯一、一次性与回滚边界", { timeout: 240_000 }, async (context) => {
  const postgres = await startTemporaryPostgres();
  const handle = createDatabase(postgres.databaseUrl);
  context.after(async () => { await handle.pool.end(); await postgres.stop(); });
  await applyAllMigrations(handle.pool);
  const repository = new AuthRepository(handle.db, true);

  await context.test("迁移允许无密码用户，并建立两张受约束的企业微信表", async () => {
    const columns = await handle.pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1
          AND ((table_name = 'users' AND column_name = 'password_hash')
            OR table_name IN ('wecom_user_identities', 'wecom_auth_transactions'))`,
      [schema],
    );
    assert.equal(columns.rows.find((row) => row.table_name === "users")?.is_nullable, "YES");
    assert.equal(columns.rows.filter((row) => row.table_name === "wecom_user_identities").length, 7);
    assert.equal(columns.rows.filter((row) => row.table_name === "wecom_auth_transactions").length, 12);
  });

  await context.test("伪造 nonce、过期 state 与重复 callback 都失败关闭", async () => {
    const valid = await createConsumedTransaction(repository, "callback-valid", baseNow);
    assert.equal(valid.kind, "consumed");
    assert.deepEqual(
      await repository.consumeWecomCallback({ stateHash: hash("callback-valid"), browserNonceHash: hash("browser") }, baseNow),
      { kind: "replayed" },
    );

    await repository.createWecomAuthTransaction({
      stateHash: hash("callback-wrong-browser"),
      browserNonceHash: hash("browser"),
      returnPath: "/projects",
      expiresAt: later(baseNow, 300),
    }, baseNow);
    assert.deepEqual(
      await repository.consumeWecomCallback({ stateHash: hash("callback-wrong-browser"), browserNonceHash: hash("other") }, baseNow),
      { kind: "invalid" },
    );

    await repository.createWecomAuthTransaction({
      stateHash: hash("callback-expired"),
      browserNonceHash: hash("browser"),
      returnPath: "/projects",
      expiresAt: later(baseNow, -1),
    }, baseNow);
    assert.deepEqual(
      await repository.consumeWecomCallback({ stateHash: hash("callback-expired"), browserNonceHash: hash("browser") }, baseNow),
      { kind: "expired" },
    );
  });

  const first = await createConsumedTransaction(repository, "parallel-a", baseNow);
  const second = await createConsumedTransaction(repository, "parallel-b", baseNow);
  assert.equal(first.kind, "consumed");
  assert.equal(second.kind, "consumed");
  if (first.kind !== "consumed" || second.kind !== "consumed") throw new Error("fixture transaction was not consumed");

  const username = `wecom_${hash("ww-corp\0member-1").slice(0, 58)}`;
  const [resolvedA, resolvedB] = await Promise.all([
    repository.resolveWecomIdentityAndIssueResult({
      transactionId: first.transactionId,
      corpId: "ww-corp",
      wecomUserId: "member-1",
      username,
      displayName: "企业成员一",
      resultHash: hash("result-a"),
      resultExpiresAt: later(baseNow, 60),
    }, baseNow),
    repository.resolveWecomIdentityAndIssueResult({
      transactionId: second.transactionId,
      corpId: "ww-corp",
      wecomUserId: "member-1",
      username,
      displayName: "不应覆盖管理员可修改的显示名",
      resultHash: hash("result-b"),
      resultExpiresAt: later(baseNow, 60),
    }, later(baseNow, 1)),
  ]);

  await context.test("并发首次登录只创建一个 member/full 用户和一个身份", async () => {
    assert.equal(resolvedA.kind, "resolved");
    assert.equal(resolvedB.kind, "resolved");
    if (resolvedA.kind !== "resolved" || resolvedB.kind !== "resolved") throw new Error("identity resolution failed");
    assert.equal(Number(resolvedA.created) + Number(resolvedB.created), 1);
    assert.equal(resolvedA.user.id, resolvedB.user.id);

    const identityRows = await handle.db.select().from(wecomUserIdentities).where(and(
      eq(wecomUserIdentities.corpId, "ww-corp"),
      eq(wecomUserIdentities.wecomUserId, "member-1"),
    ));
    assert.equal(identityRows.length, 1);
    const createdUsers = await handle.db.select().from(users).where(eq(users.username, username));
    assert.equal(createdUsers.length, 1);
    assert.equal(createdUsers[0]?.passwordHash, null);
    assert.equal(createdUsers[0]?.role, "member");
    assert.equal(createdUsers[0]?.uiMode, "full");
    assert.equal(createdUsers[0]?.displayName, "企业成员一", "再次登录不得覆盖既有显示名");

    const memberships = await handle.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${quotedSchema}.project_members WHERE user_id = $1`,
      [createdUsers[0]?.id],
    );
    assert.equal(memberships.rows[0]?.count, 0);
  });

  await context.test("一次性 result 只能换一个现有 web session", async () => {
    const resolvedUser = (await handle.db.select().from(users).where(eq(users.username, username)))[0]!;
    const previousWeb = await seedSession(handle.db, resolvedUser.id, "web", "previous-web");
    const previousCli = await seedSession(handle.db, resolvedUser.id, "cli", "previous-cli");
    const previousAgent = await seedSession(handle.db, resolvedUser.id, "agent", "previous-agent", previousWeb);
    const exchange = await repository.exchangeWecomResultForSession({
      resultHash: hash("result-a"),
      browserNonceHash: hash("browser"),
      tokenHash: hash("platform-token-a"),
      userAgent: "wecom-db-test",
      expiresAt: later(baseNow, 3600),
    }, later(baseNow, 2));
    assert.equal(exchange.kind, "exchanged");
    if (exchange.kind !== "exchanged") throw new Error("result exchange failed");
    const stored = await handle.db.select().from(sessions).where(eq(sessions.id, exchange.sessionId));
    assert.equal(stored[0]?.credentialSource, "web");
    assert.ok((await handle.db.select().from(sessions).where(eq(sessions.id, previousWeb)))[0]?.revokedAt);
    assert.ok((await handle.db.select().from(sessions).where(eq(sessions.id, previousCli)))[0]?.revokedAt);
    assert.equal((await handle.db.select().from(sessions).where(eq(sessions.id, previousAgent)))[0]?.revokedAt, null);
    assert.deepEqual(await repository.exchangeWecomResultForSession({
      resultHash: hash("result-a"),
      browserNonceHash: hash("browser"),
      tokenHash: hash("platform-token-b"),
      userAgent: null,
      expiresAt: later(baseNow, 3600),
    }, later(baseNow, 3)), { kind: "replayed" });
  });

  await context.test("session 写入失败时 result 消费一并回滚", async () => {
    const transaction = await createConsumedTransaction(repository, "rollback", baseNow);
    assert.equal(transaction.kind, "consumed");
    if (transaction.kind !== "consumed") throw new Error("fixture transaction was not consumed");
    const resolution = await repository.resolveWecomIdentityAndIssueResult({
      transactionId: transaction.transactionId,
      corpId: "ww-corp",
      wecomUserId: "member-1",
      username,
      displayName: "不覆盖",
      resultHash: hash("result-rollback"),
      resultExpiresAt: later(baseNow, 60),
    }, baseNow);
    assert.equal(resolution.kind, "resolved");

    await assert.rejects(repository.exchangeWecomResultForSession({
      resultHash: hash("result-rollback"),
      browserNonceHash: hash("browser"),
      tokenHash: hash("platform-token-a"),
      userAgent: null,
      expiresAt: later(baseNow, 3600),
    }, later(baseNow, 4)));
    const row = (await handle.db.select({ consumedAt: wecomAuthTransactions.resultConsumedAt })
      .from(wecomAuthTransactions)
      .where(eq(wecomAuthTransactions.id, transaction.transactionId)))[0];
    assert.equal(row?.consumedAt, null);
  });

  await context.test("禁用账号不能 exchange，无密码账号不能走密码登录", async () => {
    const user = (await handle.db.select().from(users).where(eq(users.username, username)))[0]!;
    await handle.db.update(users).set({ active: false }).where(eq(users.id, user.id));
    assert.deepEqual(await repository.exchangeWecomResultForSession({
      resultHash: hash("result-b"),
      browserNonceHash: hash("browser"),
      tokenHash: hash("platform-token-disabled"),
      userAgent: null,
      expiresAt: later(baseNow, 3600),
    }, later(baseNow, 5)), { kind: "account_disabled" });
    await handle.db.update(users).set({ active: true }).where(eq(users.id, user.id));
    await assert.rejects(
      new AuthService(handle.db, repository).login({ username, password: "anything-at-all" }),
      (error: unknown) => typeof error === "object" && error !== null && (error as { code?: string }).code === "unauthorized",
    );
  });

  await context.test("同一平台用户不能绑定第二个企业微信身份", async () => {
    const user = (await handle.db.select().from(users).where(eq(users.username, username)))[0]!;
    await assert.rejects(handle.db.insert(wecomUserIdentities).values({
      id: randomUUID(),
      userId: user.id,
      corpId: "ww-corp",
      wecomUserId: "member-2",
      lastAuthenticatedAt: baseNow,
      createdAt: baseNow,
      updatedAt: baseNow,
    }), (error: unknown) => postgresCode(error) === "23505");
  });

  await context.test("管理员预绑定原子写入身份与脱敏审计，并拒绝冲突", async () => {
    const actorId = randomUUID();
    const targetId = randomUUID();
    for (const [id, usernameValue, role] of [[actorId, "wecom-prebind-admin", "admin"], [targetId, "wecom-prebind-target", "member"]] as const) {
      await handle.db.insert(users).values({
        id,
        username: usernameValue,
        email: null,
        emailVerifiedAt: null,
        displayName: usernameValue,
        passwordHash: null,
        role,
        uiMode: "full",
        active: true,
        createdAt: baseNow,
        updatedAt: baseNow,
      });
    }
    const actorSessionId = await seedSession(handle.db, actorId, "web", "prebind-admin-session");
    const input = {
      actor: { userId: actorId, sessionId: actorSessionId },
      userId: targetId,
      corpId: "ww-corp",
      wecomUserId: "prebound-member",
    };
    assert.equal(await repository.prebindWecomIdentity(input, baseNow), "bound");
    assert.equal(await repository.prebindWecomIdentity(input, later(baseNow, 1)), "bound", "same binding is idempotent");

    const identity = await handle.db.select().from(wecomUserIdentities).where(eq(wecomUserIdentities.userId, targetId));
    assert.equal(identity.length, 1);
    assert.equal(identity[0]?.wecomUserId, "prebound-member");
    assert.deepEqual(await repository.findWecomIdentity("ww-corp", "prebound-member"), {
      displayName: "wecom-prebind-target",
    });
    const audit = await handle.db.select().from(adminOperationActions).where(eq(adminOperationActions.targetId, targetId));
    assert.equal(audit.length, 2);
    assert.equal(audit[0]?.action, "wecom_identity_bound");
    assert.equal(JSON.stringify(audit).includes("prebound-member"), false, "audit must not contain raw WeCom user id");

    const existingUser = (await handle.db.select().from(users).where(eq(users.username, username)))[0]!;
    assert.equal(await repository.prebindWecomIdentity({ ...input, userId: existingUser.id }, baseNow), "identity_conflict");
    await handle.db.update(users).set({ active: false }).where(eq(users.id, targetId));
    assert.equal(await repository.prebindWecomIdentity({ ...input, wecomUserId: "other-member" }, baseNow), "target_unavailable");
  });

  await context.test("清理任务只删除已终止满 24 小时的临时事务", async () => {
    const cleanupNow = later(baseNow, 25 * 60 * 60);
    const cutoff = later(cleanupNow, -24 * 60 * 60);
    const oldExpiredState = "cleanup-old-expired";
    const oldConsumedState = "cleanup-old-consumed";
    const youngExpiredState = "cleanup-young-expired";
    const youngResultState = "cleanup-young-result";

    await repository.createWecomAuthTransaction({
      stateHash: hash(oldExpiredState),
      browserNonceHash: hash("cleanup-browser"),
      returnPath: "/projects",
      expiresAt: later(cutoff, -1),
    }, later(cutoff, -300));
    await repository.createWecomAuthTransaction({
      stateHash: hash(oldConsumedState),
      browserNonceHash: hash("cleanup-browser"),
      returnPath: "/projects",
      expiresAt: later(cleanupNow, 300),
    }, later(cutoff, -300));
    assert.equal((await repository.consumeWecomCallback({
      stateHash: hash(oldConsumedState),
      browserNonceHash: hash("cleanup-browser"),
    }, cutoff)).kind, "consumed");
    await repository.createWecomAuthTransaction({
      stateHash: hash(youngExpiredState),
      browserNonceHash: hash("cleanup-browser"),
      returnPath: "/projects",
      expiresAt: later(cutoff, 1),
    }, cutoff);
    await repository.createWecomAuthTransaction({
      stateHash: hash(youngResultState),
      browserNonceHash: hash("cleanup-browser"),
      returnPath: "/projects",
      expiresAt: later(cutoff, -1),
    }, later(cutoff, -300));
    const youngResultTransaction = await repository.consumeWecomCallback({
      stateHash: hash(youngResultState),
      browserNonceHash: hash("cleanup-browser"),
    }, later(cutoff, -2));
    assert.equal(youngResultTransaction.kind, "consumed");
    if (youngResultTransaction.kind !== "consumed") throw new Error("cleanup result fixture was not consumed");
    assert.equal((await repository.resolveWecomIdentityAndIssueResult({
      transactionId: youngResultTransaction.transactionId,
      corpId: "ww-corp",
      wecomUserId: "member-1",
      username,
      displayName: "不覆盖",
      resultHash: hash("cleanup-young-result-value"),
      resultExpiresAt: later(cleanupNow, 60),
    }, cleanupNow)).kind, "resolved");

    const identitiesBefore = await handle.db.select().from(wecomUserIdentities);
    const sessionsBefore = await handle.db.select().from(sessions);
    const deleted = await repository.deleteTerminalWecomAuthTransactions(cutoff);

    assert.ok(deleted >= 4, "old expired, callback-consumed, and result-terminal fixtures are removed");
    assert.equal((await handle.db.select().from(wecomAuthTransactions)
      .where(eq(wecomAuthTransactions.stateHash, hash(oldExpiredState)))).length, 0);
    assert.equal((await handle.db.select().from(wecomAuthTransactions)
      .where(eq(wecomAuthTransactions.stateHash, hash(oldConsumedState)))).length, 0);
    assert.equal((await handle.db.select().from(wecomAuthTransactions)
      .where(eq(wecomAuthTransactions.stateHash, hash(youngExpiredState)))).length, 1);
    assert.equal((await handle.db.select().from(wecomAuthTransactions)
      .where(eq(wecomAuthTransactions.stateHash, hash(youngResultState)))).length, 1);
    assert.equal((await handle.db.select().from(wecomUserIdentities)).length, identitiesBefore.length);
    assert.equal((await handle.db.select().from(sessions)).length, sessionsBefore.length);
  });

  await context.test("持久层不存在授权 code、明文 state/nonce/result 或 token 字段", async () => {
    const columns = await handle.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name IN ('wecom_user_identities', 'wecom_auth_transactions')`,
      [schema],
    );
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const forbidden of ["state", "browser_nonce", "result", "code", "access_token", "corp_secret", "token"]) {
      assert.equal(names.has(forbidden), false, forbidden);
    }
  });
});

async function createConsumedTransaction(repository: AuthRepository, label: string, now: Date) {
  await repository.createWecomAuthTransaction({
    stateHash: hash(label),
    browserNonceHash: hash("browser"),
    returnPath: "/projects",
    expiresAt: later(now, 300),
  }, now);
  return repository.consumeWecomCallback({ stateHash: hash(label), browserNonceHash: hash("browser") }, now);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function later(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1_000);
}

async function seedSession(
  db: ReturnType<typeof createDatabase>["db"],
  userId: string,
  source: "web" | "cli" | "agent",
  label: string,
  issuedBySessionId?: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(sessions).values({
    id,
    userId,
    tokenHash: hash(label),
    credentialSource: source,
    agentType: source === "agent" ? "test_agent" : null,
    userAgent: "wecom-db-test",
    credentialLabel: source === "agent" ? "测试 Agent" : null,
    issuedBySessionId: source === "agent" ? issuedBySessionId : null,
    expiresAt: later(baseNow, 3600),
    revokedAt: null,
    createdAt: baseNow,
  });
  return id;
}

function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { code?: string }).code;
  if (direct) return direct;
  return postgresCode((error as { cause?: unknown }).cause);
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
  const name = `wecom-auth-${process.pid}-${randomUUID().slice(0, 8)}`;
  const password = "wecom-auth-test";
  const database = "wecom_auth";
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
