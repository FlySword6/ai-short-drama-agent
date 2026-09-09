import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ByteHouseHttpClient,
  executeS55HelloWorld,
  formatS55Receipt,
  loadByteHouseCredentials,
  runS55HelloWorld,
  type ByteHouseQueryClient,
  type FetchLike,
} from "../scripts/bytehouse-s55-hw.mts";

const endpoint =
  "https://tenant-2100701382-cn-beijing-dev-public.bytehouse.volces.com:8123";
const appUsername = "2100701382::shortdrama_app::dev";
const readonlyUsername = "2100701382::shortdrama_readonly::dev";
const appPassword = "app-password-not-real";
const readonlyPassword = "readonly-password-not-real";

test("S55-HW DDL 作为独立审计工件固定库、主键、时间和归属字段", () => {
  const ddl = readFileSync(
    path.resolve(import.meta.dirname, "../bytehouse/s55-hw/001_hello_world.sql"),
    "utf8",
  );

  assert.match(ddl, /CREATE DATABASE IF NOT EXISTS shortdrama_analytics ENGINE = Cnch;/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS shortdrama_analytics\.s55_hello_world/);
  assert.match(ddl, /hello_key String/);
  assert.match(ddl, /owner_project String/);
  assert.match(ddl, /created_at DateTime64\(3, 'UTC'\)/);
  assert.match(ddl, /PRIMARY KEY \(hello_key\)/);
  assert.doesNotMatch(ddl, /shortdrama_(?:dev|test|prod|entity)/);
});

test("S55-HW 固定 DDL 后由 app 写入，readonly 回读并证明顺序重放幂等", async () => {
  const appSql: string[] = [];
  const readonlySql: string[] = [];
  const row = {
    hello_key: "s55-hw-v1",
    owner_project: "shortdrama",
    created_at: "2026-08-03 05:00:00.000",
  };

  const app: ByteHouseQueryClient = {
    async query(sql) {
      appSql.push(sql);
      if (sql.includes("FROM system.tables")) {
        return JSON.stringify({
          data: [{ engine: "CnchMergeTree", primary_key: "hello_key" }],
        });
      }
      if (sql.includes("FROM system.columns")) {
        return JSON.stringify({
          data: [
            { name: "hello_key", type: "String" },
            { name: "owner_project", type: "String" },
            { name: "created_at", type: "DateTime64(3, 'UTC')" },
          ],
        });
      }
      return "";
    },
  };
  const readonly: ByteHouseQueryClient = {
    async query(sql) {
      readonlySql.push(sql);
      return JSON.stringify({ data: [row] });
    },
  };

  const result = await executeS55HelloWorld({
    app,
    readonly,
    timestamp: row.created_at,
  });

  assert.deepEqual(result, {
    environment: "dev",
    database: "shortdrama_analytics",
    table: "s55_hello_world",
    rowCount: 1,
    appWriteVerified: true,
    readonlyReadVerified: true,
    replayIdempotent: true,
    schemaVerified: true,
  });
  assert.match(appSql[0] ?? "", /^CREATE DATABASE IF NOT EXISTS shortdrama_analytics ENGINE = Cnch$/);
  assert.match(appSql[1] ?? "", /^CREATE TABLE IF NOT EXISTS shortdrama_analytics\.s55_hello_world/);
  assert.match(appSql[1] ?? "", /hello_key String/);
  assert.match(appSql[1] ?? "", /owner_project String/);
  assert.match(appSql[1] ?? "", /created_at DateTime64\(3, 'UTC'\)/);
  assert.match(appSql[1] ?? "", /PRIMARY KEY \(hello_key\)/);

  const inserts = appSql.filter((sql) => sql.startsWith("INSERT INTO"));
  assert.equal(inserts.length, 2);
  for (const sql of inserts) {
    assert.match(sql, /WHERE NOT EXISTS/);
    assert.match(sql, /hello_key = 's55-hw-v1'/);
  }
  assert.equal(readonlySql.length, 2);
  assert.ok(readonlySql.every((sql) => sql.includes("FORMAT JSON")));
});

test("S55-HW 重放后出现重复行时拒绝宣称幂等", async () => {
  let readonlyCalls = 0;
  const app: ByteHouseQueryClient = {
    async query(sql) {
      if (sql.includes("FROM system.tables")) {
        return JSON.stringify({
          data: [{ engine: "CnchMergeTree", primary_key: "hello_key" }],
        });
      }
      if (sql.includes("FROM system.columns")) {
        return JSON.stringify({
          data: [
            { name: "hello_key", type: "String" },
            { name: "owner_project", type: "String" },
            { name: "created_at", type: "DateTime64(3, 'UTC')" },
          ],
        });
      }
      return "";
    },
  };
  const readonly: ByteHouseQueryClient = {
    async query() {
      readonlyCalls += 1;
      const rows = readonlyCalls === 1
        ? [{
            hello_key: "s55-hw-v1",
            owner_project: "shortdrama",
            created_at: "2026-08-03 05:00:00.000",
          }]
        : [
            {
              hello_key: "s55-hw-v1",
              owner_project: "shortdrama",
              created_at: "2026-08-03 05:00:00.000",
            },
            {
              hello_key: "s55-hw-v1",
              owner_project: "shortdrama",
              created_at: "2026-08-03 05:00:00.000",
            },
          ];
      return JSON.stringify({ data: rows });
    },
  };

  await assert.rejects(
    executeS55HelloWorld({
      app,
      readonly,
      timestamp: "2026-08-03 05:00:00.000",
    }),
    /重放幂等验证失败/,
  );
});

test("ByteHouse HTTP 边界按官方 HTTPS/8123 形态发送，失败时不泄露秘密", async () => {
  let observedUrl: URL | undefined;
  let observedBody: unknown;
  const fetcher: FetchLike = async (input, init) => {
    observedUrl = new URL(input);
    observedBody = init?.body;
    return {
      ok: false,
      status: 500,
      async text() {
        return `${endpoint} ${appUsername} ${appPassword} raw-provider-body`;
      },
    };
  };
  const client = new ByteHouseHttpClient(
    {
      environment: "dev",
      endpoint,
      username: appUsername,
      password: appPassword,
    },
    fetcher,
  );

  let message = "";
  try {
    await client.query("SELECT leak-me");
    assert.fail("HTTP 500 不应成功");
  } catch (error: unknown) {
    message = String(error);
  }
  assert.equal(observedUrl?.protocol, "https:");
  assert.equal(observedUrl?.port, "8123");
  assert.equal(observedUrl?.searchParams.get("user"), appUsername);
  assert.equal(observedUrl?.searchParams.get("password"), appPassword);
  assert.equal(observedBody, "SELECT leak-me");
  assert.doesNotMatch(message, new RegExp(endpoint));
  assert.doesNotMatch(message, new RegExp(appUsername));
  assert.doesNotMatch(message, new RegExp(appPassword));
  assert.doesNotMatch(message, /raw-provider-body/);
  assert.doesNotMatch(message, /leak-me/);
  assert.match(message, /HTTP 500/);
});

test("ByteHouse 输入错误只报告稳定类别、代码和白名单字段", async () => {
  const client = new ByteHouseHttpClient(
    {
      environment: "dev",
      endpoint,
      username: appUsername,
      password: appPassword,
    },
    async () => ({
      ok: false,
      status: 400,
      async text() {
        return `Code: 27. Cannot parse field rank_date; value=${appPassword}`;
      },
    }),
  );

  await assert.rejects(
    client.query("INSERT secret-source-content"),
    (error: unknown) => {
      const message = String(error);
      assert.match(message, /INPUT_PARSE_ERROR:code=27:field=rank_date/u);
      assert.doesNotMatch(message, new RegExp(appPassword));
      assert.doesNotMatch(message, /secret-source-content/u);
      return true;
    },
  );
});

test("受控凭据必须同时命中租户、dev 域名、dev 数据库用户和角色隔离", () => {
  const credentials = loadByteHouseCredentials({
    BYTEHOUSE_DEV_HTTP_ENDPOINT: endpoint,
    BYTEHOUSE_DEV_APP_USERNAME: appUsername,
    BYTEHOUSE_DEV_APP_PASSWORD: appPassword,
    BYTEHOUSE_DEV_READONLY_USERNAME: readonlyUsername,
    BYTEHOUSE_DEV_READONLY_PASSWORD: readonlyPassword,
  });

  assert.equal(credentials.endpoint, endpoint);
  assert.equal(credentials.app.username, appUsername);
  assert.equal(credentials.readonly.username, readonlyUsername);

  assert.throws(
    () =>
      loadByteHouseCredentials({
        BYTEHOUSE_DEV_HTTP_ENDPOINT:
          "https://tenant-2100701382-cn-beijing-prod-public.bytehouse.volces.com:8123",
        BYTEHOUSE_DEV_APP_USERNAME: appUsername,
        BYTEHOUSE_DEV_APP_PASSWORD: appPassword,
        BYTEHOUSE_DEV_READONLY_USERNAME: readonlyUsername,
        BYTEHOUSE_DEV_READONLY_PASSWORD: readonlyPassword,
      }),
    /endpoint 未命中 S55-HW dev allowlist/,
  );
});

test("S55-HW 只接受固定 loopback SSH 隧道端口，不允许任意转发目标", () => {
  const tunneled = loadByteHouseCredentials({
    BYTEHOUSE_DEV_HTTP_ENDPOINT: endpoint,
    BYTEHOUSE_DEV_APP_USERNAME: appUsername,
    BYTEHOUSE_DEV_APP_PASSWORD: appPassword,
    BYTEHOUSE_DEV_READONLY_USERNAME: readonlyUsername,
    BYTEHOUSE_DEV_READONLY_PASSWORD: readonlyPassword,
    BYTEHOUSE_DEV_SSH_TUNNEL_PORT: "18123",
  });

  assert.equal(tunneled.app.sshTunnelPort, 18123);
  assert.equal(tunneled.readonly.sshTunnelPort, 18123);
  assert.equal(tunneled.app.endpoint, endpoint);

  assert.throws(
    () =>
      loadByteHouseCredentials({
        BYTEHOUSE_DEV_HTTP_ENDPOINT: endpoint,
        BYTEHOUSE_DEV_APP_USERNAME: appUsername,
        BYTEHOUSE_DEV_APP_PASSWORD: appPassword,
        BYTEHOUSE_DEV_READONLY_USERNAME: readonlyUsername,
        BYTEHOUSE_DEV_READONLY_PASSWORD: readonlyPassword,
        BYTEHOUSE_DEV_SSH_TUNNEL_PORT: "8123",
      }),
    /只允许固定 loopback 端口/,
  );
});

test("完整 apply 只让 app 执行 DDL/写入、readonly 回读，最终回执全脱敏", async () => {
  const calls: Array<{ readonly username: string; readonly sql: string }> = [];
  const rows: Array<{
    hello_key: string;
    owner_project: string;
    created_at: string;
  }> = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(input);
    const username = url.searchParams.get("user") ?? "";
    const sql = String(init?.body ?? "");
    calls.push({ username, sql });

    let body = "";
    if (sql.includes("FROM system.tables")) {
      body = JSON.stringify({
        data: [{ engine: "CnchMergeTree", primary_key: "hello_key" }],
      });
    } else if (sql.includes("FROM system.columns")) {
      body = JSON.stringify({
        data: [
          { name: "hello_key", type: "String" },
          { name: "owner_project", type: "String" },
          { name: "created_at", type: "DateTime64(3, 'UTC')" },
        ],
      });
    } else if (sql.startsWith("INSERT INTO") && rows.length === 0) {
      const timestamp = sql.match(/toDateTime64\('([^']+)'/)?.[1] ?? "";
      rows.push({
        hello_key: "s55-hw-v1",
        owner_project: "shortdrama",
        created_at: timestamp,
      });
    } else if (sql.startsWith("SELECT hello_key")) {
      body = JSON.stringify({ data: rows });
    }

    return {
      ok: true,
      status: 200,
      async text() {
        return body;
      },
    };
  };
  const env = {
    BYTEHOUSE_DEV_HTTP_ENDPOINT: endpoint,
    BYTEHOUSE_DEV_APP_USERNAME: appUsername,
    BYTEHOUSE_DEV_APP_PASSWORD: appPassword,
    BYTEHOUSE_DEV_READONLY_USERNAME: readonlyUsername,
    BYTEHOUSE_DEV_READONLY_PASSWORD: readonlyPassword,
  };

  const result = await runS55HelloWorld({
    env,
    fetcher,
    now: new Date("2026-08-03T05:00:00.000Z"),
  });
  const receipt = formatS55Receipt("apply", result);

  const appCalls = calls.filter((call) => call.username === appUsername);
  const readonlyCalls = calls.filter((call) => call.username === readonlyUsername);
  assert.equal(rows.length, 1);
  assert.ok(appCalls.some((call) => call.sql.startsWith("CREATE DATABASE")));
  assert.equal(
    appCalls.filter((call) => call.sql.startsWith("INSERT INTO")).length,
    2,
  );
  assert.equal(readonlyCalls.length, 2);
  assert.ok(readonlyCalls.every((call) => call.sql.startsWith("SELECT hello_key")));

  assert.match(receipt, /S55_HW_DONE/);
  assert.match(receipt, /row_count=1/);
  assert.match(receipt, /app_write_verified=true/);
  assert.match(receipt, /readonly_read_verified=true/);
  assert.match(receipt, /replay_idempotent=true/);
  assert.doesNotMatch(receipt, new RegExp(endpoint));
  assert.doesNotMatch(receipt, new RegExp(appUsername));
  assert.doesNotMatch(receipt, new RegExp(readonlyUsername));
  assert.doesNotMatch(receipt, new RegExp(appPassword));
  assert.doesNotMatch(receipt, new RegExp(readonlyPassword));
});
